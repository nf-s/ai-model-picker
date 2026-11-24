"""Check the records build: the record validator, the job file checks, stable ids and read-only inputs."""

import builtins
import collections
import contextlib
import copy
import hashlib
import io
import json
import runpy
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from hn_local.sources import DateWindow, Partition, SourcePlan
from hn_local.state import State
from records_schema import RecordError, check_people, check_record

build = runpy.run_path(str(ROOT / 'scripts/build-records.py'))
BuildError = build['BuildError']
build_core = build['build_core']
main = build['main']
read_json = build['read_json']
slug = build['slug']

SNAPSHOT = json.loads((ROOT / 'src/lib/snapshot.json').read_text(encoding='utf-8'))
GUIDE = json.loads((ROOT / 'research/app-model-choices.json').read_text(encoding='utf-8'))
JOBS = json.loads((ROOT / 'research/jobs.json').read_text(encoding='utf-8'))
CLASSIFIER = json.loads((ROOT / 'research/hn-classifier-check.json').read_text(encoding='utf-8'))['classifierId']
IMPORTED = {kind: json.loads(path.read_text(encoding='utf-8')) for kind, path in build['IMPORTED'].items()}
IMPORTED_COUNT = sum(len(data['results']) for data in IMPORTED.values())
IMPORTED_LIST = {'lmarena': 'leaderboards', 'epoch': 'files'}
USAGE = json.loads(build['USAGE'].read_text(encoding='utf-8'))
MODEL = 'gpt-6-astra'
START = 1_780_000_000
END = START + 1000


def assessment(kind, target, sentiment, themes=()):
    return {'kind': kind, 'target': target, 'sentiment': sentiment, 'aspects': [], 'confidence': 'high',
            **({'themes': list(themes)} if themes else {})}


def hn_export():
    return {
        'from': 'export',
        'publishedAt': '2026-11-21T00:00:00+00:00',
        'status': {'classifier': CLASSIFIER, 'startAt': '2026-05-20T00:00:00Z', 'endAt': '2026-11-20T00:00:00Z'},
        'stories': [{'id': 900, 'title': 'Synthetic story'}],
        'comments': [
            {'id': 101, 'createdAt': '2026-10-01T10:00:00Z', 'task': 'code', 'story': 900,
             'claim': 'It found the root cause from the stack trace.',
             'assessments': [assessment('model', MODEL, 'positive')]},
            {'id': 102, 'createdAt': '2026-10-02T10:00:00Z', 'task': 'none', 'setting': 'local',
             'claim': 'Slow on my laptop.',
             'assessments': [assessment('family', 'GPT', 'negative', ['local-use'])],
             'prefers': [{'winner': {'kind': 'model', 'target': MODEL}, 'loser': {'kind': 'family', 'target': 'GPT'}}]},
            {'id': 103, 'createdAt': '2026-09-03T10:00:00Z', 'task': 'writing',
             'assessments': [assessment('model', MODEL, 'unclear'), assessment('family', 'GPT', 'mixed')]},
        ],
    }


def fixture_cases(name, nested=None):
    fixtures = json.loads((ROOT / 'tests/fixtures' / name).read_text(encoding='utf-8'))
    cases = [(f'valid {n}', value, True) for n, value in enumerate(fixtures['valid'])]
    for item in fixtures['invalid']:
        if item['base'] is None:
            cases.append((item['why'], item['value'], False))
            continue
        value = copy.deepcopy(fixtures['valid'][item['base']])
        target = value[nested][item['person']] if 'person' in item else value
        target.update(item.get('patch', {}))
        for field in item.get('omit', []):
            del target[field]
        cases.append((item['why'], value, False))
    return cases


def job(data, job_id):
    return next(entry for entry in data['jobs'] if entry['id'] == job_id)


def rule(**values):
    """A keyword rule for the job file, with `values` replacing its fields."""
    return {'job': 'debug', 'within': [None, 'code'], 'pattern': r'\bdebug', 'caseSensitive': False, **values}


def crosswalk_entry(data, source, label):
    return next(entry for entry in data['crosswalk'][source]['labels'] if entry['label'] == label)


class TestValidator(unittest.TestCase):
    def test_fixtures(self):
        for check, name, nested in ((check_record, 'records.json', None), (check_people, 'people.json', 'people')):
            for why, value, valid in fixture_cases(name, nested):
                with self.subTest(why=why):
                    if valid:
                        check(value)
                    else:
                        self.assertRaises(RecordError, check, value)

    def test_every_built_record_is_valid(self):
        _core, records = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)
        self.assertEqual(len(records), len(SNAPSHOT['results']) + len(SNAPSHOT['reports']) + IMPORTED_COUNT + 3)
        for record in records:
            check_record(record)


class TestJobFile(unittest.TestCase):
    def setUp(self):
        self.jobs = copy.deepcopy(JOBS)

    def build(self):
        core, records = build_core(SNAPSHOT, GUIDE, self.jobs, hn_export(), IMPORTED)
        return core, {record['id']: record for record in records}

    def refused(self, *expected):
        with self.assertRaises(BuildError) as raised:
            self.build()
        for text in expected:
            self.assertIn(text, str(raised.exception))
        return str(raised.exception)

    def test_tracked_job_file_is_the_approved_list_that_builds(self):
        core, records = self.build()
        self.assertEqual((core['jobs']['status'], core['jobs']['version']), ('approved', 2))
        self.assertEqual(len(core['jobs']['list']), 13)
        self.assertEqual(
            {entry['id'] for entry in core['jobs']['list'] if entry.get('parent') == 'code'},
            {'debug', 'review', 'plan', 'interface'})
        self.assertEqual(self.jobs['keywords']['rules'], [])
        counted = sum(sum(row['counts'].values()) for row in core['coverage']['rows'] + core['coverage']['pending'])
        self.assertEqual(counted, len(records))
        self.assertEqual((records['hn:101']['job'], records['hn:101']['how'], records['hn:101']['via']), ('code', 'label', 'task:code'))
        # The review's `none` gives no job; the comment's own setting field sets the setting.
        self.assertEqual((records['hn:102']['job'], records['hn:102']['how'], records['hn:102']['setting']), ('', '', 'local'))
        self.assertEqual((records['hn:103']['job'], records['hn:103']['stance']), ('writing', 'neutral'))
        self.assertEqual(core['crowd']['counts']['line|GPT']['writing']['2026-09'], [0, 0, 1, 0])
        self.assertEqual(core['preferences'], [{'winner': 'model|' + MODEL, 'loser': 'line|GPT', 'job': '', 'setting': 'local',
                                                'run': '', 'date': '2026-10-02', 'id': 'hn:102'}])
        self.assertEqual(core['crowd']['comments'], {'': [102], 'code': [101], 'writing': [103]})
        self.assertEqual(core['crowd']['cells']['local|']['comments'], {'': [102]})
        self.assertEqual(core['crowd']['cells']['local|']['counts']['line|GPT'][''], {'2026-10': [0, 1, 0, 0]})
        self.assertEqual(core['jobs']['categories']['design'], 'interface')
        self.assertEqual(core['jobs']['categories']['general'], '')
        self.assertEqual(core['jobs']['categories']['reasoning'], '')
        # A theme alone gives no job and sets neither setting nor run.
        hn = hn_export()
        del hn['comments'][1]['setting']
        hn['comments'][1]['assessments'][0]['themes'] = ['agentic-work', 'local-use']
        _core, themed = build_core(SNAPSHOT, GUIDE, self.jobs, hn, IMPORTED)
        themed = next(record for record in themed if record['id'] == 'hn:102')
        self.assertEqual((themed['job'], themed['how'], themed['setting'], themed['run']), ('', '', '', ''))

    def test_every_old_job_id_is_current_or_replaced(self):
        old = ('coding', 'bug-fix', 'refactor', 'review', 'tests', 'interface', 'agents', 'delegation', 'planning',
               'extraction', 'research', 'analysis', 'writing', 'reasoning', 'chat', 'images', 'local')
        current = {entry['id'] for entry in self.jobs['jobs']}
        for job_id in old:
            with self.subTest(job=job_id):
                self.assertTrue(job_id in current or job_id in self.jobs['replaces'])
        self.assertFalse(current & set(self.jobs['replaces']))
        self.assertEqual(
            {old_id: (entry['job'], entry.get('setting'), entry.get('run'), tuple(entry.get('into', [])))
             for old_id, entry in self.jobs['replaces'].items()},
            {
                'coding': ('code', None, None, ()), 'bug-fix': ('debug', None, None, ()),
                'refactor': ('code', None, None, ()), 'tests': ('code', None, None, ()),
                'planning': ('plan', None, None, ()), 'analysis': ('documents', None, None, ()),
                'reasoning': (None, None, None, ('maths', 'chat')),
                'images': (None, None, None, ('read-media', 'make-images')),
                'agents': (None, None, 'unattended', ()), 'delegation': (None, None, 'parallel', ()),
                'local': (None, 'local', None, ()),
            })

    def test_records_of_split_jobs_and_fields_need_reading(self):
        # The tracked hn-task table maps only current jobs, so this copy adds two old labels whose jobs
        # were split or became a field.
        self.jobs['crosswalk']['hn-task']['labels'] += [
            {'label': 'images', 'job': 'images', 'fit': 'none'},
            {'label': 'agents', 'job': 'agents', 'fit': 'none'},
        ]
        hn = hn_export()
        hn['comments'] += [
            {'id': 104, 'createdAt': '2026-10-05T10:00:00Z', 'task': 'images', 'claim': 'It read the scan.',
             'assessments': [assessment('model', MODEL, 'positive')]},
            {'id': 105, 'createdAt': '2026-10-06T10:00:00Z', 'task': 'agents', 'claim': 'It ran overnight.', 'setting': 'local',
             'assessments': [assessment('model', MODEL, 'mixed')]},
        ]
        core, records = build_core(SNAPSHOT, GUIDE, self.jobs, hn, IMPORTED)
        records = {record['id']: record for record in records}
        self.assertEqual((records['hn:104']['job'], records['hn:104']['how'], records['hn:104']['via']), ('', 'pending', 'task:images'))
        # The old job sets the run field; the comment's own field sets the setting.
        self.assertEqual((records['hn:105']['how'], records['hn:105']['run'], records['hn:105']['setting']), ('pending', 'unattended', 'local'))
        self.assertEqual(core['coverage']['pending'], [
            {'old': 'images', 'counts': {'benchmark': 0, 'arena': 0, 'report': 0, 'hn': 1}},
            {'old': 'agents', 'counts': {'benchmark': 0, 'arena': 0, 'report': 0, 'hn': 1}},
        ])
        none = next(row for row in core['coverage']['rows'] if row['job'] == '')
        self.assertEqual(none['counts']['hn'], 1)
        self.assertEqual(core['crowd']['pending'], {'images': [104], 'agents': [105]})
        self.assertEqual(core['crowd']['comments'][''], [102, 104, 105])
        self.assertEqual(core['crowd']['cells']['local|unattended']['comments'], {'': [105]})
        table = build['coverage_table'](core, None, {'images': 'Images and vision', 'agents': 'Long agent runs'})
        self.assertIn('Needs reading until the next review', table)
        self.assertIn('  from Images and vision', table)
        self.assertLess(table.index('Needs reading'), table.index('No job'))

    def test_surface_comes_from_the_tool_and_a_local_runner_sets_local(self):
        jobs = build['Jobs'](self.jobs, {b['id'] for b in SNAPSHOT['benchmarks']} | {
            entry['id'] for kind, field in IMPORTED_LIST.items() for entry in IMPORTED[kind][field]},
            {task['id'] for task in GUIDE['tasks']})
        cases = {
            'Claude Code': 'coding-agent', 'Codex CLI': 'coding-agent', 'GitHub Copilot': 'coding-agent',
            'Pi': 'coding-agent', 'ChatGPT app': 'chat-app', 'Claude.ai': 'chat-app', 'Ollama': 'local-runner',
            'llama.cpp server': 'local-runner', 'OpenRouter API': 'api', 'llm CLI': 'api', 'Pipeline tool': '',
            'Rapid prototyping': '', '': '',
        }
        for tool, surface in cases.items():
            with self.subTest(tool=tool):
                self.assertEqual(jobs.surface_of(tool), surface)
        records = build['Records'](jobs)
        record = records.make('chat', 'task:chat', None, id='hn:9', cls='crowd', src='hn',
                              tool='Ollama', url='https://news.ycombinator.com/item?id=9')
        self.assertEqual((record['surface'], record['setting'], record['run']), ('local-runner', 'local', ''))

    def jobs_of(self, data):
        return build['Jobs'](data, {b['id'] for b in SNAPSHOT['benchmarks']} | {
            entry['id'] for kind, field in IMPORTED_LIST.items() for entry in IMPORTED[kind][field]},
            {task['id'] for task in GUIDE['tasks']})

    def test_the_drawing_test_tag_matches_the_shared_cases(self):
        # The same invented texts are checked against the pattern in JavaScript (tests/records.test.ts).
        jobs = self.jobs_of(self.jobs)
        cases = json.loads((ROOT / 'tests/fixtures/drawing-test.json').read_text(encoding='utf-8'))
        for text in cases['tagged']:
            with self.subTest(text=text):
                self.assertEqual(jobs.tags_of(text), {'tags': ['drawing-test']})
        for text in cases['untagged']:
            with self.subTest(text=text):
                self.assertEqual(jobs.tags_of(text), {})

    def drawn(self, task, claim='Its pelican on a bicycle SVG was the best yet.', jobs=None):
        """core.json and comment 101 with `task` and a claim the drawing-test rule tags."""
        hn = hn_export()
        hn['comments'][0].update(task=task, claim=claim)
        hn['comments'][0]['prefers'] = [{'winner': {'kind': 'model', 'target': MODEL}, 'loser': {'kind': 'family', 'target': 'GPT'}}]
        core, records = build_core(SNAPSHOT, GUIDE, jobs or self.jobs, hn, IMPORTED)
        return core, next(record for record in records if record['id'] == 'hn:101')

    def test_a_drawing_test_labelled_make_images_has_no_job_and_keeps_its_label(self):
        core, record = self.drawn('make-images')
        self.assertEqual((record['job'], record['how'], record['via'], record['kind'], record['x']['tags']),
                         ('', 'tag', 'task:make-images', 'make-images', ['drawing-test']))
        self.assertEqual(core['crowd']['noJob'], {'drawing-test': [101]})
        self.assertEqual(core['crowd']['tags'], {'drawing-test': {'model|' + MODEL: {'2026-10': [101]}}})

    def test_a_drawing_test_with_another_job_has_no_job(self):
        core, record = self.drawn('interface')
        self.assertEqual((record['job'], record['how'], record['via']), ('', 'tag', 'task:interface'))
        self.assertEqual(core['crowd']['noJob'], {'drawing-test': [101]})

    def test_a_drawing_test_the_review_gave_no_job_keeps_none(self):
        core, record = self.drawn('none')
        self.assertEqual((record['job'], record['how'], record['via'], record['x']['tags']), ('', '', '', ['drawing-test']))
        self.assertEqual(core['crowd']['noJob'], {})
        self.assertEqual(core['coverage']['tagged'], [{'tag': 'drawing-test', 'counts': {'benchmark': 0, 'arena': 0, 'report': 0, 'hn': 0}}])

    def test_an_untagged_make_images_comment_keeps_its_job(self):
        core, record = self.drawn('make-images', claim='The image model kept the character the same across edits.')
        self.assertEqual((record['job'], record['how'], record['via']), ('make-images', 'label', 'task:make-images'))
        self.assertEqual(core['crowd']['noJob'], {})
        self.assertEqual(core['crowd']['comments']['make-images'], [101])

    def test_counts_per_job_leave_out_drawing_tests(self):
        core, _ = self.drawn('make-images')
        self.assertNotIn('make-images', core['crowd']['comments'])
        self.assertIn(101, core['crowd']['comments'][''])
        self.assertEqual(set(core['crowd']['counts']['model|' + MODEL]), {'', 'writing'})
        self.assertEqual([p['job'] for p in core['preferences'] if p['id'] == 'hn:101'], [''])
        rows = {row['job']: row['counts']['hn'] for row in core['coverage']['rows']}
        self.assertEqual((rows['make-images'], rows['']), (0, 1))
        self.assertEqual(core['coverage']['tagged'], [{'tag': 'drawing-test', 'counts': {'benchmark': 0, 'arena': 0, 'report': 0, 'hn': 1}}])
        self.assertIn('No job: Drawing test', build['coverage_table'](core, tag_labels={'drawing-test': 'Drawing test'}))

    def test_a_tag_rule_that_gives_a_job_leaves_it(self):
        data = copy.deepcopy(self.jobs)
        data['tags']['rules'][0]['noJob'] = False
        core, record = self.drawn('make-images', jobs=data)
        self.assertEqual((record['job'], record['how'], record['x']['tags']), ('make-images', 'label', ['drawing-test']))
        self.assertEqual((core['crowd']['noJob'], core['coverage']['tagged']), ({}, []))

    def test_a_general_index_orders_no_job(self):
        job(self.jobs, 'chat')['benchmarks'].append('epoch-eci')
        self.refused('job chat: epoch-eci is a general index, which orders no job')

    def test_surface_measures_are_benchmarks_of_the_job(self):
        job(self.jobs, 'code')['bySurface']['chat-app'] = ['lmarena-webdev-overall']
        self.refused('job code: the chat-app benchmarks are not distinct benchmarks of the job')
        self.jobs = copy.deepcopy(JOBS)
        job(self.jobs, 'code')['bySurface']['editor'] = ['terminal-bench-4-1']
        self.refused('job code: unknown surface editor')

    def test_a_crosswalk_fit_agrees_with_the_job_it_gives(self):
        cases = [
            (lambda d: crosswalk_entry(d, 'hn-task', 'none').update(fit='direct'), 'crosswalk hn-task: none has fit direct but gives no job'),
            (lambda d: crosswalk_entry(d, 'report-category', 'agents').update(fit='loose'), 'crosswalk report-category: agents has fit loose but gives no job'),
            (lambda d: crosswalk_entry(d, 'hn-task', 'code').update(fit='none'), 'crosswalk hn-task: code has fit none but gives a job'),
            (lambda d: crosswalk_entry(d, 'hn-task', 'code').update(fit='close'), 'crosswalk hn-task: code has unknown fit close'),
            (lambda d: crosswalk_entry(d, 'hn-task', 'code').pop('fit'), 'crosswalk hn-task: an entry is not a label, a job, a fit'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                self.jobs = copy.deepcopy(JOBS)
                change(self.jobs)
                self.refused(message)

    def test_broken_replacements(self):
        cases = [
            (lambda d: d['replaces']['local'].pop('label'), 'replaces local: fields differ'),
            (lambda d: d['replaces']['images'].update(into=['pictures']), 'replaces images: into names a job that does not exist'),
            (lambda d: d['replaces']['coding'].update(into=['code']), 'replaces coding: a replacement job and jobs it was split into'),
            (lambda d: d['replaces']['local'].pop('setting'), 'replaces local: no job, no jobs it was split into and no field it sets'),
            (lambda d: d['replaces']['agents'].update(run='overnight'), 'replaces agents: unknown run'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                self.jobs = copy.deepcopy(JOBS)
                change(self.jobs)
                self.refused(message)

    def test_every_snapshot_benchmark_category_needs_a_job_entry(self):
        table = self.jobs['crosswalk']['benchmark-category']['labels']
        table[:] = [entry for entry in table if entry['label'] != 'coding']
        self.refused('crosswalk benchmark-category has no entry for coding')

    def test_unknown_job_id_stops_the_build_and_lists_its_records(self):
        crosswalk_entry(self.jobs, 'hn-task', 'writing')['job'] = 'writting'
        self.refused('writting is neither a job nor replaced', 'hn:103')

    def test_unknown_job_id_without_records_is_listed(self):
        crosswalk_entry(self.jobs, 'hn-task', 'maths')['job'] = 'mathz'
        self.refused('mathz is neither a job nor replaced (in crosswalk hn-task:maths): 0 records')

    def test_unmapped_source_label_stops_the_build_and_lists_its_records(self):
        labels = self.jobs['crosswalk']['hn-task']['labels']
        labels.remove(crosswalk_entry(self.jobs, 'hn-task', 'writing'))
        self.refused('hn-task:writing is not in the crosswalk', 'hn:103')

    def test_unmapped_benchmark_stops_the_build(self):
        labels = self.jobs['crosswalk']['benchmark']['labels']
        labels.remove(crosswalk_entry(self.jobs, 'benchmark', 'plato-web-clone-bench'))
        self.refused('benchmark:plato-web-clone-bench is not in the crosswalk', 'bm:plato-web-clone-bench:')

    def test_old_job_ids_map_through_replaces(self):
        crosswalk_entry(self.jobs, 'hn-task', 'code')['job'] = 'coding'
        del self.jobs['replaces']['coding']
        self.refused('coding is neither a job nor replaced', 'hn:101')
        self.jobs['replaces']['coding'] = {'label': 'Old coding', 'job': 'code'}
        _core, records = self.build()
        self.assertEqual((records['hn:101']['job'], records['hn:101']['via']), ('code', 'task:code'))

    def test_parent_that_does_not_exist(self):
        job(self.jobs, 'debug')['parent'] = 'cooding'
        self.refused('job debug: parent cooding does not exist')

    def test_parent_with_a_parent(self):
        job(self.jobs, 'code')['parent'] = 'chat'
        self.refused('job debug: parent code has a parent')

    def test_benchmark_that_does_not_exist(self):
        job(self.jobs, 'code')['benchmarks'].append('no-such-benchmark')
        self.refused('job code: benchmark no-such-benchmark does not exist')

    def test_other_broken_references(self):
        cases = [
            (lambda d: job(d, 'writing').update(guideTask='novels'), 'App guide task novels does not exist'),
            (lambda d: d['keywords']['rules'].append(rule(job='swarms')), 'keyword rule 1: job swarms does not exist'),
            (lambda d: d['keywords']['rules'].append(rule(within=[None, 'nothing'])), 'keyword rule 1: within names a job'),
            (lambda d: d['keywords']['rules'].append(rule(pattern='(')), 'keyword rule 1: pattern does not compile'),
            (lambda d: d['tags']['rules'][0].update(pattern='('), 'tag rule 1: pattern does not compile'),
            (lambda d: d['tags']['rules'][0].update(tag='code'), 'tag rule 1: code is a job id'),
            (lambda d: d['tags']['rules'][0].update(noJob='yes'), 'tag rule 1: noJob is not true or false'),
            (lambda d: d['tags']['rules'][0].pop('noJob'), 'tag rule 1: not a tag, a label, a pattern, caseSensitive and noJob'),
            (lambda d: d['fields']['hn-theme'].append({'label': 'no-such-theme', 'run': 'unattended'}), 'fields hn-theme: unknown theme no-such-theme'),
            (lambda d: d['jobs'].append(dict(job(d, 'chat'))), 'a job id is repeated'),
            (lambda d: d['replaces'].update(chat={'label': 'Chat', 'job': 'writing'}), 'replaces chat: not an old job id'),
            (lambda d: d['replaces'].update(old={'label': 'Old', 'job': 'gone'}), 'replaces old: gone is not a job'),
            (lambda d: d['crosswalk'].update(unknown={'version': 1, 'labels': []}), 'crosswalk has an unknown source'),
            (lambda d: d['surface']['surfaces'].append({'surface': 'editor', 'words': ['vim']}), 'surface: unknown surface editor'),
            (lambda d: d.update(status='final'), 'status is neither draft nor approved'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                self.jobs = copy.deepcopy(JOBS)
                change(self.jobs)
                self.refused(message)

    def test_every_guide_task_is_listed_once_and_agrees_with_the_jobs(self):
        core, _ = self.build()
        tasks = [task['id'] for task in GUIDE['tasks']]
        self.assertEqual([entry['task'] for entry in core['jobs']['guide']], tasks)
        by_id = {entry['id']: entry for entry in core['jobs']['list']}
        for entry in core['jobs']['guide']:
            with self.subTest(task=entry['task']):
                if entry['job'] is None:
                    self.assertTrue(entry['note'].strip())
                    self.assertFalse([j['id'] for j in core['jobs']['list'] if j.get('guideTask') == entry['task']])
                else:
                    self.assertEqual(by_id[entry['job']].get('guideTask'), entry['task'])

    def test_broken_guide_table(self):
        def entry(data, task):
            return next(item for item in data['guide']['tasks'] if item['task'] == task)
        cases = [
            (lambda d: d['guide']['tasks'].pop(0), 'guide: App guide task quick-answers is not listed'),
            (lambda d: d['guide']['tasks'].append({'task': 'novels', 'job': None, 'note': 'x'}), 'guide: App guide task novels does not exist'),
            (lambda d: d['guide']['tasks'].append(dict(entry(d, 'writing'))), 'guide: writing is listed twice'),
            (lambda d: entry(d, 'writing').update(job='chat'), 'guide: writing links to chat, whose guide task is quick-answers'),
            (lambda d: entry(d, 'writing').update(job='poems'), 'guide: writing links to poems, which is not a job'),
            (lambda d: entry(d, 'writing').update(job=None, note='x'), 'guide: writing has no job, but writing names it as guide task'),
            (lambda d: entry(d, 'subagents').pop('note'), 'guide: subagents has no job and no note'),
            (lambda d: entry(d, 'writing').update(note='x'), 'guide: writing needs a note when, and only when, its fit is loose'),
            (lambda d: entry(d, 'reasoning').pop('note'), 'guide: reasoning needs a note when, and only when, its fit is loose'),
            (lambda d: entry(d, 'subagents').update(fit='loose'), 'guide: subagents has no job and a fit'),
            (lambda d: job(d, 'extraction').update(guideTask='subagents'), 'guide: subagents has no job, but extraction names it as guide task'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                self.jobs = copy.deepcopy(JOBS)
                change(self.jobs)
                self.refused(message)

    def test_unknown_aspect_stops_the_build(self):
        hn = hn_export()
        hn['comments'][0]['assessments'][0]['aspects'] = ['typing']
        with self.assertRaises(BuildError):
            build_core(SNAPSHOT, GUIDE, self.jobs, hn, IMPORTED)

    def test_unknown_setting_or_run_stops_the_build(self):
        for field in ('setting', 'run'):
            with self.subTest(field=field):
                hn = hn_export()
                hn['comments'][0][field] = 'synthetic'
                with self.assertRaisesRegex(BuildError, 'hn:101: unknown setting or run'):
                    build_core(SNAPSHOT, GUIDE, self.jobs, hn, IMPORTED)


class TestImported(unittest.TestCase):
    """The LMArena and Epoch files as records."""

    def setUp(self):
        self.imported = copy.deepcopy(IMPORTED)
        self.jobs = copy.deepcopy(JOBS)

    def build(self):
        core, records = build_core(SNAPSHOT, GUIDE, self.jobs, hn_export(), self.imported)
        return core, {record['id']: record for record in records}

    def refused(self, *expected):
        with self.assertRaises(BuildError) as raised:
            self.build()
        for text in expected:
            self.assertIn(text, str(raised.exception))

    def test_imported_records(self):
        core, records = self.build()
        benchmarks = {benchmark['id']: benchmark for benchmark in core['benchmarks']}
        for kind, prefix, src in (('lmarena', 'la:', 'arena'), ('epoch', 'ep:', 'benchmark')):
            with self.subTest(source=kind):
                rows = [record for record in records.values() if record['id'].startswith(prefix)]
                self.assertEqual(len(rows), len(IMPORTED[kind]['results']))
                self.assertEqual(core['sources'][kind]['records'], len(rows))
                for record in rows:
                    self.assertEqual((record['cls'], record['src'], record['how']), ('measured', src, 'label'))
                    self.assertEqual(record['checked'], IMPORTED[kind]['checkedAt'])
                    self.assertTrue(record['date'] or kind == 'epoch')
                    self.assertIn(record['x']['b'], benchmarks)
                    self.assertTrue(benchmarks[record['x']['b']]['what'])
                    self.assertEqual(len(record['keys']), 1)
                listed = {entry['id']: entry for entry in IMPORTED[kind][IMPORTED_LIST[kind]]}
                for benchmark_id, entry in listed.items():
                    self.assertEqual(benchmarks[benchmark_id]['rows'], entry['rows'])
                    self.assertEqual(sum(record['x']['b'] == benchmark_id for record in rows), entry['kept'])
        self.assertTrue(all(benchmark['rows'] is None for benchmark in core['benchmarks'] if benchmark['source'] == 'snapshot'))
        arena = [record for record in records.values() if record['src'] == 'arena']
        self.assertTrue(all('Preference votes, not a pass rate' in record['cond'] for record in arena))
        self.assertTrue(all(record['x']['interval'] and record['x']['trials'] for record in arena))

    def test_ratings_and_percentages_never_share_a_benchmark(self):
        core, _records = self.build()
        for benchmark in core['benchmarks']:
            with self.subTest(benchmark=benchmark['id']):
                if benchmark['source'] == 'lmarena':
                    self.assertEqual(benchmark['scale'], 'rating')
                    self.assertNotIn('%', benchmark['unit'])
                    self.assertIn('Preference votes, not a pass rate', benchmark['what'])
                else:
                    self.assertNotEqual(benchmark['scale'], 'rating')

    def test_jobs_follow_the_crosswalk(self):
        core, records = self.build()
        for kind, prefix, table, field in (('lmarena', 'la:', 'arena-leaderboard', 'leaderboard'), ('epoch', 'ep:', 'epoch-run', 'file')):
            with self.subTest(source=kind):
                crosswalk = {entry['label']: entry['job'] for entry in JOBS['crosswalk'][table]['labels']}
                expected = collections.Counter(crosswalk[result[field]] for result in IMPORTED[kind]['results'])
                actual = collections.Counter(record['job'] for record in records.values() if record['id'].startswith(prefix))
                self.assertEqual(actual, expected)
        arena = sum(row['counts']['arena'] for row in core['coverage']['rows'])
        self.assertEqual(arena, len(IMPORTED['lmarena']['results']))

    def test_unreviewed_import_stops_the_build(self):
        self.imported['lmarena']['checkedAt'] = ''
        self.refused('lmarena.json: checkedAt is not set')

    def test_a_model_outside_the_snapshot_stops_the_build(self):
        self.imported['epoch']['results'][0]['modelId'] = 'new-model'
        self.refused('model new-model is not in the snapshot')

    def test_unmapped_leaderboard_or_file_stops_the_build(self):
        for table, label, expected in (
            ('arena-leaderboard', 'agent/overall', ('arena:agent/overall is not in the crosswalk', 'la:agent/overall/')),
            ('epoch-run', 'mirrorcode', ('epoch-run:mirrorcode is not in the crosswalk', 'ep:mirrorcode/')),
        ):
            with self.subTest(label=label):
                self.jobs = copy.deepcopy(JOBS)
                self.jobs['crosswalk'][table]['labels'].remove(crosswalk_entry(self.jobs, table, label))
                self.refused(*expected)

    def test_arena_benchmark_must_say_it_is_not_a_pass_rate(self):
        self.imported['lmarena']['leaderboards'][0]['what'] = 'Ratings from votes.'
        self.refused('does not say its ratings are preference votes, not a pass rate')

    def test_job_benchmarks_must_be_imported(self):
        board = 'lmarena-search_style_control-overall'
        data = self.imported['lmarena']
        data['leaderboards'] = [entry for entry in data['leaderboards'] if entry['id'] != board]
        data['results'] = [result for result in data['results'] if result['leaderboard'] != 'search_style_control/overall']
        self.refused(f'job research: benchmark {board} does not exist')


class TestUsage(unittest.TestCase):
    """OpenRouter usage: a block of its own that orders nothing and is never counted with results."""

    def setUp(self):
        self.usage = copy.deepcopy(USAGE)
        self.jobs = copy.deepcopy(JOBS)

    def build(self, usage=None):
        return build_core(SNAPSHOT, GUIDE, self.jobs, hn_export(), IMPORTED, usage)

    def refused(self, *expected):
        with self.assertRaises(BuildError) as raised:
            self.build(self.usage)
        for text in expected:
            self.assertIn(text, str(raised.exception))

    def test_usage_changes_no_ordering_and_no_coverage(self):
        without, records_without = self.build()
        with_usage, records_with = self.build(self.usage)
        self.assertIsNone(without['usage'])
        self.assertIsNotNone(with_usage['usage'])
        self.assertEqual(records_with, records_without)
        self.assertEqual({k: v for k, v in with_usage.items() if k != 'usage'}, {k: v for k, v in without.items() if k != 'usage'})
        self.assertEqual([record['id'] for record in with_usage['measured']], [record['id'] for record in without['measured']])
        self.assertEqual(with_usage['coverage'], without['coverage'])
        self.assertNotIn('usage', with_usage['coverage']['sources'])

    def test_reordered_usage_changes_nothing_else(self):
        reordered = copy.deepcopy(self.usage)
        reordered['tokens30d']['models'].reverse()
        reordered['tasks7d']['tags'].reverse()
        first, _ = self.build(self.usage)
        second, _ = self.build(reordered)
        self.assertEqual({k: v for k, v in first.items() if k != 'usage'}, {k: v for k, v in second.items() if k != 'usage'})

    def test_usage_block(self):
        core, _ = self.build(self.usage)
        usage = core['usage']
        self.assertEqual(len(usage['tokens']['models']), len(self.usage['tokens30d']['models']))
        self.assertEqual(len(usage['tasks']['tags']), len(self.usage['tasks7d']['tags']))
        for key, block in (('tokens30d', usage['tokens']), ('tasks7d', usage['tasks'])):
            self.assertEqual(block['asOf'], self.usage[key]['asOf'])
            self.assertEqual(block['meta'], self.usage[key]['meta'])
            self.assertEqual(block['period'], self.usage[key]['period'])
            self.assertTrue(block['attribution'].startswith('Source: OpenRouter (openrouter.ai/rankings), as of ' + block['asOf']))
        crosswalk = {entry['label']: entry['job'] or '' for entry in JOBS['crosswalk']['openrouter-tag']['labels']}
        self.assertEqual({tag['tag']: tag['job'] for tag in usage['tasks']['tags']}, crosswalk)
        model_ids = {model['id'] for model in SNAPSHOT['models']}
        self.assertLessEqual({model['modelId'] for model in usage['tokens']['models']}, model_ids)

    def test_tracked_usage_matches_the_crosswalk(self):
        tags = {tag['tag'] for tag in USAGE['tasks7d']['tags']}
        labels = {entry['label'] for entry in JOBS['crosswalk']['openrouter-tag']['labels']}
        self.assertEqual(tags, labels)

    def test_unreviewed_usage_stops_the_build(self):
        self.usage['checkedAt'] = ''
        self.refused('openrouter-usage.json: checkedAt is not set')

    def test_a_model_outside_the_snapshot_stops_the_build(self):
        self.usage['tokens30d']['models'][0]['modelId'] = 'new-model'
        self.refused('tokens30d new-model: model is not in the snapshot')
        self.usage = copy.deepcopy(USAGE)
        self.usage['tasks7d']['tags'][0]['top'][0]['modelId'] = 'new-model'
        self.refused('new-model is not in the snapshot')

    def test_an_unmapped_tag_stops_the_build(self):
        entry = crosswalk_entry(self.jobs, 'openrouter-tag', 'math')
        self.jobs['crosswalk']['openrouter-tag']['labels'].remove(entry)
        self.refused('OpenRouter task tags are not in the openrouter-tag crosswalk: math')

    def test_a_tag_mapped_to_an_unknown_job_stops_the_build(self):
        crosswalk_entry(self.jobs, 'openrouter-tag', 'math')['job'] = 'sums'
        self.refused('sums is neither a job nor replaced')

    def test_each_block_keeps_its_meta_and_citation(self):
        cases = [
            (lambda usage: usage['tasks7d']['meta'].pop('as_of'), 'tasks7d has no meta block with its as_of'),
            (lambda usage: usage['tokens30d'].update(attribution='Source: OpenRouter.'), 'tokens30d attribution does not cite its as_of'),
            (lambda usage: usage['source'].update(attribution='Source: OpenRouter.'), 'source attribution differs from tokens30d'),
            (lambda usage: usage['tasks7d'].update(period={'start': '2026-11-22', 'end': '2026-11-16'}), 'tasks7d period is not two dates'),
            (lambda usage: usage['tokens30d']['models'][0].update(share=1.2), 'tokens or share out of range'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                self.usage = copy.deepcopy(USAGE)
                change(self.usage)
                self.refused(message)


class TestStableIds(unittest.TestCase):
    def test_ids_come_from_the_sources(self):
        core, records = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)
        expected = (
            ['bm:' + result['id'] for result in SNAPSHOT['results']]
            + ['rp:' + report['id'] for report in SNAPSHOT['reports']]
            + [f'la:{r["leaderboard"]}/{slug(r["model"])}/{r["date"]}' for r in IMPORTED['lmarena']['results']]
            + [f'ep:{r["file"]}/{r["model"]}' for r in IMPORTED['epoch']['results']]
        )
        self.assertEqual([record['id'] for record in core['measured']], expected)
        self.assertEqual(sorted(record['id'] for record in records if record['src'] == 'hn'), ['hn:101', 'hn:102', 'hn:103'])

    def test_input_order_does_not_change_the_output(self):
        first, _ = build_core(SNAPSHOT, GUIDE, JOBS, hn_export(), IMPORTED)
        hn = hn_export()
        hn['comments'].reverse()
        second, _ = build_core(SNAPSHOT, GUIDE, copy.deepcopy(JOBS), hn, IMPORTED)
        self.assertEqual(json.dumps(first), json.dumps(second))


class TestCrowdAggregates(unittest.TestCase):
    """The app renders Hacker News counts from core.json's aggregates and loads the comment parts
    only to list comments, so the aggregates must equal what the parts give."""

    def export(self, root):
        comments = [
            {'id': 210, 'createdAt': '2026-11-02T10:00:00Z', 'task': 'code',
             'assessments': [assessment('model', MODEL, 'positive', ['code-quality', 'speed']),
                             assessment('family', 'GPT', 'negative', ['pricing'])]},
            {'id': 209, 'createdAt': '2026-10-30T10:00:00Z', 'task': 'none',
             'assessments': [assessment('model', MODEL, 'mixed', ['local-use'])]},
            {'id': 208, 'createdAt': '2026-10-01T10:00:00Z', 'task': 'writing',
             'assessments': [assessment('model', MODEL, 'unclear', ['writing-style']),
                             assessment('model', 'gpt-6-luna', 'positive')]},
            {'id': 207, 'createdAt': '2026-09-15T10:00:00Z', 'task': 'code',
             'assessments': [assessment('model', MODEL, 'negative', ['code-quality'])]},
        ]
        published = '2026-11-21T00:00:00+00:00'
        status = {'classifier': CLASSIFIER, 'startAt': '2026-05-20T00:00:00Z', 'endAt': '2026-11-20T00:00:00Z',
                  'totals': {'candidates': 4, 'commentsAboutTargets': 4}}
        dist = root / 'dist'
        dist.mkdir()
        (dist / 'hn-snapshot.json').write_text(json.dumps(
            {'publishedAt': published, 'commentParts': 2, 'status': status}), encoding='utf-8')
        for number, part in ((1, comments[:2]), (2, comments[2:])):
            (dist / f'hn-comments-{number}.json').write_text(json.dumps(
                {'publishedAt': published, 'comments': part, **({'stories': []} if number == 1 else {})}),
                encoding='utf-8')
        return dist

    def test_aggregates_equal_counts_from_the_comment_parts(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        dist = self.export(Path(directory.name))
        core, records = build_core(SNAPSHOT, GUIDE, JOBS, build['read_hn'](directory.name, 'export'), IMPORTED)
        core = json.loads(json.dumps(core))
        jobs = {record['id']: record['job'] for record in records}
        kinds = {'model': 'model', 'family': 'line'}
        stances = {'positive': 0, 'negative': 1, 'mixed': 2, 'neutral': 3, 'unclear': 3}
        counts, themes = {}, {}
        for number in (1, 2):
            for comment in json.loads((dist / f'hn-comments-{number}.json').read_text(encoding='utf-8'))['comments']:
                job_id, month = jobs[f'hn:{comment["id"]}'], comment['createdAt'][:7]
                for label in comment['assessments']:
                    key, stance = f'{kinds[label["kind"]]}|{label["target"]}', stances[label['sentiment']]
                    tally = counts.setdefault(key, {}).setdefault(job_id, {}).setdefault(month, [0, 0, 0, 0])
                    tally[stance] += 1
                    for theme in label.get('themes', []):
                        by_theme = themes.setdefault(key, {}).setdefault(job_id, {}).setdefault(month, {})
                        by_theme.setdefault(theme, [0, 0, 0, 0])[stance] += 1
        self.assertEqual(core['crowd']['counts'], counts)
        self.assertEqual(core['crowd']['themes'], themes)
        self.assertEqual(core['crowd']['themes']['line|GPT'], {'code': {'2026-11': {'pricing': [0, 1, 0, 0]}}})
        self.assertNotIn('model|gpt-6-luna', core['crowd']['themes'])

    def test_unknown_theme_stops_the_build(self):
        hn = hn_export()
        hn['comments'][0]['assessments'][0]['themes'] = ['cooking']
        with self.assertRaisesRegex(BuildError, 'hn:101: unknown theme'):
            build_core(SNAPSHOT, GUIDE, JOBS, hn, IMPORTED)

    def test_the_copy_into_dist_stops_when_the_export_is_from_another_collection(self):
        copy_core = runpy.run_path(str(ROOT / 'scripts/export-records-site.py'))
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        dist = self.export(root)
        core, _ = build_core(SNAPSHOT, GUIDE, JOBS, build['read_hn'](directory.name, 'export'), IMPORTED)
        source = root / 'core.json'
        source.write_text(json.dumps({**core, 'namedBehindSignIn': False}), encoding='utf-8')
        copy_core['export_core'](source, dist / 'core.json', dist / 'hn-snapshot.json')
        self.assertTrue((dist / 'core.json').is_file())
        snapshot = json.loads((dist / 'hn-snapshot.json').read_text(encoding='utf-8'))
        for change in ({'commentsAboutTargets': 5}, {'endAt': '2026-11-21T00:00:00Z'}):
            changed = copy.deepcopy(snapshot)
            if 'endAt' in change:
                changed['status'].update(change)
            else:
                changed['status']['totals'].update(change)
            (dist / 'hn-snapshot.json').write_text(json.dumps(changed), encoding='utf-8')
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'different collections'):
                copy_core['export_core'](source, dist / 'core.json', dist / 'hn-snapshot.json')


def tree(directory):
    """Every file under `directory` with a hash of its contents."""
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.rglob('*')) if path.is_file()
    }


# A read-only SQLite connection to a WAL database keeps its read position in the
# shared-memory index and creates it, with an empty write-ahead log, when they are
# missing. The published export reads the checkpoint the same way.
SQLITE_INDEX = 'hn/checkpoint.sqlite3-shm'
SQLITE_LOG = 'hn/checkpoint.sqlite3-wal'
EMPTY = hashlib.sha256(b'').hexdigest()


class TestReadOnly(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        local = self.root / '.local'
        (local / 'restricted').mkdir(parents=True)
        (local / 'restricted/research.json').write_text('{"benchmarks": []}', encoding='utf-8')
        (local / 'arxiv').mkdir()
        (local / 'arxiv/state.json').write_text('{}', encoding='utf-8')
        (local / 'hn').mkdir()
        plan = SourcePlan(
            'firebase', None, 1, 100, (Partition('items-1-100', 'firebase', 100, 1, 100),),
            False, DateWindow(START, END),
        )
        with State(local / 'hn') as state:
            state.initialize(plan, CLASSIFIER, 'current')
            with state.connection:
                state.connection.execute(
                    """INSERT INTO comment (item_id, classifier_key, digest, created, priority, failed_groups,
                       root, task, claim) VALUES (10, 'current', 'synthetic', ?, 0, 0, NULL, 'code', ?)""",
                    (START + 5, 'Synthetic claim about the example model.'),
                )
                state.connection.execute(
                    'INSERT INTO assessment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (10, 'current', 'model', MODEL, 'positive', '["coding"]', 'high', 0, '[]'),
                )

    def run_main(self, *arguments):
        search = ['--search-out', str(self.root / 'build/search'), '--search-local', str(self.root / 'build/search.sqlite')]
        with contextlib.redirect_stdout(io.StringIO()) as output:
            main(['--hn-root', str(self.root), *search, *arguments])
        return output.getvalue()

    def test_the_build_reads_the_checkpoint_and_changes_nothing_under_local(self):
        before = tree(self.root / '.local')
        seen = []
        read_text, open_file, connect = Path.read_text, builtins.open, sqlite3.connect

        def spy_read_text(path, *args, **kwargs):
            seen.append(Path(path).resolve())
            return read_text(path, *args, **kwargs)

        def spy_open(file, *args, **kwargs):
            seen.append(Path(file).resolve())
            return open_file(file, *args, **kwargs)

        def spy_connect(database, *args, **kwargs):
            seen.append(Path(str(database).removeprefix('file://').split('?')[0]).resolve())
            return connect(database, *args, **kwargs)

        out = self.root / 'build/core.json'
        with patch.object(Path, 'read_text', spy_read_text), patch('builtins.open', spy_open), \
                patch('sqlite3.connect', spy_connect):
            printed = self.run_main('--out', str(out))
        self.assertIn('Hacker News from the checkpoint: 1 comments', printed)
        self.assertEqual(json.loads(out.read_text(encoding='utf-8'))['sources']['hn']['comments'], 1)
        self.assertIn(self.root / '.local/hn/checkpoint.sqlite3', seen)
        self.assertFalse([path for path in seen if (self.root / '.local/restricted') in path.parents])
        after = tree(self.root / '.local')
        self.assertLessEqual(set(after) - set(before), {SQLITE_INDEX, SQLITE_LOG})
        self.assertEqual(after.get(SQLITE_LOG, EMPTY), EMPTY)
        self.assertEqual({k: v for k, v in after.items() if k in before and k != SQLITE_INDEX},
                         {k: v for k, v in before.items() if k != SQLITE_INDEX})

    def test_output_under_local_is_refused(self):
        before = tree(self.root / '.local')
        for target in ('.local/hn/core.json', '.local/arxiv/core.json', '.local/restricted/core.json', '.local/core.json'):
            with self.subTest(target=target), self.assertRaises(SystemExit) as raised:
                self.run_main('--out', str(self.root / target))
            self.assertIn('refusing to write under .local', str(raised.exception))
        self.assertEqual(tree(self.root / '.local'), before)

    def test_restricted_files_are_never_read(self):
        with self.assertRaises(BuildError):
            read_json(self.root / '.local/restricted/research.json')


if __name__ == '__main__':
    unittest.main()
