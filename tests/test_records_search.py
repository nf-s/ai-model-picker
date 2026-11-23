"""Check the search index: the tokeniser agrees with src/lib/search.ts, the public index holds only
public records, in numbered files, and the local index adds use records and method advice with their
quotes. Every person here is invented. tests/search.test.ts ranks the indexes this builds."""

import contextlib
import io
import json
import re
import runpy
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'tests'))

from search_index import (
    SearchIndexError, doc_tokens, public_files, shard_of, tokens, write_local, write_public,
)
from test_records import GUIDE, IMPORTED, JOBS, SNAPSHOT, build, hn_export
from test_records_people import ADVICE, PEOPLE, USES, named, review, write_lines

build_core = build['build_core']
main = build['main']
NAMES = {model['id']: model['name'] for model in SNAPSHOT['models']}
LABELS = {job['id']: job['label'] for job in JOBS['jobs']}
FILE = re.compile(r'(index|[tar]/[0-9]+)\.json')


def write_fixture_build(directory):
    """Run the records build on the test fixtures (Hacker News export, people review) into
    `directory`/build: core.json, named-private.json, search/ and search.sqlite."""
    root = Path(directory)
    hn = hn_export()
    (root / 'dist').mkdir(parents=True)
    (root / 'dist/hn-snapshot.json').write_text(json.dumps(
        {'publishedAt': hn['publishedAt'], 'commentParts': 1, 'status': hn['status']}), encoding='utf-8')
    (root / 'dist/hn-comments-1.json').write_text(json.dumps(
        {'publishedAt': hn['publishedAt'], 'comments': hn['comments'], 'stories': hn['stories']}), encoding='utf-8')
    people = root / '.local/people'
    people.mkdir(parents=True)
    data = review(USES, ADVICE, 1)
    shutil.copy(ROOT / 'tests/fixtures/people/people.json', people / 'people.json')
    write_lines(people / 'use-records.jsonl', data['use'])
    write_lines(people / 'method-advice.jsonl', data['advice'])
    write_lines(people / 'unresolved.jsonl', data['unresolved'])
    (people / 'review-status.json').write_text(json.dumps(data['status']), encoding='utf-8')
    out = root / 'build'
    with contextlib.redirect_stdout(io.StringIO()) as printed:
        main(['--hn-root', str(root), '--hn-source', 'export', '--out', str(out / 'core.json'),
              '--named-out', str(out / 'named-private.json'), '--search-out', str(out / 'search'),
              '--search-local', str(out / 'search.sqlite')])
    return printed.getvalue()


class TestTokens(unittest.TestCase):
    def test_tokens_and_shards_match_the_shared_fixture(self):
        fixture = json.loads((ROOT / 'tests/fixtures/search-tokens.json').read_text(encoding='utf-8'))
        for case in fixture['cases']:
            with self.subTest(text=case['text']):
                self.assertEqual(tokens(case['text']), case['tokens'])
                self.assertEqual([shard_of(word, fixture['shards']) for word in case['tokens']], case['shards'])

    def test_a_document_holds_each_word_once(self):
        record = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)[1][0]
        words = doc_tokens(record, NAMES, LABELS)
        self.assertEqual(len(words), len(set(words)))


class TestPublic(unittest.TestCase):
    def setUp(self):
        self.records = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)[1]
        self.files = public_files(self.records, NAMES, LABELS, '2026-11-24')
        self.manifest = self.files['index.json']

    def documents(self):
        return [record for n in range(self.manifest['files']['records'])
                for record in self.files[f'r/{n}.json']['records']]

    def test_hacker_news_comes_first_oldest_first_then_measured(self):
        docs = self.documents()
        self.assertEqual(len(docs), len(self.records))
        self.assertEqual(self.manifest['bands'], {'crowd': [0, 3], 'measured': [3, len(self.records)]})
        self.assertEqual([record['id'] for record in docs[:3]], ['hn:103', 'hn:101', 'hn:102'])
        self.assertTrue(all(record['cls'] == 'measured' for record in docs[3:]))

    def test_postings_list_every_document_that_holds_a_word(self):
        docs = self.documents()
        held = [set(doc_tokens({**record, 'quote': '', 'person': ''}, NAMES, LABELS)) for record in docs]
        seen = 0
        for n in range(self.manifest['shards']):
            for word, gaps in self.files[f't/{n}.json']['terms'].items():
                self.assertEqual(shard_of(word), n)
                numbers, at = [], 0
                for i, gap in enumerate(gaps):
                    at = gap if i == 0 else at + gap
                    numbers.append(at)
                self.assertEqual(numbers, [i for i, words in enumerate(held) if word in words])
                seen += len(numbers)
        self.assertEqual(seen, sum(map(len, held)))

    def test_facts_give_length_job_benchmark_date_and_keys(self):
        docs = self.documents()
        facts = [row for n in range(self.manifest['files']['facts']) for row in self.files[f'a/{n}.json']['docs']]
        for record, row in zip(docs, facts):
            length, job, benchmark, day, *keys = row
            self.assertEqual(length, len(doc_tokens({**record, 'quote': '', 'person': ''}, NAMES, LABELS)))
            self.assertEqual(self.manifest['jobs'][job], record['job'])
            expected = (record['x'] or {}).get('b', '') if record['cls'] == 'measured' else ''
            self.assertEqual(self.manifest['benchmarks'][benchmark] if benchmark >= 0 else '', expected)
            self.assertEqual(day < 0, record['date'] == '')
            self.assertEqual([self.manifest['keys'][key] for key in keys], [key for key, _ in record['keys']])

    def test_files_are_named_by_number_and_hold_no_private_field(self):
        for name, value in self.files.items():
            self.assertRegex(name, FILE)
            text = json.dumps(value)
            for private in ('"quote"', '"person"', '"cls": "named"', 'ur:', 'ma:'):
                self.assertNotIn(private, text, name)

    def test_named_records_quotes_and_people_cannot_enter(self):
        result = named()
        for record in result['use'][:1] + result['advice'][:1]:
            with self.subTest(record=record['id']), self.assertRaises(SearchIndexError):
                public_files(self.records + [record], NAMES, LABELS, '')
        for change in ({'quote': 'Copied words.'}, {'person': 'Ada Example'}):
            with self.subTest(change=change), self.assertRaises(SearchIndexError):
                public_files([{**self.records[0], **change}] + self.records[1:], NAMES, LABELS, '')

    def test_write_replaces_the_folder_whole(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'search'
            (target / 't').mkdir(parents=True)
            (target / 't/9999.json').write_text('{}', encoding='utf-8')
            write_public(target, self.records, NAMES, LABELS, '2026-11-24')
            self.assertFalse((target / 't/9999.json').exists())
            self.assertEqual(len(list(target.rglob('*.json'))), len(self.files))


class TestLocal(unittest.TestCase):
    def test_local_index_adds_named_records_with_quotes(self):
        records = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)[1]
        result = named()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'search.sqlite'
            counts = write_local(path, records, result['use'], result['advice'], NAMES, LABELS, '2026-11-24')
            self.assertEqual(counts, {'public': len(records), 'use': 5, 'advice': 3})
            connection = sqlite3.connect(path)
            try:
                rows = connection.execute(
                    "SELECT d.corpus, d.pos, d.record FROM terms JOIN docs d ON d.n = terms.rowid WHERE terms MATCH ?",
                    ('"renderer"',)).fetchall()
                public = [json.loads(row[0]) for row in connection.execute(
                    "SELECT record FROM docs WHERE corpus = 'public' ORDER BY pos LIMIT 3")]
                corpora = json.loads(connection.execute("SELECT value FROM meta WHERE key = 'corpora'").fetchone()[0])
            finally:
                connection.close()
        self.assertEqual({row[0] for row in rows}, {'use'})
        self.assertEqual(json.loads(rows[0][2])['quote'], 'A quote from the source itself.')
        self.assertEqual([record['id'] for record in public], ['hn:103', 'hn:101', 'hn:102'])
        self.assertEqual(corpora['use']['records'], 5)

    def test_a_record_in_the_wrong_corpus_stops_the_index(self):
        result = named()
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(SearchIndexError):
            write_local(Path(directory) / 'search.sqlite', [], result['advice'], [], NAMES, LABELS, '')


class TestBuild(unittest.TestCase):
    def test_the_records_build_writes_both_indexes(self):
        with tempfile.TemporaryDirectory() as directory:
            printed = write_fixture_build(directory)
            out = Path(directory) / 'build'
            self.assertIn('public records in', printed)
            self.assertIn('5 use records, 3 method advice', printed)
            manifest = json.loads((out / 'search/index.json').read_text(encoding='utf-8'))
            text = ''.join(path.read_text(encoding='utf-8') for path in (out / 'search').rglob('*.json'))
            self.assertTrue((out / 'search.sqlite').is_file())
        self.assertEqual(manifest['bands']['crowd'], [0, 3])
        for person in PEOPLE['people']:
            self.assertNotIn(person['name'], text)


class TestExport(unittest.TestCase):
    def test_the_index_is_copied_whole_and_checked_against_core(self):
        export = runpy.run_path(str(ROOT / 'scripts/export-records-site.py'))['export_search']
        with tempfile.TemporaryDirectory() as directory:
            write_fixture_build(directory)
            out = Path(directory) / 'build'
            core = json.loads((out / 'core.json').read_text(encoding='utf-8'))
            manifest, files, size = export(out / 'search', Path(directory) / 'dist/search', core)
            self.assertEqual(files, len(list((out / 'search').rglob('*.json'))))
            self.assertEqual(manifest['records'], 3 + len(core['measured']))
            self.assertGreater(size, 0)
            with self.assertRaises(ValueError):
                export(out / 'search', Path(directory) / 'dist/search', core)
            fewer = {**core, 'measured': core['measured'][1:]}
            with self.assertRaises(ValueError):
                export(out / 'search', Path(directory) / 'other', fewer)
            chunk = out / 'search/r/0.json'
            data = json.loads(chunk.read_text(encoding='utf-8'))
            data['records'][0]['quote'] = 'Copied words.'
            chunk.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(ValueError):
                export(out / 'search', Path(directory) / 'tampered', core)
            self.assertFalse((Path(directory) / 'tampered').exists())


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'fixture-build':
        write_fixture_build(sys.argv[2])
    else:
        unittest.main()
