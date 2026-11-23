"""Check the LMArena, Epoch and OpenRouter importers on saved samples of each source's format, with no network."""

import contextlib
import datetime
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import import_common
import import_epoch
import import_lmarena
import import_openrouter
from import_common import SourceError

FIXTURES = ROOT / 'tests/fixtures'
SNAPSHOT_IDS = import_common.model_ids()
SAMPLE_BOARDS = tuple(
    board for board in import_lmarena.LEADERBOARDS
    if (board[0], board[1]) in {('webdev', 'overall'), ('agent', 'overall'), ('text_style_control', 'math')}
)
SAMPLE_FILES = tuple(entry for entry in import_epoch.FILES if entry[0] == 'gpqa_diamond')
LMARENA_ALIASES = import_common.read_aliases(ROOT / 'research/aliases/lmarena.json', SNAPSHOT_IDS)
EPOCH_ALIASES = import_common.read_aliases(ROOT / 'research/aliases/epoch.json', SNAPSHOT_IDS)
OPENROUTER_ALIASES = import_common.read_aliases(ROOT / 'research/aliases/openrouter.json', SNAPSHOT_IDS)
# A made-up value in the shape of an OpenRouter key; no real key is used anywhere in the tests.
FAKE_KEY = 'sk-or-v1-made-up-test-value-0123456789abcdef'


def usage_model_ids(data):
    """Every model id an OpenRouter usage file names, outside top-list places with no model."""
    return {model['modelId'] for model in data['tokens30d']['models']} | {
        top['modelId'] for tag in data['tasks7d']['tags'] for top in tag['top'] if top['modelId']
    }


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Folder(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)


# ---- LMArena ---------------------------------------------------------------------------


class TestLmarenaNames(unittest.TestCase):
    def test_effort_and_harness_are_settings(self):
        split = import_lmarena.split_name
        self.assertEqual(split('GPT-6.2 Sol (Max)'), ('GPT-6.2 Sol', 'max', ''))
        self.assertEqual(split('GPT-5.6 Sol (xHigh, Codex Harness)'), ('GPT-5.6 Sol', 'xhigh', 'Codex'))
        self.assertEqual(split('DeepSeek-V4-Pro (High, 20260813)'), ('DeepSeek-V4-Pro (20260813)', 'high', ''))
        self.assertEqual(split('FLUX.2 [max]'), ('FLUX.2 [max]', '', ''))
        self.assertEqual(split('Claude Opus 4.8'), ('Claude Opus 4.8', '', ''))

    def test_matches_are_exact(self):
        match = import_lmarena.match
        self.assertEqual(match('GPT-6.2 Sol (Max)', LMARENA_ALIASES), ('gpt-6.2-sol', 'max', ''))
        self.assertEqual(match('DeepSeek-V4-Pro (High, 20260813)', LMARENA_ALIASES), ('deepseek-v4-pro', 'high', ''))
        # Another dated release of a listed model: the date is never taken out.
        self.assertIsNone(match('DeepSeek-V4.1-Flash-20260910 (Max)', LMARENA_ALIASES))
        self.assertIsNone(match('DeepSeek-V4-Pro', LMARENA_ALIASES))
        self.assertIsNone(match('GPT-6.2 Sol Mini (Max)', LMARENA_ALIASES))

    def test_the_full_name_is_tried_first(self):
        aliases = {'Model (Max)': 'full', 'Model': 'base'}
        self.assertEqual(import_lmarena.match('Model (Max)', aliases), ('full', 'max', ''))
        self.assertEqual(import_lmarena.match('Model (High)', aliases), ('base', 'high', ''))


class TestLmarenaImport(Folder):
    def convert(self, folder=FIXTURES / 'lmarena', aliases=LMARENA_ALIASES):
        with patch.object(import_lmarena, 'LEADERBOARDS', SAMPLE_BOARDS):
            return import_lmarena.convert(folder, aliases)

    def sample(self):
        folder = self.root / 'download'
        shutil.copytree(FIXTURES / 'lmarena', folder)
        return folder

    def test_sample_results(self):
        data, counts, unmatched = self.convert()
        self.assertEqual(counts, {'webdev/overall': (4, 1), 'agent/overall': (3, 3), 'text_style_control/math': (4, 2)})
        self.assertEqual(
            sorted(unmatched),
            ['Claude Opus 4.8', 'DeepSeek-V4.1-Flash-20260910 (Max)', 'GPT-5.3-Codex (Codex Harness) (listed 2 times on webdev/overall)',
             'GPT-5.6 Sol (xHigh, Codex Harness)'],
        )
        results = {(r['leaderboard'], r['model']): r for r in data['results']}
        self.assertEqual(results['text_style_control/math', 'GPT-6.2 Sol (Max)'], {
            'leaderboard': 'text_style_control/math', 'model': 'GPT-6.2 Sol (Max)', 'modelId': 'gpt-6.2-sol',
            'effort': 'max', 'tool': '', 'score': 1483, 'lower': 1446, 'upper': 1519, 'count': 244, 'rank': 38,
            'date': '2026-11-22',
        })
        agent = results['agent/overall', 'Gemini 3.1 Pro Preview']
        self.assertEqual((agent['score'], agent['lower'], agent['upper']), (-0.056, -0.074, -0.039))
        self.assertEqual((agent['count'], agent['sessions'], agent['costPerTask']), (3000921, 87227, 0.6731))
        self.assertIsNone(results['agent/overall', 'Kimi K3.1 Pro (Max)']['costPerTask'])
        self.assertEqual(data['checkedAt'], '')
        self.assertEqual(data['fetchedAt'], '2026-11-23')
        self.assertEqual(
            data['source']['attribution'],
            'Source: Arena leaderboard dataset (huggingface.co/datasets/lmarena-ai/leaderboard-dataset), '
            'latest split as published 22 November 2026. Licensed under CC BY 4.0.',
        )
        for board in data['leaderboards']:
            self.assertIn('Preference votes, not a pass rate', board['what'])
            self.assertEqual(board['scale'], 'rating')

    def test_changed_licence_stops_the_import(self):
        folder = self.sample()
        (folder / 'dataset.json').write_text(json.dumps({'cardData': {'license': 'other'}}), encoding='utf-8')
        with self.assertRaisesRegex(SourceError, "licence is now 'other'"):
            self.convert(folder)

    def test_changed_format_stops_the_import(self):
        cases = [
            (lambda row: row.pop('rating'), 'rating is not a number'),
            (lambda row: row.update(rating=2000.0), 'outside its interval'),
            (lambda row: row.update(vote_count=12.5), 'vote_count is not a whole number'),
            (lambda row: row.update(rank=0), 'rank is not a positive whole number'),
            (lambda row: row.update(category='coding'), "category 'coding'"),
            (lambda row: row.update(leaderboard_publish_date='2026-11-21'), 'rows from 2 publish dates'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                folder = self.sample()
                path = folder / 'text_style_control.math.json'
                rows = json.loads(path.read_text(encoding='utf-8'))
                change(rows[0])
                path.write_text(json.dumps(rows), encoding='utf-8')
                with self.assertRaisesRegex(SourceError, message):
                    self.convert(folder)
                shutil.rmtree(folder)

    def test_an_alias_for_a_name_listed_twice_stops_the_import(self):
        aliases = {**LMARENA_ALIASES, 'GPT-5.3-Codex': 'gpt-6.2-sol'}
        with self.assertRaisesRegex(SourceError, 'listed 2 times'):
            self.convert(aliases=aliases)

    def test_download_pages_through_the_rows(self):
        rows = {
            (config, category): json.loads((FIXTURES / 'lmarena' / f'{config}.{category}.json').read_text(encoding='utf-8'))
            for config, category, *_ in SAMPLE_BOARDS
        }
        requests = []

        def get(url):
            requests.append(url)
            if url == import_lmarena.DATASET_API:
                return (FIXTURES / 'lmarena/dataset.json').read_bytes()
            query = {key: value[0] for key, value in parse_qs(urlparse(url).query).items()}
            category = query['where'].split("'")[1]
            selected = rows[query['config'], category]
            offset, length = int(query['offset']), int(query['length'])
            return json.dumps({
                'rows': [{'row': row} for row in selected[offset:offset + length]],
                'num_rows_total': len(selected),
            }).encode()

        folder = self.root / 'download'
        folder.mkdir()
        with patch.object(import_lmarena, 'LEADERBOARDS', SAMPLE_BOARDS), patch.object(import_lmarena, 'PAGE', 2):
            import_lmarena.download(folder, get=get, pause=lambda _seconds: None)
        self.assertEqual(len(requests), 1 + 2 + 2 + 2)
        self.assertTrue(all(url.startswith('https://') for url in requests))
        data, _counts, _unmatched = self.convert(folder)
        expected, _counts, _unmatched = self.convert()
        self.assertEqual(data['results'], expected['results'])

    def test_a_short_download_stops(self):
        def get(url):
            if url == import_lmarena.DATASET_API:
                return b'{}'
            return json.dumps({'rows': [], 'num_rows_total': 3}).encode()

        folder = self.root / 'download'
        folder.mkdir()
        with patch.object(import_lmarena, 'LEADERBOARDS', SAMPLE_BOARDS), self.assertRaisesRegex(SourceError, 'empty page'):
            import_lmarena.download(folder, get=get, pause=lambda _seconds: None)


# ---- Epoch -----------------------------------------------------------------------------


def epoch_zip(folder, readme=None, csv_text=None):
    """A download folder holding an archive in the ZIP's layout, from the saved sample."""
    folder.mkdir(parents=True)
    with zipfile.ZipFile(folder / import_epoch.ZIP_NAME, 'w') as archive:
        archive.writestr('README.md', readme or (FIXTURES / 'epoch/README.md').read_text(encoding='utf-8'))
        archive.writestr('gpqa_diamond.csv', csv_text or (FIXTURES / 'epoch/gpqa_diamond.csv').read_text(encoding='utf-8'))
        # An external file: another publisher's results, never read.
        archive.writestr('gpqa_diamond_external.csv', 'Model version,score\nclaude-opus-5-5_max,0.5\n')
    (folder / 'download.json').write_text(json.dumps({'fetchedAt': '2026-11-23T09:57:00Z'}), encoding='utf-8')
    return folder


class TestEpochImport(Folder):
    def convert(self, folder):
        with patch.object(import_epoch, 'FILES', SAMPLE_FILES):
            return import_epoch.convert(folder, EPOCH_ALIASES)

    def test_version_suffixes(self):
        split = import_epoch.split_version
        self.assertEqual(split('gemini-4-neon_xhigh'), ('gemini-4-neon', 'xhigh'))
        self.assertEqual(split('deepseek-v4-pro_unknown'), ('deepseek-v4-pro', 'unknown'))
        self.assertEqual(split('claude-sonnet-4-6_32K'), ('claude-sonnet-4-6_32K', ''))
        self.assertEqual(split('phi-4'), ('phi-4', ''))

    def test_sample_results(self):
        data, counts, unmatched = self.convert(epoch_zip(self.root / 'download'))
        self.assertEqual(counts, {'gpqa_diamond': (6, 3)})
        # Undated and differently dated releases, a fallback route and a token budget stay out.
        self.assertEqual(sorted(unmatched), ['claude-opus-5-5-fallback', 'claude-sonnet-4-6_32K', 'deepseek-v4-pro'])
        results = {r['model']: r for r in data['results']}
        self.assertEqual(sorted(results), ['claude-opus-5-5_max', 'deepseek-v4-pro-0813_max', 'gemini-4-neon_xhigh'])
        neon = results['gemini-4-neon_xhigh']
        self.assertEqual(
            {key: neon[key] for key in ('modelId', 'effort', 'score', 'mean', 'stderr', 'date', 'run')},
            {'modelId': 'gemini-4-neon', 'effort': 'xhigh', 'score': 96.3, 'mean': 96.3, 'stderr': 1.287,
             'date': '2026-11-19', 'run': 'oRxFiWKdd7DmcfFkg999ph'},
        )
        self.assertTrue(neon['log'].startswith('https://logs.epoch.ai/'))
        self.assertEqual(data['files'][0]['scale'], 'percent')
        self.assertEqual(data['checkedAt'], '')
        self.assertTrue(data['source']['attribution'].endswith('Accessed 23 November 2026. Licensed under CC BY 4.0.'))

    def test_changed_terms_stop_the_import(self):
        readme = (FIXTURES / 'epoch/README.md').read_text(encoding='utf-8')
        cases = [
            (readme.replace('https://creativecommons.org/licenses/by/4.0/', 'https://example.org/terms'), 'no longer gives the CC BY 4.0'),
            (readme.replace('Capabilities & benchmarking', 'Benchmarking hub'), 'citation has changed'),
        ]
        for number, (text, message) in enumerate(cases):
            with self.subTest(message=message), self.assertRaisesRegex(SourceError, message):
                self.convert(epoch_zip(self.root / str(number), readme=text))

    def test_changed_format_stops_the_import(self):
        sample = (FIXTURES / 'epoch/gpqa_diamond.csv').read_text(encoding='utf-8')
        cases = [
            (sample.replace('Best score (across scorers)', 'Best score'), 'columns missing'),
            (sample.replace(',0.9627525252525253,0.9627525252525253,', ',0.96,96.3,', 1), 'not a share between 0 and 1'),
            (sample.replace('gemini-4-neon_xhigh', 'claude-opus-5-5_max'), 'listed twice'),
            (sample.replace('2026-11-19T21:24:50.000Z', 'soon'), 'Started at is not a date'),
            (sample.replace(',oRxFiWKdd7DmcfFkg999ph', ''), 'more or fewer cells than the header'),
        ]
        for number, (text, message) in enumerate(cases):
            with self.subTest(message=message), self.assertRaisesRegex(SourceError, message):
                self.convert(epoch_zip(self.root / str(number), csv_text=text))

    def test_download_writes_the_archive_into_its_own_folder(self):
        folder = self.root / 'download'
        folder.mkdir()
        archive = epoch_zip(self.root / 'sample') / import_epoch.ZIP_NAME
        import_epoch.download(folder, get=lambda url: archive.read_bytes() if url == import_epoch.ZIP_URL else b'')
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ['benchmark_data.zip', 'download.json'])
        data, _counts, _unmatched = self.convert(folder)
        self.assertEqual(len(data['results']), 3)


# ---- OpenRouter --------------------------------------------------------------------------


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_exception):
        self.close()


def openrouter_sample(folder):
    shutil.copytree(FIXTURES / 'openrouter', folder)
    return folder


def edit_json(path, change):
    data = json.loads(path.read_text(encoding='utf-8'))
    change(data)
    path.write_text(json.dumps(data), encoding='utf-8')


class TestOpenrouterRoutes(unittest.TestCase):
    def test_matches_are_exact_after_free(self):
        match = import_openrouter.match
        self.assertEqual(match('deepseek/deepseek-v4.1-flash-20261017', OPENROUTER_ALIASES), 'deepseek-flash')
        self.assertEqual(match('nvidia/nemotron-3-ultra-550b-a55b-20260604:free', OPENROUTER_ALIASES), 'nemotron-3-ultra')
        # The undated route served another release, and other variants are not the same model.
        self.assertIsNone(match('deepseek/deepseek-v4.1-flash', OPENROUTER_ALIASES))
        self.assertIsNone(match('deepseek/deepseek-v4.1-flash-20260910', OPENROUTER_ALIASES))
        self.assertIsNone(match('anthropic/claude-opus-5.5-20260921:batch', OPENROUTER_ALIASES))
        self.assertIsNone(match('meta/muse-spark-1.3-contributor-20260902', OPENROUTER_ALIASES))


class TestOpenrouterImport(Folder):
    def test_sample_usage(self):
        data, counts, unmatched = import_openrouter.convert(FIXTURES / 'openrouter', OPENROUTER_ALIASES)
        self.assertEqual(counts, {'rankings-daily (30 days)': (120, 90), 'classifications/task (7 days)': (87, 65)})
        self.assertIn('deepseek/deepseek-v4.1-flash-20260910', unmatched)
        self.assertNotIn('other', unmatched)
        tokens = data['tokens30d']
        self.assertEqual(tokens['meta'], {
            'as_of': '2026-11-23T02:56:32.003Z', 'version': 'v1', 'start_date': '2026-10-24', 'end_date': '2026-11-22',
        })
        self.assertEqual(tokens['period'], {'start': '2026-10-24', 'end': '2026-11-22'})
        self.assertEqual(tokens['totalTokens'], 404117634337576)
        self.assertEqual([m['modelId'] for m in tokens['models']], ['deepseek-flash', 'claude-opus-5-5', 'nemotron-3-ultra'])
        self.assertEqual(tokens['models'][0], {
            'modelId': 'deepseek-flash', 'routes': ['deepseek/deepseek-v4.1-flash-20261017'], 'tokens': 238933994015213,
            'share': 0.5912, 'daysInTop50': 30,
        })
        self.assertEqual(tokens['models'][2]['routes'], ['nvidia/nemotron-3-ultra-550b-a55b-20260604:free'])
        tasks = data['tasks7d']
        self.assertEqual(tasks['meta'], {'window_days': 7, 'as_of': '2026-11-22'})
        self.assertEqual(tasks['period'], {'start': '2026-11-16', 'end': '2026-11-22'})
        self.assertEqual(len(tasks['tags']), 29)
        self.assertEqual(tasks['tags'][0]['top'][:3], [
            {'route': 'typesafe/jev-1.13-20260917', 'modelId': '', 'share': 0.175, 'tokenShare': 0.12},
            {'route': 'typesafe/jev-1.14-20261014', 'modelId': '', 'share': 0.128, 'tokenShare': 0.083},
            {'route': 'openai/gpt-6-luna-20260922', 'modelId': 'gpt-6-luna', 'share': 0.08, 'tokenShare': 0.042},
        ])
        self.assertEqual(data['fetchedAt'], '2026-11-23')
        self.assertEqual(data['checkedAt'], '')
        line = 'Source: OpenRouter (openrouter.ai/rankings), as of {}. Licensed under CC BY 4.0.'
        self.assertEqual(data['source']['attribution'], line.format('2026-11-23T02:56:32.003Z'))
        self.assertEqual(tasks['attribution'], line.format('2026-11-22'))

    def test_changed_format_stops_the_import(self):
        def drop_other(data):
            data['data'] = [row for row in data['data'] if not (row['model_permaslug'] == 'other' and row['date'] == '2026-11-01')]

        rankings = [
            (drop_other, 'rankings-daily 2026-11-01: no "other" row'),
            (lambda data: data['data'][0].update(total_tokens='12e9'), 'total_tokens is not a count'),
            (lambda data: data['data'][0].update(total_tokens=1.5), 'total_tokens is not a count'),
            (lambda data: data['meta'].update(start_date='2026-11-16'), 'the window is 7 days, not 30'),
            (lambda data: data['meta'].pop('as_of'), 'meta.as_of is not a timestamp'),
            (lambda data: data['data'].append(dict(data['data'][0])), 'is listed twice'),
            (lambda data: data['data'][0].update(date='2026-12-01'), 'outside the window'),
        ]
        tasks = [
            (lambda data: data['data'].update(window_days=30), 'window_days is 30, not 7'),
            (lambda data: data['data']['classifications'][0].update(usage_share=1.5), 'usage_share is not a share'),
            (lambda data: data['data']['classifications'].pop(0), 'request shares add up to 0.678, not 1'),
            (lambda data: data['data']['classifications'][1].update(tag='classification_tagging'), 'listed twice'),
            (lambda data: data['data']['classifications'][0]['models'][0].pop('tag_usage_share'), 'tag_usage_share is not a share'),
            (lambda data: data['data']['classifications'][0].update(macro_category='new'), 'unknown macro_category'),
        ]
        for number, (file, change, message) in enumerate(
            [(import_openrouter.RANKINGS_FILE, *case) for case in rankings] + [(import_openrouter.TASKS_FILE, *case) for case in tasks]
        ):
            with self.subTest(message=message):
                folder = openrouter_sample(self.root / str(number))
                edit_json(folder / file, change)
                with self.assertRaisesRegex(SourceError, message):
                    import_openrouter.convert(folder, OPENROUTER_ALIASES)

    def test_download_makes_two_calls_to_the_data_api(self):
        requests, pauses = [], []
        bodies = {
            import_openrouter.RANKINGS_URL: (FIXTURES / 'openrouter/rankings-daily-30d.json').read_bytes(),
            import_openrouter.TASKS_URL: (FIXTURES / 'openrouter/task-7d.json').read_bytes(),
        }

        def get(url):
            requests.append(url)
            return bodies[url]

        folder = self.root / 'download'
        folder.mkdir()
        import_openrouter.download(folder, get=get, pause=pauses.append)
        self.assertEqual(requests, [import_openrouter.RANKINGS_URL, import_openrouter.TASKS_URL])
        self.assertTrue(all(url.startswith('https://openrouter.ai/api/v1/') for url in requests))
        self.assertEqual(pauses, [import_openrouter.PAUSE])
        self.assertEqual(sorted(path.name for path in folder.iterdir()), ['download.json', 'rankings-daily-30d.json', 'task-7d.json'])


class TestOpenrouterKey(Folder):
    """The key is read from the environment inside the call, sent only as a header to the Data API,
    and never reaches a file, the printed report or an error message."""

    def environment(self, **values):
        clean = {name: value for name, value in os.environ.items() if name != import_openrouter.KEY_VARIABLE}
        return patch.dict(os.environ, {**clean, **values}, clear=True)

    def new_folder(self, source):
        return import_common.new_download_dir(source, root=self.root / 'imports')

    def run_main(self, *arguments):
        with contextlib.redirect_stdout(io.StringIO()) as output, \
                patch.object(import_openrouter, 'new_download_dir', self.new_folder), \
                patch.object(import_openrouter, 'PAUSE', 0):
            import_openrouter.main(list(arguments))
        return output.getvalue()

    def written(self):
        return b''.join(path.read_bytes() for path in self.root.rglob('*') if path.is_file())

    def test_the_key_never_reaches_the_output_or_the_report(self):
        sent = []
        bodies = {
            import_openrouter.RANKINGS_URL: (FIXTURES / 'openrouter/rankings-daily-30d.json').read_bytes(),
            import_openrouter.TASKS_URL: (FIXTURES / 'openrouter/task-7d.json').read_bytes(),
        }

        def opened(request, timeout):
            sent.append(request)
            return FakeResponse(bodies[request.full_url])

        out = self.root / 'openrouter-usage.json'
        with self.environment(OPENROUTER_API_KEY=FAKE_KEY), patch.object(import_common, 'urlopen', opened):
            printed = self.run_main('--out', str(out))
        self.assertEqual([request.full_url for request in sent], [import_openrouter.RANKINGS_URL, import_openrouter.TASKS_URL])
        for request in sent:
            self.assertEqual(request.unredirected_hdrs, {'Authorization': f'Bearer {FAKE_KEY}'})
            self.assertNotIn('Authorization', request.headers)
        self.assertIn('Downloading into', printed)
        self.assertNotIn(FAKE_KEY, printed)
        self.assertTrue(out.is_file())
        self.assertNotIn(FAKE_KEY.encode(), self.written())

    def test_the_key_never_reaches_an_error(self):
        failures = [
            import_common.HTTPError(import_openrouter.RANKINGS_URL, 401, 'Unauthorized', {}, None),
            URLError('connection refused'),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                with self.environment(OPENROUTER_API_KEY=FAKE_KEY), patch.object(import_common, 'urlopen', side_effect=failure), \
                        patch.object(import_common.time, 'sleep'), self.assertRaises(SystemExit) as raised:
                    self.run_main('--out', str(self.root / 'openrouter-usage.json'))
                self.assertIn('OpenRouter import stopped', str(raised.exception))
                self.assertNotIn(FAKE_KEY, str(raised.exception))
                self.assertNotIn(FAKE_KEY.encode(), self.written())

    def test_a_response_that_repeats_the_key_is_not_saved(self):
        def opened(request, timeout):
            return FakeResponse(json.dumps({'error': f'bad key {FAKE_KEY}'}).encode())

        with self.environment(OPENROUTER_API_KEY=FAKE_KEY), patch.object(import_common, 'urlopen', opened), \
                self.assertRaises(SystemExit) as raised:
            self.run_main('--out', str(self.root / 'openrouter-usage.json'))
        self.assertIn('the response repeats the key, so it was not saved', str(raised.exception))
        self.assertNotIn(FAKE_KEY, str(raised.exception))
        self.assertNotIn(FAKE_KEY.encode(), self.written())

    def test_the_key_is_not_passed_on_by_a_redirect(self):
        request = Request(import_openrouter.RANKINGS_URL)
        request.add_unredirected_header('Authorization', f'Bearer {FAKE_KEY}')
        moved = HTTPRedirectHandler().redirect_request(request, None, 302, 'Found', {}, 'https://example.org/elsewhere')
        self.assertNotIn('Authorization', moved.headers)
        self.assertNotIn('Authorization', moved.unredirected_hdrs)

    def test_the_key_is_sent_only_to_the_data_api(self):
        with self.environment(OPENROUTER_API_KEY=FAKE_KEY), self.assertRaisesRegex(SourceError, 'outside the Data API') as raised:
            import_openrouter.authorised_get('https://example.org/api/v1/datasets', get=lambda *_a, **_k: b'')
        self.assertNotIn(FAKE_KEY, str(raised.exception))

    def test_a_missing_variable_stops_before_any_download(self):
        for value in ({}, {'OPENROUTER_API_KEY': ''}, {'OPENROUTER_API_KEY': '  '}):
            with self.subTest(value=value):
                with self.environment(**value), patch.object(import_common, 'urlopen') as opened, \
                        self.assertRaises(SystemExit) as raised:
                    self.run_main('--out', str(self.root / 'openrouter-usage.json'))
                self.assertEqual(
                    str(raised.exception),
                    'OpenRouter import stopped: OPENROUTER_API_KEY is not set. '
                    'Run the command in your own terminal with the key in that variable.',
                )
                opened.assert_not_called()
                self.assertFalse((self.root / 'imports').exists())
                self.assertFalse((self.root / 'openrouter-usage.json').exists())

    def test_from_a_download_needs_no_key(self):
        with self.environment():
            printed = self.run_main('--from', str(FIXTURES / 'openrouter'), '--out', str(self.root / 'openrouter-usage.json'))
        self.assertIn('155 results', printed)


# ---- Shared steps ------------------------------------------------------------------------


class TestCommon(Folder):
    def test_downloads_go_into_a_new_empty_folder(self):
        moment = datetime.datetime(2026, 11, 23, 10, 5, 48, tzinfo=datetime.timezone.utc)
        clock = SimpleNamespace(datetime=SimpleNamespace(now=lambda _zone: moment), timezone=datetime.timezone)
        with patch.object(import_common, 'datetime', clock):
            folder = import_common.new_download_dir('lmarena', root=self.root)
            self.assertEqual(folder, self.root / 'lmarena/20261123T100548Z')
            self.assertEqual(list(folder.iterdir()), [])
            with self.assertRaises(FileExistsError):
                import_common.new_download_dir('lmarena', root=self.root)

    def test_an_alias_must_name_a_model_in_the_snapshot(self):
        path = self.root / 'aliases.json'
        path.write_text(json.dumps({'version': 1, 'rule': 'Exact.', 'aliases': {'New Model': 'new-model'}}), encoding='utf-8')
        with self.assertRaisesRegex(SourceError, 'new-model, which is not in the snapshot'):
            import_common.read_aliases(path, SNAPSHOT_IDS)

    def test_tracked_alias_tables_name_only_snapshot_models(self):
        for name in ('lmarena', 'epoch', 'openrouter'):
            with self.subTest(table=name):
                aliases = import_common.read_aliases(ROOT / f'research/aliases/{name}.json', SNAPSHOT_IDS)
                self.assertTrue(aliases)

    def test_date_ranges(self):
        self.assertEqual(import_common.date_range(['2026-11-22']), '22 November 2026')
        self.assertEqual(import_common.date_range(['2026-11-22', '2026-11-09']), '9–22 November 2026')
        self.assertEqual(import_common.date_range(['2026-10-28', '2026-11-02']), '28 October–2 November 2026')
        self.assertEqual(import_common.date_range(['2025-12-30', '2026-01-02']), '30 December 2025–2 January 2026')

    def test_headers_are_sent_unredirected(self):
        sent = []

        def opened(request, timeout):
            sent.append(request)
            return FakeResponse(b'{}')

        with patch.object(import_common, 'urlopen', opened):
            self.assertEqual(import_common.fetch('https://example.org', headers={'X-Test': 'value'}), b'{}')
            import_common.fetch('https://example.org')
        self.assertEqual(sent[0].unredirected_hdrs, {'X-test': 'value'})
        self.assertEqual(sent[1].unredirected_hdrs, {})
        self.assertEqual(sent[0].headers, {'User-agent': import_common.USER_AGENT})

    def test_retries_then_stops(self):
        waits = []
        error = import_common.HTTPError('https://example.org', 503, 'busy', {}, None)
        with patch.object(import_common, 'urlopen', side_effect=error):
            with self.assertRaisesRegex(SourceError, 'HTTP 503'):
                import_common.fetch('https://example.org', sleep=waits.append)
        self.assertEqual(waits, [10, 20, 30])


class TestNoNewModels(Folder):
    """An import never adds a model: every kept result names a snapshot model, and the snapshot is unchanged."""

    def run_main(self, module, *arguments):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            module.main(list(arguments))
        return output.getvalue()

    def test_imports_leave_the_snapshot_unchanged(self):
        before = digest(import_common.SNAPSHOT)
        lmarena_out, epoch_out = self.root / 'lmarena.json', self.root / 'epoch-runs.json'
        with patch.object(import_lmarena, 'LEADERBOARDS', SAMPLE_BOARDS):
            printed = self.run_main(import_lmarena, '--from', str(FIXTURES / 'lmarena'), '--out', str(lmarena_out))
        self.assertIn('6 results', printed)
        self.assertIn('DeepSeek-V4.1-Flash-20260910 (Max)', printed)
        with patch.object(import_epoch, 'FILES', SAMPLE_FILES):
            printed = self.run_main(import_epoch, '--from', str(epoch_zip(self.root / 'epoch')), '--out', str(epoch_out))
        self.assertIn('3 results', printed)
        openrouter_out = self.root / 'openrouter-usage.json'
        printed = self.run_main(import_openrouter, '--from', str(FIXTURES / 'openrouter'), '--out', str(openrouter_out))
        self.assertIn('deepseek/deepseek-v4.1-flash-20260910', printed)
        self.assertEqual(digest(import_common.SNAPSHOT), before)
        for path in (lmarena_out, epoch_out):
            ids = {result['modelId'] for result in json.loads(path.read_text(encoding='utf-8'))['results']}
            self.assertLessEqual(ids, SNAPSHOT_IDS)
        self.assertLessEqual(usage_model_ids(json.loads(openrouter_out.read_text(encoding='utf-8'))), SNAPSHOT_IDS)

    def test_an_alias_to_a_new_model_stops_before_writing(self):
        aliases = json.loads((ROOT / 'research/aliases/lmarena.json').read_text(encoding='utf-8'))
        aliases['aliases']['Claude Opus 4.8'] = 'claude-opus-4-8-new'
        path, out = self.root / 'aliases.json', self.root / 'lmarena.json'
        path.write_text(json.dumps(aliases), encoding='utf-8')
        with self.assertRaises(SystemExit) as raised:
            self.run_main(import_lmarena, '--from', str(FIXTURES / 'lmarena'), '--aliases', str(path), '--out', str(out))
        self.assertIn('not in the snapshot', str(raised.exception))
        self.assertFalse(out.exists())

    def test_tracked_imports_name_only_snapshot_models(self):
        for name in ('lmarena', 'epoch-runs'):
            with self.subTest(file=name):
                data = json.loads((ROOT / f'research/{name}.json').read_text(encoding='utf-8'))
                self.assertLessEqual({result['modelId'] for result in data['results']}, SNAPSHOT_IDS)
        usage = json.loads((ROOT / 'research/openrouter-usage.json').read_text(encoding='utf-8'))
        self.assertLessEqual(usage_model_ids(usage), SNAPSHOT_IDS)

    def test_an_openrouter_alias_to_a_new_model_stops_before_writing(self):
        aliases = json.loads((ROOT / 'research/aliases/openrouter.json').read_text(encoding='utf-8'))
        aliases['aliases']['deepseek/deepseek-v4.1-flash-20260910'] = 'deepseek-v4-1-flash-0910'
        path, out = self.root / 'aliases.json', self.root / 'openrouter-usage.json'
        path.write_text(json.dumps(aliases), encoding='utf-8')
        with self.assertRaises(SystemExit) as raised:
            self.run_main(import_openrouter, '--from', str(FIXTURES / 'openrouter'), '--aliases', str(path), '--out', str(out))
        self.assertIn('not in the snapshot', str(raised.exception))
        self.assertFalse(out.exists())

    def test_output_under_local_is_refused(self):
        with self.assertRaisesRegex(SourceError, 'under .local'):
            import_common.write_reviewed(self.root / '.local/lmarena.json', {})


if __name__ == '__main__':
    unittest.main()
