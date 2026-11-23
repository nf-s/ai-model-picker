"""Word search over the records: the public static index and the local index.

The records build calls write_public() and write_local(). src/lib/search.ts holds the same
tokeniser, shard mapping and document text; tests/fixtures/search-tokens.json checks that both
give the same tokens and shards, and tests/search.test.ts that both indexes rank the same.

The public index is a folder of static files that the published app copies into dist/search/:

- index.json: the manifest. Build time, record counts, the tables the other files point into
  (jobs, benchmarks, target keys), the number of files of each kind and the average document
  length.
- t/<shard>.json: for each token in the shard, the numbers of the documents that hold it,
  each written as the gap from the one before. A token's shard is the FNV-1a hash of its bytes
  modulo `shards`, so a browser fetches only the shards of the words searched.
- a/<n>.json: per document, in `factChunk` documents a file: its length in tokens, job, benchmark,
  date and target keys, which the filters and the ranking need before any record is read.
- r/<n>.json: the records themselves, `chunk` to a file, read only for the results shown.

Every file carries the build time as `release`, so a reader can refuse files from two builds.

Documents are numbered with Hacker News records first, oldest first, then measured records, so
a Hacker News update rewrites only the last record files and the measured ones.

It holds only public records: measured records and Hacker News labels with their claims. A
named record, a quote or a person stops the build. OpenRouter usage is not a record and is
never read here.

The local index (one SQLite file, never published) adds the people review's use records and
method advice with their quotes, for `npm run search`. Its output is private.

Usage, for tests: python3 scripts/search_index.py INPUT.json PUBLIC_DIR LOCAL_FILE, where INPUT
holds {"records": [...], "use": [...], "advice": [...], "models": [{id, name}], "jobs": [{id, label}]}.
"""

import datetime
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

VERSION = 1
SHARDS = 256
CHUNK = 32
FACT_CHUNK = 4096
STOP = frozenset(
    'a an and are as at be but by for from has have how i if in is it its of on or that the their this to was '
    'what when which who with would you your does do should than vs can good best better use using used model '
    'models there any some about into over my me we they them not no so get got will just then also more most '
    'much very'.split()
)
WORD = re.compile(r'[a-z]+|[0-9]+(?:\.[0-9]+)*')
TOKEN = re.compile(r'[a-z0-9.]+')
PUBLIC_CLASSES = ('crowd', 'measured')
# Public records leave out the two fields only named records fill.
PRIVATE_FIELDS = ('quote', 'person')
EPOCH = datetime.date(1970, 1, 1)


class SearchIndexError(ValueError):
    """A record cannot go into the index it was given to."""


def tokens(text):
    """The words of `text` as the index holds them: lower case, letters or numbers (with their
    dots, as in 5.5), stop words dropped, a final -ing or -s cut."""
    out = []
    for word in WORD.findall(text.lower()):
        if word in STOP:
            continue
        if len(word) > 5 and word.endswith('ing'):
            word = word[:-3]
        elif len(word) > 3 and word.endswith('s') and not word.endswith('ss'):
            word = word[:-1]
        out.append(word)
    return out


def shard_of(token, shards=SHARDS):
    """The shard of a token: 32-bit FNV-1a over its UTF-8 bytes, modulo `shards`."""
    value = 0x811C9DC5
    for byte in token.encode('utf-8'):
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value % shards


def key_name(key, names):
    kind, value = key.split('|', 1)
    return names.get(value, value) if kind == 'model' else value


def doc_text(record, names, job_labels):
    """The words a record is found by: its own text and the names of what it is about."""
    x = record['x'] or {}
    parts = [
        record['text'], record['quote'], record['cond'],
        ' '.join(key_name(key, names) for key, _ in record['keys']),
        record['person'], record['title'], record['kind'], record['tool'], record['effort'],
        job_labels.get(record['job'], record['job']) if record['job'] else '',
        *(x.get(field) for field in ('named', 'task', 'cmpNamed')),
    ]
    return ' '.join(part for part in parts if isinstance(part, str) and part)


def doc_tokens(record, names, job_labels):
    """Each word once, in order; the document's length is their number."""
    return list(dict.fromkeys(tokens(doc_text(record, names, job_labels))))


def day_number(date):
    return -1 if date == '' else (datetime.date.fromisoformat(date) - EPOCH).days


def benchmark_of(record):
    """The benchmark a measured record belongs to, or ''."""
    benchmark = (record['x'] or {}).get('b') if record['cls'] == 'measured' else None
    return benchmark if isinstance(benchmark, str) else ''


def public_order(records):
    """Hacker News records oldest first, then measured records in the build's order."""
    for record in records:
        if record['cls'] not in PUBLIC_CLASSES or any(record[field] for field in PRIVATE_FIELDS):
            raise SearchIndexError(f'{record["id"]}: only measured and Hacker News records go into the public index')
    crowd = sorted((r for r in records if r['cls'] == 'crowd'), key=lambda r: (r['date'], int(r['id'][3:])))
    return crowd + [r for r in records if r['cls'] == 'measured']


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def write_files(directory, files):
    """Write {relative path: value} into a new folder that then replaces `directory` whole."""
    directory = Path(directory)
    temporary = directory.with_name(directory.name + '.tmp')
    shutil.rmtree(temporary, ignore_errors=True)
    for name, value in files.items():
        path = temporary / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(dump(value), encoding='utf-8')
    shutil.rmtree(directory, ignore_errors=True)
    temporary.rename(directory)


def public_files(records, names, job_labels, built_at):
    """{relative path: JSON value} for the public index of `records`."""
    docs = public_order(records)
    crowd = sum(record['cls'] == 'crowd' for record in docs)
    lists = [doc_tokens(record, names, job_labels) for record in docs]
    jobs = sorted({record['job'] for record in docs} | {''})
    benchmarks = sorted({benchmark_of(record) for record in docs} - {''})
    keys = sorted({key for record in docs for key, _ in record['keys']})
    job_at, benchmark_at, key_at = ({value: n for n, value in enumerate(table)} for table in (jobs, benchmarks, keys))
    postings = {}
    for number, words in enumerate(lists):
        for word in words:
            postings.setdefault(word, []).append(number)
    shards = [{} for _ in range(SHARDS)]
    for word in sorted(postings):
        numbers = postings[word]
        shards[shard_of(word)][word] = [numbers[0]] + [b - a for a, b in zip(numbers, numbers[1:])]
    facts = []
    for record, words in zip(docs, lists):
        benchmark = benchmark_of(record)
        facts.append([
            len(words), job_at[record['job']], benchmark_at[benchmark] if benchmark else -1,
            day_number(record['date']), *(key_at[key] for key, _ in record['keys']),
        ])
    public = [{field: value for field, value in record.items() if field not in PRIVATE_FIELDS} for record in docs]
    record_files = range(0, len(docs), CHUNK)
    fact_files = range(0, len(docs), FACT_CHUNK)
    manifest = {
        'version': VERSION,
        'builtAt': built_at,
        'records': len(docs),
        'bands': {'crowd': [0, crowd], 'measured': [crowd, len(docs)]},
        'avgLength': sum(map(len, lists)) / len(lists) if lists else 0,
        'shards': SHARDS,
        'chunk': CHUNK,
        'factChunk': FACT_CHUNK,
        'files': {'records': len(record_files), 'facts': len(fact_files)},
        'jobs': jobs,
        'benchmarks': benchmarks,
        'keys': keys,
    }
    files = {'index.json': manifest}
    head = {'v': VERSION, 'release': built_at}
    files.update({f't/{n}.json': {**head, 'terms': shard} for n, shard in enumerate(shards)})
    files.update({f'a/{n}.json': {**head, 'from': start, 'docs': facts[start:start + FACT_CHUNK]}
                  for n, start in enumerate(fact_files)})
    files.update({f'r/{n}.json': {**head, 'from': start, 'records': public[start:start + CHUNK]}
                  for n, start in enumerate(record_files)})
    return files


def write_public(directory, records, names, job_labels, built_at):
    files = public_files(records, names, job_labels, built_at)
    write_files(directory, files)
    return files['index.json']


def write_local(path, records, use, advice, names, job_labels, built_at):
    """The local index: every public record (numbered as in the public index), then use records and
    method advice with their quotes. Returns the number of documents per corpus."""
    corpora = {'public': public_order(records), 'use': use, 'advice': advice}
    for corpus, expected in (('use', 'use'), ('advice', 'advice')):
        for record in corpora[corpus]:
            if record['src'] != expected:
                raise SearchIndexError(f'{record["id"]}: not a {expected} record')
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(
            'CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);'
            'CREATE TABLE docs(n INTEGER PRIMARY KEY, corpus TEXT NOT NULL, pos INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,'
            ' length INTEGER NOT NULL, tokens TEXT NOT NULL, record TEXT NOT NULL);'
            "CREATE VIRTUAL TABLE terms USING fts5(tokens, content='', detail=none, tokenize=\"unicode61 tokenchars '.'\");"
        )
        stats = {}
        number = 0
        for corpus, docs in corpora.items():
            lengths = []
            for position, record in enumerate(docs):
                words = doc_tokens(record, names, job_labels)
                if not all(TOKEN.fullmatch(word) for word in words):
                    raise SearchIndexError(f'{record["id"]}: a token has a character the index does not keep')
                text = ' '.join(words)
                connection.execute('INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?)',
                                   (number, corpus, position, record['id'], len(words), text, dump(record)))
                connection.execute('INSERT INTO terms(rowid, tokens) VALUES (?, ?)', (number, text))
                lengths.append(len(words))
                number += 1
            stats[corpus] = {'records': len(docs), 'avgLength': sum(lengths) / len(lengths) if lengths else 0}
        connection.executemany('INSERT INTO meta VALUES (?, ?)', [
            ('version', dump(VERSION)), ('builtAt', dump(built_at)), ('corpora', dump(stats)),
        ])
        connection.commit()
    finally:
        connection.close()
    os.replace(temporary, path)
    return {corpus: value['records'] for corpus, value in stats.items()}


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('Usage: python3 scripts/search_index.py INPUT.json PUBLIC_DIR LOCAL_FILE')
    data = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    model_names = {model['id']: model['name'] for model in data['models']}
    labels = {job['id']: job['label'] for job in data['jobs']}
    write_public(sys.argv[2], data['records'], model_names, labels, data.get('builtAt', ''))
    write_local(sys.argv[3], data['records'], data['use'], data['advice'], model_names, labels, data.get('builtAt', ''))
