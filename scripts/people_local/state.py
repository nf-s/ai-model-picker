"""The files in a people state directory (.local/people/ by default) and the review checkpoint.

  people.json, sources.json      who is collected and how (written by hand; see config.py)
  items.jsonl                    collected items: text, title, link, date, byline and links of each
  exclusions.jsonl               found items that were not kept, with the reason
  collection-summary.json        counts from the last collection
  fetch-log.jsonl                every request of a collection: address, status, size and time
  review.sqlite3                 passages (offsets and the redacted text sent), batches, replies, token counts
  use-records.jsonl, method-advice.jsonl, unresolved.jsonl, review-status.json
                                 the review's results, exported from the checkpoint
  review-plan.json, verification-report.json
                                 kept from the review of 23 November 2026
  pipeline.lock                  held by the command that writes to the directory
"""

import json
import os
import sqlite3
from collections import Counter
from hashlib import sha256
from pathlib import Path

from hn_local.sources import PipelineError

from .review import METHODOLOGY, MODEL, PROMPT_SHA256, prompt_hash

ITEMS = 'items.jsonl'
EXCLUSIONS = 'exclusions.jsonl'
SUMMARY = 'collection-summary.json'
FETCH_LOG = 'fetch-log.jsonl'
DATABASE = 'review.sqlite3'
USE_RECORDS = 'use-records.jsonl'
METHOD_ADVICE = 'method-advice.jsonl'
UNRESOLVED = 'unresolved.jsonl'
REVIEW_STATUS = 'review-status.json'
# US$ per million tokens at batch rates.
RATES = {'input_tokens': 0.05, 'output_tokens': 0.25, 'cache_creation_input_tokens': 0.0625, 'cache_read_input_tokens': 0.005}
# Measured on 23 November 2026: US$1.754465 for 18,345 passages, retries included.
USD_PER_PASSAGE = 1.754465 / 18_345
SCHEMA = """
    CREATE TABLE IF NOT EXISTS configuration (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS batches (local_id INTEGER PRIMARY KEY, remote_id TEXT UNIQUE, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
        payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        batch INTEGER REFERENCES batches(local_id), state TEXT NOT NULL DEFAULT 'queued',
        result TEXT, issue TEXT, usage TEXT);
    CREATE TABLE IF NOT EXISTS usage (batch INTEGER, job TEXT, value TEXT NOT NULL, PRIMARY KEY(batch, job));
    CREATE TABLE IF NOT EXISTS prepared (source_id TEXT PRIMARY KEY, passages INTEGER NOT NULL);
"""


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.part')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    temporary.replace(path)


def write_lines(path, rows):
    temporary = path.with_suffix(path.suffix + '.part')
    with temporary.open('w', encoding='utf-8') as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + '\n')
    temporary.replace(path)


def append_line(path, row):
    """Append one JSON line in a single write, so an interrupted collection leaves whole lines."""
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(descriptor, (json.dumps(row, ensure_ascii=False) + '\n').encode())
    finally:
        os.close(descriptor)


def read_lines(path):
    if not path.is_file():
        return []
    with path.open(encoding='utf-8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def file_sha256(path):
    digest = sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def items(directory):
    """Collected items by id. An item without text or a public link, or a repeated id, stops the command."""
    found = {}
    for row in read_lines(Path(directory) / ITEMS):
        if row['id'] in found or not row['body'] or not row['url'].startswith('https://'):
            raise PipelineError('invalid-collected-item')
        found[row['id']] = row
    return found


def review_key():
    return json.dumps([METHODOLOGY, MODEL, prompt_hash()])


class Checkpoint:
    """The review checkpoint. Opened read-only for status, so status never changes a file."""

    def __init__(self, directory, readonly=False):
        self.directory = Path(directory)
        path = self.directory / DATABASE
        self.readonly = readonly
        if readonly and not path.is_file():
            self.db = None
            return
        self.db = sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro' if readonly else path, uri=readonly, timeout=25)
        self.db.row_factory = sqlite3.Row
        if not readonly:
            self.db.executescript(SCHEMA)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.db is not None:
            self.db.close()

    def key(self):
        row = self.db.execute("SELECT value FROM configuration WHERE name='review_key'").fetchone()
        return json.loads(row['value']) if row else None

    def check_key(self):
        """Refuse a checkpoint made with other instructions, schema, model or methodology. The review of
        23 November 2026 also stored its corpus hash in the key; that part does not bind later runs."""
        if prompt_hash() != PROMPT_SHA256:
            raise PipelineError('review-instructions-changed')
        key = self.key()
        if key is None:
            if not self.readonly:
                with self.db:
                    self.db.execute("INSERT INTO configuration VALUES ('review_key', ?)", (review_key(),))
            return
        if key[:2] != [METHODOLOGY, MODEL] or key[-1] != PROMPT_SHA256:
            raise PipelineError('review-checkpoint-methodology-mismatch')

    def has_table(self, name):
        return self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

    def prepared_ids(self):
        """Ids of the collected items already split into passages (including items with none).

        A checkpoint from 23 November 2026 has no `prepared` table: its key holds the hash of the
        collection it prepared, and every item of that collection counts as prepared when the hash
        still matches the first lines of items.jsonl.
        """
        if self.db is None:
            return set()
        if self.has_table('prepared') and self.db.execute('SELECT 1 FROM prepared LIMIT 1').fetchone():
            return {row['source_id'] for row in self.db.execute('SELECT source_id FROM prepared')}
        key = self.key()
        if key is None or len(key) != 5:
            return {row['source_id'] for row in self.db.execute('SELECT DISTINCT source_id FROM jobs')}
        return self.original_items(key[3])

    def original_items(self, digest):
        """Ids in the leading lines of items.jsonl whose bytes hash to `digest`; empty when none do."""
        hasher = sha256()
        ids = []
        path = self.directory / ITEMS
        if not path.is_file():
            return set()
        with path.open('rb') as stream:
            for line in stream:
                hasher.update(line)
                ids.append(json.loads(line)['id'])
                if hasher.copy().hexdigest() == digest:
                    return set(ids)
        return set()

    def mark_prepared(self):
        """Record every item prepared so far, once, before new items are added."""
        if not self.db.execute('SELECT 1 FROM prepared LIMIT 1').fetchone():
            done = self.prepared_ids()
            with self.db:
                self.db.executemany('INSERT OR IGNORE INTO prepared VALUES (?, 0)', ((source_id,) for source_id in done))
                self.db.execute(
                    'UPDATE prepared SET passages = (SELECT count(*) FROM jobs WHERE jobs.source_id = prepared.source_id)')

    def add(self, source_id, rows):
        with self.db:
            self.db.executemany('INSERT INTO jobs (id, source_id, start, end, payload) VALUES (?, ?, ?, ?, ?)', rows)
            self.db.execute('INSERT INTO prepared VALUES (?, ?)', (source_id, len(rows)))

    def states(self):
        if self.db is None:
            return {}
        return dict(self.db.execute('SELECT state, count(*) FROM jobs GROUP BY state').fetchall())

    def queue(self):
        if self.db is None:
            return 0, 0
        row = self.db.execute("SELECT count(*), coalesce(sum(length(payload)), 0) FROM jobs WHERE state='queued'").fetchone()
        return row[0], row[1]

    def usage(self):
        totals = Counter()
        if self.db is not None:
            for row in self.db.execute('SELECT value FROM usage'):
                totals.update(json.loads(row['value']))
        return dict(totals), round(sum(totals[name] * rate for name, rate in RATES.items()) / 1e6, 6)

    def batches(self):
        if self.db is None:
            return {}
        return dict(self.db.execute('SELECT state, count(*) FROM batches GROUP BY state').fetchall())


def export(directory, checkpoint, collected, config):
    """Write the use records, method advice, unresolved passages and review status from the checkpoint."""
    directory = Path(directory)
    uses, advice, seen = [], [], set()
    for row in checkpoint.db.execute("SELECT * FROM jobs WHERE state='valid' ORDER BY source_id, start"):
        verdict = json.loads(row['result'])
        source = collected[row['source_id']]
        person = config.by_key(source['person'])
        if person is None:
            raise PipelineError('collected-item-from-unknown-person')
        common = {
            'source_id': source['id'], 'person': source['person'], 'practitioner': person.name,
            'source_class': person.source_class, 'source_url': source['url'], 'source_date': source['date'],
            'source_channel': source['channel'], 'source_title': source['title'], 'passage': [row['start'], row['end']],
        }
        for use in verdict['use_records']:
            key = (source['id'], ' '.join(use['quote'].split()).casefold(), use['model_named'].casefold())
            if key not in seen:
                seen.add(key)
                uses.append(use | common)
        for item in verdict['method_advice']:
            key = (source['id'], ' '.join(item['quote'].split()).casefold(), 'advice')
            if key not in seen:
                seen.add(key)
                advice.append(item | common)
    unresolved = [dict(row) for row in checkpoint.db.execute(
        "SELECT source_id, start, end, attempts, issue FROM jobs WHERE state='unresolved' ORDER BY source_id")]
    write_lines(directory / USE_RECORDS, uses)
    write_lines(directory / METHOD_ADVICE, advice)
    write_lines(directory / UNRESOLVED, unresolved)
    usage, cost = checkpoint.usage()
    repaired = [row['issue'] for row in checkpoint.db.execute("SELECT issue FROM jobs WHERE state='valid' AND issue LIKE 'repaired:%'")]
    status = {
        'model': MODEL, 'methodology': METHODOLOGY, 'passage_states': checkpoint.states(),
        'use_records': len(uses), 'method_advice': len(advice), 'usage_tokens': usage, 'usd_from_usage': cost,
        'issues': dict(Counter(row['issue'] for row in unresolved)),
        'repaired_replies': len(repaired), 'repairs': sum(int(issue.split(':')[1]) for issue in repaired),
    }
    write_json(directory / REVIEW_STATUS, status)
    return status
