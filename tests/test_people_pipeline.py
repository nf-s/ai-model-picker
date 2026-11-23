"""Check the people pipeline with invented people, saved sample pages and a stand-in batch client:
polite collection, bylines, redaction, reply validation, resumable state, the lock and what the
state files hold. Nothing here reaches the network or Anthropic."""

import contextlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import people_pipeline
from hn_local.sources import PipelineError
from hn_local.state import writer_lock
from people_local import batches as batch_api
from people_local import fetch as fetch_module
from people_local.collect import byline_ok, discover, gather, known
from people_local.config import load, redaction_pattern
from people_local.fetch import AGENT, SPACING, Fetcher, http_get
from people_local.redact import Privacy, hide_blocks, own_names, passage_ranges, plain_links
from people_local.review import (
    ADVICE_FIELDS, JOBS, MAX_OUTPUT, PROMPT_SHA256, RETRY_NOTE, SCHEMA, SYSTEM, USE_FIELDS, ReviewError, job_list,
    params, prompt_hash, repair, validate,
)
from people_local.state import SCHEMA as STATE_SCHEMA, Checkpoint, file_sha256, items

FIXTURES = ROOT / 'tests/fixtures/people'
PAGES = FIXTURES / 'pages'
SINCE, UNTIL = '2025-11-23', '2026-11-23'


def page(name):
    return (PAGES / name).read_bytes()


# The web as the stand-in transport serves it: address -> (status, body, Location header).
WEB = {
    'https://ada.example.com/robots.txt': (200, page('robots-ada.txt'), ''),
    'https://ada.example.com/feed.xml': (200, page('ada-feed.xml'), ''),
    'https://ada.example.com/sitemap.xml': (200, page('ada-sitemap-index.xml'), ''),
    'https://ada.example.com/sitemap-posts.xml': (200, page('ada-sitemap-posts.xml'), ''),
    'https://ada.example.com/posts/porting-renderer': (200, page('ada-article.html'), ''),
    'https://ada.example.com/posts/guest-post': (200, page('guest-article.html'), ''),
    'https://ada.example.com/posts/last-year': (200, page('last-year.html'), ''),
    'https://basil.example.net/robots.txt': (404, b'', ''),
    'https://basil.example.net/p/survey-results': (200, page('basil-survey.html'), ''),
    'https://cora.example.org/robots.txt': (404, b'', ''),
    'https://cora.example.org/series.html': (200, page('cora-series.html'), ''),
    'https://cora.example.org/feed.atom': (200, page('cora-feed.atom'), ''),
    'https://cora.example.org/articles/briefing-agents.html': (200, page('cora-article.html'), ''),
    'https://cora.example.org/articles/review-loops.html': (301, b'', 'https://elsewhere.example.net/loops.html'),
    'https://elsewhere.example.net/robots.txt': (200, b'User-agent: *\nDisallow: /\n', ''),
    'https://weekly.example.com/robots.txt': (404, b'', ''),
    'https://weekly.example.com/review/feed': (200, page('weekly-feed.xml'), ''),
    'https://weekly.example.com/review/gpt-6-2-astra': (200, page('weekly-article.html'), ''),
}


class Web:
    """A stand-in transport with a fake clock: records each request and the time it was made."""

    def __init__(self, pages=None):
        self.pages = WEB if pages is None else pages
        self.now = 1000.0
        self.requests = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds

    def __call__(self, url, accept):
        self.requests.append((url, self.now))
        self.now += 0.2
        return self.pages.get(url, (404, b'', ''))

    def fetcher(self, log_path=None, max_requests=None):
        return Fetcher(log_path, transport=self, clock=self.clock, sleep=self.sleep, max_requests=max_requests)


def state_dir(test):
    directory = tempfile.TemporaryDirectory()
    test.addCleanup(directory.cleanup)
    path = Path(directory.name) / 'people'
    path.mkdir()
    shutil.copy(FIXTURES / 'people.json', path)
    shutil.copy(FIXTURES / 'sources.json', path)
    return path


def run_cli(*arguments):
    with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
        code = people_pipeline.main(list(arguments))
    return code, out.getvalue(), err.getvalue()


def collect_with(test, directory, web, *more):
    with patch.object(people_pipeline, 'Fetcher', web.fetcher):
        code, out, err = run_cli('collect', '--state-dir', str(directory), '--since', SINCE, *more)
    test.assertEqual(code, 0, err)
    return out


class TestFetcher(unittest.TestCase):
    def test_one_request_every_three_seconds_and_robots_first(self):
        web = Web()
        fetcher = web.fetcher()
        for url in ('https://ada.example.com/feed.xml', 'https://ada.example.com/posts/porting-renderer',
                    'https://basil.example.net/p/survey-results'):
            self.assertEqual(fetcher.fetch(url)[0], 200)
        urls = [url for url, _ in web.requests]
        self.assertEqual(urls, [
            'https://ada.example.com/robots.txt', 'https://ada.example.com/feed.xml',
            'https://ada.example.com/posts/porting-renderer',
            'https://basil.example.net/robots.txt', 'https://basil.example.net/p/survey-results',
        ])
        times = [at for _, at in web.requests]
        self.assertTrue(all(later - earlier >= SPACING for earlier, later in zip(times, times[1:])))

    def test_disallowed_pages_and_redirect_targets_are_not_read(self):
        web = Web()
        fetcher = web.fetcher()
        self.assertEqual(fetcher.fetch('https://ada.example.com/drafts/secret')[0], 'robots')
        status, data, final = fetcher.fetch('https://cora.example.org/articles/review-loops.html')
        self.assertEqual((status, data, final), ('robots', b'', 'https://elsewhere.example.net/loops.html'))
        urls = [url for url, _ in web.requests]
        self.assertNotIn('https://ada.example.com/drafts/secret', urls)
        self.assertIn('https://elsewhere.example.net/robots.txt', urls)
        self.assertNotIn('https://elsewhere.example.net/loops.html', urls)

    def test_only_public_web_addresses(self):
        web = Web()
        fetcher = web.fetcher()
        for url in ('file:///etc/hosts', 'ftp://ada.example.com/x', 'https://user:pass@ada.example.com/'):
            self.assertEqual(fetcher.fetch(url)[0], 'not-public')
        self.assertEqual(web.requests, [])

    def test_request_limit(self):
        web = Web()
        fetcher = web.fetcher(max_requests=2)
        fetcher.fetch('https://ada.example.com/feed.xml')
        self.assertEqual(fetcher.fetch('https://ada.example.com/posts/porting-renderer')[0], 'request-limit')

    def test_generic_client_name_and_no_credentials(self):
        sent = []

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _limit):
                return b'ok'

        def opened(request, timeout):
            sent.append((request, timeout))
            return Response()

        with patch.object(fetch_module.OPENER, 'open', opened), patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'not-sent'}):
            self.assertEqual(http_get('https://ada.example.com/feed.xml', 'application/rss+xml'), (200, b'ok', ''))
        request = sent[0][0]
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertEqual(headers, {'user-agent': AGENT, 'accept': 'application/rss+xml'})
        self.assertIsNone(request.data)


class TestCollection(unittest.TestCase):
    def setUp(self):
        self.config = load(FIXTURES)

    def test_discovery_reads_each_kind_of_feed_and_skips_dropped_people(self):
        web = Web()
        jobs, notes = discover(self.config, web.fetcher(), SINCE)
        found = {job['url']: (job['person'].key, job['via'], job['channel']) for job in jobs}
        self.assertEqual(found, {
            'https://ada.example.com/posts/porting-renderer': ('ada', 'feed', 'site'),
            'https://ada.example.com/posts/guest-post': ('ada', 'feed', 'site'),
            'https://ada.example.com/drafts/secret': ('ada', 'feed', 'site'),
            'https://ada.example.com/posts/last-year': ('ada', 'sitemap', 'site'),
            'https://basil.example.net/p/survey-results': ('basil', 'listed page', 'newsletter'),
            'https://cora.example.org/articles/briefing-agents.html': ('cora', 'series page', 'site'),
            'https://cora.example.org/articles/review-loops.html': ('cora', 'series page', 'site'),
            'https://weekly.example.com/review/gpt-6-2-astra': ('weekly', 'feed', 'outlet article'),
        })
        urls = [url for url, _ in web.requests]
        self.assertNotIn('https://ada.example.com/sitemap-tags.xml', urls)
        self.assertFalse(any('dov.example.com' in url for url in urls))
        self.assertIn('https://ada.example.com/sitemap-posts.xml: 2 candidate links', notes)

    def gathered(self, url, key, via='feed', feed=None):
        web = Web()
        job = {'person': self.config.by_key(key), 'channel': 'site', 'url': url, 'via': via, 'feed': feed}
        return gather(job, web.fetcher(), SINCE, UNTIL)

    def test_a_confirmed_item_keeps_its_date_byline_text_and_links(self):
        item, excluded = self.gathered('https://ada.example.com/posts/porting-renderer', 'ada')
        self.assertIsNone(excluded)
        self.assertEqual((item['date'], item['bylines'], item['fidelity']), ('2026-11-09', ['Ada Example'], 'public page'))
        self.assertIn('I asked Claude Opus 5.5 at medium effort', item['body'])
        self.assertNotIn('Home · About', item['body'])
        self.assertNotIn('do not keep', item['body'])
        self.assertIn('https://github.com/example/renderer', item['links'])
        for private in ('ada.private@example.com', '555 010 9999', 'sk-ant-api03'):
            self.assertNotIn(private, json.dumps(item))
        self.assertEqual(len(item['id']), 24)

    def test_an_item_by_someone_else_is_excluded(self):
        item, excluded = self.gathered('https://ada.example.com/posts/guest-post', 'ada')
        self.assertIsNone(item)
        self.assertEqual(excluded['reason'], 'byline unverified')

    def test_an_item_outside_the_window_is_excluded_with_its_date(self):
        item, excluded = self.gathered('https://ada.example.com/posts/last-year', 'ada', 'sitemap')
        self.assertIsNone(item)
        self.assertEqual((excluded['reason'], excluded['date']), ('outside window', '2024-06-01'))

    def test_only_the_public_part_of_a_paid_post_is_kept(self):
        item, _ = self.gathered('https://basil.example.net/p/survey-results', 'basil', 'listed page')
        self.assertEqual(item['fidelity'], 'public page, public part of a paid post')
        self.assertEqual((item['date'], item['source_class']), ('2026-10-01', 'secondary'))

    def test_a_byline_and_date_read_from_the_page_text(self):
        item, excluded = self.gathered('https://cora.example.org/articles/briefing-agents.html', 'cora', 'series page')
        self.assertIsNone(excluded)
        self.assertEqual(item['date'], '2026-11-05')
        self.assertIn('Cora Placeholder', item['bylines'])

    def test_an_outlet_byline_in_the_page(self):
        person = self.config.by_key('weekly')
        self.assertTrue(byline_ok(person, ['Dana Writer and Eli Editor'], 'Weekly Review · the outlet'))
        self.assertFalse(byline_ok(person, ['Dana Writer'], 'Another outlet'))
        item, excluded = self.gathered('https://weekly.example.com/review/gpt-6-2-astra', 'weekly')
        self.assertIsNone(excluded)

    def test_no_date_means_excluded(self):
        web = Web({**WEB, 'https://ada.example.com/posts/undated': (200, b'<p>' + b'text ' * 80 + b'</p>', '')})
        job = {'person': self.config.by_key('ada'), 'channel': 'site', 'url': 'https://ada.example.com/posts/undated',
               'via': 'sitemap', 'feed': None}
        self.assertEqual(gather(job, web.fetcher(), SINCE, UNTIL)[1]['reason'], 'date unverified')

    def test_later_collections_skip_kept_items_and_final_exclusions_only(self):
        collected = {'a': {'url': 'https://ada.example.com/posts/porting-renderer/'}}
        exclusions = [
            {'url': 'https://ada.example.com/posts/guest-post', 'reason': 'byline unverified'},
            {'url': 'https://ada.example.com/posts/last-year', 'reason': 'outside window', 'date': '2024-06-01'},
            {'url': 'https://ada.example.com/posts/flaky', 'reason': 'page status 503'},
        ]
        self.assertEqual(known(collected, exclusions, SINCE), {
            'https://ada.example.com/posts/porting-renderer', 'https://ada.example.com/posts/guest-post',
            'https://ada.example.com/posts/last-year',
        })
        self.assertNotIn('https://ada.example.com/posts/last-year', known(collected, exclusions, '2024-01-01'))


class TestConfig(unittest.TestCase):
    def test_people_and_rules_come_from_the_local_files(self):
        config = load(FIXTURES)
        self.assertEqual([person.name for person in config.people],
                         ['Ada Example', 'Basil Sample', 'Cora Placeholder', 'Example Weekly', 'Dov Dropped'])
        self.assertEqual(config.by_key('basil').source_class, 'secondary')
        self.assertTrue(config.by_key('cora').advice_only)
        self.assertTrue(config.by_key('dov').dropped)

    def broken(self, change):
        directory = state_dir(self)
        sources = json.loads((directory / 'sources.json').read_text(encoding='utf-8'))
        change(sources)
        (directory / 'sources.json').write_text(json.dumps(sources), encoding='utf-8')
        with self.assertRaises(PipelineError) as raised:
            load(directory)
        return str(raised.exception)

    def test_rules_are_checked(self):
        def foreign_feed(sources):
            sources['people'][0]['discover'][0]['url'] = 'https://elsewhere.example.net/feed'

        def missing_person(sources):
            del sources['people'][1]

        def bad_pattern(sources):
            sources['people'][0]['discover'][1]['include'] = '('

        def repeated_key(sources):
            sources['people'][1]['key'] = 'ada'

        def short_name(sources):
            sources['people'][0]['redact'] = ['Al']

        for change in (foreign_feed, missing_person, bad_pattern, repeated_key, short_name):
            with self.subTest(change.__name__):
                self.assertTrue(self.broken(change).startswith('sources-file-invalid'))

    def test_a_missing_people_file_stops(self):
        with self.assertRaises(PipelineError) as raised:
            load(FIXTURES / 'pages')
        self.assertEqual(str(raised.exception), 'missing-people.json')


class TestRedaction(unittest.TestCase):
    def setUp(self):
        self.config = load(FIXTURES)
        self.privacy = Privacy(redaction_pattern(self.config))

    def test_names_links_keys_and_contact_details(self):
        text = ('Ada Example: I tried it.\nBasil Sample and adaex agreed; Dana Writer did not.\n'
                'See https://example.com/x or www.example.org, mail ada@example.com, call +1 555 010 9999.\n'
                'Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and Authorization: Bearer abc.\n'
                '```\ncode here\n```\nFiles in C:\\Users\\ada\\project, ask @adahandle.')
        out = self.privacy.redact(text, ['Ada Example'])
        self.assertTrue(out.startswith('[practitioner]: I tried it.'))
        for gone in ('Ada Example', 'Basil Sample', 'adaex', 'Dana Writer', 'https://', 'www.example', 'ada@example.com',
                     '555 010', 'sk-ant', 'Bearer abc', 'code here', 'Users\\ada', '@adahandle'):
            self.assertNotIn(gone, out)
        self.assertIn('[name omitted]', out)
        self.assertIn('[code omitted]', out)
        self.assertFalse(self.privacy.leaks([out], scrubbed=False))
        self.assertTrue(self.privacy.leaks(['Basil Sample said so']))

    def test_unix_home_folders_are_removed_wherever_they_start(self):
        cases = ('cd /Users/quill/src', 'the path "/Users/quill/app"', "the path '/home/quill/app'",
                 'run `/home/quill/bin/tool`', 'see (/Users/quill/notes) and [/home/quill/x]',
                 '/Users/quill/start of a line', 'line one\n/home/quill/next line', 'tmp/Users/quill/a',
                 'logs at ~/../home/quill/logs', 'path=/home/quill/x')
        for text in cases:
            with self.subTest(text=text):
                out = self.privacy.redact(text, ['Ada Example'])
                self.assertNotIn('quill', out)
                self.assertIn('[redacted]', out)
                self.assertFalse(self.privacy.leaks([out], scrubbed=False))
                self.assertTrue(self.privacy.leaks([text], scrubbed=False))
        self.assertEqual(self.privacy.redact('/Users/ and /homepage stay', ['Ada Example']), '/Users/ and /homepage stay')

    def test_an_outlet_redacts_the_names_in_each_byline(self):
        person = self.config.by_key('weekly')
        self.assertEqual(own_names({'bylines': ['Dana Writer and Eli Editor', 'Weekly Review']}, person), ['Dana Writer', 'Eli Editor'])
        self.assertEqual(own_names({}, self.config.by_key('ada')), ['Ada Example'])

    def test_masking_keeps_offsets(self):
        body = 'Intro text.\n```\nsecret code\n```\nVisit https://example.com/page now.'
        hidden = hide_blocks(body)
        self.assertEqual(len(hidden), len(body))
        self.assertNotIn('secret code', hidden)
        self.assertNotIn('example.com', hidden)

    def test_links_without_targets_become_text(self):
        self.assertEqual(plain_links('see [the demo]([link omitted]) and ([omitted])'), 'see the demo and ')

    def test_passages_overlap_and_cover_the_text(self):
        text = ('word ' * 30 + '\n') * 400
        ranges = list(passage_ranges(text))
        self.assertGreater(len(ranges), 1)
        self.assertEqual((ranges[0][0], ranges[-1][1]), (0, len(text)))
        for (_, end), (start, _) in zip(ranges, ranges[1:]):
            self.assertEqual(end - start, 600)
        self.assertTrue(all(end - start <= 8200 for start, end in ranges))


PASSAGE = ('I asked Claude Opus 5.5 at medium effort in Claude Code to port my renderer. '
           'It took two tries and I had to fix the shader loading by hand.')
JOB = {
    'passage': PASSAGE,
    'candidates': [
        {'kind': 'model', 'id': 'claude-opus-5-5', 'name': 'Claude Opus 5.5', 'status': 'current'},
        {'kind': 'family', 'id': 'Claude', 'name': 'Claude'},
    ],
}


def use_record(**changes):
    record = {
        'model_named': 'Claude Opus 5.5', 'exact': True, 'model_id': 'claude-opus-5-5', 'model_line': '',
        'tool': 'Claude Code', 'effort': 'medium', 'other_settings': '', 'setting': '', 'run': '', 'job': 'interface',
        'task': 'Port a renderer', 'outcome': 'worked after rework', 'compared_named': '', 'compared_id': '', 'comparison': '',
        'basis': 'first-hand use', 'sample_size': '', 'scale': 'one session', 'cost_time': '',
        'quote': 'It took two tries and I had to fix the shader loading by hand.',
        'summary': 'The writer ported a renderer and fixed shader loading by hand.',
    }
    return record | changes


def advice(**changes):
    return {'advice': 'Check the result by hand.', 'applies_to': 'general', 'setting': '', 'run': '', 'tool': '',
            'quote': 'I had to fix the shader loading by hand.'} | changes


class TestReplies(unittest.TestCase):
    def setUp(self):
        self.privacy = Privacy(redaction_pattern(load(FIXTURES)))

    def check(self, reply):
        return validate(reply, JOB, self.privacy)

    def refused(self, reply, issue):
        with self.assertRaises(ReviewError) as raised:
            self.check(reply)
        self.assertEqual(str(raised.exception), issue)

    def test_the_instructions_and_schema_are_those_of_the_stored_review(self):
        self.assertEqual(prompt_hash(), PROMPT_SHA256)
        self.assertEqual(set(SCHEMA['properties']['use_records']['items']['required']), set(USE_FIELDS))
        request = params('{"passage": "x"}', retry=True)
        self.assertEqual(request['thinking'], {'type': 'disabled'})
        self.assertEqual(request['max_tokens'], MAX_OUTPUT)
        self.assertEqual(request['system'][0], {'type': 'text', 'text': SYSTEM, 'cache_control': {'type': 'ephemeral'}})
        self.assertEqual(request['output_config']['format']['schema'], SCHEMA)
        self.assertTrue(request['messages'][0]['content'].endswith(RETRY_NOTE))
        self.assertFalse(params('{}')['messages'][0]['content'].endswith(RETRY_NOTE))

    def test_the_jobs_are_the_approved_list(self):
        approved = json.loads((ROOT / 'research/jobs.json').read_text(encoding='utf-8'))['jobs']
        self.assertEqual(JOBS, tuple(job['id'] for job in approved) + ('other',))
        for job in approved:
            self.assertIn(f'  {job["id"]}: {job["label"]}', SYSTEM)
        for old in ('coding', 'bug-fix', 'agents', 'delegation', 'local', 'images', 'reasoning'):
            self.assertNotIn(f'  {old}: ', SYSTEM)
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / 'jobs.json'
            changed.write_text(json.dumps({'jobs': approved[:-1]}), encoding='utf-8')
            with self.assertRaises(PipelineError) as raised:
                job_list(changed)
            self.assertEqual(str(raised.exception), 'review-jobs-differ-from-job-list')

    def test_a_valid_reply(self):
        reply = {'use_records': [use_record()], 'method_advice': [advice()]}
        self.assertIs(self.check(reply), reply)
        self.check({'use_records': [], 'method_advice': []})

    def test_exact_keys(self):
        self.refused({'use_records': []}, 'wrong-top-level-shape')
        self.refused({'use_records': [], 'method_advice': [], 'notes': ''}, 'wrong-top-level-shape')
        extra = use_record() | {'confidence': 'high'}
        self.refused({'use_records': [extra], 'method_advice': []}, 'wrong-use-record-shape')
        missing = use_record()
        del missing['summary']
        self.refused({'use_records': [missing], 'method_advice': []}, 'wrong-use-record-shape')
        self.refused({'use_records': [], 'method_advice': [advice() | {'x': ''}]}, 'wrong-advice-shape')
        self.refused({'use_records': [use_record(exact='yes')], 'method_advice': []}, 'wrong-type-exact')

    def test_counts_and_labels(self):
        self.refused({'use_records': [use_record()] * 5, 'method_advice': []}, 'wrong-array-shape')
        self.refused({'use_records': [], 'method_advice': [advice()] * 3}, 'wrong-array-shape')
        for field, value in (('job', 'gardening'), ('job', 'coding'), ('job', 'local'), ('outcome', 'fine'),
                             ('basis', 'rumour'), ('effort', 'huge'), ('scale', 'forever'), ('comparison', 'better'),
                             ('setting', 'laptop'), ('run', 'overnight')):
            with self.subTest(field=field):
                self.refused({'use_records': [use_record(**{field: value})], 'method_advice': []}, 'unrecognized-label')
        self.refused({'use_records': [], 'method_advice': [advice(applies_to='other')]}, 'unrecognized-advice-label')
        self.refused({'use_records': [], 'method_advice': [advice(applies_to='delegation')]}, 'unrecognized-advice-label')
        self.refused({'use_records': [], 'method_advice': [advice(run='swarm')]}, 'unrecognized-advice-label')
        self.check({'use_records': [use_record(job='read-media', setting='local', run='unattended')],
                    'method_advice': [advice(applies_to='plan', run='parallel')]})

    def test_ids_only_from_the_candidate_list(self):
        self.refused({'use_records': [use_record(model_id='gpt-6.2-sol')], 'method_advice': []}, 'model-id-not-a-candidate')
        self.refused({'use_records': [use_record(compared_named='GPT-6.2 Sol', compared_id='gpt-6.2-sol', comparison='this better')],
                      'method_advice': []}, 'compared-id-not-a-candidate')
        self.refused({'use_records': [use_record(exact=False, model_id='', model_line='GPT')], 'method_advice': []},
                     'model-line-not-a-candidate')
        self.refused({'use_records': [use_record(exact=False)], 'method_advice': []}, 'model-id-without-exact')
        self.refused({'use_records': [use_record(compared_named='GPT-6.2 Sol')], 'method_advice': []},
                     'comparison-fields-inconsistent')

    def test_quotes_are_verbatim(self):
        self.refused({'use_records': [use_record(quote='It took three tries and a lot of patience.')], 'method_advice': []},
                     'quote-not-verbatim')
        self.refused({'use_records': [use_record(quote='short')], 'method_advice': []}, 'quote-not-verbatim')
        spaced = use_record(quote='It took   two tries and\nI had to fix the shader loading by hand.')
        self.check({'use_records': [spaced], 'method_advice': []})
        redacted = {'passage': 'He said [name omitted] fixed the shader loading by hand twice.', 'candidates': []}
        with self.assertRaises(ReviewError) as raised:
            validate({'use_records': [], 'method_advice': [advice(quote='[name omitted] fixed the shader loading')]},
                     redacted, self.privacy)
        self.assertEqual(str(raised.exception), 'quote-spans-a-redaction')

    def test_length_limits_and_required_text(self):
        self.refused({'use_records': [use_record(summary='x' * 201)], 'method_advice': []}, 'too-long-summary')
        self.refused({'use_records': [use_record(task='x' * 161)], 'method_advice': []}, 'too-long-task')
        self.refused({'use_records': [], 'method_advice': [advice(advice='x' * 201)]}, 'too-long-advice')
        self.refused({'use_records': [use_record(task='  ')], 'method_advice': []}, 'empty-required-text')

    def test_no_names_links_or_contact_details_in_a_reply(self):
        for summary in ('Ada Example ported a renderer.', 'See https://example.com for the demo.',
                        'Contact ada@example.com for details.', 'Thanks to @adahandle for the tip.'):
            with self.subTest(summary=summary):
                self.refused({'use_records': [use_record(summary=summary)], 'method_advice': []},
                             'output-contains-redacted-identifier')

    def test_repair_blanks_unlisted_ids_and_keeps_the_words(self):
        reply = {'use_records': [
            use_record(model_id='gpt-9', model_named='GPT-9'),
            use_record(compared_named='GPT-6.2 Sol', comparison=''),
            use_record(exact=False),
        ], 'method_advice': []}
        repaired, fixes = repair(reply, JOB)
        self.assertEqual(fixes, 3)
        self.assertEqual((repaired['use_records'][0]['model_id'], repaired['use_records'][0]['model_named']), ('', 'GPT-9'))
        self.assertEqual(repaired['use_records'][1]['compared_named'], '')
        self.assertEqual(repaired['use_records'][2]['model_id'], '')


class StandInBatches:
    """Anthropic's batch calls as the pipeline uses them, answering each passage with `answer`."""

    def __init__(self, answer):
        self.answer = answer
        self.created = []
        self.messages = SimpleNamespace(batches=self)

    def create(self, requests):
        self.created.append(requests)
        return SimpleNamespace(id=f'msgbatch_{len(self.created)}')

    def retrieve(self, batch_id):
        return SimpleNamespace(processing_status='ended')

    def results(self, batch_id):
        requests = self.created[int(batch_id.split('_')[1]) - 1]
        for request in requests:
            result = self.answer(request)
            yield SimpleNamespace(model_dump=lambda mode, result=result, request=request: {
                'custom_id': request['custom_id'], 'result': result})


def succeeded(text):
    return {'type': 'succeeded', 'message': {
        'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': text}],
        'usage': {'input_tokens': 100, 'output_tokens': 20, 'cache_read_input_tokens': 3000, 'cache_creation_input_tokens': 0}}}


def reply_for(request):
    """A valid reply: one use record quoting the passage's first sentence."""
    payload = json.loads(request['params']['messages'][0]['content'].removesuffix(RETRY_NOTE))
    passage = payload['passage']
    quote = ' '.join(passage.split())[:120].rsplit(' ', 1)[0]
    model = next((c for c in payload['candidates'] if c['kind'] == 'model'), None)
    record = use_record(quote=quote, model_id=model['id'] if model else '', exact=bool(model),
                        model_named=model['name'] if model else 'a model', summary='The writer used a model for a task.')
    return succeeded(json.dumps({'use_records': [record], 'method_advice': [advice(quote=quote)]}))


def review(test, directory, client, *more):
    with patch.object(batch_api, 'anthropic_client', lambda: (client, None)), patch.object(batch_api, 'wait', lambda: None):
        code, out, err = run_cli('review', '--state-dir', str(directory), '--backend', 'anthropic', *more)
    test.assertEqual(code, 0, err)
    return out


class TestPipeline(unittest.TestCase):
    def setUp(self):
        self.directory = state_dir(self)

    def test_collect_is_resumable(self):
        web = Web()
        collect_with(self, self.directory, web)
        collected = items(self.directory)
        self.assertEqual(sorted(item['person'] for item in collected.values()), ['ada', 'basil', 'cora', 'weekly'])
        exclusions = [json.loads(line) for line in (self.directory / 'exclusions.jsonl').read_text().splitlines()]
        # The draft's page is closed to robots, so the feed's copy is judged, and it has no byline.
        self.assertEqual(sorted((row['url'].rsplit('/', 1)[1], row['reason']) for row in exclusions), [
            ('guest-post', 'byline unverified'), ('last-year', 'outside window'),
            ('review-loops.html', 'page status robots'), ('secret', 'byline unverified'),
        ])
        first = len(web.requests)
        again = Web()
        out = collect_with(self, self.directory, again)
        self.assertIn('"new_items": 0', out)
        read_again = {url for url, _ in again.requests}
        self.assertNotIn('https://ada.example.com/posts/porting-renderer', read_again)
        self.assertNotIn('https://ada.example.com/posts/guest-post', read_again)
        self.assertLess(len(again.requests), first)
        self.assertEqual(items(self.directory), collected)

    def test_review_queue_only_sends_nothing_and_is_resumable(self):
        collect_with(self, self.directory, Web())

        def refuse():
            raise AssertionError('no client for --queue-only')

        with patch.object(batch_api, 'anthropic_client', refuse):
            code, out, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        self.assertEqual(code, 0, err)
        plan = json.loads(out)
        self.assertEqual((plan['newItems'], plan['blockedByPrivacyCheck']), (4, 0))
        self.assertGreater(plan['queued'], 0)
        self.assertAlmostEqual(plan['estimatedUsd'], round(plan['queued'] * 1.86164 / 18345, 2))
        code, out, _ = run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        self.assertEqual((json.loads(out)['newItems'], json.loads(out)['queued']), (0, plan['queued']))

    def test_review_needs_a_mode(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            people_pipeline.main(['review', '--state-dir', str(self.directory)])

    def test_review_with_a_stand_in_client(self):
        collect_with(self, self.directory, Web())
        client = StandInBatches(reply_for)
        review(self, self.directory, client)
        uses = [json.loads(line) for line in (self.directory / 'use-records.jsonl').read_text().splitlines()]
        self.assertTrue(uses)
        self.assertEqual({use['practitioner'] for use in uses} - {'Ada Example', 'Basil Sample', 'Cora Placeholder', 'Example Weekly'}, set())
        self.assertEqual({use['source_class'] for use in uses if use['person'] == 'basil'}, {'secondary'})
        status = json.loads((self.directory / 'review-status.json').read_text())
        self.assertEqual(status['passage_states'], {'valid': sum(len(batch) for batch in client.created)})
        self.assertGreater(status['usd_from_usage'], 0)
        payloads = [json.loads(request['params']['messages'][0]['content']) for request in client.created[0]]
        sent = json.dumps(payloads)
        for private in ('Ada Example', 'Basil Sample', 'Dana Writer', 'ada.private@example.com', 'https://', '555 010'):
            self.assertNotIn(private, sent)
        self.assertIn('[practitioner]', sent)

    def test_invalid_replies_are_retried_once_then_unresolved(self):
        collect_with(self, self.directory, Web())
        client = StandInBatches(lambda request: succeeded('not json'))
        review(self, self.directory, client)
        self.assertEqual(len(client.created), 2)
        self.assertTrue(all(request['params']['messages'][0]['content'].endswith(RETRY_NOTE) for request in client.created[1]))
        unresolved = [json.loads(line) for line in (self.directory / 'unresolved.jsonl').read_text().splitlines()]
        self.assertEqual({row['issue'] for row in unresolved}, {'invalid-response-json'})
        self.assertEqual({row['attempts'] for row in unresolved}, {2})

    def test_expired_requests_stay_queued(self):
        collect_with(self, self.directory, Web())
        client = StandInBatches(lambda request: {'type': 'expired'})
        review(self, self.directory, client, '--max-passages', '1')
        with Checkpoint(self.directory, readonly=True) as checkpoint:
            self.assertEqual(checkpoint.states().get('unresolved', 0), 0)
            self.assertGreater(checkpoint.states()['queued'], 0)

    def test_an_unconfirmed_submission_blocks_the_next(self):
        collect_with(self, self.directory, Web())
        run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        with sqlite3.connect(self.directory / 'review.sqlite3') as db:
            db.execute("INSERT INTO batches (state) VALUES ('submitting')")
        with patch.object(batch_api, 'anthropic_client', lambda: (StandInBatches(reply_for), None)):
            code, _, err = run_cli('review', '--state-dir', str(self.directory), '--backend', 'anthropic')
        self.assertEqual((code, err.strip()), (1, 'previous-submission-unconfirmed'))

    def test_a_checkpoint_with_other_instructions_is_refused(self):
        collect_with(self, self.directory, Web())
        run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        with sqlite3.connect(self.directory / 'review.sqlite3') as db:
            db.execute("UPDATE configuration SET value=? WHERE name='review_key'", (json.dumps(['use-records-v1', 'm', 'x']),))
        code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        self.assertEqual((code, err.strip()), (1, 'review-checkpoint-methodology-mismatch'))

    def test_a_stored_review_counts_its_collection_as_prepared(self):
        """A checkpoint of 23 November 2026 keys its collection by hash; items added later are new."""
        collect_with(self, self.directory, Web())
        path = self.directory / 'items.jsonl'
        lines = path.read_text(encoding='utf-8').splitlines(keepends=True)
        path.write_text(''.join(lines[:2]), encoding='utf-8')
        digest = file_sha256(path)
        with sqlite3.connect(self.directory / 'review.sqlite3') as db:
            db.executescript(STATE_SCHEMA + 'DROP TABLE prepared;')
            db.execute("INSERT INTO configuration VALUES ('review_key', ?)",
                       (json.dumps(['use-records-v2', 'claude-haiku-5-5', 'registry', digest, 'earlier-instructions']),))
        path.write_text(''.join(lines), encoding='utf-8')
        code, out, _ = run_cli('status', '--state-dir', str(self.directory))
        review_state = json.loads(out)['review']
        self.assertEqual((review_state['itemsPrepared'], review_state['instructionsUnchanged']), (2, False))
        code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        self.assertEqual((code, err.strip()), (1, 'review-checkpoint-methodology-mismatch'))

    def earlier_review(self):
        """A finished review whose checkpoint was made with earlier instructions, and a kept copy of it."""
        collect_with(self, self.directory, Web())
        review(self, self.directory, StandInBatches(reply_for))
        with sqlite3.connect(self.directory / 'review.sqlite3') as db:
            db.execute("UPDATE configuration SET value=? WHERE name='review_key'",
                       (json.dumps(['use-records-v2', 'claude-haiku-5-5', 'earlier-instructions']),))
        kept = self.directory / 'earlier-review'
        kept.mkdir()
        for name in ('review.sqlite3', 'use-records.jsonl', 'method-advice.jsonl', 'unresolved.jsonl', 'review-status.json'):
            shutil.copy(self.directory / name, kept)
        return kept

    def test_a_review_with_earlier_instructions_is_replaced_only_after_its_copy_is_checked(self):
        kept = self.earlier_review()
        with Checkpoint(self.directory, readonly=True) as checkpoint:
            earlier = checkpoint.states()
        # An item stored before the home-folder fix still holds one; preparing again removes it.
        path = self.directory / 'items.jsonl'
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
        rows[0]['body'] += '\nThe files were in "/Users/quill/projects" and `/home/quill/src`.'
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')
        before = (self.directory / 'review.sqlite3').read_bytes()
        for target, issue in ((self.directory / 'missing', 'kept-copy-missing'), (self.directory, 'kept-copy-missing')):
            code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only', '--replace-review', str(target))
            self.assertEqual((code, err.strip()), (1, issue))
        (kept / 'use-records.jsonl').write_text('', encoding='utf-8')
        code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only', '--replace-review', str(kept))
        self.assertEqual((code, err.strip()), (1, 'kept-copy-differs'))
        self.assertEqual((self.directory / 'review.sqlite3').read_bytes(), before)
        shutil.copy(self.directory / 'use-records.jsonl', kept)
        code, out, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only', '--replace-review', str(kept))
        self.assertEqual(code, 0, err)
        plan = json.loads(out)
        self.assertEqual((plan['replacedReview'], plan['newItems'], plan['blockedByPrivacyCheck']), (earlier, 4, 0))
        with Checkpoint(self.directory, readonly=True) as checkpoint:
            self.assertEqual(checkpoint.states(), {'queued': plan['queued']})
            self.assertEqual((checkpoint.batches(), checkpoint.usage()[1]), ({}, 0))
            payloads = ' '.join(row[0] for row in checkpoint.db.execute('SELECT payload FROM jobs'))
        self.assertNotIn('quill', payloads)
        self.assertIn('[redacted]', payloads)
        with Checkpoint(kept, readonly=True) as copy:
            self.assertEqual(copy.states(), earlier)
        code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only', '--replace-review', str(kept))
        self.assertEqual((code, err.strip()), (1, 'no-earlier-review-to-replace'))

    def test_an_unfinished_earlier_review_is_not_replaced(self):
        kept = self.earlier_review()
        for directory in (self.directory, kept):
            with sqlite3.connect(directory / 'review.sqlite3') as db:
                db.execute("INSERT INTO batches (remote_id, state) VALUES ('msgbatch_9', 'submitted')")
        code, _, err = run_cli('review', '--state-dir', str(self.directory), '--queue-only', '--replace-review', str(kept))
        self.assertEqual((code, err.strip()), (1, 'earlier-review-unfinished'))

    def test_status_reads_without_network_or_writes(self):
        collect_with(self, self.directory, Web())
        run_cli('review', '--state-dir', str(self.directory), '--queue-only')
        before = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        with patch('socket.socket.connect', side_effect=AssertionError('network')):
            code, out, err = run_cli('status', '--state-dir', str(self.directory))
        self.assertEqual(code, 0, err)
        result = json.loads(out)
        self.assertEqual((result['items'], result['people']['dropped'], result['review']['itemsNotPrepared']), (4, 1, 0))
        self.assertEqual({path.name: path.read_bytes() for path in self.directory.iterdir()}, before)

    def test_one_command_per_state_directory(self):
        with writer_lock(self.directory):
            for command in (('collect', '--since', SINCE), ('review', '--queue-only'), ('export',)):
                with self.subTest(command=command[0]):
                    code, _, err = run_cli(command[0], '--state-dir', str(self.directory), *command[1:])
                    self.assertEqual((code, err.strip()), (1, 'already-running'))
            code, _, err = run_cli('status', '--state-dir', str(self.directory))
            self.assertEqual(code, 0, err)

    def test_state_files_hold_only_what_the_docs_list(self):
        collect_with(self, self.directory, Web())
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'sk-ant-stand-in-credential-0000000000'}):
            review(self, self.directory, StandInBatches(reply_for))
        self.assertEqual({path.name for path in self.directory.iterdir()}, {
            'people.json', 'sources.json', 'items.jsonl', 'exclusions.jsonl', 'collection-summary.json',
            'fetch-log.jsonl', 'review.sqlite3', 'use-records.jsonl', 'method-advice.jsonl', 'unresolved.jsonl',
            'review-status.json', 'pipeline.lock',
        })
        stored = b''.join(path.read_bytes() for path in self.directory.iterdir())
        for absent in (b'<html', b'<article', b'do not keep', b'ada.private@example.com', b'555 010 9999',
                       b'sk-ant-api03', b'sk-ant-stand-in', SYSTEM[:60].encode()):
            self.assertNotIn(absent, stored)
        # Collected items keep the page's text, code included; what is sent and stored from the
        # review has code, links and names removed.
        self.assertIn(b'inside a code block', (self.directory / 'items.jsonl').read_bytes())
        reviewed = b''.join(path.read_bytes() for path in self.directory.iterdir() if path.name != 'items.jsonl')
        self.assertNotIn(b'inside a code block', reviewed)
        with sqlite3.connect(self.directory / 'review.sqlite3') as db:
            tables = {row[0]: [column[1] for column in db.execute(f'PRAGMA table_info({row[0]})')]
                      for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            payloads = ' '.join(row[0] for row in db.execute('SELECT payload FROM jobs'))
        self.assertEqual(tables, {
            'configuration': ['name', 'value'],
            'batches': ['local_id', 'remote_id', 'state'],
            'jobs': ['id', 'source_id', 'start', 'end', 'payload', 'attempts', 'batch', 'state', 'result', 'issue', 'usage'],
            'usage': ['batch', 'job', 'value'],
            'prepared': ['source_id', 'passages'],
        })
        for name in ('Ada Example', 'Basil Sample', 'Dana Writer', 'Eli Editor', 'Cora Placeholder'):
            self.assertNotIn(name, payloads)
        for row in (self.directory / 'fetch-log.jsonl').read_text().splitlines():
            self.assertEqual(set(json.loads(row)), {'url', 'status', 'bytes', 'at'})
        fields = set(USE_FIELDS) | {'source_id', 'person', 'practitioner', 'source_class', 'source_url', 'source_date',
                                     'source_channel', 'source_title', 'passage'}
        for row in (self.directory / 'use-records.jsonl').read_text().splitlines():
            self.assertEqual(set(json.loads(row)), fields)
        for row in (self.directory / 'method-advice.jsonl').read_text().splitlines():
            self.assertEqual(set(json.loads(row)), fields - set(USE_FIELDS) | set(ADVICE_FIELDS))


if __name__ == '__main__':
    unittest.main()
