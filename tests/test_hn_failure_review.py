"""Failure shortlist checks using only synthetic Hacker News checkpoints."""

import io
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

import hn_pipeline
from failure_review import REVIEW_LIMIT
from hn_local.classify import Assessment, Review
from hn_local.failure_review import REPORT_NAME, export_failure_review
from hn_local.sources import DateWindow, SourcePlan, iso_time
from hn_local.state import Found, State

TIME = 1_780_000_000
SKIPPED = 'GPT-6 Astra skipped tests after editing a route.'


class TestHnFailureReview(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        self.path = self.directory / REPORT_NAME
        self.targets = hn_pipeline.current_targets()
        self.astra = self.targets.by_label[('model', 'gpt-6-astra')]
        self.opus = self.targets.by_label[('model', 'claude-opus-4')]
        self.model, self.classifier = hn_pipeline.BACKENDS['local']
        self.key = hn_pipeline.classifier_key_for(self.classifier, self.model, self.targets)
        self.state = State(self.directory)
        self.addCleanup(self.state.connection.close)
        self.state.initialize(
            SourcePlan('firebase', None, 1, 1000, (), window=DateWindow(TIME, TIME + 172_800)),
            self.classifier, self.key, hn_pipeline.scan_key_for(self.targets),
        )

    def review(self, claim, *, task='coding', sentiment='negative', confidence='high', themes=('code-quality',),
               also_assesses=None):
        labels = (Assessment(self.astra, sentiment, ('coding',), confidence, themes),)
        if also_assesses is not None:
            labels += (Assessment(also_assesses, 'positive', ('coding',), 'high', themes),)
        return Review(labels, task, claim)

    def queue(self, item, created=TIME, key=None):
        with self.state.connection:
            self.state.queue(key or self.key, Found(comments=[(item, created, 1)]))

    def save(self, item, review, created=TIME, key=None):
        self.queue(item, created, key)
        self.state.save_reviews(key or self.key, [(item, 1, 1, review)])

    def report(self):
        export_failure_review(self.state, self.state.status(), self.targets)
        return json.loads(self.path.read_text())

    def test_requires_a_concrete_scoped_report_with_a_single_critical_target(self):
        self.save(2, self.review(SKIPPED))
        self.save(3, self.review('It lost context after resuming the agent session.', task='other',
                                 confidence='medium', themes=('agentic-work',)), TIME + 86_400)
        for item, review in enumerate((
            self.review('GPT-6 Astra feels worse on complex code.'),
            self.review('GPT-6 Astra no longer skipped tests but took longer.'),
            self.review('Claude Opus 4 invented an API.'),
            self.review('GPT-6 Astra skipped tests while Claude Opus 4 caught the failure.'),
            self.review(SKIPPED, also_assesses=self.opus),
            self.review(SKIPPED, confidence='low'),
            self.review(SKIPPED, sentiment='neutral'),
            self.review(SKIPPED, task='other', themes=('release',)),
            self.review('Something else skipped tests more often than it did.'),
            None,
            self.review(SKIPPED),
            self.review(SKIPPED),
        ), start=4):
            self.save(item, review)
        self.save(30, self.review(SKIPPED), TIME - 1)
        self.save(31, self.review(SKIPPED), key='different-classifier')
        with self.state.connection:
            self.state.connection.execute('UPDATE assessment SET failed = 1 WHERE item_id = 14')
            self.state.connection.execute('UPDATE comment SET failed_groups = NULL WHERE item_id = 15')

        report = self.report()
        self.assertEqual(report['source'], 'hacker-news')
        self.assertEqual(report['reviewedComments'], 12)
        self.assertEqual(report['totalCandidates'], 2)
        context, named = report['candidates']
        self.assertEqual((context['url'], context['date'], context['attribution']), (
            'https://news.ycombinator.com/item?id=3', iso_time(TIME + 86_400), 'review-context',
        ))
        self.assertEqual((named['url'], named['date'], named['attribution']), (
            'https://news.ycombinator.com/item?id=2', iso_time(TIME), 'named-in-claim',
        ))
        self.assertEqual(named['targets'], [{'kind': 'model', 'target': 'gpt-6-astra'}])
        self.assertEqual(named['sourceKind'], 'classifier-claim')
        self.assertEqual(named['evidence'], SKIPPED)
        self.assertIn('test log', named['checks'][0])
        self.assertIn('handoff', context['checks'][0])

    def test_counts_every_match_and_caps_the_shortlist_with_stable_newest_first_order(self):
        for item in range(2, REVIEW_LIMIT + 7):
            self.save(item, self.review(SKIPPED))
        self.save(1, self.review(SKIPPED), TIME + 1)

        report = self.report()
        self.assertEqual(report['totalCandidates'], REVIEW_LIMIT + 6)
        self.assertEqual(len(report['candidates']), REVIEW_LIMIT)
        ids = [int(candidate['url'].split('=')[1]) for candidate in report['candidates']]
        self.assertEqual(ids, [1, *range(REVIEW_LIMIT + 6, 7, -1)])
        first = self.path.read_bytes()
        self.report()
        self.assertEqual(first, self.path.read_bytes())
        self.assertFalse(self.path.with_suffix('.tmp').exists())

    def run_pipeline(self, reviews=(), extra_args=()):
        def review_comments(state, _firebase, _targets, _classifier, key, _executor, _budget, _stop, retrying):
            if not retrying:
                state.save_reviews(key, reviews)

        argv = ['hn_pipeline.py', 'run', '--state-dir', str(self.directory),
                '--source', 'firebase', '--first-item', '1', '--last-item', '1000', *extra_args]
        with (
            patch.object(sys, 'argv', argv),
            patch.object(hn_pipeline, 'build_classifier'),
            patch.object(hn_pipeline, 'FirebaseReader'),
            patch.object(hn_pipeline, 'expand_stories'),
            patch.object(hn_pipeline, 'review_comments', side_effect=review_comments) as classifier,
            patch.object(hn_pipeline.signal, 'signal'),
            redirect_stdout(io.StringIO()) as stdout,
        ):
            code = hn_pipeline.main()
        return code, stdout.getvalue(), classifier.call_count

    def test_complete_run_writes_and_export_rebuilds_the_local_report(self):
        self.queue(2)
        code, output, calls = self.run_pipeline([(2, 1, 1, self.review(SKIPPED))])
        self.assertEqual((code, calls), (0, 2))
        self.assertIn('"state": "complete"', output)
        self.assertNotIn(SKIPPED, output)
        report = self.path.read_bytes()
        self.assertEqual(json.loads(report)['totalCandidates'], 1)
        self.path.unlink()

        result = subprocess.run(
            [sys.executable, '-B', str(ROOT / 'scripts/hn_pipeline.py'), 'export', '--state-dir', str(self.directory)],
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(self.path.read_bytes(), report)
        self.assertNotIn(SKIPPED, result.stdout)

    def test_classification_unresolved_still_writes_successful_reviews(self):
        self.queue(2)
        self.queue(3)
        code, output, calls = self.run_pipeline([(2, 1, 1, self.review(SKIPPED)), (3, 1, 1, None)])
        self.assertEqual((code, calls), (1, 2))
        self.assertIn('"reason": "classification-unresolved"', output)
        report = json.loads(self.path.read_text())
        self.assertEqual((report['reason'], report['totalCandidates']), ('classification-unresolved', 1))

    def test_collect_only_keeps_the_report_for_the_last_review_run(self):
        self.save(2, self.review(SKIPPED))
        self.report()
        previous_report = self.path.read_bytes()
        self.save(3, self.review(SKIPPED))
        code, output, calls = self.run_pipeline(extra_args=('--collect-only',))
        self.assertEqual((code, calls), (0, 0))
        self.assertIn('"state": "complete"', output)
        self.assertEqual(self.path.read_bytes(), previous_report)
