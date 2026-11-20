"""Regression checks for the HN source, classifier boundary, thread phases and resumable state."""

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import anthropic

import hn_pipeline
from hn_local.anthropic_api import API_URL, AnthropicClassifier
from hn_local.classify import (
    CLAIM_LIMIT, COMMENT_LIMIT, MAX_THEMES, PARENT_LIMIT, REMINDER, STORY_SYSTEM, SYSTEM, TITLE_LIMIT,
    Assessment, LocalClassifier, Review, Targets, parse_review, review_prompt, validate_endpoint,
)
from hn_local.clickhouse import read_row
from hn_local.sources import (
    RECONCILE_ID, DateWindow, FirebaseReader, Item, Partition, PipelineError, SourcePlan,
    archive_pages, build_plan, clip_archive_partition, iso_time, read_item, recent_window, screened, tail_partitions,
)
from hn_local.state import Counters, State
from hn_pipeline import (
    REWALK_DAYS, arguments, classifier_key_for, consume_partition, expand_stories, extend_window, mirror_pages,
    previous_targets, process_block, read_ancestors, reconcile_pages, resolve_context, retarget, review_batches,
    review_comments, scan_key_for, thread_root,
)

MODEL_FIXTURES = [
    {'id': 'claude-opus-4', 'name': 'Claude Opus 4'},
    {'id': 'claude-opus-4-8', 'name': 'Claude Opus 4.8'},
    {'id': 'gpt-6-astra', 'name': 'GPT-6 Astra', 'apiId': 'gpt-6-astra'},
    {'id': 'deepseek-v4-pro', 'name': 'DeepSeek V4 Pro', 'version': 'DeepSeek-V4-Pro-0813'},
    {'id': 'glm-5-3', 'name': 'GLM-5.3'},
]
TIME = 1_780_000_000
SENSITIVE_PLACEHOLDERS = ('Sampleperson', 'example.contact@example.test', 'hidden-test-handle')
SYNC = type('Runner', (), {'run': staticmethod(lambda values: values)})()


def comment(item_id, parent, text='', created=TIME, kids=(), **extra):
    data = {'id': item_id, 'type': 'comment', 'time': created, 'parent': parent, 'text': text, 'kids': list(kids)}
    return read_item({**data, **extra}, item_id)


def story(item_id, title, kids=(), created=TIME, kind='story'):
    return read_item({'id': item_id, 'type': kind, 'time': created, 'title': title, 'kids': list(kids)}, item_id)


def removed(item_id, parent, kids=(), created=TIME):
    return read_item(
        {'id': item_id, 'type': 'comment', 'time': created, 'parent': parent, 'dead': True, 'kids': list(kids)},
        item_id,
    )


class Firebase:
    """Complete public items by id, as FirebaseReader.read returns them."""

    workers = 1
    runner = SYNC

    def __init__(self, items=()):
        self.items = {item.id: item for item in items}
        self.reads = []
        self.calls = 0

    def read(self, item_ids):
        item_ids = list(dict.fromkeys(item_ids))
        self.calls += bool(item_ids)
        self.reads.extend(item_ids)
        return {item_id: self.items.get(item_id, Item(item_id, 'unavailable')) for item_id in item_ids}

    def cap_page_size(self, count):
        return count

    def fetch_all(self, item_ids):
        return [self.items.get(item_id, Item(item_id, 'unavailable')) for item_id in item_ids]


class Reviewer:
    """Judges every target: GPT-6 Astra positive, anything else negative."""

    def __init__(self, about=(), fail=False, prefers=False):
        self.about = set(about)
        self.fail = fail
        self.prefers = prefers
        self.subjects = []
        self.titles = []

    def review(self, subject):
        self.subjects.append(subject)
        if self.fail:
            return None
        assessments = tuple(
            Assessment(
                target, 'positive' if target.label == 'gpt-6-astra' else 'negative',
                ('coding',), 'high', ('code-quality',),
            )
            for target in subject.targets
        )
        prefers = (subject.targets[0], subject.targets[1]) if self.prefers and len(subject.targets) > 1 else None
        return Review(assessments, 'coding', 'Synthetic claim.', (prefers,) if prefers else ())

    def about_story(self, title, targets):
        self.titles.append(title)
        return title in self.about


def api_message(text):
    usage = SimpleNamespace(
        input_tokens=40, cache_read_input_tokens=900, cache_creation_input_tokens=0, output_tokens=30,
    )
    return SimpleNamespace(content=[SimpleNamespace(type='text', text=text)], usage=usage)


def judged(prompt):
    """A valid reply that calls every target in the prompt positive."""
    count = len(re.findall(r'^\d+\. ', prompt.partition('\nTargets:\n')[2], re.M))
    labels = [[index, 'positive', ['speed'], 'high'] for index in range(count)]
    return json.dumps({'labels': labels, 'task': 'coding', 'claim': 'Synthetic claim.', 'prefers': []})


class Batches:
    """The batch interface of the API client, answering each request with reply(custom_id, prompt)."""

    def __init__(self, reply=lambda _custom_id, prompt: ('succeeded', judged(prompt)), ready=True):
        self.reply = reply
        self.ready = ready
        self.sent = {}
        self.polls = 0

    def create(self, requests):
        batch_id = f'batch-{len(self.sent) + 1}'
        self.sent[batch_id] = list(requests)
        return SimpleNamespace(id=batch_id)

    def retrieve(self, batch_id):
        self.polls += 1
        return SimpleNamespace(processing_status='ended' if self.ready else 'in_progress')

    def results(self, batch_id):
        for request in self.sent[batch_id]:
            kind, text = self.reply(request['custom_id'], request['params']['messages'][0]['content'])
            message = api_message(text) if kind == 'succeeded' else None
            yield SimpleNamespace(custom_id=request['custom_id'], result=SimpleNamespace(type=kind, message=message))

    def prompts(self):
        return {
            int(request['custom_id']): request['params']['messages'][0]['content']
            for requests in self.sent.values() for request in requests
        }


def api_classifier(batches=None, create=None):
    client = SimpleNamespace(messages=SimpleNamespace(create=create, batches=batches))
    return AnthropicClassifier('fixture-model', client)


class TestClassifier(unittest.TestCase):
    def setUp(self):
        self.targets = Targets(MODEL_FIXTURES)

    def labels(self, prose, trusted=False):
        return [target.label for target in self.targets.mentions(prose, trusted)]

    def test_version_and_family_ambiguity(self):
        found = self.targets.mentions(
            'Opus 4.8 is better than Claude Opus 4. DeepSeek V4 Pro is fine but DeepSeek-V4-Pro-0813 is slow.'
        )
        self.assertEqual(
            [(value.kind, value.label) for value in found],
            [
                ('model', 'claude-opus-4-8'),
                ('model', 'claude-opus-4'),
                ('family', 'DeepSeek V4 Pro'),
                ('model', 'deepseek-v4-pro'),
            ],
        )
        self.assertEqual(self.targets.mentions('Claude Opus 4.9 is fine')[0].kind, 'family')
        self.assertEqual(self.targets.mentions('GLM-5.3-Air is fine')[0].kind, 'family')
        self.assertEqual(self.targets.mentions('GLM-5.3 is fine.')[0].label, 'glm-5-3')
        self.assertEqual(self.targets.mentions('Llama 3 and GPT-4')[0].kind, 'family')
        self.assertEqual(self.targets.mentions('I prefer an unnamed model'), ())
        self.assertEqual(self.labels('Claude Opuſ 4 is fine and GPT-6 Astra is slow.'), ['gpt-6-astra'])

    def test_ambiguous_names_need_nearby_ai_evidence(self):
        for prose in (
            'Claude Exampleperson wrote excellent research papers.',
            'The mistral is too strong for a boat today.',
            'Bert is a great friend who works hard.',
        ):
            with self.subTest(prose=prose):
                self.assertEqual(self.targets.mentions(prose), ())
                self.assertEqual(len(self.targets.mentions(prose, trusted=True)), 1)
        self.assertEqual(
            self.labels('Claude uses more tokens than GPT-6 Astra for coding.'), ['Claude', 'gpt-6-astra']
        )
        self.assertEqual(self.labels('Claude hallucinates less these days.'), ['Claude'])
        far = 'Bert is a great friend. ' + 'Computers work. ' * 40 + 'GPT-6 Astra is great for coding.'
        self.assertEqual(self.labels(far), ['gpt-6-astra'])
        self.assertEqual(self.labels(far, trusted=True), ['BERT', 'gpt-6-astra'])

    def test_title_targets_mark_certainty(self):
        named, certain = self.targets.title_targets('GPT-6 Astra is out')
        self.assertEqual(([target.label for target in named], certain), (['gpt-6-astra'], True))
        named, certain = self.targets.title_targets('Claude &amp; the art of conversation')
        self.assertEqual(([target.label for target in named], certain), (['Claude'], False))
        self.assertEqual(self.targets.title_targets('Show HN: A text editor'), ((), False))
        self.assertEqual(self.targets.title_targets(''), ((), False))

    def test_subject_keeps_only_public_prose(self):
        name, address, handle = SENSITIVE_PLACEHOLDERS
        item = comment(
            10, 1,
            f'<blockquote>GPT-6 Astra is bad</blockquote><pre><code>{name} DeepSeek-V4-Pro-0813</code></pre>'
            f'<p>My name is {name}. Email {address}. @{handle} says Claude Opus 4 is slow, '
            f'see https://example.test/{handle} and www.example.test/{name}.'
            f'<p>&gt; GLM-5.3 is a quoted line',
            by=handle,
        )
        subject = self.targets.subject(
            item.body, f'Ask {address} or @{handle} about it.', f'Claude Opus 4 notes https://example.test/{name}',
        )
        self.assertEqual([target.label for target in subject.targets], ['claude-opus-4'])
        prompt = review_prompt(subject)
        self.assertIn('Claude Opus 4 is slow', prompt)
        for line in ('Story title:', 'Replied-to text:', 'Comment:', 'Targets:'):
            self.assertIn(line, prompt)
        for removed_text in (*SENSITIVE_PLACEHOLDERS, 'example.test', 'is bad', 'quoted line', 'DeepSeek', 'GLM'):
            self.assertNotIn(removed_text.lower(), prompt.lower())
        for value in (repr(subject), repr(item), repr(story(11, 'Claude Opus 4 notes'))):
            self.assertNotIn('slow', value)
            self.assertNotIn('notes', value)
            self.assertNotIn(handle, value)

    def test_subject_orders_targets_by_origin(self):
        opus = self.targets.by_label[('model', 'claude-opus-4')]
        subject = self.targets.subject(
            'Claude is slower than GPT-6 Astra, and Claude Opus 4 agrees.',
            'GLM-5.3 and GPT-6 Astra both failed for me.',
            'Claude Opus 4 review',
            (opus,),
        )
        self.assertEqual(
            [target.label for target in subject.targets], ['claude-opus-4', 'Claude', 'gpt-6-astra', 'glm-5-3']
        )
        self.assertEqual(
            subject.origins,
            ('story subject', 'named in the comment', 'named in the comment', 'named in the replied-to text'),
        )
        self.assertEqual(subject.title, 'Claude Opus 4 review')
        untrusted = self.targets.subject('Claude is my neighbour.', 'GLM-5.3 is fine.')
        self.assertEqual([target.label for target in untrusted.targets], ['glm-5-3'])
        self.assertEqual(untrusted.origins, ('named in the replied-to text',))

    def test_subject_needs_text_and_a_target(self):
        opus = self.targets.by_label[('model', 'claude-opus-4')]
        self.assertIsNone(self.targets.subject('', 'GPT-6 Astra', 'GPT-6 Astra', (opus,)))
        self.assertIsNone(self.targets.subject('<code>GPT-6 Astra</code>', '', '', (opus,)))
        self.assertIsNone(self.targets.subject('I had lunch.', 'So did I.', 'Show HN: A text editor'))
        self.assertIsNotNone(self.targets.subject('I had lunch.', '', 'Claude Opus 4', (opus,)))

    def test_subject_clips_long_text(self):
        filler = 'word ' * 2000
        subject = self.targets.subject('GPT-6 Astra ' + filler + 'ending', filler + 'tail', 'Title ' + filler)
        for text, limit in ((subject.text, COMMENT_LIMIT), (subject.parent, PARENT_LIMIT), (subject.title, TITLE_LIMIT)):
            self.assertLessEqual(len(text), limit + len(' … '))
            self.assertIn('…', text)
        self.assertTrue(subject.text.startswith('GPT-6 Astra'))
        self.assertTrue(subject.text.endswith('ending'))
        self.assertTrue(subject.parent.endswith('tail'))

    def test_review_labels_are_enum_only(self):
        targets = self.targets.mentions('GPT-6 Astra is better than Claude Opus 4 and GLM-5.3 for coding.')
        review = parse_review(json.dumps({
            'labels': [
                [0, 'positive', ['pricing', 'synthetic-unknown', 'pricing', 'speed', 'context', 'regression'], 'high'],
                [1, 'negative', [], 'medium'],
                [2, 'none', ['speed'], 'high'],
            ],
            'task': 'coding',
            'claim': 'GPT-6 Astra beats Claude Opus 4.',
            'prefers': [],
        }), targets)
        self.assertEqual(
            [(value.target.label, value.sentiment) for value in review.assessments],
            [('gpt-6-astra', 'positive'), ('claude-opus-4', 'negative')],
        )
        self.assertEqual(review.assessments[0].themes, ('pricing', 'speed', 'context'))
        self.assertEqual(len(review.assessments[0].themes), MAX_THEMES)
        self.assertEqual(review.assessments[0].aspects, ('coding', 'cost', 'speed'))
        self.assertEqual(review.assessments[1].aspects, ('coding',))
        self.assertEqual(review.task, 'coding')
        for sentiment in ('positive', 'negative', 'mixed'):
            with self.subTest(sentiment=sentiment):
                low = parse_review(json.dumps({'labels': [[0, sentiment, [], 'low']]}), targets).assessments[0]
                self.assertEqual((low.sentiment, low.confidence), ('unclear', 'low'))
        neutral = parse_review('{"labels":[[0,"neutral",[],"low"]]}', targets).assessments[0]
        self.assertEqual(neutral.sentiment, 'neutral')
        missing = parse_review('{"labels":[[1,"neutral",[],"high"]],"task":"synthetic-task"}', targets)
        self.assertEqual([value.target.label for value in missing.assessments], ['claude-opus-4'])
        self.assertEqual(missing.task, 'other')

    def test_review_rejects_malformed_rows(self):
        targets = self.targets.mentions('GPT-6 Astra and Claude Opus 4')
        for message in (
            '{"labels":[[0,"positive",[],"high"],[0,"negative",[],"medium"]]}',
            '{"labels":[[2,"positive",[],"high"]]}',
            '{"labels":[[-1,"positive",[],"high"]]}',
            '{"labels":[[true,"positive",[],"high"]]}',
            '{"labels":[[0,"great",[],"high"]]}',
            '{"labels":[[0,"positive",[],"certain"]]}',
            '{"labels":[[0,"positive","coding","high"]]}',
            '{"labels":[[0,"positive",[]]]}',
            '{"labels":{}}',
            '[]',
            'not json',
        ):
            with self.subTest(message=message), self.assertRaises(ValueError):
                parse_review(message, targets)

    def test_review_claim_and_preferences(self):
        targets = self.targets.mentions('GPT-6 Astra, Claude Opus 4 and GLM-5.3')
        name, address, handle = SENSITIVE_PLACEHOLDERS
        review = parse_review(json.dumps({
            'labels': [[0, 'positive', [], 'high'], [1, 'negative', [], 'high'], [2, 'none', [], 'high']],
            'task': 'coding',
            'claim': f'GPT-6 Astra beats Claude Opus 4, says {address} and @{handle}. ' + 'More detail. ' * 40,
            'prefers': [[0, 1], [0, 1], [1, 1], [0, 2], [2, 0], [0, 5], ['0', '1'], [0]],
        }), targets)
        self.assertEqual(
            [(winner.label, loser.label) for winner, loser in review.prefers], [('gpt-6-astra', 'claude-opus-4')]
        )
        self.assertTrue(review.claim.startswith('GPT-6 Astra beats Claude Opus 4'))
        self.assertLessEqual(len(review.claim), CLAIM_LIMIT + len(' … '))
        for value in SENSITIVE_PLACEHOLDERS:
            self.assertNotIn(value, review.claim)
        nothing = parse_review(json.dumps({
            'labels': [[0, 'none', [], 'high']], 'claim': 'GPT-6 Astra is irrelevant here.', 'prefers': [[0, 1]],
        }), targets)
        self.assertEqual((nothing.assessments, nothing.claim, nothing.prefers), ((), '', ()))

    def test_review_tolerates_thinking_and_fences(self):
        targets = self.targets.mentions('GPT-6 Astra')
        message = '<think>Synthetic reasoning.</think>\n```json\n{"labels":[[0,"mixed",["speed"],"high"]]}\n```'
        review = parse_review(message, targets)
        self.assertEqual([value.sentiment for value in review.assessments], ['mixed'])
        self.assertEqual(review.assessments[0].aspects, ('speed',))

    def test_review_retries_once_then_gives_up(self):
        classifier = LocalClassifier('http://127.0.0.1:8788/v1/chat/completions', 'fixture')
        subject = self.targets.subject('GPT-6 Astra is useful, but Claude Opus 4 is unreliable.')
        valid = '{"labels":[[0,"positive",[],"high"],[1,"negative",["regression"],"high"]],"task":"chat"}'
        with patch.object(classifier, 'request', side_effect=['{"labels":[[0', valid]) as request:
            review = classifier.review(subject)
        self.assertEqual(
            [(value.target.label, value.sentiment) for value in review.assessments],
            [('gpt-6-astra', 'positive'), ('claude-opus-4', 'negative')],
        )
        first, retry = [call.args[1] for call in request.call_args_list]
        self.assertEqual(first, review_prompt(subject))
        self.assertEqual(retry, first + REMINDER)
        with patch.object(classifier, 'request', side_effect=['not json', '{"labels":[[9,"none",[],"high"]]}']) as request:
            self.assertIsNone(classifier.review(subject))
        self.assertEqual(request.call_count, 2)

    def test_story_question_is_yes_or_no(self):
        classifier = LocalClassifier('http://127.0.0.1:8788/v1/chat/completions', 'fixture')
        claude = self.targets.by_label[('family', 'Claude')]
        for answer, expected in (('Yes', True), ('<think>Synthetic.</think> yes.', True), ('No', False), ('', False)):
            with self.subTest(answer=answer), patch.object(classifier, 'request', return_value=answer) as request:
                self.assertIs(classifier.about_story('Claude &amp; friends', (claude,)), expected)
                self.assertIn('Claude & friends', request.call_args.args[1])

    def test_api_request_disables_thinking_and_caches_the_instructions(self):
        calls = []

        def create(**params):
            calls.append(params)
            return api_message(judged(params['messages'][0]['content']))

        classifier = api_classifier(create=create)
        subject = self.targets.subject('GPT-6 Astra is useful.')
        review = classifier.review(subject)
        self.assertEqual(
            [(value.target.label, value.sentiment) for value in review.assessments], [('gpt-6-astra', 'positive')],
        )
        self.assertEqual(calls, [{
            'model': 'fixture-model',
            'max_tokens': 512,
            'thinking': {'type': 'disabled'},
            'system': [{'type': 'text', 'text': SYSTEM, 'cache_control': {'type': 'ephemeral'}}],
            'messages': [{'role': 'user', 'content': review_prompt(subject)}],
        }])
        self.assertEqual(dict(classifier.usage), {
            'inputTokens': 40, 'cacheReadTokens': 900, 'cacheWriteTokens': 0, 'outputTokens': 30,
        })
        claude = self.targets.by_label[('family', 'Claude')]
        calls.clear()
        classifier.client.messages.create = lambda **params: calls.append(params) or api_message('Yes')
        self.assertTrue(classifier.about_story('Claude keeps rewriting my tests', (claude,)))
        self.assertEqual((calls[0]['system'][0]['text'], calls[0]['max_tokens']), (STORY_SYSTEM, 8))

    def test_api_replies_that_fail_validation_are_retried_once(self):
        replies = iter(['not json', '{"labels":[[9,"none",[],"high"]]}'])
        classifier = api_classifier(create=lambda **_params: api_message(next(replies)))
        self.assertIsNone(classifier.review(self.targets.subject('GPT-6 Astra is useful.')))
        self.assertEqual(next(replies, None), None)

    def test_api_needs_a_credential_and_keeps_its_address(self):
        # HOME is a temporary directory so that a sign-in stored on this machine is not found.
        with tempfile.TemporaryDirectory() as home, patch.dict(
            os.environ, {'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9', 'HOME': home}, clear=True,
        ):
            with self.assertRaisesRegex(PipelineError, 'anthropic-api-credential-missing'):
                AnthropicClassifier('fixture-model')
            os.environ['ANTHROPIC_API_KEY'] = 'synthetic-test-key'
            classifier = AnthropicClassifier('fixture-model')
            self.assertEqual(str(classifier.client.base_url).rstrip('/'), API_URL)
            self.assertIsNone(classifier.client.credentials)

            # The files `ant auth login` leaves: a pointer to the active profile and its settings.
            del os.environ['ANTHROPIC_API_KEY']
            profile = Path(home, '.config/anthropic/configs/default.json')
            profile.parent.mkdir(parents=True)
            Path(home, '.config/anthropic/active_config').write_text('default')
            profile.write_text('not json')
            with self.assertRaisesRegex(PipelineError, 'anthropic-api-credential-failed'):
                AnthropicClassifier('fixture-model')
            profile.write_text(json.dumps({
                'authentication': {'type': 'user_oauth'}, 'base_url': 'https://elsewhere.invalid',
            }))
            classifier = AnthropicClassifier('fixture-model')
        self.assertIsNone(classifier.client.api_key)
        self.assertIsNotNone(classifier.client.credentials)
        self.assertEqual(str(classifier.client.base_url).rstrip('/'), API_URL)

    def test_a_sign_in_that_cannot_be_used_stops_the_run_with_a_reason(self):
        def refuse(**_params):
            raise anthropic.CredentialsError('synthetic')

        classifier = api_classifier(create=refuse)
        with self.assertRaisesRegex(PipelineError, 'anthropic-api-credential-failed'):
            classifier.request(SYSTEM, 'Synthetic prompt.', 8)

    def test_api_errors_stop_the_run_with_a_reason(self):
        def refuse(**_params):
            raise anthropic.APIConnectionError(request=None)

        classifier = api_classifier(create=refuse)
        with self.assertRaisesRegex(PipelineError, 'anthropic-api-unreachable'):
            classifier.request(SYSTEM, 'Synthetic prompt.', 8)

    def test_backend_sets_the_default_model_and_classifier(self):
        for backend, expected in (
            ((), ('local', 'default_model', 'qwen3.8-27b-4bit-thread-v1')),
            (('--backend', 'anthropic'), ('anthropic', 'claude-haiku-5-5', 'claude-haiku-5.5-thread-v1')),
            (
                ('--backend', 'anthropic', '--model', 'other-model'),
                ('anthropic', 'other-model', 'claude-haiku-5.5-thread-v1'),
            ),
        ):
            with self.subTest(backend=backend), patch.object(sys, 'argv', ['hn_pipeline.py', 'run', *backend]):
                args = arguments()
                self.assertEqual((args.backend, args.model, args.classifier_id), expected)

    def test_runtime_must_use_loopback(self):
        self.assertTrue(validate_endpoint('http://127.0.0.1:4000/api/chat'))
        self.assertFalse(validate_endpoint('http://[::1]:4000/v1/chat/completions'))
        for endpoint in (
            'https://example.test/v1/chat/completions',
            'http://127.0.0.1:4000/v1/chat/completions?forward=1',
            'http://127.0.0.1@example.test:4000/api/chat',
        ):
            with self.assertRaises(PipelineError):
                validate_endpoint(endpoint)


class TestState(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.targets = Targets(MODEL_FIXTURES)
        self.partition = Partition('items-1-3', 'firebase', 3, 1, 3)

    def test_scan_queues_resumes_deduplicates_and_exports_no_text(self):
        body = 'GPT-6 Astra is useful while Claude Opus 4 is slow. ' + ' '.join(SENSITIVE_PLACEHOLDERS)
        first = Item(4, 'comment', TIME, body, True, 1)
        changed = Item(4, 'comment', TIME, body.replace('slow', 'worse'), True, 1)
        launch = Item(3, 'story', TIME, available=True, title='GPT-6 Astra launch')
        partition = Partition('items-1-4', 'firebase', 4, 1, 4)
        plan = SourcePlan('firebase', None, 1, 4, (partition,), full_range=True)
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            self.assertEqual(process_block(state, partition, 0, [first, first], self.targets, 'key'), (2, 2))
            state.set_run('paused', 'item-limit', partition)
        with State(self.directory) as state:
            partition, position = state.next_partition()
            self.assertEqual(position, 2)
            self.assertEqual(process_block(state, partition, position, [changed, launch], self.targets, 'key'), (4, 2))
            self.assertIsNone(state.next_partition())
            self.assertEqual([(row['item_id'], row['parent'], row['root']) for row in state.queued(10)], [(4, 1, None)])
            pending = state.pending_stories()
            self.assertEqual([(row['item_id'], row['title'], row['certain']) for row in pending], [
                (3, 'GPT-6 Astra launch', 1),
            ])
            self.assertEqual(json.loads(pending[0]['targets']), [['model', 'gpt-6-astra']])
            state.set_run('complete')
            status = state.export()
        self.assertTrue(status['allPublicItemsScanned'])
        totals = status['totals']
        self.assertEqual(totals['itemsScanned'], 4)
        self.assertEqual(totals['commentsQueued'], 1)
        self.assertEqual(totals['classificationUntracked'], 1)
        self.assertEqual(totals['classified'], 0)
        self.assertEqual(totals['candidates'], 3)
        self.assertEqual((totals['stories'], totals['storiesPending']), (1, 1))
        self.assertEqual(json.loads((self.directory / 'results.json').read_text())['models'], [])
        for file in self.directory.iterdir():
            content = file.read_bytes()
            self.assertNotIn(b'is useful', content)
            for value in SENSITIVE_PLACEHOLDERS:
                self.assertNotIn(value.encode(), content)

    def test_window_checks_inclusive_timestamps_before_queueing(self):
        window = DateWindow(TIME, TIME + 3)
        partition = Partition('items-1-8', 'firebase', 8, 1, 8)
        plan = SourcePlan('firebase', None, 1, 8, (partition,), window=window)
        items = [
            Item(item_id, 'comment', created, 'GPT-6 Astra is useful.', True, 1)
            for item_id, created in enumerate((TIME - 1, TIME, TIME + 3, TIME + 4), 1)
        ] + [
            Item(item_id, kind, created, available=True, title='GPT-6 Astra launch')
            for item_id, kind, created in ((5, 'story', TIME - 1), (6, 'story', TIME), (7, 'poll', TIME + 3), (8, 'story', TIME + 4))
        ]
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            process_block(state, partition, 0, items, self.targets, 'key')
            status = state.export()
            self.assertEqual([row['item_id'] for row in state.queued(10)], [3, 2])
            self.assertEqual([row['item_id'] for row in state.pending_stories()], [7, 6])
        self.assertEqual(status['totals']['itemsScanned'], 8)
        self.assertEqual(status['totals']['commentsScanned'], 2)
        self.assertEqual(status['startAt'], status['firstCommentAt'])
        self.assertEqual(status['endAt'], status['lastCommentAt'])

    def test_failed_partition_keeps_checkpoint_and_partial_coverage(self):
        plan = SourcePlan('firebase', None, 1, 3, (self.partition,), full_range=True)
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.checkpoint(self.partition, 0, Counters(position=1, unavailable=1), 'key')
            state.set_run('blocked', 'firebase-item-request', self.partition)
            status = state.export()
            self.assertEqual(state.next_partition()[1], 1)
        self.assertFalse(status['allPublicItemsScanned'])
        self.assertEqual(status['state'], 'blocked')
        self.assertEqual(status['totals']['partitionsComplete'], 0)
        self.assertEqual(status['totals']['failures'], 1)

    def test_archive_completion_does_not_claim_all_public_items(self):
        archive = Partition('data/2026/2026-08.parquet', 'archive', 1)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 3, (archive,))
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.checkpoint(archive, 0, Counters(position=1), 'key')
            state.set_run('complete')
            status = state.export()
        self.assertEqual(status['totals']['archivePartitionsComplete'], 1)
        self.assertFalse(status['allPublicItemsScanned'])

    def test_archive_bitmap_deduplicates_and_resumes_reconciliation(self):
        archive = Partition('data/2026/2026-08.parquet', 'archive', 4, 1, 6)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 6, (archive,))
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.ensure_reconciliation()
            state.checkpoint(archive, 0, Counters(position=2), 'key', None, [1, 3])
        with State(self.directory) as state:
            state.ensure_reconciliation()
            state.checkpoint(archive, 2, Counters(position=2), 'key', None, [3, 6])
            gap_partition, position = state.next_partition()
            self.assertEqual(gap_partition.id, RECONCILE_ID)
            self.assertEqual(gap_partition.expected_items, 0)
            state.materialize_gaps(gap_partition.last_item)
            gap_partition, position = state.next_partition()
            self.assertEqual(gap_partition.expected_items, 3)
            self.assertEqual(state.gap_ids(position, 3), [5, 4, 2])
            state.checkpoint(gap_partition, 0, Counters(position=1, unavailable=1), 'key')
        with State(self.directory) as state:
            gap_partition, position = state.next_partition()
            self.assertEqual(state.gap_ids(position, 2), [4, 2])
            state.checkpoint(gap_partition, 1, Counters(position=2), 'key')
            state.set_run('complete')
            status = state.export()
        self.assertTrue(status['archiveIdsReconciled'])
        self.assertFalse(status['allPublicItemsScanned'])

    def test_window_migration_preserves_matching_progress_and_removes_older_comments_and_gaps(self):
        old_archive = Partition('data/2026/2026-04.parquet', 'archive', 4, 1, 4)
        archive = Partition('data/2026/2026-05.parquet', 'archive', 4, 5, 10)
        tail = Partition('items-11-13', 'clickhouse-and-firebase', 3, 11, 13)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 13, (tail, archive, old_archive))
        clipped = Partition(archive.id, 'archive', 2, 8, 10, row_offset=2, archive_rows=4)
        window = DateWindow(TIME, TIME + 20)
        new_tail = Partition('items-14-15', 'clickhouse-and-firebase', 2, 14, 15)
        new_plan = SourcePlan('archive-and-tail', 'fixture-revision', 8, 15, (new_tail, tail, clipped), window=window)
        items = [Item(13, 'comment', TIME, 'GPT-6 Astra is useful.', True, 12)]
        old_item = Item(4, 'comment', TIME - 1, 'GPT-6 Astra is useful.', True, 3)
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.ensure_reconciliation()
            process_block(state, tail, 0, items, self.targets, 'key')
            process_block(state, old_archive, 0, [old_item], self.targets, 'key')
            self.assertEqual([row['item_id'] for row in state.queued(10)], [13, 4])
            state.materialize_gaps(10)
            state.restrict_to_plan(new_plan)
            state.ensure_reconciliation()
            status = state.status()
            self.assertEqual(status['state'], 'paused')
            self.assertEqual(status['totals']['itemsScanned'], 1)
            self.assertEqual(status['totals']['commentsQueued'], 1)
            self.assertEqual(status['partitions'][1]['id'], tail.id)
            self.assertEqual(status['partitions'][1]['itemsScanned'], 1)
            self.assertEqual(status['partitions'][2]['expectedItems'], 2)
            self.assertNotIn(old_archive.id, [p['id'] for p in status['partitions']])
            self.assertEqual(state.gap_ids(0, 10), [])
            state.checkpoint(clipped, 0, Counters(position=2), 'key', None, [8, 10])
            state.materialize_gaps(10, 8)
            self.assertEqual(state.gap_ids(0, 10), [9])
            self.assertEqual([row['item_id'] for row in state.queued(10)], [13])

    def test_window_migration_removes_stories_outside_the_window(self):
        tail = Partition('items-1-4', 'clickhouse-and-firebase', 4, 1, 4)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 4, (tail,))
        window = DateWindow(TIME, TIME + 20)
        new_plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 4, (tail,), window=window)
        items = [
            story(1, 'GPT-6 Astra released', created=TIME - 1),
            comment(3, 1, 'GPT-6 Astra is useful.'),
            story(4, 'GPT-6 Astra benchmarks'),
        ]
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            process_block(state, tail, 0, items, self.targets, 'key')
            state.expand_story('key', 1, [(2, TIME, 1), (3, TIME, 1)])
            state.restrict_to_plan(new_plan)
            self.assertEqual([row['item_id'] for row in state.pending_stories()], [4])
            self.assertIsNone(state.story(1))
            self.assertEqual([(row['item_id'], row['root']) for row in state.queued(10)], [(3, None)])

    def test_extension_moves_the_window_end_and_queues_new_items_after_the_old_ones(self):
        tail = Partition('items-1-4', 'clickhouse-and-firebase', 4, 1, 4)
        window = DateWindow(TIME, TIME + 20)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 4, (tail,), window=window)
        new = [Partition('items-6-7', 'clickhouse-and-firebase', 2, 6, 7),
               Partition('items-5-5', 'clickhouse-and-firebase', 1, 5, 5)]
        items = [
            story(1, 'GPT-6 Astra released', created=TIME),
            story(2, 'GPT-6 Astra benchmarks', created=TIME + 10),
            comment(3, 2, 'GPT-6 Astra is useful.', created=TIME + 11),
        ]
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.ensure_reconciliation()
            process_block(state, tail, 0, items, self.targets, 'key')
            state.expand_story('key', 1, [(4, TIME + 1, 1)])
            state.expand_story('key', 2, [(3, TIME + 11, 2)])
            state.connection.execute('UPDATE comment SET failed_groups = 0')
            state.connection.execute("UPDATE partition SET state = 'complete'")
            state.set_run('complete')
            for end, last, partitions in (
                (TIME + 20, 7, new),
                (TIME + 30, 4, ()),
                (TIME + 30, 7, [Partition('items-4-7', 'clickhouse-and-firebase', 4, 4, 7)]),
            ):
                with self.subTest(end=end, last=last), self.assertRaises(PipelineError):
                    state.extend(end, last, partitions, TIME + 5)
            state.extend(TIME + 30, 7, new, TIME + 5)
            status = state.status()
            self.assertEqual((status['state'], status['reason']), ('paused', None))
            self.assertEqual((status['lastItem'], status['endAt'], status['startAt']),
                             (7, iso_time(TIME + 30), iso_time(TIME)))
            self.assertEqual([p['id'] for p in status['partitions']][-2:], ['items-6-7', 'items-5-5'])
            self.assertEqual(state.next_partition(), (new[0], 0))
            # Only the walked story created from the cut-off on is walked again; reviews stay.
            self.assertEqual([row['item_id'] for row in state.pending_stories()], [2])
            self.assertEqual(state.story(1)['state'], 'expanded')
            self.assertEqual(status['totals']['storiesPending'], 1)
            self.assertEqual(status['totals']['classified'], 2)
            self.assertEqual(state.queued(10), [])

    def test_extension_needs_a_dated_archive_and_tail_run(self):
        tail = Partition('items-1-4', 'firebase', 4, 1, 4)
        with State(self.directory) as state:
            with self.assertRaisesRegex(PipelineError, 'no-checkpoint'):
                extend_window(state, 'scan', TIME)
            state.initialize(
                SourcePlan('firebase', None, 1, 4, (tail,), window=DateWindow(TIME, TIME + 20)), 'f', 'k', 'scan',
            )
            with patch('hn_pipeline.get_maxitem', return_value=7), self.assertRaises(PipelineError):
                extend_window(state, 'scan', TIME + 30)

    def test_extension_refuses_a_run_whose_target_names_changed(self):
        tail = Partition('items-1-4', 'clickhouse-and-firebase', 4, 1, 4)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 4, (tail,), window=DateWindow(TIME, TIME + 20))
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key', scan_key_for(self.targets))
            state.connection.execute("UPDATE partition SET state = 'complete'")
            state.set_run('complete')
            before = state.status()
            renamed = Targets([*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}])
            with patch('hn_pipeline.get_maxitem', return_value=7):
                # `run` would refuse the checkpoint afterwards, so nothing may change.
                with self.assertRaisesRegex(PipelineError, 'checkpoint-configuration-mismatch'):
                    extend_window(state, scan_key_for(renamed), TIME + 30)
                self.assertEqual(state.status(), before)
                extend_window(state, scan_key_for(self.targets), TIME + 30)
            self.assertEqual((state.status()['state'], state.status()['lastItem']), ('paused', 7))

    def test_reconciliation_request_cap_allows_single_id_checkpoint(self):
        archive = Partition('data/2026/2026-08.parquet', 'archive', 1, 1, 3)
        plan = SourcePlan('archive-and-tail', 'fixture-revision', 1, 3, (archive,))

        class Capped:
            workers = 8
            requests = 0
            request_limit = 1
            cap_page_size = FirebaseReader.cap_page_size
            runner = SYNC

            def fetch_all(self, ids):
                self.requests += len(ids)
                return [Item(item_id, 'unavailable') for item_id in ids]

        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            state.ensure_reconciliation()
            state.checkpoint(archive, 0, Counters(position=1), 'key', None, [1])
            state.materialize_gaps(3)

            def consume_gaps():
                partition, position = state.next_partition()
                return consume_partition(
                    state, partition, position, reconcile_pages(state, partition, position, 10, Capped()),
                    self.targets, 'key', [10, 10], lambda: False,
                )

            with self.assertRaisesRegex(PipelineError, 'request-limit'):
                consume_gaps()
            self.assertEqual(state.next_partition()[1], 1)
            self.assertEqual(consume_gaps(), 2)
            self.assertIsNone(state.next_partition())
            self.assertTrue(state.status()['archiveIdsReconciled'])

    def test_item_limit_stops_fetching_pages_before_extra_read(self):
        plan = SourcePlan('firebase', None, 1, 3, (self.partition,))
        pages_read = []

        def pages():
            for item_id in (3, 2):
                pages_read.append(item_id)
                yield [Item(item_id, 'story', TIME, available=True)]

        budget = [1, 1]
        with State(self.directory) as state:
            state.initialize(plan, 'fixture', 'key')
            position = consume_partition(state, self.partition, 0, pages(), self.targets, 'key', budget, lambda: False)
        self.assertEqual(pages_read, [3])
        self.assertEqual((position, budget), (1, [0, 1]))


class TestPhases(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.targets = Targets(MODEL_FIXTURES)
        self.partition = Partition('items-1-1000', 'firebase', 1000, 1, 1000)
        self.state = State(self.directory)
        self.addCleanup(self.state.connection.close)
        self.state.initialize(
            SourcePlan('firebase', None, 1, 1000, (self.partition,), window=DateWindow(TIME, TIME + 10)),
            'fixture', 'key',
        )

    def scan(self, items):
        position = self.state.next_partition()[1]
        process_block(self.state, self.partition, position, items, self.targets, 'key')

    def expand(self, firebase, classifier):
        expand_stories(self.state, firebase, self.targets, classifier, 'key', lambda: False)

    def review(self, firebase, classifier, budget=None, failed=False):
        budget = budget or [10, 100]
        with ThreadPoolExecutor() as executor:
            review_comments(
                self.state, firebase, self.targets, classifier, 'key', executor, budget, lambda: False, failed,
            )
        return budget

    def rows(self):
        return {
            row['item_id']: (row['parent'], row['root'], row['mention'])
            for row in self.state.connection.execute('SELECT item_id, parent, root, mention FROM comment')
        }

    def test_expansion_walks_every_level_and_skips_removed_and_out_of_window(self):
        items = [
            story(100, 'GPT-6 Astra launch', kids=(101, 102, 107)),
            comment(101, 100, 'First.', kids=(103, 106)),
            removed(102, 100, kids=(105,)),
            comment(103, 101, 'Claude Opus 4 did better for me.', kids=(104,)),
            comment(104, 103, 'Same here.'),
            comment(105, 102, 'Reply under a removed comment.'),
            comment(106, 101, 'Too late.', created=TIME + 11),
            read_item({'id': 107, 'type': 'comment', 'time': TIME, 'parent': 100, 'deleted': True}, 107),
        ]
        reviewer = Reviewer()
        self.scan([items[0], items[3]])
        self.assertEqual(self.rows(), {103: (101, None, 1)})
        self.expand(Firebase(items), reviewer)
        self.assertEqual(self.rows(), {
            101: (100, 100, 0),
            103: (101, 100, 1),
            104: (103, 100, 0),
            105: (102, 100, 0),
        })
        self.assertEqual(reviewer.titles, [])
        self.assertEqual(self.state.story(100)['state'], 'expanded')
        totals = self.state.status()['totals']
        self.assertEqual((totals['stories'], totals['storiesPending'], totals['threadComments']), (1, 0, 4))

    def test_uncertain_titles_are_checked_before_expansion(self):
        items = [
            story(200, 'Claude Monet retrospective', kids=(201,)),
            comment(201, 200, 'Lovely paintings.'),
            story(300, 'Claude keeps rewriting my tests', kids=(301,)),
            comment(301, 300, 'Mine too.'),
        ]
        reviewer = Reviewer(about={'Claude keeps rewriting my tests'})
        self.scan([items[0], items[2]])
        self.assertEqual([row['certain'] for row in self.state.pending_stories()], [0, 0])
        self.expand(Firebase(items), reviewer)
        self.assertEqual(sorted(reviewer.titles), ['Claude Monet retrospective', 'Claude keeps rewriting my tests'])
        self.assertEqual(self.state.story(200)['state'], 'rejected')
        self.assertEqual(self.state.story(300)['state'], 'expanded')
        self.assertEqual(self.rows(), {301: (300, 300, 0)})
        self.assertEqual(self.state.status()['totals']['stories'], 1)

    def test_an_extended_window_walks_recent_threads_again_without_judging_titles_again(self):
        items = [
            story(300, 'Claude keeps rewriting my tests', kids=(301, 302)),
            comment(301, 300, 'Mine too.'),
            comment(302, 300, 'Later reply.', created=TIME + 15),
        ]
        reviewer = Reviewer(about={'Claude keeps rewriting my tests'})
        self.scan([items[0]])
        self.expand(Firebase(items), reviewer)
        self.review(Firebase(items), reviewer)
        self.assertEqual(self.rows(), {301: (300, 300, 0)})
        self.state.connection.execute("UPDATE partition SET state = 'complete'")
        self.state.connection.execute("UPDATE run SET source = 'archive-and-tail', scan_key = 'scan'")
        new = Partition('items-1001-1010', 'clickhouse-and-firebase', 10, 1001, 1010)
        with patch('hn_pipeline.get_maxitem', return_value=1010):
            extend_window(self.state, 'scan', TIME + 20)
        self.assertEqual(self.state.next_partition(), (new, 0))
        # The title was accepted before, so a reviewer that now accepts nothing is not asked again.
        judge = Reviewer()
        self.expand(Firebase(items), judge)
        self.assertEqual(judge.titles, [])
        self.assertEqual(self.state.story(300)['state'], 'expanded')
        self.assertEqual(self.rows(), {301: (300, 300, 0), 302: (300, 300, 0)})
        self.assertEqual([row['item_id'] for row in self.state.queued(10)], [302])
        self.assertEqual(self.state.status()['totals']['classified'], 1)
        # A story recorded by the new scan is still judged by its title.
        self.state.connection.execute("UPDATE story SET state = 'pending', comments = 0 WHERE item_id = 300")
        self.expand(Firebase(items), judge)
        self.assertEqual(judge.titles, ['Claude keeps rewriting my tests'])
        self.assertEqual(self.state.story(300)['state'], 'rejected')

    def retargeted_run(self):
        """A finished run whose reviews were made under MODEL_FIXTURES, keyed as `run` keys them."""
        key = classifier_key_for('fixture', 'fixture-model', self.targets)
        self.state.connection.execute(
            "UPDATE run SET source = 'archive-and-tail', classifier = 'fixture', classifier_key = ?, scan_key = ?",
            (key, scan_key_for(self.targets)),
        )
        items = [
            story(300, 'GPT-6 Astra launch', kids=(301,)),
            comment(301, 300, 'Fast.'),
            comment(302, 1, 'Claude Opus 4 and Example New 9 both did well.'),
            comment(303, 1, 'Claude Opus 4 is slow.'),
            story(310, 'Example New 9 launch', kids=(311,)),
            comment(311, 310, 'Nice.'),
            story(320, 'GPT-6 Astra or Example New 9?', kids=(321,)),
            comment(321, 320, 'Hmm.'),
            story(330, 'Claude and Example New 9 rewrite my tests', kids=(331,)),
            comment(331, 330, 'Mine too.'),
        ]
        scanned = [items[index] for index in (0, 2, 3, 4, 6, 8)]
        process_block(self.state, self.partition, 0, scanned, self.targets, key)
        expand_stories(self.state, Firebase(items), self.targets, Reviewer(), key, lambda: False)
        with ThreadPoolExecutor() as executor:
            review_comments(
                self.state, Firebase(items), self.targets, Reviewer(), key, executor, [10, 100], lambda: False,
            )
        self.state.connection.execute("UPDATE partition SET state = 'complete', position = 1000")
        self.state.set_run('complete')
        return items, scanned

    def assessed(self):
        return {
            (row['item_id'], row['target'])
            for row in self.state.connection.execute('SELECT item_id, target FROM assessment')
        }

    def test_retarget_keeps_reviews_and_reviews_again_only_what_names_a_new_target(self):
        items, scanned = self.retargeted_run()
        self.assertEqual(self.state.story(330)['state'], 'rejected')
        self.assertEqual(self.state.queued(10), [])
        before = self.assessed()
        renamed = Targets([*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}])
        key = classifier_key_for('fixture', 'fixture-model', renamed)
        with patch('hn_pipeline.current_targets', return_value=renamed):
            retarget(self.state, self.targets, 'fixture', 'fixture-model')
        job = self.state.job()
        self.assertEqual((job['classifier_key'], job['scan_key'], job['state']), (key, scan_key_for(renamed), 'paused'))
        # Every review is kept under the new key.
        self.assertEqual(self.assessed(), before)
        self.assertEqual(
            {row[0] for row in self.state.connection.execute('SELECT DISTINCT classifier_key FROM comment')}, {key},
        )
        self.assertEqual(self.state.added_targets(), {('model', 'example-new')})
        self.assertEqual(self.state.next_partition(), (self.partition, 0))
        # The walked thread whose title names the new model is reviewed again; the rejected story is walked.
        self.assertEqual([row['item_id'] for row in self.state.queued(10)], [321])
        self.assertIn(['model', 'example-new'], json.loads(self.state.story(320)['targets']))
        self.assertEqual([row['item_id'] for row in self.state.pending_stories()], [330])

        # The scan again: a reviewed comment that names the new model is queued, the others are not.
        process_block(self.state, self.partition, 0, scanned, renamed, key)
        reviewer = Reviewer()
        expand_stories(self.state, Firebase(items), renamed, reviewer, key, lambda: False)
        self.assertEqual(reviewer.titles, [])
        self.assertEqual({row['item_id'] for row in self.state.queued(10)}, {302, 311, 321, 331})
        self.state.finish_retarget()
        with ThreadPoolExecutor() as executor:
            review_comments(self.state, Firebase(items), renamed, reviewer, key, executor, [10, 100], lambda: False)
        self.assertEqual(self.state.queued(10), [])
        after = self.assessed()
        self.assertTrue(before < after)
        self.assertTrue({(302, 'example-new'), (311, 'example-new'), (321, 'example-new')} <= after)
        self.assertEqual(len(reviewer.subjects), 4)
        # The run can be extended again with the new list.
        with patch('hn_pipeline.get_maxitem', return_value=1010):
            extend_window(self.state, scan_key_for(renamed), TIME + 20)

    def test_retarget_refuses_another_run_an_unchanged_list_and_a_removed_target_with_reviews(self):
        self.retargeted_run()
        renamed = Targets([*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}])
        without = Targets([model for model in MODEL_FIXTURES if model['id'] != 'claude-opus-4'])
        before = self.state.job()
        for previous, current, model, reason in (
            (self.targets, renamed, 'another-model', 'checkpoint-configuration-mismatch'),
            (Targets(MODEL_FIXTURES[:2]), renamed, 'fixture-model', 'checkpoint-configuration-mismatch'),
            (self.targets, self.targets, 'fixture-model', 'targets-unchanged'),
            (self.targets, without, 'fixture-model', 'removed-target-has-reviews'),
        ):
            with self.subTest(reason=reason, model=model), patch('hn_pipeline.current_targets', return_value=current):
                with self.assertRaisesRegex(PipelineError, reason):
                    retarget(self.state, previous, 'fixture', model)
                self.assertEqual(tuple(self.state.job()), tuple(before))

    def test_a_second_retarget_before_the_scan_ends_adds_its_targets_to_the_first(self):
        self.retargeted_run()
        first = Targets([*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}])
        second = Targets([*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}, {'id': 'other-new', 'name': 'Other New 2'}])
        with patch('hn_pipeline.current_targets', return_value=first):
            retarget(self.state, self.targets, 'fixture', 'fixture-model')
        with patch('hn_pipeline.current_targets', return_value=second):
            retarget(self.state, first, 'fixture', 'fixture-model')
        self.assertEqual(self.state.added_targets(), {('model', 'example-new'), ('model', 'other-new')})
        self.assertEqual(self.state.job()['scan_key'], scan_key_for(second))

    def test_the_previous_target_list_is_the_newest_commit_that_gives_the_scan_key(self):
        source = (ROOT / 'scripts/hn_local/classify.py').read_text()
        lists = {'newest': [*MODEL_FIXTURES, {'id': 'example-new', 'name': 'Example New 9'}], 'older': MODEL_FIXTURES}

        def revision_file(revision, path):
            if revision == 'broken':
                raise subprocess.CalledProcessError(128, 'git')
            return source if path.endswith('.py') else json.dumps({'models': lists[revision]})

        with patch('hn_pipeline.revisions', return_value=['newest', 'broken', 'older']), \
                patch('hn_pipeline.revision_file', side_effect=revision_file):
            found = previous_targets(scan_key_for(self.targets))
            self.assertEqual(found.registry_id, self.targets.registry_id)
            with self.assertRaisesRegex(PipelineError, 'previous-targets-not-found'):
                previous_targets('another-scan')

    def test_collecting_without_the_model_leaves_uncertain_titles_pending(self):
        items = [
            story(200, 'Claude keeps rewriting my tests', kids=(201,)),
            comment(201, 200, 'Mine too.'),
            story(300, 'GPT-6 Astra launch', kids=(301,)),
            comment(301, 300, 'First.'),
        ]
        reviewer = Reviewer()
        self.scan([items[0], items[2]])
        expand_stories(self.state, Firebase(items), self.targets, reviewer, 'key', lambda: False, True)
        self.assertEqual(reviewer.titles, [])
        self.assertEqual([row['item_id'] for row in self.state.pending_stories()], [200])
        self.assertEqual(self.rows(), {301: (300, 300, 0)})
        self.assertFalse(self.state.model_used())

    def test_untouched_queue_can_change_classifier(self):
        items = [
            story(300, 'GPT-6 Astra launch', kids=(301,)),
            comment(301, 300, 'First.'),
        ]
        self.scan([items[0]])
        self.expand(Firebase(items), Reviewer())
        self.assertFalse(self.state.model_used())
        self.state.change_classifier('other', 'other-key')
        job = self.state.job()
        self.assertEqual((job['classifier'], job['classifier_key']), ('other', 'other-key'))
        with ThreadPoolExecutor() as executor:
            review_comments(
                self.state, Firebase(items), self.targets, Reviewer(), 'other-key',
                executor, [10, 100], lambda: False,
            )
        self.assertEqual(self.state.status()['totals']['commentsAboutTargets'], 1)
        self.assertTrue(self.state.model_used())

    def test_title_judgement_counts_as_model_use(self):
        self.scan([story(400, 'Claude keeps rewriting my tests')])
        self.expand(Firebase(), Reviewer())
        self.assertEqual(self.state.story(400)['state'], 'rejected')
        self.assertTrue(self.state.model_used())

    def test_review_reads_story_title_parent_and_story_targets(self):
        items = [
            story(100, 'GPT-6 Astra launch', kids=(101,)),
            comment(101, 100, 'It is slower than Claude Opus 4.', kids=(102,)),
            comment(102, 101, 'Not in my experience.'),
        ]
        reviewer = Reviewer()
        self.scan([items[0]])
        self.expand(Firebase(items), reviewer)
        self.review(Firebase(items), reviewer)
        subjects = sorted(reviewer.subjects, key=lambda subject: subject.text)
        first, reply = subjects
        self.assertEqual((first.title, first.parent), ('GPT-6 Astra launch', ''))
        self.assertEqual([target.label for target in first.targets], ['gpt-6-astra', 'claude-opus-4'])
        self.assertEqual(first.origins, ('story subject', 'named in the comment'))
        self.assertEqual((reply.title, reply.parent), ('GPT-6 Astra launch', 'It is slower than Claude Opus 4.'))
        self.assertEqual(reply.origins, ('story subject', 'named in the replied-to text'))
        self.assertEqual(self.state.status()['totals']['classified'], 2)

    def test_off_topic_comment_is_stored_without_a_model_call(self):
        self.scan([comment(101, 100, 'GPT-6 Astra is useful.')])
        reviewer = Reviewer()
        budget = self.review(Firebase([comment(101, 100, 'Edited to remove the name.'), story(100, 'Ask HN')]), reviewer)
        self.assertEqual((reviewer.subjects, budget[1]), ([], 100))
        totals = self.state.status()['totals']
        self.assertEqual((totals['classified'], totals['commentsAboutTargets'], totals['commentsQueued']), (1, 0, 0))
        self.assertEqual(self.state.results(self.state.status())['models'], [])

    def test_unavailable_comments_leave_the_queue(self):
        self.scan([comment(item_id, 100, 'GPT-6 Astra is useful.') for item_id in (101, 102, 103)])
        firebase = Firebase([removed(101, 100), Item(102, 'story', TIME, available=True), story(100, 'Ask HN')])
        reviewer = Reviewer()
        self.review(firebase, reviewer)
        self.assertEqual((self.rows(), reviewer.subjects), ({}, []))
        totals = self.state.status()['totals']
        self.assertEqual((totals['commentsQueued'], totals['classified']), (0, 0))

    def test_mention_outside_model_thread_keeps_root_and_context_story(self):
        items = [
            story(400, 'Show HN: A text editor', kids=(500,)),
            comment(500, 400, 'Nice work.', kids=(501,)),
            comment(501, 500, 'I built mine with GPT-6 Astra.'),
        ]
        self.scan(items)
        reviewer = Reviewer()
        self.review(Firebase(items), reviewer)
        (subject,) = reviewer.subjects
        self.assertEqual((subject.title, subject.parent, subject.origins), (
            'Show HN: A text editor', 'Nice work.', ('named in the comment',),
        ))
        self.assertEqual(self.rows(), {501: (500, 400, 1)})
        context = self.state.story(400)
        self.assertEqual((context['state'], context['title']), ('context', 'Show HN: A text editor'))
        self.assertEqual(self.state.status()['totals']['stories'], 0)

    def test_root_is_found_through_a_removed_ancestor(self):
        items = [
            story(400, 'Show HN: A text editor', kids=(500,)),
            removed(500, 400, kids=(501,)),
            comment(501, 500, 'I built mine with GPT-6 Astra.'),
        ]
        self.scan([items[2]])
        reviewer = Reviewer()
        self.review(Firebase(items), reviewer)
        self.assertEqual(reviewer.subjects[0].title, 'Show HN: A text editor')
        self.assertEqual(self.rows(), {501: (500, 400, 1)})

    @staticmethod
    def deep_thread():
        """Two branches under one story, one through a removed comment, three and four levels deep."""
        return [
            story(400, 'Show HN: A text editor', kids=(500, 510)),
            comment(500, 400, 'Nice work.', kids=(501,)),
            removed(501, 500, kids=(502,)),
            comment(502, 501, 'Agreed.', kids=(503,)),
            comment(503, 502, 'I built mine with GPT-6 Astra.'),
            comment(510, 400, 'Which language?', kids=(511,)),
            comment(511, 510, 'Rust.', kids=(512,)),
            comment(512, 511, 'GPT-6 Astra wrote most of it.'),
        ]

    def test_ancestors_are_read_one_level_at_a_time(self):
        items = {item.id: item for item in self.deep_thread()}
        firebase = Firebase(items.values())
        known = {}
        read_ancestors(firebase, known, [items[503], items[512]])
        self.assertEqual(firebase.calls, 3)
        self.assertEqual(sorted(firebase.reads), [400, 500, 501, 502, 510, 511])
        for item_id in (503, 512):
            self.assertEqual(thread_root(firebase, known, items[item_id]).id, 400)
        self.assertEqual(firebase.calls, 3)
        read_ancestors(firebase, known, [items[503], None, Item(9, 'unavailable')])
        self.assertEqual(firebase.calls, 3)

    def test_review_reads_ancestors_by_level_outside_a_model_thread(self):
        items = self.deep_thread()
        self.scan([items[4], items[7]])
        firebase = Firebase(items)
        reviewer = Reviewer()
        self.review(firebase, reviewer)
        # The page, its parents, then two more levels: not one request per ancestor.
        self.assertEqual(firebase.calls, 4)
        self.assertEqual(self.rows(), {503: (502, 400, 1), 512: (511, 400, 1)})
        self.assertEqual(
            sorted((subject.title, subject.parent) for subject in reviewer.subjects),
            [('Show HN: A text editor', 'Agreed.'), ('Show HN: A text editor', 'Rust.')],
        )
        self.assertEqual(self.state.story(400)['state'], 'context')

    def test_context_backfill_stores_parent_root_and_title_without_the_model(self):
        thread = self.deep_thread()
        mention = 'I built mine with GPT-6 Astra.'
        queued = [
            comment(503, 502, mention),
            comment(512, 511, mention),
            comment(510, 400, mention),
            comment(700, 699, mention),
            comment(800, 801, mention),
            comment(900, 400, mention),
            comment(451, 450, mention),
        ]
        self.scan(queued)
        self.state.remember_story(450, TIME, 'GPT-6 Astra launch')
        connection = self.state.connection
        with connection:
            connection.execute("UPDATE comment SET parent = NULL WHERE item_id IN (503, 512)")
            connection.execute(
                "UPDATE comment SET failed_groups = 0, task = 'coding', claim = 'Synthetic claim.' WHERE item_id = 510"
            )
            connection.execute(
                """INSERT INTO assessment VALUES
                   (510, 'key', 'model', 'gpt-6-astra', 'positive', '["coding"]', 'high', 0, '[]')"""
            )
            connection.execute(
                "INSERT INTO preference VALUES (510, 'key', 'model', 'gpt-6-astra', 'family', 'Claude')"
            )

        def reviews():
            return (
                [tuple(row) for row in connection.execute('SELECT * FROM assessment')],
                [tuple(row) for row in connection.execute('SELECT * FROM preference')],
                [tuple(row) for row in connection.execute(
                    'SELECT item_id, failed_groups, mention, task, claim, created FROM comment ORDER BY item_id'
                )],
                [tuple(row) for row in connection.execute("SELECT * FROM story WHERE item_id = 450")],
            )

        before = reviews()
        firebase = Firebase([
            *thread,
            comment(700, 699, mention),
            comment(800, 801, mention, kids=(801,)),
            comment(801, 800, 'A loop.', kids=(800,)),
            comment(451, 450, mention),
            story(450, 'Edited title', kids=(451,)),
        ])
        output = io.StringIO()
        with (
            patch('hn_pipeline.CONTEXT_PAGE', 2),
            patch.object(LocalClassifier, 'request', side_effect=AssertionError('no model call')),
            redirect_stdout(output),
        ):
            totals = resolve_context(self.state, firebase, lambda: False)
        self.assertEqual(totals, {'checked': 7, 'resolved': 4, 'unresolved': 3})
        for queued_id in (503, 512, 510, 700, 800, 900, 451):
            self.assertEqual(firebase.reads.count(queued_id), 1, queued_id)
        lines = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(len(lines), 4)
        self.assertTrue(all(set(line) == set(totals) and all(type(v) is int for v in line.values()) for line in lines))
        self.assertEqual(self.rows(), {
            503: (502, 400, 1),
            512: (511, 400, 1),
            510: (400, 400, 1),
            700: (699, None, 1),
            800: (801, None, 1),
            900: (400, None, 1),
            451: (450, 450, 1),
        })
        context = self.state.story(400)
        self.assertEqual((context['state'], context['title'], context['created']), (
            'context', 'Show HN: A text editor', TIME,
        ))
        self.assertEqual(reviews(), before)
        self.assertEqual(self.state.story(450)['title'], 'GPT-6 Astra launch')

        again = Firebase(firebase.items.values())
        with redirect_stdout(io.StringIO()):
            totals = resolve_context(self.state, again, lambda: False)
        self.assertEqual(totals, {'checked': 3, 'resolved': 0, 'unresolved': 3})
        self.assertTrue({503, 512, 510, 451}.isdisjoint(again.reads))
        self.assertEqual(reviews(), before)
        with redirect_stdout(io.StringIO()):
            self.assertEqual(resolve_context(self.state, Firebase(), lambda: True)['checked'], 0)
            self.assertEqual(resolve_context(self.state, Firebase(), lambda: False, budget=1)['checked'], 1)

        connection.close()
        for file in self.directory.iterdir():
            content = file.read_bytes()
            for text in ('built mine', 'Nice work', 'Agreed', 'Which language', 'A loop', *SENSITIVE_PLACEHOLDERS):
                self.assertNotIn(text.encode(), content)

    def test_failed_review_is_excluded_counted_and_retried(self):
        items = [story(100, 'Ask HN'), comment(101, 100, 'GPT-6 Astra is useful.')]
        self.scan(items)
        reviewer = Reviewer(fail=True)
        self.review(Firebase(items), reviewer)
        status = self.state.status()
        self.assertEqual(status['totals']['classificationFailures'], 1)
        self.assertEqual(status['totals']['failures'], 1)
        self.assertEqual((status['totals']['classified'], status['totals']['commentsQueued']), (0, 0))
        self.assertEqual(self.state.results(status)['models'], [])
        self.review(Firebase(items), reviewer)
        self.assertEqual(len(reviewer.subjects), 1)
        reviewer.fail = False
        self.review(Firebase(items), reviewer, failed=True)
        status = self.state.status()
        self.assertEqual(len(reviewer.subjects), 2)
        self.assertEqual((status['totals']['classificationFailures'], status['totals']['classified']), (0, 1))
        self.assertEqual([model['modelId'] for model in self.state.results(status)['models']], ['gpt-6-astra'])

    def test_review_budget_stops_the_phase(self):
        items = [story(100, 'Ask HN')] + [comment(item_id, 100, 'GPT-6 Astra is useful.') for item_id in (101, 102, 103)]
        self.scan(items)
        reviewer = Reviewer()
        budget = self.review(Firebase(items), reviewer, budget=[10, 2])
        self.assertEqual((len(reviewer.subjects), budget), (2, [10, 0]))
        self.assertEqual([row['item_id'] for row in self.state.queued(10)], [101])

    def batch_review(self, firebase, classifier, budget=None, failed=False, stopped=lambda: False):
        budget = budget or [10, 100]
        with patch.object(hn_pipeline, 'BATCH_POLL', 0), redirect_stdout(io.StringIO()):
            review_batches(self.state, firebase, self.targets, classifier, 'key', budget, stopped, failed)
        return budget

    def test_batch_review_sends_context_and_stores_labels_without_text(self):
        items = [
            story(100, 'GPT-6 Astra launch', kids=(101, 103)),
            comment(101, 100, 'It is slower than Claude Opus 4.', kids=(102,)),
            comment(102, 101, 'Not in my experience.'),
            comment(103, 100, 'Deleted before the review.'),
        ]
        firebase = Firebase(items)
        self.scan([items[0]])
        self.expand(firebase, Reviewer())
        firebase.items[103] = removed(103, 100)
        batches = Batches(ready=False)
        classifier = api_classifier(batches)
        self.batch_review(firebase, classifier, stopped=lambda: batches.polls >= 1)
        prompts = batches.prompts()
        self.assertEqual(sorted(prompts), [101, 102])
        self.assertIn('Story title: GPT-6 Astra launch', prompts[101])
        self.assertIn('Replied-to text: It is slower than Claude Opus 4.', prompts[102])
        self.assertIn('1. Claude Opus 4 (model; named in the replied-to text)', prompts[102])
        self.assertEqual((self.state.batches(), self.state.batched()), (['batch-1'], 2))
        self.assertTrue(self.state.model_used())
        self.assertEqual(self.state.status()['totals']['commentsQueued'], 2)
        for file in self.directory.iterdir():
            content = file.read_bytes()
            for text in ('slower than', 'Not in my experience', 'Deleted before'):
                self.assertNotIn(text.encode(), content)

        batches.ready = True
        self.batch_review(firebase, classifier)
        self.assertEqual((len(batches.sent), self.state.batches(), self.state.batched()), (1, [], 0))
        totals = self.state.status()['totals']
        self.assertEqual((totals['classified'], totals['commentsQueued'], totals['classificationFailures']), (2, 0, 0))
        labels = self.state.connection.execute(
            'SELECT item_id, target, sentiment FROM assessment ORDER BY item_id, target'
        )
        self.assertEqual([tuple(row) for row in labels], [
            (101, 'claude-opus-4', 'positive'), (101, 'gpt-6-astra', 'positive'),
            (102, 'claude-opus-4', 'positive'), (102, 'gpt-6-astra', 'positive'),
        ])
        self.assertEqual(classifier.usage['outputTokens'], 60)

    def test_batch_failures_are_retried_with_the_stricter_instruction(self):
        items = [story(100, 'Ask HN')] + [
            comment(item_id, 100, 'GPT-6 Astra is useful.') for item_id in (101, 102, 103, 104)
        ]
        firebase = Firebase(items)
        self.scan(items)
        outcomes = {
            '101': ('succeeded', 'not json'),
            '102': ('errored', ''),
            '103': ('expired', ''),
        }
        batches = Batches(lambda custom_id, prompt: outcomes.get(custom_id, ('succeeded', judged(prompt))))
        classifier = api_classifier(batches)
        self.batch_review(firebase, classifier)
        totals = self.state.status()['totals']
        self.assertEqual(
            (totals['classified'], totals['classificationFailures'], totals['commentsQueued']), (1, 2, 1),
        )
        self.assertEqual((len(batches.sent), self.state.batches()), (1, []))

        outcomes.clear()
        self.batch_review(firebase, classifier, failed=True)
        retried = batches.sent['batch-2']
        self.assertEqual(sorted(request['custom_id'] for request in retried), ['101', '102'])
        self.assertTrue(all(request['params']['messages'][0]['content'].endswith(REMINDER) for request in retried))
        totals = self.state.status()['totals']
        self.assertEqual(
            (totals['classified'], totals['classificationFailures'], totals['commentsQueued']), (3, 0, 1),
        )

    def test_batches_respect_the_budget_and_the_number_in_flight(self):
        items = [story(100, 'Ask HN')] + [
            comment(item_id, 100, 'GPT-6 Astra is useful.') for item_id in range(101, 108)
        ]
        firebase = Firebase(items)
        self.scan(items)
        batches = Batches()
        in_flight = []
        create = batches.create

        def counted(requests):
            batch = create(requests)
            in_flight.append(self.state.batched() + len(batches.sent[batch.id]))
            return batch

        batches.create = counted
        with patch.object(hn_pipeline, 'BATCH_SIZE', 2), patch.object(hn_pipeline, 'BATCH_WAVE', 4):
            budget = self.batch_review(firebase, api_classifier(batches), budget=[10, 5])
        self.assertEqual([len(requests) for requests in batches.sent.values()], [2, 2, 1])
        self.assertEqual((in_flight, budget), ([2, 4, 1], [10, 0]))
        self.assertEqual([row['item_id'] for row in self.state.queued(10)], [102, 101])

    def test_preferences_and_themes_are_stored(self):
        items = [story(100, 'Ask HN'), comment(101, 100, 'GPT-6 Astra beats Claude Opus 4 at coding.')]
        self.scan(items)
        self.review(Firebase(items), Reviewer(prefers=True))
        preference = self.state.connection.execute('SELECT winner, loser FROM preference').fetchall()
        self.assertEqual([tuple(row) for row in preference], [('gpt-6-astra', 'claude-opus-4')])
        themes = self.state.connection.execute('SELECT target, themes FROM assessment ORDER BY target').fetchall()
        self.assertEqual(
            [(row['target'], json.loads(row['themes'])) for row in themes],
            [('claude-opus-4', ['code-quality']), ('gpt-6-astra', ['code-quality'])],
        )
        task, claim = self.state.connection.execute('SELECT task, claim FROM comment').fetchone()
        self.assertEqual((task, claim), ('coding', 'Synthetic claim.'))

    def test_phases_end_to_end_status_results_and_no_text_on_disk(self):
        name, address, handle = SENSITIVE_PLACEHOLDERS
        items = [
            story(100, 'GPT-6 Astra is out', kids=(101, 102)),
            comment(101, 100, 'Much faster than Claude Opus 4 at coding.', kids=(103,)),
            comment(102, 100, f'I had lunch with {name}, mail {address} or @{handle}.'),
            comment(103, 101, 'Agreed, much faster.'),
            story(200, 'Show HN: My editor', kids=(201,)),
            comment(201, 200, 'I wrote it with GPT-6 Astra and it was great.'),
        ]
        reviewer = Reviewer()
        firebase = Firebase(items)
        self.scan(list(reversed(items)))
        self.expand(firebase, reviewer)
        self.review(firebase, reviewer)
        self.review(firebase, reviewer, failed=True)
        status = self.state.export()
        totals = status['totals']
        self.assertEqual((totals['itemsScanned'], totals['commentsScanned']), (6, 4))
        self.assertEqual((totals['stories'], totals['storiesPending'], totals['threadComments']), (1, 0, 3))
        self.assertEqual((totals['commentsQueued'], totals['classificationUntracked']), (0, 0))
        self.assertEqual((totals['classified'], totals['classificationFailures']), (4, 0))
        self.assertEqual((totals['commentsAboutTargets'], totals['candidates']), (4, 4))
        results = self.state.results(status)
        models = {model['modelId']: model for model in results['models']}
        self.assertEqual(sorted(models), ['claude-opus-4', 'gpt-6-astra'])
        self.assertEqual(models['gpt-6-astra']['counts']['positive'], 4)
        self.assertEqual(models['claude-opus-4']['counts']['negative'], 2)
        self.assertEqual([entry['itemId'] for entry in models['gpt-6-astra']['evidence']], [201, 103, 102, 101])
        self.assertEqual(models['gpt-6-astra']['aspects']['coding'], 4)
        self.assertEqual(results['families'], [])
        self.state.connection.close()
        for file in self.directory.iterdir():
            content = file.read_bytes()
            for text in ('Much faster', 'had lunch', 'Agreed', 'wrote it with', *SENSITIVE_PLACEHOLDERS):
                self.assertNotIn(text.encode(), content)


class TestSources(unittest.TestCase):
    def test_calendar_window_is_fixed_to_hobart_dates(self):
        window = recent_window(datetime(2026, 11, 16, 5, 0, tzinfo=timezone.utc))
        self.assertEqual(iso_time(window.start), '2026-05-15T14:00:00Z')
        self.assertEqual(iso_time(window.end), '2026-11-16T05:00:00Z')
        clamped = recent_window(datetime(2026, 8, 31, 5, 0, tzinfo=timezone.utc))
        self.assertEqual(iso_time(clamped.start), '2026-02-27T13:00:00Z')

    def test_plan_prunes_old_archive_and_preserves_legacy_tail_alignment(self):
        archive = Partition('data/2026/2026-07.parquet', 'archive', 200, 200, 400)
        cutoff = Partition('data/2026/2026-05.parquet', 'archive', 200, 1, 199)
        older = Partition('data/2026/2026-04.parquet', 'archive', 100, 1, 100)
        clipped = Partition(cutoff.id, 'archive', 100, 101, 199, row_offset=100, archive_rows=200)
        window = recent_window(datetime(2026, 11, 16, 5, 0, tzinfo=timezone.utc))
        with (
            patch('hn_local.sources.get_maxitem', return_value=20_505),
            patch('hn_local.sources.get_archive', return_value=('fixture-revision', (archive, cutoff, older))),
            patch('hn_local.sources.clip_archive_partition', return_value=clipped) as clip,
        ):
            plan = build_plan('archive-and-tail', window=window, previous_last=20_500)
        clip.assert_called_once_with('fixture-revision', cutoff, window)
        self.assertEqual(plan.window, window)
        self.assertEqual(plan.first_item, 101)
        self.assertEqual([p.id for p in plan.partitions[:3]], ['items-20501-20505', 'items-10501-20500', 'items-501-10500'])
        self.assertEqual(plan.partitions[-2:], (archive, clipped))

    def test_tail_partitions_run_newest_first_in_fixed_sizes(self):
        self.assertEqual(
            [(p.id, p.expected_items) for p in tail_partitions(5, 25_004, 'clickhouse-and-firebase')],
            [('items-15005-25004', 10_000), ('items-5005-15004', 10_000), ('items-5-5004', 5_000)],
        )
        self.assertEqual(tail_partitions(6, 5, 'firebase'), [])
        self.assertEqual(REWALK_DAYS, 30)

    def test_archive_watermark_and_bounded_official_range(self):
        archive = Partition('data/2026/2026-08.parquet', 'archive', 200, 200, 400)
        window = recent_window(datetime(2026, 11, 16, 5, 0, tzinfo=timezone.utc))
        with (
            patch('hn_local.sources.get_maxitem', return_value=500),
            patch('hn_local.sources.get_archive', return_value=('fixture-revision', (archive,))),
            patch('hn_local.sources.recent_window', return_value=window),
        ):
            source = build_plan('archive-and-tail')
            self.assertEqual(source.partitions[0].first_item, 401)
            self.assertEqual(source.partitions[0].last_item, 500)
            self.assertEqual(source.partitions[1], archive)
            self.assertEqual(source.window, window)
            self.assertFalse(source.full_range)
            self.assertFalse(build_plan('firebase', 1, 499).full_range)
            self.assertTrue(build_plan('firebase', 1, 500).full_range)
            with self.assertRaisesRegex(PipelineError, 'firebase-item-range'):
                build_plan('firebase')

    def test_tail_fetches_mirror_holes_from_official_api_in_order(self):
        partition = Partition('items-1-4', 'clickhouse-and-firebase', 4, 1, 4)

        class Mirror:
            def read(self, lower, upper):
                self.range = lower, upper
                return {3: Item(3, 'comment', TIME), 2: Item(2, 'invalid'), 1: Item(1, 'story', TIME)}

        class Official:
            runner = SYNC

            def fetch_all(self, ids):
                self.ids = ids
                return [Item(item_id, 'unavailable') for item_id in ids]

        mirror, firebase = Mirror(), Official()
        pages = list(mirror_pages(partition, 0, 4, mirror, firebase))
        self.assertEqual(mirror.range, (1, 4))
        self.assertEqual(firebase.ids, [4, 2])
        self.assertEqual([item.id for item in pages[0]], [4, 3, 2, 1])

    def test_read_item_keeps_thread_links_and_screened_drops_unnamed_text(self):
        prefilter = Targets(MODEL_FIXTURES).prefilter
        gone = removed(5, 4, kids=(6, 'x', -1, 7))
        self.assertEqual((gone.kind, gone.available, gone.body, gone.kids), ('comment', False, None, (6, 7)))
        launch = read_item({
            'id': 4, 'type': 'story', 'time': TIME, 'title': 'GPT-6 Astra launch', 'text': 'Details.', 'kids': [5],
        }, 4)
        self.assertEqual((launch.title, launch.body, launch.kids, launch.available), (
            'GPT-6 Astra launch', 'Details.', (5,), True,
        ))
        reply = comment(6, 5, 'GPT-6 Astra is useful.', kids=(8,))
        self.assertEqual((reply.parent, reply.kids), (5, (8,)))
        self.assertEqual(read_item({'id': 9, 'type': 'comment', 'time': TIME, 'text': 'x'}, 9).kind, 'invalid')
        self.assertEqual(screened(reply, prefilter).body, 'GPT-6 Astra is useful.')
        self.assertEqual(screened(launch, prefilter).title, 'GPT-6 Astra launch')
        self.assertIsNone(screened(launch, prefilter).body)
        self.assertIsNone(screened(comment(6, 5, 'I had lunch.'), prefilter).body)
        self.assertIsNone(screened(story(4, 'Bicycle repair'), prefilter).title)
        kept = screened(comment(6, 5, 'I had lunch.'), prefilter)
        self.assertEqual((kept.id, kept.kind, kept.created, kept.available, kept.parent), (6, 'comment', TIME, True, 5))

    def test_clickhouse_rows_carry_titles(self):
        row = [4, 'story', TIME, 0, 0, 0, '', 'GPT-6 Astra launch']
        item = read_row(json.dumps(row).encode(), 1, 10)
        self.assertEqual((item.id, item.kind, item.title), (4, 'story', 'GPT-6 Astra launch'))
        reply = read_row(json.dumps([5, 'comment', TIME, 4, 0, 0, 'GPT-6 Astra is useful.', '']).encode(), 1, 10)
        self.assertEqual((reply.parent, reply.body, reply.title), (4, 'GPT-6 Astra is useful.', None))
        for payload in (row[:7], [*row[:7], None], [11, *row[1:]]):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                read_row(json.dumps(payload).encode(), 1, 10)

    @staticmethod
    def archive_buffer(table, row_group_size):
        import pyarrow as arrow
        import pyarrow.parquet as parquet

        with arrow.BufferOutputStream() as writer:
            parquet.write_table(table, writer, row_group_size=row_group_size)
            return writer.getvalue()

    @staticmethod
    @contextmanager
    def patched_reader(buffer):
        import pyarrow as arrow
        import pyarrow.parquet as parquet

        @contextmanager
        def reader(_revision, _partition):
            yield parquet.ParquetFile(arrow.BufferReader(buffer))

        with patch('hn_local.sources.archive_reader', reader):
            yield

    def test_arrow_archive_resumes_inside_batch_and_skips_completed_groups(self):
        import pyarrow as arrow

        table = arrow.table({
            'id': [1, 2, 3, 4, 5, 6, 7],
            'type': [2] * 6 + [1],
            'time': [TIME] * 7,
            'parent': [1] * 6 + [0],
            'dead': [0] * 7,
            'deleted': [0] * 7,
            'text': ['GPT-6 Astra is useful.'] * 6 + [None],
            'title': arrow.array([None] * 6 + ['GPT-6 Astra launch'], arrow.string()),
            'by': ['synthetic-source-author'] * 7,
        })
        partition = Partition('data/2026/2026-08.parquet', 'archive', 7)
        with self.patched_reader(self.archive_buffer(table, 4)):
            pages = list(archive_pages('fixture', partition, 5, 2, 2, re.compile('GPT')))
        self.assertEqual([item.id for page in pages for item in page], [6, 7])
        self.assertEqual([len(page) for page in pages], [1, 1])
        self.assertEqual((pages[1][0].kind, pages[1][0].title), ('story', 'GPT-6 Astra launch'))
        self.assertEqual(pages[0][0].parent, 1)

    def test_archive_titles_and_text_without_targets_are_dropped(self):
        import pyarrow as arrow

        table = arrow.table({
            'id': [1, 2, 3, 4],
            'type': [1, 1, 2, 2],
            'time': [TIME] * 4,
            'parent': [0, 0, 1, 1],
            'dead': [0, 0, 0, 1],
            'deleted': [0] * 4,
            'text': arrow.array([None, None, 'I had lunch.', 'GPT-6 Astra is useful.'], arrow.string()),
            'title': arrow.array(['Bicycle repair', 'GPT-6 Astra launch', None, None], arrow.string()),
        })
        partition = Partition('data/2026/2026-08.parquet', 'archive', 4)
        with self.patched_reader(self.archive_buffer(table, 4)):
            (page,) = archive_pages('fixture', partition, 0, 8, 8, Targets(MODEL_FIXTURES).prefilter)
        self.assertEqual([(item.kind, item.title, item.body, item.available) for item in page], [
            ('story', None, None, True),
            ('story', 'GPT-6 Astra launch', None, True),
            ('comment', None, None, True),
            ('comment', None, None, False),
        ])

    def test_archive_boundary_offsets_and_resumes_across_row_groups(self):
        import pyarrow as arrow

        table = arrow.table({
            'id': [8, 9, 10, 11, 12, 13, 14],
            'type': [2] * 7,
            'time': [TIME - 3, TIME - 2, TIME - 1, TIME, TIME + 1, TIME + 2, TIME + 3],
            'parent': [1] * 7,
            'dead': [0] * 7,
            'deleted': [0] * 7,
            'text': ['GPT-6 Astra is useful.'] * 7,
            'title': arrow.array([None] * 7, arrow.string()),
        })
        partition = Partition('data/2026/2026-05.parquet', 'archive', 7, 8, 14)
        with self.patched_reader(self.archive_buffer(table, 2)):
            clipped = clip_archive_partition('fixture', partition, DateWindow(TIME, TIME + 2))
            self.assertEqual(clipped, Partition(partition.id, 'archive', 3, 11, 13, row_offset=3, archive_rows=7))
            pages = list(archive_pages('fixture', clipped, 1, 2, 5, re.compile('GPT')))
        self.assertEqual([item.id for page in pages for item in page], [12, 13])


if __name__ == '__main__':
    unittest.main()
