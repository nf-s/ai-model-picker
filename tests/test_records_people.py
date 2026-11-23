"""Check the named records the build makes from a people review: stable ids, the secondary,
advice-only, line and version rules, jobs by review, a public-safe core.json and a read-only
.local/people. Every person here is invented."""

import builtins
import contextlib
import copy
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'tests'))

from records_schema import check_record
from test_records import GUIDE, IMPORTED, JOBS, SNAPSHOT, USAGE, build, hn_export

BuildError = build['BuildError']
build_core = build['build_core']
build_named = build['build_named']
main = build['main']

PEOPLE = json.loads((ROOT / 'tests/fixtures/people/people.json').read_text(encoding='utf-8'))
ADA, BASIL, CORA = 'a' * 24, 'b' * 24, 'c' * 24
SOURCES = {
    ADA: ('ada', 'Ada Example', 'first-hand'),
    BASIL: ('basil', 'Basil Sample', 'secondary'),
    CORA: ('cora', 'Cora Placeholder', 'first-hand'),
}


def common(source):
    key, name, source_class = SOURCES[source]
    return {
        'source_id': source, 'person': key, 'practitioner': name, 'source_class': source_class,
        'source_url': f'https://{key}.example.com/posts/1', 'source_date': '2026-11-09',
        'source_channel': 'site', 'source_title': 'A post', 'passage': [0, 500],
    }


def use(source, **changes):
    return {
        'model_named': 'Claude Opus 5.5', 'exact': True, 'model_id': 'claude-opus-5-5', 'model_line': '',
        'tool': 'Claude Code', 'effort': 'medium', 'setting': '', 'job': 'interface', 'task': 'Port a renderer',
        'outcome': 'worked', 'compared_named': '', 'compared_id': '', 'comparison': '', 'basis': 'first-hand use',
        'sample_size': '', 'scale': 'one session', 'cost_time': '', 'quote': 'A quote from the source itself.',
        'summary': 'The writer ported a renderer.',
    } | changes | common(source)


def advice(source, **changes):
    return {'advice': 'Write down what done looks like.', 'applies_to': 'delegation', 'tool': '',
            'quote': 'Write down what done looks like first.'} | changes | common(source)


def review(uses, advices, unresolved=0):
    return {
        'people': copy.deepcopy(PEOPLE),
        'use': uses,
        'advice': advices,
        'unresolved': [{'source_id': ADA, 'start': 0, 'end': 10, 'attempts': 2, 'issue': 'quote-not-verbatim'}] * unresolved,
        'status': {'model': 'claude-haiku-5-5', 'methodology': 'use-records-v2', 'use_records': len(uses),
                   'method_advice': len(advices), 'passage_states': {'valid': 9, 'unresolved': unresolved},
                   'issues': {'quote-not-verbatim': unresolved} if unresolved else {}},
    }


USES = [
    use(ADA),
    use(ADA, exact=False, model_id='', model_named='Claude', model_line='Claude', job='other', outcome='failed'),
    use(ADA, model_id='', model_named='GPT-9 Turbo', tool='', job='coding', outcome='worked after rework'),
    use(BASIL, basis='measured', sample_size='120 respondents', job='review', outcome='no outcome stated'),
    use(BASIL, basis='first-hand use'),
    use(CORA),
]
ADVICE = [advice(ADA), advice(CORA, applies_to='general'), advice(CORA)]


def named(data=None, jobs=None):
    return build_named(SNAPSHOT, GUIDE, jobs or JOBS, IMPORTED, data or review(USES, ADVICE, 1))


def by_id(result):
    return {record['id']: record for record in result['use'] + result['advice']}


class TestNamed(unittest.TestCase):
    def test_ids_are_numbered_within_each_source(self):
        result = named()
        self.assertEqual(sorted(record['id'] for record in result['use']), [
            f'ur:{ADA}/1', f'ur:{ADA}/2', f'ur:{ADA}/3', f'ur:{BASIL}/1', f'ur:{BASIL}/2',
        ])
        self.assertEqual(sorted(record['id'] for record in result['advice']), [f'ma:{ADA}/1', f'ma:{CORA}/1', f'ma:{CORA}/2'])
        for record in result['use'] + result['advice']:
            check_record(record)

    def test_ids_are_stable_across_builds_and_other_sources_reviews(self):
        first = by_id(named())
        self.assertEqual(first, by_id(named()))
        again = [row for row in USES if row['source_id'] != BASIL] + [use(BASIL, summary='Reviewed again.')]
        second = by_id(named(review(again, ADVICE, 1)))
        for record_id, record in first.items():
            if BASIL not in record_id:
                self.assertEqual(second[record_id], record)
        self.assertEqual(second[f'ur:{BASIL}/1']['text'], 'Reviewed again.')
        self.assertNotIn(f'ur:{BASIL}/2', second)

    def test_advice_only_people_give_method_advice_only(self):
        result = named()
        self.assertFalse([record for record in result['use'] if record['person'] == 'Cora Placeholder'])
        self.assertEqual(sum(record['person'] == 'Cora Placeholder' for record in result['advice']), 2)
        cora = next(person for person in result['people'] if person['name'] == 'Cora Placeholder')
        self.assertEqual((cora['use'], cora['advice'], cora['useLeftOut'], cora['adviceOnly']), (0, 2, 1, True))
        people = copy.deepcopy(PEOPLE)
        next(person for person in people['people'] if person['name'] == 'Cora Placeholder')['adviceOnly'] = False
        data = review(USES, ADVICE, 1) | {'people': people}
        shown = by_id(named(data))
        self.assertEqual(shown[f'ur:{CORA}/1']['person'], 'Cora Placeholder')
        self.assertEqual({key: value for key, value in shown.items() if key.startswith('ur:') and CORA not in key},
                         {key: value for key, value in by_id(named()).items() if key.startswith('ur:')})

    def test_secondary_measurements_are_reported_figures(self):
        records = by_id(named())
        measured = records[f'ur:{BASIL}/1']
        self.assertEqual((measured['x']['basis'], measured['x']['b'], measured['x']['sec']), ('measured', 'second', True))
        self.assertEqual(records[f'ur:{BASIL}/2']['x']['b'], 'first')
        self.assertEqual(records[f'ur:{ADA}/1']['x']['sec'], False)
        self.assertTrue(records[f'ma:{ADA}/1']['x']['sec'] is False)

    def test_lines_stay_lines_and_versions_keep_their_own_key(self):
        records = by_id(named())
        self.assertEqual(records[f'ur:{ADA}/1']['keys'], [['model|claude-opus-5-5', 'positive'], ['tool|Claude Code', 'positive']])
        self.assertEqual(records[f'ur:{ADA}/2']['keys'], [['line|Claude', 'critical'], ['tool|Claude Code', 'critical']])
        self.assertEqual(records[f'ur:{ADA}/3']['keys'], [['version|GPT-9 Turbo', 'mixed']])

    def test_jobs_are_marked_as_assigned_by_review(self):
        records = by_id(named())
        first = records[f'ur:{ADA}/1']
        self.assertEqual((first['job'], first['how'], first['via']), ('interface', 'review', 'review:interface'))
        self.assertEqual((records[f'ur:{ADA}/2']['job'], records[f'ur:{ADA}/2']['how']), ('', ''))
        self.assertEqual(records[f'ma:{CORA}/1']['job'], '')
        self.assertEqual(records[f'ma:{ADA}/1']['how'], 'review')

    def test_old_job_ids_map_through_replaces(self):
        jobs = copy.deepcopy(JOBS)
        next(job for job in jobs['jobs'] if job['id'] == 'interface')['id'] = 'web-interface'
        for rule in jobs['keywords']['rules']:
            rule['job'] = 'web-interface' if rule['job'] == 'interface' else rule['job']
            rule['within'] = ['web-interface' if job == 'interface' else job for job in rule['within']]
        for entry in jobs['guide']['tasks']:
            entry['job'] = 'web-interface' if entry['job'] == 'interface' else entry['job']
        jobs['replaces'] = {'interface': {'job': 'web-interface'}}
        records = by_id(named(jobs=jobs))
        self.assertEqual((records[f'ur:{ADA}/1']['job'], records[f'ur:{ADA}/1']['via']), ('web-interface', 'review:interface'))

    def test_an_unmapped_review_label_stops_the_build(self):
        jobs = copy.deepcopy(JOBS)
        jobs['crosswalk']['review-job']['labels'] = [
            entry for entry in jobs['crosswalk']['review-job']['labels'] if entry['label'] != 'review']
        with self.assertRaises(BuildError) as raised:
            named(jobs=jobs)
        self.assertIn(f'review:review is not in the crosswalk: 1 records: ur:{BASIL}/1', str(raised.exception))

    def test_method_advice_counts_toward_no_model_or_coverage(self):
        result = named()
        self.assertTrue(all(record['keys'] == [] for record in result['advice']))
        self.assertEqual(sum(row['use'] for row in result['coverage']), len(result['use']))
        core_with, _ = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED, USAGE, True)
        core_without, _ = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED, USAGE, False)
        self.assertEqual(core_with['coverage'], core_without['coverage'])

    def test_broken_review_files_stop_the_build(self):
        cases = {
            'differ from review-status.json': review(USES, ADVICE, 1) | {'unresolved': []},
            'its person is not in people.json': review([use(ADA) | {'practitioner': 'Unlisted Person'}], []),
            'is not in the snapshot': review([use(ADA, model_id='gpt-9-turbo')], []),
            'has other fields': review([use(ADA) | {'notes': ''}], []),
            'unknown label': review([use(ADA, outcome='fine')], []),
            'source id is not 24 hex digits': review([use(ADA) | {'source_id': 'x'}], []),
        }
        for expected, data in cases.items():
            with self.subTest(expected), self.assertRaises(BuildError) as raised:
                named(data)
            self.assertIn(expected, str(raised.exception))


def tree(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob('*')) if path.is_file()
    }


def write_lines(path, rows):
    path.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')


class TestMain(unittest.TestCase):
    """The command: what it reads and writes, with an HN export in dist/ and a fixture people folder."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        hn = hn_export()
        (self.root / 'dist').mkdir()
        (self.root / 'dist/hn-snapshot.json').write_text(json.dumps(
            {'publishedAt': hn['publishedAt'], 'commentParts': 1, 'status': hn['status']}), encoding='utf-8')
        (self.root / 'dist/hn-comments-1.json').write_text(json.dumps(
            {'publishedAt': hn['publishedAt'], 'comments': hn['comments'], 'stories': hn['stories']}), encoding='utf-8')
        self.people = self.root / '.local/people'
        self.people.mkdir(parents=True)
        data = review(USES, ADVICE, 1)
        shutil.copy(ROOT / 'tests/fixtures/people/people.json', self.people / 'people.json')
        write_lines(self.people / 'use-records.jsonl', data['use'])
        write_lines(self.people / 'method-advice.jsonl', data['advice'])
        write_lines(self.people / 'unresolved.jsonl', data['unresolved'])
        (self.people / 'review-status.json').write_text(json.dumps(data['status']), encoding='utf-8')
        self.empty = self.root / 'no-people'
        self.empty.mkdir()

    def run_main(self, *arguments):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            main(['--hn-root', str(self.root), '--hn-source', 'export', *arguments])
        return output.getvalue()

    def outputs(self, name):
        return ['--out', str(self.root / name / 'core.json'), '--named-out', str(self.root / name / 'named-private.json'),
                '--search-out', str(self.root / name / 'search'), '--search-local', str(self.root / name / 'search.sqlite')]

    def test_core_names_nobody_and_differs_only_by_the_flag(self):
        printed = self.run_main(*self.outputs('with'))
        self.assertIn('Named records (private, behind sign-in): 5 use records (1 left out as advice-only), 3 method advice', printed)
        printed = self.run_main('--people-root', str(self.empty), *self.outputs('without'))
        self.assertIn('no named records; core.json says none exist', printed)
        self.assertFalse((self.root / 'without/named-private.json').exists())
        core_with = json.loads((self.root / 'with/core.json').read_text(encoding='utf-8'))
        core_without = json.loads((self.root / 'without/core.json').read_text(encoding='utf-8'))
        self.assertEqual((core_with.pop('namedBehindSignIn'), core_without.pop('namedBehindSignIn')), (True, False))
        self.assertEqual(core_with, core_without)
        text = (self.root / 'with/core.json').read_text(encoding='utf-8')
        for person in PEOPLE['people']:
            self.assertNotIn(person['name'], text)
        for private in ('ur:', 'ma:', 'A quote from the source itself', 'Write down what done looks like', '"named"', '"person":"A'):
            self.assertNotIn(private, text)
        self.assertNotIn('"person":"', text.replace('"person":""', ''))
        search = ''.join(path.read_text(encoding='utf-8') for path in sorted((self.root / 'with/search').rglob('*.json')))
        self.assertEqual(search, ''.join(
            path.read_text(encoding='utf-8') for path in sorted((self.root / 'without/search').rglob('*.json'))))
        for person in PEOPLE['people']:
            self.assertNotIn(person['name'], search)
        for private in ('ur:', 'ma:', 'A quote from the source itself', 'Write down what done looks like', '"quote"', '"person"'):
            self.assertNotIn(private, search)
        private = json.loads((self.root / 'with/named-private.json').read_text(encoding='utf-8'))
        self.assertEqual(len(private['use']), 5)
        self.assertEqual(private['use'][0]['quote'], 'A quote from the source itself.')

    def test_two_builds_are_identical(self):
        self.run_main(*self.outputs('first'))
        self.run_main(*self.outputs('second'))
        for name in ('core.json', 'named-private.json'):
            self.assertEqual((self.root / 'first' / name).read_bytes(), (self.root / 'second' / name).read_bytes())

    def test_the_people_folder_is_only_read(self):
        before = tree(self.people)
        opened = []
        open_file = builtins.open

        def spy_open(file, mode='r', *args, **kwargs):
            opened.append((Path(file).resolve(), mode))
            return open_file(file, mode, *args, **kwargs)

        with patch('builtins.open', spy_open):
            self.run_main(*self.outputs('build'))
        self.assertEqual(tree(self.people), before)
        self.assertFalse([path for path, mode in opened if self.people in path.parents and set(mode) & set('wax+')])
        for target in ('.local/people/core.json', '.local/people/named-private.json', '.local/named-private.json'):
            flag = '--out' if target.endswith('core.json') else '--named-out'
            with self.subTest(target=target), self.assertRaises(SystemExit) as raised:
                self.run_main(*self.outputs('build'), flag, str(self.root / target))
            self.assertIn('refusing to write under .local', str(raised.exception))
        self.assertEqual(tree(self.people), before)


if __name__ == '__main__':
    unittest.main()
