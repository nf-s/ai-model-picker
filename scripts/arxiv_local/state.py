"""Store arXiv harvest checkpoints, matched papers, assessments and evaluation results in SQLite."""

import hashlib
import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from hn_local.sources import PipelineError, iso_time
from hn_local.state import atomic_write

from .assess import KINDS, RESULT_VERSION, TOPICS
from .sources import days_between, parse_day, utc_day

DATABASE = 'checkpoint.sqlite3'
COUNTERS = {
    'recordsScanned': 'records',
    'recordsEligible': 'eligible',
    'unavailable': 'unavailable',
    'invalid': 'invalid',
}
COVERAGE = (
    'daysComplete', 'daysTotal', 'recordsScanned', 'recordsEligible', 'papers', 'assessed', 'assessmentFailures',
    'results', 'resultFailures',
)
REMATCH_BATCH = 2_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    registry TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated INTEGER NOT NULL,
    reason TEXT,
    assessor TEXT,
    assessor_key TEXT
);
CREATE TABLE IF NOT EXISTS partition (
    day TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'pending',
    records INTEGER NOT NULL DEFAULT 0,
    eligible INTEGER NOT NULL DEFAULT 0,
    unavailable INTEGER NOT NULL DEFAULT 0,
    invalid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS paper (
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL,
    categories TEXT NOT NULL,
    license TEXT,
    submitted INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    versions INTEGER NOT NULL,
    digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_submitted ON paper (submitted);
CREATE TABLE IF NOT EXISTS mention (
    paper_id TEXT NOT NULL REFERENCES paper (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    PRIMARY KEY (paper_id, kind, target)
);
CREATE INDEX IF NOT EXISTS mention_target ON mention (kind, target);
CREATE TABLE IF NOT EXISTS assessment (
    paper_id TEXT NOT NULL REFERENCES paper (id) ON DELETE CASCADE,
    assessor_key TEXT NOT NULL,
    digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    topics TEXT NOT NULL,
    takeaway TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, assessor_key)
);
CREATE TABLE IF NOT EXISTS result (
    paper_id TEXT NOT NULL REFERENCES paper (id) ON DELETE CASCADE,
    result_key TEXT NOT NULL,
    digest TEXT NOT NULL,
    area TEXT NOT NULL,
    task TEXT NOT NULL,
    best TEXT NOT NULL,
    weak TEXT NOT NULL,
    finding TEXT,
    failed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (paper_id, result_key)
);
"""
# Results are read only for papers whose current label is an evaluation.
EVALUATION = """JOIN assessment a ON a.paper_id = p.id AND a.digest = p.digest AND a.assessor_key = ?
    AND a.failed = 0 AND a.kind = 'evaluation'"""
EXACT = "EXISTS (SELECT 1 FROM mention m WHERE m.paper_id = p.id AND (m.kind = 'model' OR NOT ?))"


@dataclass
class Counters:
    records: int = 0
    eligible: int = 0
    unavailable: int = 0
    invalid: int = 0

    def add(self, record, in_scope):
        self.records += 1
        if record.kind == 'unavailable':
            self.unavailable += 1
        elif record.kind == 'invalid':
            self.invalid += 1
        else:
            self.eligible += int(in_scope)


def target_labels(targets):
    return sorted({(target.kind, target.label) for target in targets})


def paper_digest(title, abstract, labels):
    return hashlib.sha256(json.dumps([title, abstract, labels]).encode()).hexdigest()


def result_key(assessor_key):
    """Results belong to one set of labels and one result prompt."""
    return hashlib.sha256(f'{RESULT_VERSION}/{assessor_key}'.encode()).hexdigest()


def refs(text):
    return [{'kind': kind, 'target': target} for kind, target in json.loads(text)]


class State:
    def __init__(self, directory, readonly=False):
        self.directory = Path(directory)
        database = self.directory / DATABASE
        if readonly and not database.is_file():
            raise PipelineError('no-checkpoint')
        self.connection = sqlite3.connect(
            f'{database.resolve().as_uri()}?mode=ro' if readonly else database,
            uri=readonly,
            timeout=15,
        )
        self.connection.row_factory = sqlite3.Row
        self.connection.execute('PRAGMA foreign_keys=ON')
        if not readonly:
            self.connection.execute('PRAGMA journal_mode=WAL')
            self.connection.executescript(SCHEMA)
            self.connection.commit()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.connection.close()

    def job(self):
        return self.connection.execute('SELECT * FROM run').fetchone()

    def initialize(self, registry, start_at):
        with self.connection:
            self.connection.execute(
                'INSERT INTO run (id, registry, start_at, state, updated) VALUES (1, ?, ?, ?, ?)',
                (registry, start_at, 'pending', int(time.time())),
            )

    def extend(self, last_day):
        first_day = utc_day(self.job()['start_at'])
        with self.connection:
            self.connection.executemany(
                'INSERT OR IGNORE INTO partition (day) VALUES (?)',
                ((day,) for day in days_between(first_day, last_day)),
            )

    def pending_days(self):
        """Newest closed days first; the still-open final day is read last."""
        days = [
            row['day'] for row in self.connection.execute(
                "SELECT day FROM partition WHERE state != 'complete' ORDER BY day DESC"
            )
        ]
        last = self.connection.execute('SELECT MAX(day) FROM partition').fetchone()[0]
        return days[1:] + days[:1] if days and days[0] == last else days

    def set_run(self, state, reason=None):
        with self.connection:
            self.connection.execute(
                'UPDATE run SET state = ?, updated = ?, reason = ?', (state, int(time.time()), reason)
            )

    def add_paper(self, day, record, targets):
        labels = target_labels(targets)
        digest = paper_digest(record.title, record.abstract, labels)
        self.connection.execute(
            """INSERT INTO paper (id, day, title, abstract, categories, license, submitted, updated,
                                  versions, digest)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   day = excluded.day, title = excluded.title, abstract = excluded.abstract,
                   categories = excluded.categories, license = excluded.license,
                   submitted = excluded.submitted, updated = excluded.updated,
                   versions = excluded.versions, digest = excluded.digest""",
            (record.id, day, record.title, record.abstract, json.dumps(record.categories),
             record.license, record.submitted, record.updated, record.versions, digest),
        )
        self.set_mentions(record.id, labels, digest)

    def set_mentions(self, paper_id, labels, digest):
        self.connection.execute('DELETE FROM mention WHERE paper_id = ?', (paper_id,))
        self.connection.executemany(
            'INSERT INTO mention VALUES (?, ?, ?)', [(paper_id, kind, label) for kind, label in labels]
        )
        for table in ('assessment', 'result'):
            self.connection.execute(f'DELETE FROM {table} WHERE paper_id = ? AND digest != ?', (paper_id, digest))

    def rematch(self, registry, match):
        """Apply a changed alias registry to stored metadata without harvesting again."""
        after = ''
        with self.connection:
            while True:
                rows = self.connection.execute(
                    'SELECT id, title, abstract, categories, digest FROM paper WHERE id > ? ORDER BY id LIMIT ?',
                    (after, REMATCH_BATCH),
                ).fetchall()
                if not rows:
                    break
                for row in rows:
                    labels = target_labels(match(row['title'], row['abstract'], json.loads(row['categories'])))
                    digest = paper_digest(row['title'], row['abstract'], labels)
                    if digest != row['digest']:
                        self.connection.execute('UPDATE paper SET digest = ? WHERE id = ?', (digest, row['id']))
                        self.set_mentions(row['id'], labels, digest)
                after = rows[-1]['id']
            self.connection.execute('UPDATE run SET registry = ?, updated = ?', (registry, int(time.time())))

    def checkpoint(self, day, counters, papers, cleared, complete):
        with self.connection:
            self.connection.executemany(
                'DELETE FROM paper WHERE id = ?', ((paper_id,) for paper_id in cleared)
            )
            for record, targets in papers:
                self.add_paper(day, record, targets)
            self.connection.execute(
                """UPDATE partition SET state = ?, records = ?, eligible = ?, unavailable = ?, invalid = ?
                   WHERE day = ?""",
                ('complete' if complete else 'partial', counters.records, counters.eligible,
                 counters.unavailable, counters.invalid, day),
            )
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))

    def set_assessor(self, assessor, assessor_key):
        with self.connection:
            self.connection.execute(
                'UPDATE run SET assessor = ?, assessor_key = ?, updated = ?',
                (assessor, assessor_key, int(time.time())),
            )

    def unassessed(self, assessor_key, limit, exact_only=False):
        """Papers naming an exact model come first, then newest first."""
        return list(self.connection.execute(
            f"""SELECT p.id, p.title, p.abstract, p.digest,
                      EXISTS (SELECT 1 FROM mention m WHERE m.paper_id = p.id AND m.kind = 'model') AS exact
               FROM paper p
               LEFT JOIN assessment a ON a.paper_id = p.id AND a.assessor_key = ?
               WHERE a.paper_id IS NULL AND {EXACT}
               ORDER BY exact DESC, p.submitted DESC, p.id DESC LIMIT ?""",
            (assessor_key, exact_only, limit),
        ))

    def failed_assessments(self, assessor_key, after, limit, exact_only=False):
        return list(self.connection.execute(
            f"""SELECT p.id, p.title, p.abstract, p.digest
               FROM paper p JOIN assessment a ON a.paper_id = p.id AND a.assessor_key = ?
               WHERE a.failed = 1 AND p.id > ? AND {EXACT}
               ORDER BY p.id LIMIT ?""",
            (assessor_key, after, exact_only, limit),
        ))

    def unextracted(self, assessor_key, limit, exact_only=False):
        """Evaluation papers without a result, newest first."""
        return list(self.connection.execute(
            f"""SELECT p.id, p.title, p.abstract, p.digest
                FROM paper p {EVALUATION}
                LEFT JOIN result r ON r.paper_id = p.id AND r.result_key = ?
                WHERE r.paper_id IS NULL AND {EXACT}
                ORDER BY p.submitted DESC, p.id DESC LIMIT ?""",
            (assessor_key, result_key(assessor_key), exact_only, limit),
        ))

    def failed_results(self, assessor_key, after, limit, exact_only=False):
        return list(self.connection.execute(
            f"""SELECT p.id, p.title, p.abstract, p.digest
                FROM paper p {EVALUATION}
                JOIN result r ON r.paper_id = p.id AND r.result_key = ?
                WHERE r.failed = 1 AND p.id > ? AND {EXACT}
                ORDER BY p.id LIMIT ?""",
            (assessor_key, result_key(assessor_key), after, exact_only, limit),
        ))

    def paper_targets(self, paper_id):
        return [
            (row['kind'], row['target']) for row in self.connection.execute(
                'SELECT kind, target FROM mention WHERE paper_id = ? ORDER BY kind DESC, target', (paper_id,)
            )
        ]

    def add_assessment(self, assessor_key, paper_id, digest, assessment):
        with self.connection:
            self.connection.execute(
                """INSERT INTO assessment (paper_id, assessor_key, digest, kind, topics, takeaway, failed)
                   SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM paper WHERE id = ? AND digest = ?)
                   ON CONFLICT(paper_id, assessor_key) DO UPDATE SET
                       digest = excluded.digest, kind = excluded.kind, topics = excluded.topics,
                       takeaway = excluded.takeaway, failed = excluded.failed""",
                (paper_id, assessor_key, digest, assessment.kind, json.dumps(assessment.topics),
                 assessment.takeaway, int(assessment.failed), paper_id, digest),
            )
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))

    def add_result(self, assessor_key, paper_id, digest, result, targets):
        """`targets` is the list whose names the model was given; the result holds positions in it."""
        best, weak = (json.dumps([targets[position] for position in group]) for group in (result.best, result.weak))
        with self.connection:
            self.connection.execute(
                """INSERT INTO result (paper_id, result_key, digest, area, task, best, weak, finding, failed)
                   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM paper WHERE id = ? AND digest = ?)
                   ON CONFLICT(paper_id, result_key) DO UPDATE SET
                       digest = excluded.digest, area = excluded.area, task = excluded.task, best = excluded.best,
                       weak = excluded.weak, finding = excluded.finding, failed = excluded.failed""",
                (paper_id, result_key(assessor_key), digest, result.area, result.task, best, weak,
                 result.finding, int(result.failed), paper_id, digest),
            )
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))

    def status(self):
        job = self.job()
        if job is None:
            raise PipelineError('no-checkpoint')
        partitions = list(self.connection.execute('SELECT * FROM partition ORDER BY day'))
        totals = {name: sum(p[key] for p in partitions) for name, key in COUNTERS.items()}
        stored = self.connection.execute('SELECT COUNT(*) FROM paper').fetchone()[0]
        papers, first, last = self.connection.execute(
            """SELECT COUNT(*), MIN(submitted), MAX(submitted) FROM paper p
               WHERE EXISTS (SELECT 1 FROM mention m WHERE m.paper_id = p.id)"""
        ).fetchone()
        # A revised paper belongs to the day of its latest record, so day totals never count it twice.
        matched = {
            row[0]: row[1] for row in self.connection.execute(
                """SELECT p.day, COUNT(DISTINCT p.id) FROM mention m JOIN paper p ON p.id = m.paper_id
                   GROUP BY p.day"""
            )
        }
        assessed, failed = self.connection.execute(
            """SELECT COUNT(CASE WHEN a.failed = 0 THEN 1 END), COUNT(CASE WHEN a.failed = 1 THEN 1 END)
               FROM assessment a JOIN paper p ON p.id = a.paper_id AND p.digest = a.digest
               WHERE a.assessor_key = ?""",
            (job['assessor_key'],),
        ).fetchone()
        extracted, unextracted = self.connection.execute(
            f"""SELECT COUNT(CASE WHEN r.failed = 0 THEN 1 END), COUNT(CASE WHEN r.failed = 1 THEN 1 END)
                FROM paper p {EVALUATION}
                JOIN result r ON r.paper_id = p.id AND r.digest = p.digest AND r.result_key = ?""",
            (job['assessor_key'], result_key(job['assessor_key'])),
        ).fetchone()
        totals['recordsStored'] = stored
        totals['papers'] = papers
        totals['assessed'] = assessed
        totals['assessmentFailures'] = failed
        totals['results'] = extracted
        totals['resultFailures'] = unextracted
        totals['daysComplete'] = sum(p['state'] == 'complete' for p in partitions)
        totals['daysTotal'] = len(partitions)
        return {
            'schemaVersion': 1,
            'state': job['state'],
            'reason': job['reason'],
            'updatedAt': iso_time(job['updated']),
            'registry': job['registry'],
            'assessor': job['assessor'],
            'startAt': iso_time(job['start_at']),
            'firstDay': partitions[0]['day'] if partitions else None,
            'lastDay': partitions[-1]['day'] if partitions else None,
            'totals': totals,
            'firstPaperAt': iso_time(first),
            'lastPaperAt': iso_time(last),
            'days': [
                {
                    'day': parse_day(part['day']).isoformat(),
                    'state': part['state'],
                    'records': part['records'],
                    'papers': matched.get(part['day'], 0),
                }
                for part in partitions
            ],
        }

    def results(self, status):
        job = self.job()
        rows = self.connection.execute(
            """SELECT p.id, p.title, p.categories, p.submitted,
                      m.kind AS target_kind, m.target, a.kind, a.topics, a.takeaway,
                      r.area, r.task, r.best, r.weak, r.finding
               FROM paper p JOIN mention m ON m.paper_id = p.id
               LEFT JOIN assessment a ON a.paper_id = p.id AND a.digest = p.digest
                   AND a.assessor_key = ? AND a.failed = 0
               LEFT JOIN result r ON r.paper_id = p.id AND r.digest = p.digest
                   AND r.result_key = ? AND r.failed = 0 AND a.kind = 'evaluation'
               ORDER BY p.submitted DESC, p.id DESC, m.kind DESC, m.target""",
            (job['assessor_key'], result_key(job['assessor_key'])),
        )
        papers = []
        models, families = {}, {}
        for row in rows:
            if not papers or papers[-1]['id'] != row['id']:
                papers.append({
                    'id': row['id'],
                    'title': row['title'],
                    'submittedAt': iso_time(row['submitted']),
                    'categories': json.loads(row['categories']),
                    'targets': [],
                    'assessment': None if row['kind'] is None else {
                        'kind': row['kind'],
                        'topics': json.loads(row['topics']),
                        'takeaway': row['takeaway'],
                    },
                    'result': None if row['area'] is None else {
                        'area': row['area'],
                        'task': row['task'],
                        'best': refs(row['best']),
                        'weak': refs(row['weak']),
                        'finding': row['finding'],
                    },
                })
            paper = papers[-1]
            is_model = row['target_kind'] == 'model'
            paper['targets'].append({'kind': row['target_kind'], 'target': row['target']})
            aggregate = models if is_model else families
            if row['target'] not in aggregate:
                aggregate[row['target']] = {
                    'modelId' if is_model else 'familyName': row['target'],
                    'papers': 0,
                    'months': {},
                    'kinds': dict.fromkeys(KINDS, 0),
                    'topics': dict.fromkeys(TOPICS, 0),
                }
            target = aggregate[row['target']]
            month = paper['submittedAt'][:7]
            target['papers'] += 1
            target['months'][month] = target['months'].get(month, 0) + 1
            if paper['assessment']:
                target['kinds'][paper['assessment']['kind']] += 1
                for topic in paper['assessment']['topics']:
                    target['topics'][topic] += 1
        return {
            'schemaVersion': 1,
            'updatedAt': status['updatedAt'],
            'assessor': status['assessor'],
            'startAt': status['startAt'],
            'coverage': {
                'state': status['state'],
                'firstDay': status['firstDay'],
                'lastDay': status['lastDay'],
                **{key: status['totals'][key] for key in COVERAGE},
            },
            'models': [models[key] for key in sorted(models)],
            'families': [families[key] for key in sorted(families)],
            'papers': papers,
        }

    def export(self):
        status = self.status()
        atomic_write(self.directory / 'papers.json', self.results(status))
        atomic_write(self.directory / 'status.json', status)
        return status
