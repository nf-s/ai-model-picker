"""Regression checks for the arXiv OAI reader, matching boundary, resumable state, labelling and results."""

import argparse
import io
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from arxiv_local.assess import (
    FAILED, FAILED_RESULT, MAX_FINDING, MAX_TAKEAWAY, MAX_TASK, MAX_TOPICS, Assessment, Assessor, Result,
    validate_assessment, validate_result,
)
from arxiv_local.sources import (
    ENDPOINT, MAX_ABSTRACT, MAX_DAY_PAGES, MAX_RETRY_DELAY, OAI, REQUEST_INTERVAL, OaiReader, Record,
    parse_page, read_record, retry_delay, utc_day,
)
from arxiv_local.state import Counters, State
from arxiv_pipeline import AI_ARCHIVES, AI_CUE, MATCH_VERSION, PRODUCT_SPELLING, assess, harvest_day, match, registry
from hn_local.classify import Targets
from hn_local.sources import PipelineError, timestamp

MODEL_FIXTURES = [
    {'id': 'claude-opus-4', 'name': 'Claude Opus 4'},
    {'id': 'claude-opus-4-8', 'name': 'Claude Opus 4.8', 'apiId': 'claude-opus-4-8'},
    {'id': 'glm-5-3', 'name': 'GLM-5.3'},
]
REVISED_FIXTURES = [
    {'id': 'claude-opus-4', 'name': 'Claude Opus 4'},
    {'id': 'claude-opus-4-8', 'name': 'Claude Opus 4.8', 'apiId': 'claude-opus-4-8'},
    {'id': 'gpt-6-astra', 'name': 'GPT-6 Astra', 'apiId': 'gpt-6-astra'},
]
OAI_NS = 'http://www.openarchives.org/OAI/2.0/'
RAW_NS = 'http://arxiv.org/OAI/arXivRaw/'
START = 1_780_272_000
DAY = '2026-06-02'
CS = ('cs.CL',)
SENSITIVE_PLACEHOLDERS = ('Placeholder Authorperson', 'Sample Submitterperson', 'synthetic.submitter@example.test')
CC_LICENSE = 'http://creativecommons.org/licenses/by/4.0/'
ARXIV_LICENSE = 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/'


def released(day, hour=12):
    return format_datetime(datetime.fromisoformat(f'{day}T{hour:02}:00:00+00:00'), usegmt=True)


def record(paper_id, title='A synthetic study', abstract='Synthetic abstract text.', categories='cs.CL cs.AI',
           versions=(released(DAY),), license_url=CC_LICENSE, deleted=False, identifier=None):
    author, submitter, contact = SENSITIVE_PLACEHOLDERS
    status = ' status="deleted"' if deleted else ''
    header = (
        f'<header{status}><identifier>{identifier or "oai:arXiv.org:" + paper_id}</identifier>'
        f'<datestamp>{DAY}</datestamp><setSpec>cs</setSpec></header>'
    )
    if deleted:
        return f'<record>{header}</record>'
    history = ''.join(
        f'<version version="v{number}"><date>{value}</date><size>12kb</size></version>'
        for number, value in enumerate(versions, 1)
    )
    return (
        f'<record>{header}<metadata><arXivRaw xmlns="{RAW_NS}"><id>{paper_id}</id>'
        f'<submitter>{submitter} &lt;{contact}&gt;</submitter>{history}'
        f'<title>{escape(title)}</title><authors>{author} and {submitter}</authors>'
        f'<categories>{categories}</categories><license>{license_url}</license>'
        f'<abstract>{escape(abstract)}</abstract></arXivRaw></metadata></record>'
    )


def page(*records, token=None):
    resumption = '<resumptionToken cursor="0"/>' if token is None else f'<resumptionToken>{token}</resumptionToken>'
    return (
        f'<?xml version="1.0" encoding="UTF-8"?><OAI-PMH xmlns="{OAI_NS}">'
        f'<responseDate>2026-06-03T00:00:00Z</responseDate>'
        f'<ListRecords>{"".join(records)}{resumption}</ListRecords></OAI-PMH>'
    ).encode()


def oai_error(code):
    return (
        f'<?xml version="1.0" encoding="UTF-8"?><OAI-PMH xmlns="{OAI_NS}">'
        f'<error code="{code}">synthetic</error></OAI-PMH>'
    ).encode()


def paper(paper_id, abstract, submitted, title='A synthetic study'):
    return Record(paper_id, 'paper', title, abstract, ('cs.CL',), CC_LICENSE, submitted, submitted, 1)


def labels(targets):
    return [(target.kind, target.label) for target in targets]


class PagesFixture:
    def __init__(self, days):
        self.days = days
        self.read = []

    def day(self, day):
        self.read.append(day)
        for data in self.days[day]:
            yield parse_page(data)[0]


class ClockFixture:
    def __init__(self):
        self.now = 1_000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class NetworkFixture:
    def __init__(self, clock, responses):
        self.clock = clock
        self.responses = list(responses)
        self.urls = []
        self.starts = []

    def __call__(self, url):
        self.urls.append(url)
        self.starts.append(self.clock.now)
        self.clock.now += 0.25
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class AssessorFixture:
    def __init__(self, failing=(), kind='usage', unextractable=()):
        self.failing = set(failing)
        self.kind = kind
        self.unextractable = set(unextractable)
        self.calls = []
        self.extracted = []

    def assess(self, title, _abstract, names):
        self.calls.append((title, tuple(names)))
        if title in self.failing:
            return FAILED
        return Assessment(self.kind, ('prompting',), 'Synthetic takeaway.')

    def extract(self, title, _abstract, names):
        self.extracted.append((title, tuple(names)))
        if title in self.unextractable:
            return FAILED_RESULT
        return Result('coding', 'Synthetic task', (0,), tuple(range(1, len(names))), 'Synthetic finding.')


class TestSources(unittest.TestCase):
    def assertCode(self, code, function, *args):
        with self.assertRaises(PipelineError) as raised:
            function(*args)
        self.assertEqual(str(raised.exception), code)

    def test_valid_record_keeps_allowlisted_metadata_only(self):
        data = page(record(
            '2606.01234', title='  Prompting\n   large   models ', abstract='First line.\n\n  Second\tline. ',
            versions=(released(DAY, 9), released('2026-06-04', 18)),
        ))
        records, token = parse_page(data)
        self.assertIsNone(token)
        self.assertEqual(records, [Record(
            '2606.01234', 'paper', 'Prompting large models', 'First line. Second line.', ('cs.CL', 'cs.AI'),
            CC_LICENSE, timestamp(datetime(2026, 6, 2, 9, tzinfo=timezone.utc)),
            timestamp(datetime(2026, 6, 4, 18, tzinfo=timezone.utc)), 2,
        )])
        element = ET.fromstring(data).find(f'{OAI}ListRecords/{OAI}record')
        self.assertEqual(read_record(element), records[0])
        for value in SENSITIVE_PLACEHOLDERS:
            self.assertNotIn(value, repr(records[0]) + records[0].abstract)

    def test_license_allowlist(self):
        for license_url, expected in (
            (CC_LICENSE, CC_LICENSE),
            (ARXIV_LICENSE, ARXIV_LICENSE),
            ('http://creativecommons.org/publicdomain/zero/1.0/', 'http://creativecommons.org/publicdomain/zero/1.0/'),
            ('https://example.test/licenses/by/4.0/', None),
            ('http://creativecommons.org/licenses/by/4.0/?track=1', None),
            ('', None),
        ):
            with self.subTest(license_url=license_url):
                records, _token = parse_page(page(record('2606.01234', license_url=license_url)))
                self.assertEqual(records[0].kind, 'paper')
                self.assertEqual(records[0].license, expected)

    def test_deleted_and_invalid_records(self):
        records, _token = parse_page(page(
            record('2606.00001', deleted=True),
            record('2606.00002', identifier='oai:arXiv.org:not an id'),
            record('2606.00003', identifier='oai:example.test:2606.00003'),
            record('2606.00004', versions=()),
            record('2606.00005', versions=('not a date',)),
            record('2606.00006', title=' \n '),
            record('2606.00007', abstract='word ' * (MAX_ABSTRACT // 5 + 1)),
            record('2606.00008', categories='cs.CL bad!category'),
            record('2606.00009', categories=''),
        ))
        self.assertEqual(
            [(value.id, value.kind) for value in records],
            [
                ('2606.00001', 'unavailable'),
                (None, 'invalid'),
                (None, 'invalid'),
                ('2606.00004', 'invalid'),
                ('2606.00005', 'invalid'),
                ('2606.00006', 'invalid'),
                ('2606.00007', 'invalid'),
                ('2606.00008', 'invalid'),
                ('2606.00009', 'invalid'),
            ],
        )

    def test_papers_older_than_the_window_stay_valid(self):
        records, _token = parse_page(page(record(
            'hep-th/9501001', categories='hep-th', versions=(released('1995-01-05'), released(DAY)),
        )))
        self.assertEqual(
            (records[0].kind, utc_day(records[0].submitted).isoformat(), records[0].versions),
            ('paper', '1995-01-05', 2),
        )
        records, _token = parse_page(page(record('2606.00001', versions=(released('2101-01-05'),))))
        self.assertEqual(records[0].kind, 'invalid')

    def test_page_errors_and_resumption_tokens(self):
        self.assertEqual(parse_page(oai_error('noRecordsMatch')), ([], None))
        self.assertCode('arxiv-oai-error', parse_page, oai_error('badResumptionToken'))
        self.assertCode('arxiv-oai-response', parse_page, b'<OAI-PMH><ListRecords>')
        self.assertCode(
            'arxiv-oai-response', parse_page,
            f'<OAI-PMH xmlns="{OAI_NS}"><GetRecord/></OAI-PMH>'.encode(),
        )
        self.assertEqual(parse_page(page(token=' synthetic-token|2000 '))[1], 'synthetic-token|2000')
        for token in ('synthetic token', 'a' * 1025):
            with self.subTest(token=token[:20]):
                self.assertCode('arxiv-oai-response', parse_page, page(token=token))


class TestReader(unittest.TestCase):
    def setUp(self):
        self.clock = ClockFixture()

    def http_error(self, code, retry_after=None):
        headers = {} if retry_after is None else {'Retry-After': retry_after}
        error = HTTPError(ENDPOINT, code, 'synthetic', headers, None)
        self.addCleanup(error.close)
        return error

    def reader(self, responses):
        network = NetworkFixture(self.clock, responses)
        return OaiReader(read=network, sleep=self.clock.sleep, clock=self.clock), network

    def assertCode(self, code, function, *args):
        with self.assertRaises(PipelineError) as raised:
            function(*args)
        self.assertEqual(str(raised.exception), code)

    def test_requests_are_paced(self):
        reader, network = self.reader([b'one', b'two', b'three'])
        self.assertEqual([reader.request({'verb': 'Identify'}) for _ in range(3)], [b'one', b'two', b'three'])
        self.assertEqual(reader.requests, 3)
        for earlier, later in zip(network.starts, network.starts[1:]):
            self.assertGreaterEqual(later - earlier, REQUEST_INTERVAL)

    def test_retry_after_and_exponential_backoff(self):
        reader, network = self.reader([self.http_error(503, '120'), b'ok'])
        self.assertEqual(reader.request({'verb': 'Identify'}), b'ok')
        self.assertEqual(self.clock.sleeps, [120.0])
        self.assertGreaterEqual(network.starts[1] - network.starts[0], 120)

        self.clock.sleeps.clear()
        reader, network = self.reader([OSError(), TimeoutError(), OSError(), b'ok'])
        self.assertEqual(reader.request({'verb': 'Identify'}), b'ok')
        self.assertEqual(self.clock.sleeps, [REQUEST_INTERVAL * 2**attempt for attempt in range(3)])

        self.assertEqual(retry_delay(self.http_error(429, '999999'), 0), MAX_RETRY_DELAY)
        self.assertEqual(retry_delay(self.http_error(429, 'synthetic'), 2), REQUEST_INTERVAL * 4)

    def test_failures_stop_requests(self):
        reader, network = self.reader([self.http_error(400)])
        self.assertCode('arxiv-oai-unavailable', reader.request, {'verb': 'Identify'})
        self.assertEqual(reader.requests, 1)

        reader, network = self.reader([self.http_error(503), OSError(), self.http_error(502), OSError()])
        self.assertCode('arxiv-oai-unavailable', reader.request, {'verb': 'Identify'})
        self.assertEqual(reader.requests, 4)
        self.assertEqual(network.responses, [])

    def test_day_follows_resumption_tokens(self):
        reader, network = self.reader([
            page(record('2606.00001'), token='synthetic-token|1'),
            page(record('2606.00002')),
        ])
        pages = list(reader.day(DAY))
        self.assertEqual([[value.id for value in records] for records in pages], [['2606.00001'], ['2606.00002']])
        first, follow = (parse_qs(urlsplit(url).query) for url in network.urls)
        self.assertTrue(all(url.startswith(f'{ENDPOINT}?') for url in network.urls))
        self.assertEqual(
            first, {'verb': ['ListRecords'], 'metadataPrefix': ['arXivRaw'], 'from': [DAY], 'until': [DAY]},
        )
        self.assertEqual(follow, {'verb': ['ListRecords'], 'resumptionToken': ['synthetic-token|1']})

    def test_day_rejects_bad_day_and_endless_tokens(self):
        reader, network = self.reader([])
        self.assertCode('arxiv-oai-day', list, reader.day('2026-6-2'))
        self.assertEqual(network.urls, [])

        reader, network = self.reader([page(token='synthetic-token')] * MAX_DAY_PAGES)
        self.assertCode('arxiv-oai-page-limit', list, reader.day(DAY))
        self.assertEqual(reader.requests, MAX_DAY_PAGES)


class TestHarvest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.targets = Targets(MODEL_FIXTURES)

    def harvest(self, state, days, day=DAY, complete=True):
        counters, papers, cleared = harvest_day(PagesFixture(days), self.targets, START, day)
        state.checkpoint(day, counters, papers, cleared, complete)
        return counters, papers, cleared

    def count(self, state, table):
        return state.connection.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def new_state(self, last_day=date(2026, 6, 4)):
        state = State(self.directory)
        state.initialize('fixture-registry', START)
        state.extend(last_day)
        return state

    def test_window_matching_and_counters(self):
        pages = [
            page(
                record('2606.00001', title='Prompting   Claude Opus 4.8\n for proofs'),
                record('2606.00002', abstract='We call claude-opus-4-8 through an API.'),
                record('2606.00003', abstract='Opus 4.8 solves more tasks.'),
                record('2606.00004', abstract='We evaluate Claude Opus 4.9 on reasoning benchmarks.'),
                token='synthetic-token|1',
            ),
            page(
                record('2606.00005', abstract='A survey of river sediment transport.'),
                record('2606.00006', title='Gemini and Llama in the Andes',
                       abstract='Observations of the Gemini constellation from llama farms.'),
                record('2606.00007', abstract='Gains hold at p < 0.05 & recall > 90% when <script> output '
                                              'and Claude Opus 4.8 agree.'),
                record('2506.09999', abstract='Claude Opus 4.8 is evaluated.',
                       versions=(released('2025-06-20'), released(DAY))),
                record('2606.00099', deleted=True),
                record('2606.00098', title=''),
            ),
        ]
        with self.new_state() as state:
            counters, papers, cleared = self.harvest(state, {DAY: pages})
            self.assertEqual(counters, Counters(records=10, eligible=7, unavailable=1, invalid=1))
            self.assertEqual(cleared, ['2606.00099', '2606.00098'])
            self.assertEqual(
                {value.id: labels(targets) for value, targets in papers},
                {
                    '2606.00001': [('model', 'claude-opus-4-8')],
                    '2606.00002': [('model', 'claude-opus-4-8')],
                    '2606.00003': [('model', 'claude-opus-4-8')],
                    '2606.00004': [('family', 'Claude Opus')],
                    '2606.00005': [],
                    '2606.00006': [],
                    '2606.00007': [('model', 'claude-opus-4-8')],
                },
            )
            status = state.export()
            stored = state.connection.execute("SELECT title FROM paper WHERE id = '2606.00001'").fetchone()
        self.assertEqual(stored['title'], 'Prompting Claude Opus 4.8 for proofs')
        totals = status['totals']
        self.assertEqual(
            (totals['recordsScanned'], totals['recordsEligible'], totals['recordsStored'], totals['papers']),
            (10, 7, 7, 5),
        )
        self.assertEqual((totals['unavailable'], totals['invalid']), (1, 1))
        self.assertEqual(
            [(day['day'], day['state'], day['records'], day['papers']) for day in status['days']],
            [('2026-06-01', 'pending', 0, 0), (DAY, 'complete', 10, 5), ('2026-06-03', 'pending', 0, 0),
             ('2026-06-04', 'pending', 0, 0)],
        )
        results = json.loads((self.directory / 'papers.json').read_text())
        self.assertNotIn('2506.09999', [entry['id'] for entry in results['papers']])
        for file in self.directory.iterdir():
            for value in SENSITIVE_PLACEHOLDERS:
                self.assertNotIn(value.encode(), file.read_bytes())

    def test_comparison_signs_do_not_hide_mentions(self):
        for title, abstract in (
            ('Recall study', '> 90% recall is reached with Claude Opus 4.8.'),
            ('> 90% recall with Claude Opus 4.8', 'Synthetic abstract text.'),
            ('Recall study', 'At p<0.05 & recall>90%, <code> and Claude Opus 4.8 agree.'),
        ):
            with self.subTest(title=title, abstract=abstract):
                self.assertEqual(labels(match(self.targets, title, abstract, CS)), [('model', 'claude-opus-4-8')])

    def test_ambiguous_family_names_need_ai_context(self):
        self.assertEqual(match(self.targets, 'Gemini and Llama in the Andes', 'Field notes on llama herds.', CS), ())
        self.assertEqual(match(self.targets, 'Twin stars', 'The Gemini constellation at dusk.', CS), ())
        self.assertEqual(
            labels(match(self.targets, 'Gemini under load', 'Gemini models hallucinate on long prompts.', CS)),
            [('family', 'Gemini')],
        )

    def test_family_names_need_field_or_cue_and_product_spelling(self):
        self.assertEqual(set(PRODUCT_SPELLING), {'MiniMax', 'Microsoft Phi', 'Cohere Command'})
        self.assertTrue({'cs', 'stat', 'eess'} <= AI_ARCHIVES)
        self.assertIsNone(AI_CUE.search('Gemini models of stellar spectra.'))
        for title, abstract, categories, expected in (
            ('Bounds', 'We prove a minimax lower bound for the model.', ['cs.LG'], []),
            ('Small models', 'We evaluate MiniMax M2 and Phi-4-mini as language models.', ['cs.CL'],
             [('family', 'MiniMax'), ('family', 'Microsoft Phi')]),
            ('Field theory', r'The $\phi^4$ and phi-4 field model at finite temperature.', ['hep-th'], []),
            ('Robots', 'We command a robot with an LLM model.', ['cs.RO'], []),
            ('Robots', 'We use Command R and Command~A models.', ['cs.CL'], [('family', 'Cohere Command')]),
            ('Spectra', 'Gemini models of stellar spectra.', ['astro-ph.SR'], []),
            ('Spectra', 'Gemini models of stellar spectra.', ['stat.ML'], [('family', 'Gemini')]),
            ('Proofs', 'Gemini as an AI model proves lemmas.', ['math.CO'], [('family', 'Gemini')]),
            ('Proofs', 'Claude Opus 4.8 proves lemmas.', ['math.CO'], [('model', 'claude-opus-4-8')]),
        ):
            with self.subTest(abstract=abstract, categories=categories):
                self.assertEqual(labels(match(self.targets, title, abstract, categories)), expected)

    def test_registry_includes_match_version(self):
        self.assertEqual(registry(self.targets), f'{MATCH_VERSION}/{self.targets.registry_id}')
        self.assertNotEqual(registry(self.targets), registry(Targets(REVISED_FIXTURES)))

    def test_partial_days_are_read_again_and_open_day_is_last(self):
        with self.new_state() as state:
            self.assertEqual(
                [row['day'] for row in state.connection.execute('SELECT day FROM partition ORDER BY day')],
                ['2026-06-01', DAY, '2026-06-03', '2026-06-04'],
            )
            self.assertEqual(state.pending_days(), ['2026-06-03', DAY, '2026-06-01', '2026-06-04'])
            self.harvest(state, {'2026-06-03': [page(record('2606.00001'))]}, '2026-06-03')
            self.harvest(state, {'2026-06-04': [page(record('2606.00002'))]}, '2026-06-04', complete=False)
            self.assertEqual(state.pending_days(), [DAY, '2026-06-01', '2026-06-04'])
            state.extend(date(2026, 6, 4))
            self.assertEqual(self.count(state, 'partition'), 4)
            state.extend(date(2026, 6, 5))
            self.assertEqual(state.pending_days(), ['2026-06-04', DAY, '2026-06-01', '2026-06-05'])
            status = state.status()
        self.assertEqual(
            [(day['day'], day['state']) for day in status['days']][2:],
            [('2026-06-03', 'complete'), ('2026-06-04', 'partial'), ('2026-06-05', 'pending')],
        )

    def test_reharvest_replaces_day_counters(self):
        first = [page(record('2606.00001', abstract='Claude Opus 4.8 is evaluated.'), record('2606.00002'))]
        second = [page(
            record('2606.00001', abstract='Claude Opus 4.8 is evaluated.'), record('2606.00002'),
            record('2606.00003', abstract='Opus 4.8 is evaluated.'),
        )]
        with self.new_state() as state:
            self.harvest(state, {DAY: first}, complete=False)
            self.harvest(state, {DAY: second})
            status = state.status()
        self.assertEqual(status['totals']['recordsScanned'], 3)
        self.assertEqual(status['totals']['recordsEligible'], 3)
        self.assertEqual(status['totals']['recordsStored'], 3)
        self.assertEqual(status['totals']['papers'], 2)
        self.assertEqual(status['days'][1]['papers'], 2)

    def test_revised_paper_moves_to_new_day_without_duplicate(self):
        revised = record(
            '2606.00001', title='Claude Opus 4.8 revisited', versions=(released(DAY), released('2026-06-03')),
        )
        with self.new_state() as state:
            self.harvest(state, {DAY: [page(record('2606.00001', title='Claude Opus 4.8 study'))]})
            self.harvest(state, {'2026-06-03': [page(revised)]}, '2026-06-03')
            rows = list(state.connection.execute('SELECT id, day, title, versions FROM paper'))
            status = state.status()
        self.assertEqual([tuple(row) for row in rows], [('2606.00001', '2026-06-03', 'Claude Opus 4.8 revisited', 2)])
        self.assertEqual(status['totals']['papers'], 1)
        self.assertEqual([day['papers'] for day in status['days']], [0, 0, 1, 0])

    def test_deleted_record_removes_paper_mentions_and_assessments(self):
        with self.new_state() as state:
            self.harvest(state, {DAY: [page(
                record('2606.00001', abstract='Claude Opus 4.8 is evaluated.'),
                record('2606.00002', abstract='Opus 4.8 is evaluated.'),
            )]})
            state.set_assessor('fixture-assessor', 'key')
            for row in state.unassessed('key', 10):
                state.add_assessment('key', row['id'], row['digest'], Assessment('evaluation', (), None))
                state.add_result(
                    'key', row['id'], row['digest'], Result('coding', 'Synthetic task', (0,), (), None),
                    state.paper_targets(row['id']),
                )
            self.assertEqual((self.count(state, 'assessment'), self.count(state, 'result')), (2, 2))
            self.harvest(state, {'2026-06-03': [page(
                record('2606.00001', deleted=True),
                record('2606.00002', categories=''),
            )]}, '2026-06-03')
            for table in ('paper', 'mention', 'assessment', 'result'):
                self.assertEqual(self.count(state, table), 0)
            self.assertEqual(state.status()['totals']['papers'], 0)

    def test_rematch_updates_mentions_and_keeps_unchanged_assessments(self):
        revised = Targets(REVISED_FIXTURES)
        with self.new_state() as state:
            self.harvest(state, {DAY: [page(
                record('2606.00001', abstract='Claude Opus 4.8 is evaluated.'),
                record('2606.00002', abstract='GLM-5.3 solves tasks.'),
                record('2606.00003', abstract='The GPT-6 Astra survey of river sediment.'),
                record('2606.00004', abstract='Gemini models of stellar spectra.', categories='stat.ML astro-ph.SR'),
            )]})
            state.set_assessor('fixture-assessor', 'key')
            for row in state.unassessed('key', 10):
                state.add_assessment('key', row['id'], row['digest'], Assessment('evaluation', ('prompting',), None))
                state.add_result(
                    'key', row['id'], row['digest'], Result('coding', 'Synthetic task', (0,), (), None),
                    state.paper_targets(row['id']),
                )
            self.assertEqual(state.status()['days'][1]['papers'], 3)
            state.rematch(registry(revised), lambda *values: match(revised, *values))
            mentions = list(state.connection.execute('SELECT * FROM mention ORDER BY paper_id'))
            assessed = [row[0] for row in state.connection.execute('SELECT paper_id FROM assessment')]
            extracted = [row[0] for row in state.connection.execute('SELECT paper_id FROM result')]
            status = state.status()
        self.assertEqual(
            [tuple(row) for row in mentions],
            [('2606.00001', 'model', 'claude-opus-4-8'), ('2606.00002', 'family', 'GLM'),
             ('2606.00003', 'model', 'gpt-6-astra'), ('2606.00004', 'family', 'Gemini')],
        )
        self.assertEqual(sorted(assessed), ['2606.00001', '2606.00004'])
        self.assertEqual(sorted(extracted), sorted(assessed))
        self.assertEqual(status['registry'], registry(revised))
        self.assertEqual(status['days'][1]['papers'], 4)
        self.assertEqual((status['totals']['papers'], status['totals']['assessed']), (4, 2))
        self.assertEqual((status['totals']['results'], status['totals']['resultFailures']), (2, 0))


class TestAssessment(unittest.TestCase):
    def test_validation_enforces_enums_and_limits(self):
        result = validate_assessment(json.dumps({
            'kind': 'usage',
            'topics': ['prompting', 'synthetic-unknown', 'prompting', 'agents', 'tools', 'coding', 'cost'],
            'takeaway': '  Use   short\n prompts. ',
        }))
        self.assertEqual(result.kind, 'usage')
        self.assertEqual(result.topics, ('prompting', 'agents', 'tools', 'coding', 'cost')[:MAX_TOPICS])
        self.assertEqual(result.takeaway, 'Use short prompts.')
        self.assertFalse(result.failed)
        self.assertEqual(
            validate_assessment('{"kind":"evaluation","topics":[],"takeaway":"' + 'x' * MAX_TAKEAWAY + '"}').takeaway,
            'x' * MAX_TAKEAWAY,
        )
        self.assertIsNone(validate_assessment('{"kind":"usage","topics":[],"takeaway":"   "}').takeaway)
        other = validate_assessment('{"kind":"other","topics":["coding"],"takeaway":"Synthetic advice."}')
        self.assertEqual((other.topics, other.takeaway), (('coding',), None))
        fenced = validate_assessment(
            '<think>synthetic</think>```json\n{"kind":"release","topics":["agents"],"takeaway":null}\n```'
        )
        self.assertEqual(fenced, Assessment('release', ('agents',), None))
        for message in (
            '{"kind":"Usage","topics":[],"takeaway":null}',
            '{"kind":"synthetic-kind","topics":[],"takeaway":null}',
            '{"kind":"usage","topics":"coding","takeaway":null}',
            '{"kind":"usage","topics":[1],"takeaway":null}',
            '{"kind":"usage","topics":[],"takeaway":7}',
            '{"kind":"usage","topics":[],"takeaway":"' + 'x' * (MAX_TAKEAWAY + 1) + '"}',
            '{"kind":"usage","topics":[],"takeaway":null,"summary":"synthetic-extra"}',
            '{"kind":"usage","topics":[]}',
            '["usage",[],null]',
            'not json',
        ):
            with self.subTest(message=message[:40]):
                with self.assertRaises(ValueError):
                    validate_assessment(message)

    def test_assessor_retries_once_then_fails(self):
        assessor = Assessor('http://127.0.0.1:8790/v1/chat/completions', 'fixture')
        valid = '{"kind":"usage","topics":["prompting"],"takeaway":null}'
        with patch.object(assessor, 'request', side_effect=['not json', valid]) as request:
            self.assertEqual(
                assessor.assess('Synthetic title', 'Synthetic abstract.', ['Claude Opus 4.8']),
                Assessment('usage', ('prompting',), None),
            )
        self.assertEqual(request.call_count, 2)
        self.assertIn('Claude Opus 4.8', request.call_args_list[0].args[1])
        with patch.object(assessor, 'request', side_effect=['not json', '{"kind":"usage"}']) as request:
            self.assertIs(assessor.assess('Synthetic title', 'Synthetic abstract.', []), FAILED)
        self.assertEqual(request.call_count, 2)

    def test_result_validation_maps_names_and_enforces_limits(self):
        names = ['Claude Opus 4.8', 'GPT-6 Astra', 'Qwen']
        result = validate_result(json.dumps({
            'area': 'coding',
            'task': '  fixing   bugs\n in repositories ',
            'best': ['gpt-6-astra', 'Synthetic Unlisted Model'],
            'weak': ['QWEN', 'Qwen'],
            'finding': ' GPT-6 Astra  leads at 61%. ',
        }), names)
        self.assertEqual(
            result, Result('coding', 'Fixing bugs in repositories', (1,), (2,), 'GPT-6 Astra leads at 61%.'),
        )
        self.assertFalse(result.failed)
        untested = validate_result(
            '<think>synthetic</think>```json\n'
            '{"area":"other","task":"Synthetic task","best":[],"weak":[],"finding":"  "}\n```', names,
        )
        self.assertEqual(untested, Result('other', 'Synthetic task', (), (), None))
        alone = '{"area":"coding","task":"Synthetic task","best":["Synthetic Unlisted Model"],"weak":["Qwen"],' \
            '"finding":null}'
        self.assertEqual(validate_result(alone, names), Result('coding', 'Synthetic task', (), (), None))
        longest = '{"area":"domain","task":"' + 'x' * MAX_TASK + '","best":[],"weak":[],"finding":"' \
            + 'y' * MAX_FINDING + '"}'
        self.assertEqual(len(validate_result(longest, names).finding), MAX_FINDING)
        for message in (
            '{"area":"Coding","task":"Synthetic task","best":[],"weak":[],"finding":null}',
            '{"area":"synthetic-area","task":"Synthetic task","best":[],"weak":[],"finding":null}',
            '{"area":"coding","task":"  ","best":[],"weak":[],"finding":null}',
            '{"area":"coding","task":7,"best":[],"weak":[],"finding":null}',
            '{"area":"coding","task":"' + 'x' * (MAX_TASK + 1) + '","best":[],"weak":[],"finding":null}',
            '{"area":"coding","task":"Synthetic task","best":"Qwen","weak":[],"finding":null}',
            '{"area":"coding","task":"Synthetic task","best":[1],"weak":[],"finding":null}',
            '{"area":"coding","task":"Synthetic task","best":["Qwen"],"weak":["qwen"],"finding":null}',
            '{"area":"coding","task":"Synthetic task","best":[],"weak":[],"finding":7}',
            '{"area":"coding","task":"Synthetic task","best":[],"weak":[],"finding":"' + 'x' * (MAX_FINDING + 1) + '"}',
            '{"area":"coding","task":"Synthetic task","best":[],"weak":[],"finding":null,"note":"synthetic-extra"}',
            '{"area":"coding","task":"Synthetic task","best":[],"weak":[]}',
            'not json',
        ):
            with self.subTest(message=message[:60]):
                with self.assertRaises(ValueError):
                    validate_result(message, names)

    def test_extractor_retries_once_then_fails(self):
        assessor = Assessor('http://127.0.0.1:8790/v1/chat/completions', 'fixture')
        valid = '{"area":"coding","task":"Synthetic task","best":["Claude Opus 4.8"],"weak":[],"finding":null}'
        with patch.object(assessor, 'request', side_effect=['not json', valid]) as request:
            self.assertEqual(
                assessor.extract('Synthetic title', 'Synthetic abstract.', ['Claude Opus 4.8']),
                Result('coding', 'Synthetic task', (0,), (), None),
            )
        self.assertEqual(request.call_count, 2)
        self.assertIn('Named models: Claude Opus 4.8', request.call_args_list[0].args[1])
        with patch.object(assessor, 'request', side_effect=['not json', '{"area":"coding"}']) as request:
            self.assertIs(assessor.extract('Synthetic title', 'Synthetic abstract.', []), FAILED_RESULT)
        self.assertEqual(request.call_count, 2)

    def test_assessor_requires_loopback(self):
        for endpoint in (
            'https://example.test/v1/chat/completions',
            'http://192.0.2.10:8790/v1/chat/completions',
            'http://127.0.0.1@example.test:8790/v1/chat/completions',
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(PipelineError):
                Assessor(endpoint, 'fixture')


class TestAssessFlow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.targets = Targets(MODEL_FIXTURES)
        records = [
            paper('2606.00010', 'Claude Opus 4.8 is evaluated.', START + 100, 'Older model paper'),
            paper('2606.00011', 'Opus 4.8 and Claude Opus 4 are compared.', START + 200, 'Newer model paper'),
            paper('2606.00012', 'Claude Opus 4.9 is evaluated.', START + 300, 'Family paper'),
            paper('2606.00013', 'A survey of river sediment transport.', START + 400, 'Unmatched paper'),
        ]
        with State(self.directory) as state:
            state.initialize('fixture-registry', START)
            state.extend(date(2026, 6, 1))
            papers = [(value, match(self.targets, value.title, value.abstract, value.categories)) for value in records]
            state.checkpoint('2026-06-01', Counters(records=4, eligible=4), papers, [], True)

    def run_assess(self, assessor, max_papers=None, exact_models=False):
        args = argparse.Namespace(
            assessor_id='fixture-assessor', model='fixture-model', workers=1, max_papers=max_papers,
            endpoint='http://127.0.0.1:8790/v1/chat/completions', exact_models=exact_models,
        )
        with (
            State(self.directory) as state,
            patch('arxiv_pipeline.Assessor', return_value=assessor),
            patch('arxiv_pipeline.load_targets', return_value=self.targets),
            patch('arxiv_pipeline.stop_flag', return_value=lambda: False),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(assess(args, state), 0)
            return state.status()

    def test_order_and_budget(self):
        assessor = AssessorFixture()
        status = self.run_assess(assessor, max_papers=2)
        self.assertEqual(
            assessor.calls,
            [('Newer model paper', ('Claude Opus 4', 'Claude Opus 4.8')), ('Older model paper', ('Claude Opus 4.8',))],
        )
        self.assertEqual((status['totals']['assessed'], status['totals']['assessmentFailures']), (2, 0))
        self.assertEqual(status['assessor'], 'fixture-assessor')
        assessor = AssessorFixture()
        status = self.run_assess(assessor)
        self.assertEqual(assessor.calls, [('Family paper', ('Claude Opus',))])
        self.assertEqual(status['totals']['assessed'], 3)

    def test_exact_models_only_skips_family_papers(self):
        assessor = AssessorFixture(failing={'Older model paper'})
        status = self.run_assess(assessor, exact_models=True)
        self.assertEqual(
            [title for title, _names in assessor.calls],
            ['Newer model paper', 'Older model paper', 'Older model paper'],
        )
        self.assertEqual((status['totals']['assessed'], status['totals']['assessmentFailures']), (1, 1))
        with State(self.directory) as state:
            for row in state.unassessed(state.job()['assessor_key'], 10):
                state.add_assessment(state.job()['assessor_key'], row['id'], row['digest'], FAILED)
        assessor = AssessorFixture()
        self.run_assess(assessor, exact_models=True)
        self.assertEqual([title for title, _names in assessor.calls], ['Older model paper'])
        assessor = AssessorFixture()
        status = self.run_assess(assessor)
        self.assertEqual([title for title, _names in assessor.calls], ['Family paper'])
        self.assertEqual((status['totals']['assessed'], status['totals']['assessmentFailures']), (3, 0))

    def test_failed_rows_are_retried_once_per_invocation(self):
        assessor = AssessorFixture(failing={'Older model paper'})
        status = self.run_assess(assessor)
        self.assertEqual(
            [title for title, _names in assessor.calls],
            ['Newer model paper', 'Older model paper', 'Family paper', 'Older model paper'],
        )
        self.assertEqual((status['totals']['assessed'], status['totals']['assessmentFailures']), (2, 1))
        with State(self.directory) as state:
            results = state.results(status)
        self.assertIsNone(next(entry for entry in results['papers'] if entry['id'] == '2606.00010')['assessment'])
        assessor = AssessorFixture()
        status = self.run_assess(assessor)
        self.assertEqual([title for title, _names in assessor.calls], ['Older model paper'])
        self.assertEqual((status['totals']['assessed'], status['totals']['assessmentFailures']), (3, 0))

    def test_results_follow_evaluation_labels(self):
        assessor = AssessorFixture(kind='evaluation', unextractable={'Older model paper'})
        status = self.run_assess(assessor, exact_models=True)
        self.assertEqual([title for title, _names in assessor.calls], ['Newer model paper', 'Older model paper'])
        self.assertEqual(
            assessor.extracted,
            [('Newer model paper', ('Claude Opus 4', 'Claude Opus 4.8')), ('Older model paper', ('Claude Opus 4.8',)),
             ('Older model paper', ('Claude Opus 4.8',))],
        )
        self.assertEqual((status['totals']['results'], status['totals']['resultFailures']), (1, 1))
        with State(self.directory) as state:
            papers = {entry['id']: entry for entry in state.results(status)['papers']}
        self.assertEqual(papers['2606.00011']['result'], {
            'area': 'coding',
            'task': 'Synthetic task',
            'best': [{'kind': 'model', 'target': 'claude-opus-4'}],
            'weak': [{'kind': 'model', 'target': 'claude-opus-4-8'}],
            'finding': 'Synthetic finding.',
        })
        self.assertIsNone(papers['2606.00010']['result'])
        self.assertIsNone(papers['2606.00012']['result'])
        assessor = AssessorFixture(kind='evaluation')
        status = self.run_assess(assessor)
        self.assertEqual([title for title, _names in assessor.calls], ['Family paper'])
        self.assertEqual([title for title, _names in assessor.extracted], ['Family paper', 'Older model paper'])
        self.assertEqual((status['totals']['results'], status['totals']['resultFailures']), (3, 0))

    def test_results_share_the_budget_and_skip_other_kinds(self):
        assessor = AssessorFixture(kind='evaluation')
        status = self.run_assess(assessor, max_papers=3)
        self.assertEqual((len(assessor.calls), assessor.extracted), (3, []))
        self.assertEqual((status['totals']['assessed'], status['totals']['results']), (3, 0))
        assessor = AssessorFixture()
        status = self.run_assess(assessor, max_papers=1)
        self.assertEqual((assessor.calls, [title for title, _names in assessor.extracted]), ([], ['Family paper']))
        self.assertEqual(status['totals']['results'], 1)
        with State(self.directory) as state:
            key = state.job()['assessor_key']
            row = state.connection.execute("SELECT digest FROM paper WHERE id = '2606.00012'").fetchone()
            state.add_assessment(key, '2606.00012', row['digest'], Assessment('usage', (), None))
            status = state.status()
            papers = {entry['id']: entry for entry in state.results(status)['papers']}
        self.assertEqual(status['totals']['results'], 0)
        self.assertIsNone(papers['2606.00012']['result'])

    def test_export_shape(self):
        self.run_assess(AssessorFixture())
        with State(self.directory) as state:
            status = state.export()
        results = json.loads((self.directory / 'papers.json').read_text())
        self.assertEqual(json.loads((self.directory / 'status.json').read_text()), status)
        self.assertEqual(
            list(results),
            ['schemaVersion', 'updatedAt', 'assessor', 'startAt', 'coverage', 'models', 'families', 'papers'],
        )
        self.assertEqual([entry['id'] for entry in results['papers']], ['2606.00012', '2606.00011', '2606.00010'])
        for entry in results['papers']:
            self.assertEqual(
                set(entry), {'id', 'title', 'submittedAt', 'categories', 'targets', 'assessment', 'result'},
            )
            self.assertIsNone(entry['result'])
        self.assertEqual(
            results['papers'][1]['targets'],
            [{'kind': 'model', 'target': 'claude-opus-4'}, {'kind': 'model', 'target': 'claude-opus-4-8'}],
        )
        self.assertEqual(
            results['papers'][0]['assessment'],
            {'kind': 'usage', 'topics': ['prompting'], 'takeaway': 'Synthetic takeaway.'},
        )
        self.assertEqual([model['modelId'] for model in results['models']], ['claude-opus-4', 'claude-opus-4-8'])
        self.assertEqual([family['familyName'] for family in results['families']], ['Claude Opus'])
        aggregate = results['models'][1]
        self.assertTrue({'papers', 'months', 'kinds', 'topics'} <= set(aggregate))
        self.assertEqual((aggregate['papers'], aggregate['months']), (2, {'2026-06': 2}))
        self.assertEqual((aggregate['kinds']['usage'], aggregate['topics']['prompting']), (2, 2))
        self.assertEqual(results['coverage']['assessed'], 3)
        self.assertEqual((results['coverage']['results'], results['coverage']['resultFailures']), (0, 0))
        self.assertEqual(results['coverage']['papers'], 3)
        self.assertNotIn('river sediment', json.dumps(results))


if __name__ == '__main__':
    unittest.main()
