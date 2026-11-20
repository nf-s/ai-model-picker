"""Store checkpoint counters and allowlisted assessment data in SQLite."""

import fcntl
import json
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from .classify import ASPECTS, SENTIMENTS
from .sources import RECONCILE_ID, DateWindow, Partition, PipelineError, iso_time

DATABASE = 'checkpoint.sqlite3'
EVIDENCE_LIMIT = 12
BITMAP_CHUNK_BYTES = 1024
BITMAP_CHUNK_ITEMS = BITMAP_CHUNK_BYTES * 8
COUNTERS = {
    'itemsScanned': 'position',
    'commentsScanned': 'comments',
    'commentsEligible': 'eligible',
    'candidates': 'candidates',
    'unavailable': 'unavailable',
    'invalid': 'invalid',
    'failures': 'failures',
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS run (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source TEXT NOT NULL,
    archive_revision TEXT,
    first_item INTEGER NOT NULL,
    last_item INTEGER NOT NULL,
    classifier TEXT NOT NULL,
    classifier_key TEXT NOT NULL,
    state TEXT NOT NULL,
    updated INTEGER NOT NULL,
    reason TEXT,
    full_range INTEGER NOT NULL,
    retry_failures INTEGER NOT NULL DEFAULT 0,
    start_at INTEGER,
    end_at INTEGER,
    scan_key TEXT
);
CREATE TABLE IF NOT EXISTS partition (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE,
    source TEXT NOT NULL,
    expected_items INTEGER NOT NULL,
    first_item INTEGER,
    last_item INTEGER,
    row_offset INTEGER NOT NULL DEFAULT 0,
    archive_rows INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    position INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    eligible INTEGER NOT NULL DEFAULT 0,
    candidates INTEGER NOT NULL DEFAULT 0,
    unavailable INTEGER NOT NULL DEFAULT 0,
    invalid INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    first_comment INTEGER,
    last_comment INTEGER
);
CREATE TABLE IF NOT EXISTS comment (
    item_id INTEGER NOT NULL,
    classifier_key TEXT NOT NULL,
    digest TEXT NOT NULL,
    created INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    failed_groups INTEGER,
    parent INTEGER,
    root INTEGER,
    mention INTEGER NOT NULL DEFAULT 1,
    task TEXT,
    claim TEXT,
    PRIMARY KEY (item_id, classifier_key)
);
CREATE TABLE IF NOT EXISTS assessment (
    item_id INTEGER NOT NULL,
    classifier_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    sentiment TEXT NOT NULL,
    aspects TEXT NOT NULL,
    confidence TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    themes TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (item_id, classifier_key, kind, target),
    FOREIGN KEY (item_id, classifier_key)
        REFERENCES comment (item_id, classifier_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS assessment_target ON assessment (kind, target);
CREATE TABLE IF NOT EXISTS preference (
    item_id INTEGER NOT NULL,
    classifier_key TEXT NOT NULL,
    winner_kind TEXT NOT NULL,
    winner TEXT NOT NULL,
    loser_kind TEXT NOT NULL,
    loser TEXT NOT NULL,
    PRIMARY KEY (item_id, classifier_key, winner_kind, winner, loser_kind, loser),
    FOREIGN KEY (item_id, classifier_key)
        REFERENCES comment (item_id, classifier_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS story (
    item_id INTEGER PRIMARY KEY,
    created INTEGER,
    title TEXT NOT NULL,
    targets TEXT NOT NULL DEFAULT '[]',
    certain INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    comments INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS archive_bitmap (
    chunk INTEGER PRIMARY KEY,
    bits BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_gap (
    item_id INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS added_target (
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (kind, label)
);
CREATE TABLE IF NOT EXISTS batch (
    id TEXT PRIMARY KEY,
    classifier_key TEXT NOT NULL,
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_request (
    batch_id TEXT NOT NULL REFERENCES batch (id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL,
    parent INTEGER,
    root INTEGER,
    targets TEXT NOT NULL,
    PRIMARY KEY (batch_id, item_id)
);
"""


@dataclass
class Found:
    """What one scanned block queues: comments naming a target and stories about one."""

    comments: list = field(default_factory=list)
    stories: list = field(default_factory=list)
    # Reviewed comments to review again, because their text names a target added by `retarget`.
    renamed: list = field(default_factory=list)


@dataclass
class Counters:
    position: int = 0
    comments: int = 0
    eligible: int = 0
    candidates: int = 0
    unavailable: int = 0
    invalid: int = 0
    failures: int = 0
    first_comment: int | None = None
    last_comment: int | None = None

    def add(self, item, has_candidate, in_scope=True):
        self.position += 1
        if not in_scope and (item.created is not None or item.kind == 'comment'):
            return
        if item.kind == 'comment':
            self.comments += 1
            self.eligible += int(item.available)
            self.candidates += int(has_candidate)
            self.unavailable += int(not item.available)
            if item.created is not None:
                self.first_comment = min(self.first_comment or item.created, item.created)
                self.last_comment = max(self.last_comment or item.created, item.created)
        elif item.kind == 'unavailable':
            self.unavailable += 1
        elif item.kind == 'invalid':
            self.invalid += 1


@contextmanager
def writer_lock(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / 'pipeline.lock').open('a', encoding='utf-8') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise PipelineError('already-running') from None
        yield


def atomic_write(path, data):
    temporary = path.with_suffix('.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as file:
            json.dump(data, file, ensure_ascii=True, separators=(',', ':'))
            file.write('\n')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


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
        if not readonly:
            self.connection.execute('PRAGMA journal_mode=WAL')
            self.connection.execute('PRAGMA foreign_keys=ON')
            self.connection.executescript(SCHEMA)
            for table, column, declaration in (
                ('run', 'full_range', 'INTEGER NOT NULL DEFAULT 0'),
                ('run', 'retry_failures', 'INTEGER NOT NULL DEFAULT 0'),
                ('run', 'start_at', 'INTEGER'),
                ('run', 'end_at', 'INTEGER'),
                ('run', 'scan_key', 'TEXT'),
                ('partition', 'row_offset', 'INTEGER NOT NULL DEFAULT 0'),
                ('partition', 'archive_rows', 'INTEGER'),
                ('comment', 'failed_groups', 'INTEGER'),
                ('assessment', 'failed', 'INTEGER NOT NULL DEFAULT 0'),
                ('comment', 'parent', 'INTEGER'),
                ('comment', 'root', 'INTEGER'),
                ('comment', 'mention', 'INTEGER NOT NULL DEFAULT 1'),
                ('comment', 'task', 'TEXT'),
                ('comment', 'claim', 'TEXT'),
                ('assessment', 'themes', "TEXT NOT NULL DEFAULT '[]'"),
            ):
                columns = self.connection.execute(f'PRAGMA table_info({table})')
                if not any(row['name'] == column for row in columns):
                    self.connection.execute(f'ALTER TABLE {table} ADD COLUMN {column} {declaration}')
                    if column == 'failed':
                        self.connection.execute(
                            """UPDATE assessment SET failed = 1
                               WHERE sentiment = 'unclear' AND confidence = 'low'
                               AND EXISTS (SELECT 1 FROM comment c WHERE c.item_id = assessment.item_id
                                   AND c.classifier_key = assessment.classifier_key AND c.failed_groups > 0)"""
                        )
            self.connection.commit()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.connection.close()

    def job(self):
        return self.connection.execute('SELECT * FROM run').fetchone()

    def scan_window(self, job=None):
        if job is None:
            job = self.job()
        if job is not None and 'start_at' in job.keys() and job['start_at'] is not None and job['end_at'] is not None:
            return DateWindow(job['start_at'], job['end_at'])
        return None

    def initialize(self, plan, classifier, classifier_key, scan_key=None):
        start, end = (plan.window.start, plan.window.end) if plan.window else (None, None)
        with self.connection:
            self.connection.execute(
                """INSERT INTO run (id, source, archive_revision, first_item, last_item, classifier,
                   classifier_key, state, updated, reason, full_range, start_at, end_at, scan_key)
                   VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)""",
                (plan.source, plan.archive_revision, plan.first_item, plan.last_item, classifier,
                 classifier_key, 'pending', int(time.time()), int(plan.full_range), start, end, scan_key),
            )
            self.insert_partitions(plan.partitions)

    def model_used(self):
        """Whether a model has reviewed or been sent a comment, or judged a story title, in this checkpoint."""
        return bool(self.connection.execute(
            """SELECT EXISTS (SELECT 1 FROM comment WHERE failed_groups IS NOT NULL)
                   OR EXISTS (SELECT 1 FROM story WHERE certain = 0 AND state IN ('expanded', 'rejected'))
                   OR EXISTS (SELECT 1 FROM batch)"""
        ).fetchone()[0])

    def change_classifier(self, classifier, classifier_key):
        """Hand a queue no model has touched to another classifier. Collection does not depend on the model."""
        with self.connection:
            self.connection.execute('UPDATE comment SET classifier_key = ?', (classifier_key,))
            self.connection.execute(
                'UPDATE run SET classifier = ?, classifier_key = ?, updated = ?',
                (classifier, classifier_key, int(time.time())),
            )

    def insert_partitions(self, partitions, first_sequence=0):
        self.connection.executemany(
            """INSERT INTO partition
               (id, sequence, source, expected_items, first_item, last_item, row_offset, archive_rows)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                (p.id, index, p.source, p.expected_items, p.first_item, p.last_item, p.row_offset, p.archive_rows)
                for index, p in enumerate(partitions, first_sequence)
            ],
        )

    def restrict_to_plan(self, plan):
        job = self.job()
        if job is None or self.scan_window(job) is not None or plan.window is None or plan.source != job['source']:
            raise PipelineError('checkpoint-configuration-mismatch')
        old_partitions = {p['id']: p for p in self.connection.execute('SELECT * FROM partition')}
        archive_unchanged = job['archive_revision'] == plan.archive_revision
        window = plan.window
        with self.connection:
            self.connection.execute('DELETE FROM partition')
            self.insert_partitions(plan.partitions)
            for partition in plan.partitions:
                previous = old_partitions.get(partition.id)
                if previous is None or self.read_partition(previous) != partition:
                    continue
                if partition.source == 'archive' and not archive_unchanged:
                    continue
                if any(
                    previous[key] is not None and not window.contains(previous[key])
                    for key in ('first_comment', 'last_comment')
                ):
                    continue
                self.connection.execute(
                    """UPDATE partition SET state = :state, position = :position, comments = :comments,
                       eligible = :eligible, candidates = :candidates, unavailable = :unavailable,
                       invalid = :invalid, failures = :failures, first_comment = :first_comment,
                       last_comment = :last_comment WHERE id = :id""",
                    dict(previous),
                )
            self.connection.execute('DELETE FROM archive_gap')
            if not archive_unchanged:
                self.connection.execute('DELETE FROM archive_bitmap')
            self.connection.execute('DELETE FROM comment WHERE created NOT BETWEEN ? AND ?', (window.start, window.end))
            self.connection.execute(
                "DELETE FROM story WHERE state != 'context' AND created NOT BETWEEN ? AND ?",
                (window.start, window.end),
            )
            self.connection.execute(
                'DELETE FROM comment WHERE mention = 0 AND root NOT IN (SELECT item_id FROM story)'
            )
            self.connection.execute('UPDATE comment SET root = NULL WHERE root NOT IN (SELECT item_id FROM story)')
            self.connection.execute(
                """UPDATE run SET archive_revision = ?, first_item = ?, last_item = ?, full_range = 0,
                   start_at = ?, end_at = ?, state = 'paused', reason = NULL, retry_failures = 0, updated = ?""",
                (plan.archive_revision, plan.first_item, plan.last_item, window.start, window.end, int(time.time())),
            )

    def extend(self, end, last_item, partitions, rewalk_after):
        """Move the end of the window and of the item range forward, keeping every review.

        partitions cover the items after the old range and are scanned next. Walked stories created
        from rewalk_after on are walked again, since their threads can have comments after the old end.
        """
        job = self.job()
        window = self.scan_window(job)
        if (
            job is None or window is None or job['source'] != 'archive-and-tail'
            or end <= window.end or last_item <= job['last_item']
            or any(not job['last_item'] < p.first_item <= p.last_item <= last_item for p in partitions)
        ):
            raise PipelineError('checkpoint-configuration-mismatch')
        sequence = self.connection.execute('SELECT COALESCE(MAX(sequence), -1) + 1 FROM partition').fetchone()[0]
        with self.connection:
            self.insert_partitions(partitions, sequence)
            self.connection.execute(
                "UPDATE story SET state = 'pending' WHERE state = 'expanded' AND created >= ?", (rewalk_after,),
            )
            self.connection.execute(
                """UPDATE run SET last_item = ?, end_at = ?, state = 'paused', reason = NULL, updated = ?""",
                (last_item, end, int(time.time())),
            )

    def ensure_reconciliation(self):
        watermark, sequence = self.connection.execute(
            "SELECT MAX(last_item), MAX(sequence) FROM partition WHERE source = 'archive'"
        ).fetchone()
        if watermark is None:
            return
        job = self.job()
        first = job['first_item'] if self.scan_window(job) else 1
        with self.connection:
            cursor = self.connection.execute(
                """INSERT INTO partition (id, sequence, source, expected_items, first_item, last_item)
                   VALUES (?, ?, 'firebase', 0, ?, ?) ON CONFLICT(id) DO NOTHING""",
                (RECONCILE_ID, sequence + 1, first, watermark),
            )
            if cursor.rowcount:
                self.connection.execute("UPDATE run SET state = 'paused' WHERE state = 'complete'")

    def mark_archive_ids(self, item_ids):
        chunks = {}
        for item_id in item_ids:
            chunk, bit = divmod(item_id - 1, BITMAP_CHUNK_ITEMS)
            chunks[chunk] = chunks.get(chunk, 0) | (1 << bit)
        for chunk, bits in chunks.items():
            stored = self.connection.execute('SELECT bits FROM archive_bitmap WHERE chunk = ?', (chunk,)).fetchone()
            if stored:
                previous = int.from_bytes(stored['bits'], 'little')
                bits |= previous
                if bits == previous:
                    continue
            self.connection.execute(
                """INSERT INTO archive_bitmap VALUES (?, ?)
                   ON CONFLICT(chunk) DO UPDATE SET bits = excluded.bits""",
                (chunk, bits.to_bytes(BITMAP_CHUNK_BYTES, 'little')),
            )

    def materialize_gaps(self, watermark, first_item=1):
        def missing_ids():
            if first_item > watermark:
                return
            for chunk in range((first_item - 1) // BITMAP_CHUNK_ITEMS, (watermark - 1) // BITMAP_CHUNK_ITEMS + 1):
                first = chunk * BITMAP_CHUNK_ITEMS + 1
                low = max(0, first_item - first)
                high = min(BITMAP_CHUNK_ITEMS, watermark - first + 1)
                stored = self.connection.execute('SELECT bits FROM archive_bitmap WHERE chunk = ?', (chunk,)).fetchone()
                present = int.from_bytes(stored['bits'], 'little') if stored else 0
                unset = ~present & ((1 << high) - (1 << low))
                while unset:
                    bit = unset & -unset
                    yield (first + bit.bit_length() - 1,)
                    unset ^= bit

        with self.connection:
            self.connection.executemany('INSERT OR IGNORE INTO archive_gap VALUES (?)', missing_ids())
            self.connection.execute(
                'UPDATE partition SET expected_items = (SELECT COUNT(*) FROM archive_gap) WHERE id = ?',
                (RECONCILE_ID,),
            )

    def gap_ids(self, position, count):
        return [
            row['item_id'] for row in self.connection.execute(
                'SELECT item_id FROM archive_gap ORDER BY item_id DESC LIMIT ? OFFSET ?', (count, position)
            )
        ]

    def pending_stories(self):
        return list(self.connection.execute(
            """SELECT item_id, title, targets, certain, comments FROM story
               WHERE state = 'pending' ORDER BY item_id DESC"""
        ))

    def story(self, item_id):
        return self.connection.execute('SELECT * FROM story WHERE item_id = ?', (item_id,)).fetchone()

    def reject_story(self, item_id):
        with self.connection:
            self.connection.execute("UPDATE story SET state = 'rejected' WHERE item_id = ?", (item_id,))
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))

    def expand_story(self, classifier_key, item_id, comments, requeue=False):
        """Queue every comment of a story about a target. Comments are (id, created, parent).

        With requeue, comments of the thread that were reviewed already are reviewed again.
        """
        with self.connection:
            self.connection.executemany(
                """INSERT INTO comment (item_id, classifier_key, digest, created, priority, parent, root, mention)
                   VALUES (?, ?, '', ?, 0, ?, ?, 0)
                   ON CONFLICT(item_id, classifier_key) DO UPDATE SET
                       parent = excluded.parent, root = excluded.root""",
                [(comment, classifier_key, created, parent, item_id) for comment, created, parent in comments],
            )
            if requeue:
                self.requeue_thread(classifier_key, item_id)
            self.connection.execute(
                "UPDATE story SET state = 'expanded', comments = ? WHERE item_id = ?", (len(comments), item_id)
            )
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))

    def requeue_thread(self, classifier_key, item_id):
        self.connection.execute(
            'UPDATE comment SET failed_groups = NULL WHERE classifier_key = ? AND root = ? AND failed_groups = 0',
            (classifier_key, item_id),
        )

    def added_targets(self):
        """The (kind, label) of each target added by `retarget` whose scan or thread walks are not done."""
        return {(row['kind'], row['label']) for row in self.connection.execute('SELECT kind, label FROM added_target')}

    def finish_retarget(self):
        with self.connection:
            self.connection.execute('DELETE FROM added_target')

    def assessed_targets(self):
        """The (kind, label) of every target with a stored assessment or stated preference."""
        return {
            (row[0], row[1]) for row in self.connection.execute(
                """SELECT kind, target FROM assessment
                   UNION SELECT winner_kind, winner FROM preference
                   UNION SELECT loser_kind, loser FROM preference"""
            )
        }

    def retarget(self, classifier_key, scan_key, added, stories):
        """Keep every review under a changed target list, and set the saved window to be scanned again.

        added holds the (kind, label) of each new target. stories maps the ID of each recorded story whose
        title names a new target to its targets and certainty under the new list. A walked one keeps its
        thread and has its comments reviewed again; any other is judged and walked again.
        """
        job = self.job()
        if job is None or self.scan_window(job) is None or job['source'] != 'archive-and-tail' or self.batched():
            raise PipelineError('checkpoint-configuration-mismatch')
        previous = job['classifier_key']
        # The reviews move to the new key together, so the foreign keys hold only at the commit.
        self.connection.execute('PRAGMA defer_foreign_keys = ON')
        with self.connection:
            for table in ('comment', 'assessment', 'preference'):
                self.connection.execute(
                    f'UPDATE {table} SET classifier_key = ? WHERE classifier_key = ?', (classifier_key, previous),
                )
            # A retarget before the last one's scan finished adds to its targets.
            self.connection.executemany('INSERT OR IGNORE INTO added_target VALUES (?, ?)', sorted(added))
            for item_id, (targets, certain) in stories.items():
                if self.story(item_id)['state'] == 'expanded':
                    self.requeue_thread(classifier_key, item_id)
                    self.connection.execute(
                        'UPDATE story SET targets = ?, certain = ? WHERE item_id = ?', (targets, certain, item_id),
                    )
                else:
                    self.connection.execute(
                        "UPDATE story SET targets = ?, certain = ?, state = 'pending' WHERE item_id = ?",
                        (targets, certain, item_id),
                    )
            self.connection.execute(
                """UPDATE partition SET state = 'pending', position = 0, comments = 0, eligible = 0,
                   candidates = 0, unavailable = 0, invalid = 0, failures = 0,
                   first_comment = NULL, last_comment = NULL"""
            )
            self.connection.execute(
                """UPDATE run SET classifier_key = ?, scan_key = ?, state = 'paused', reason = NULL,
                   updated = ?""",
                (classifier_key, scan_key, int(time.time())),
            )

    def remember_story(self, item_id, created, title):
        """Keep the title of a thread that holds a queued comment, for context and display."""
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO story (item_id, created, title, state) VALUES (?, ?, ?, 'context')",
                (item_id, created, title),
            )

    def queued(self, limit, failed=False, before=None):
        """Comments awaiting a review, newest first. With failed, those whose last attempt was invalid."""
        condition = 'failed_groups > 0' if failed else 'failed_groups IS NULL'
        return list(self.connection.execute(
            f"""SELECT item_id, created, parent, root FROM comment
                WHERE {condition} AND item_id < ? ORDER BY item_id DESC LIMIT ?""",
            (before if before is not None else 2**62, limit),
        ))

    def unrooted(self, limit, before=None):
        """Comments with no story yet, newest first, once each across classifiers."""
        return list(self.connection.execute(
            """SELECT DISTINCT item_id FROM comment
               WHERE root IS NULL AND item_id < ? ORDER BY item_id DESC LIMIT ?""",
            (before if before is not None else 2**62, limit),
        ))

    def save_context(self, records):
        """Store thread context as (item_id, parent, root) on comments that have no story yet.

        A root of None keeps the comment without a story. Reviews and assessments are untouched.
        """
        with self.connection:
            self.connection.executemany(
                'UPDATE comment SET parent = ?, root = ? WHERE item_id = ? AND root IS NULL',
                [(parent, root, item_id) for item_id, parent, root in records],
            )

    def open_batch(self, batch_id, classifier_key, requests):
        """Record a batch sent for review. Requests are (item_id, parent, root, targets as JSON)."""
        with self.connection:
            self.connection.execute(
                'INSERT INTO batch VALUES (?, ?, ?)', (batch_id, classifier_key, int(time.time()))
            )
            self.connection.executemany(
                'INSERT INTO batch_request VALUES (?, ?, ?, ?, ?)',
                [(batch_id, *request) for request in requests],
            )

    def batches(self):
        """Batches sent for review whose results are not stored yet, oldest first."""
        return [row['id'] for row in self.connection.execute('SELECT id FROM batch ORDER BY created, rowid')]

    def batched(self):
        """Comments in batches whose results are not stored yet."""
        return self.connection.execute('SELECT COUNT(*) FROM batch_request').fetchone()[0]

    def batch_requests(self, batch_id):
        """The comments of one batch that are still in the checkpoint."""
        return list(self.connection.execute(
            """SELECT r.item_id, r.parent, r.root, r.targets FROM batch_request r
               JOIN batch b ON b.id = r.batch_id
               JOIN comment c ON c.item_id = r.item_id AND c.classifier_key = b.classifier_key
               WHERE r.batch_id = ?""",
            (batch_id,),
        ))

    def save_reviews(self, classifier_key, records, cleared=(), batch=None):
        """Store reviews as (item_id, parent, root, review). A review of None is a failed attempt.

        With batch, that batch is closed in the same transaction.
        """
        with self.connection:
            if batch is not None:
                self.connection.execute('DELETE FROM batch WHERE id = ?', (batch,))
            self.connection.executemany(
                'DELETE FROM comment WHERE classifier_key = ? AND item_id = ?',
                ((classifier_key, item_id) for item_id in cleared),
            )
            for item_id, parent, root, review in records:
                key = (item_id, classifier_key)
                self.connection.execute('DELETE FROM assessment WHERE item_id = ? AND classifier_key = ?', key)
                self.connection.execute('DELETE FROM preference WHERE item_id = ? AND classifier_key = ?', key)
                self.connection.execute(
                    """UPDATE comment SET failed_groups = ?, parent = ?, root = ?, task = ?, claim = ?
                       WHERE item_id = ? AND classifier_key = ?""",
                    (
                        int(review is None), parent, root,
                        review.task if review else None, (review.claim or None) if review else None, *key,
                    ),
                )
                if review is None:
                    continue
                self.connection.executemany(
                    'INSERT INTO assessment VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
                    [
                        (*key, label.target.kind, label.target.label, label.sentiment,
                         json.dumps(label.aspects), label.confidence, json.dumps(label.themes))
                        for label in review.assessments
                    ],
                )
                self.connection.executemany(
                    'INSERT OR IGNORE INTO preference VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        (*key, winner.kind, winner.label, loser.kind, loser.label)
                        for winner, loser in review.prefers
                    ],
                )
            self.connection.execute(
                'UPDATE run SET retry_failures = retry_failures + ?, updated = ?',
                (sum(review is None for *_ids, review in records), int(time.time())),
            )

    def next_partition(self):
        row = self.connection.execute(
            "SELECT * FROM partition WHERE state != 'complete' ORDER BY sequence LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        return self.read_partition(row), row['position']

    @staticmethod
    def read_partition(row):
        return Partition(
            row['id'], row['source'], row['expected_items'], row['first_item'], row['last_item'],
            row['row_offset'], row['archive_rows'],
        )

    def set_run(self, state, reason=None, partition=None):
        with self.connection:
            self.connection.execute(
                'UPDATE run SET state = ?, updated = ?, reason = ?', (state, int(time.time()), reason)
            )
            if partition is not None:
                self.connection.execute(
                    "UPDATE partition SET state = ? WHERE id = ? AND state != 'complete'",
                    (state, partition.id),
                )
                if state == 'blocked':
                    self.connection.execute('UPDATE partition SET failures = failures + 1 WHERE id = ?', (partition.id,))

    def queue(self, classifier_key, found):
        self.connection.executemany(
            """INSERT INTO comment (item_id, classifier_key, digest, created, priority, parent)
               VALUES (?, ?, '', ?, 0, ?)
               ON CONFLICT(item_id, classifier_key) DO UPDATE SET
                   created = excluded.created, parent = excluded.parent, mention = 1""",
            [(item_id, classifier_key, created, parent) for item_id, created, parent in found.comments],
        )
        self.connection.executemany(
            """INSERT INTO story (item_id, created, title, targets, certain) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(item_id) DO UPDATE SET
                   created = excluded.created, title = excluded.title,
                   targets = excluded.targets, certain = excluded.certain
               WHERE story.state = 'pending'""",
            [
                (item_id, created, title, json.dumps([[t.kind, t.label] for t in targets]), int(certain))
                for item_id, created, title, targets, certain in found.stories
            ],
        )
        self.connection.executemany(
            'UPDATE comment SET failed_groups = NULL WHERE item_id = ? AND classifier_key = ? AND failed_groups = 0',
            [(item_id, classifier_key) for item_id in found.renamed],
        )

    def checkpoint(self, partition, position, counters, classifier_key, found=None, archive_ids=()):
        updated_position = position + counters.position
        if updated_position > partition.expected_items:
            raise PipelineError('partition-size-mismatch')
        state = 'complete' if updated_position == partition.expected_items else 'running'
        with self.connection:
            self.queue(classifier_key, found or Found())
            self.mark_archive_ids(archive_ids)
            self.connection.execute(
                """UPDATE partition SET
                   position = position + ?, comments = comments + ?, eligible = eligible + ?,
                   candidates = candidates + ?, unavailable = unavailable + ?, invalid = invalid + ?,
                   failures = failures + ?,
                   first_comment = COALESCE(MIN(first_comment, ?), first_comment, ?),
                   last_comment = COALESCE(MAX(last_comment, ?), last_comment, ?),
                   state = ? WHERE id = ?""",
                (
                    counters.position, counters.comments, counters.eligible, counters.candidates,
                    counters.unavailable, counters.invalid, counters.failures,
                    counters.first_comment, counters.first_comment,
                    counters.last_comment, counters.last_comment, state, partition.id,
                ),
            )
            self.connection.execute('UPDATE run SET updated = ?', (int(time.time()),))
        return updated_position

    def status(self):
        job = self.job()
        if job is None:
            raise PipelineError('no-checkpoint')
        window = self.scan_window(job)
        partitions = list(self.connection.execute('SELECT * FROM partition ORDER BY sequence'))
        totals = {name: sum(p[key] for p in partitions) for name, key in COUNTERS.items()}
        totals['failures'] += job['retry_failures']
        classified, failed, untracked = self.connection.execute(
            'SELECT COUNT(CASE WHEN failed_groups = 0 THEN 1 END), '
            'COUNT(CASE WHEN failed_groups > 0 THEN 1 END), '
            'COUNT(CASE WHEN failed_groups IS NULL THEN 1 END) FROM comment'
        ).fetchone()
        totals['classified'] = classified
        totals['classificationFailures'] = failed
        totals['classificationUntracked'] = untracked
        totals['candidates'] = max(totals['candidates'], classified + failed + untracked)
        totals['commentsQueued'] = untracked
        totals['commentsAboutTargets'] = self.connection.execute(
            """SELECT COUNT(*) FROM comment c WHERE EXISTS (
                   SELECT 1 FROM assessment a WHERE a.item_id = c.item_id
                   AND a.classifier_key = c.classifier_key AND a.failed = 0)"""
        ).fetchone()[0]
        stories = dict(self.connection.execute('SELECT state, COUNT(*) FROM story GROUP BY state'))
        totals['stories'] = sum(stories.get(state, 0) for state in ('pending', 'expanded'))
        totals['storiesPending'] = stories.get('pending', 0)
        totals['threadComments'] = self.connection.execute(
            "SELECT COALESCE(SUM(comments), 0) FROM story WHERE state = 'expanded'"
        ).fetchone()[0]
        totals['partitionsComplete'] = sum(p['state'] == 'complete' for p in partitions)
        totals['partitionsTotal'] = len(partitions)
        archive = [p for p in partitions if p['source'] == 'archive']
        tail = [p for p in partitions if p['source'] != 'archive' and p['id'] != RECONCILE_ID]
        gaps = next((p for p in partitions if p['id'] == RECONCILE_ID), None)
        totals['archivePartitionsComplete'] = sum(p['state'] == 'complete' for p in archive)
        totals['archivePartitionsTotal'] = len(archive)
        totals['firebasePartitionsComplete'] = sum(p['state'] == 'complete' for p in tail)
        totals['firebasePartitionsTotal'] = len(tail)
        totals['expectedItems'] = sum(p['expected_items'] for p in partitions)
        first = min((p['first_comment'] for p in partitions if p['first_comment'] is not None), default=None)
        last = max((p['last_comment'] for p in partitions if p['last_comment'] is not None), default=None)
        return {
            'schemaVersion': 1,
            'state': job['state'],
            'reason': job['reason'],
            'updatedAt': iso_time(job['updated']),
            'classifier': job['classifier'],
            'source': job['source'],
            'archiveRevision': job['archive_revision'],
            'firstItem': job['first_item'],
            'lastItem': job['last_item'],
            'startAt': iso_time(window.start) if window else None,
            'endAt': iso_time(window.end) if window else None,
            'totals': totals,
            'firstCommentAt': iso_time(first),
            'lastCommentAt': iso_time(last),
            'archiveIdsReconciled': (
                gaps is not None and gaps['state'] == 'complete' and gaps['invalid'] == 0
            ),
            'allPublicItemsScanned': (
                bool(job['full_range']) and job['state'] == 'complete'
                and totals['invalid'] == 0
            ),
            'partitions': [
                {
                    'id': part['id'],
                    'source': part['source'],
                    'state': part['state'],
                    'itemsScanned': part['position'],
                    'expectedItems': part['expected_items'],
                    'firstCommentAt': iso_time(part['first_comment']),
                    'lastCommentAt': iso_time(part['last_comment']),
                }
                for part in partitions
            ],
        }

    def results(self, status, rows=None):
        models, families = {}, {}
        if rows is None:
            rows = self.connection.execute(
                """SELECT a.*, c.created FROM assessment a JOIN comment c USING(item_id, classifier_key)
                   WHERE a.failed = 0 ORDER BY a.item_id DESC"""
            )
        for row in rows:
            is_model = row['kind'] == 'model'
            aggregate = models if is_model else families
            if row['target'] not in aggregate:
                aggregate[row['target']] = {
                    'modelId' if is_model else 'familyName': row['target'],
                    'counts': dict.fromkeys(SENTIMENTS, 0),
                    'aspects': dict.fromkeys(ASPECTS, 0),
                    'evidence': [],
                }
            target = aggregate[row['target']]
            target['counts'][row['sentiment']] += 1
            aspects = json.loads(row['aspects'])
            for aspect in aspects:
                target['aspects'][aspect] += 1
            if len(target['evidence']) < EVIDENCE_LIMIT:
                target['evidence'].append({
                    'itemId': row['item_id'],
                    'createdAt': iso_time(row['created']),
                    'sentiment': row['sentiment'],
                    'aspects': aspects,
                    'confidence': row['confidence'],
                })
        return {
            'schemaVersion': 1,
            'updatedAt': status['updatedAt'],
            'classifier': status['classifier'],
            'startAt': status['startAt'],
            'endAt': status['endAt'],
            'models': [models[key] for key in sorted(models)],
            'families': [families[key] for key in sorted(families)],
        }

    def export(self):
        status = self.status()
        atomic_write(self.directory / 'results.json', self.results(status))
        atomic_write(self.directory / 'status.json', status)
        return status
