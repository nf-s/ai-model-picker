"""Check the local failure-review export using synthetic abstracts and checkpoints."""

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from arxiv_local.failure_review import abstract_evidence, export_failure_review
from arxiv_local.sources import Record
from arxiv_local.state import Counters, State
from arxiv_pipeline import main
from failure_review import REVIEW_LIMIT
from hn_local.classify import Target, Targets
from hn_local.sources import DateWindow

DAY = '2026-06-01'
START = 1_780_272_000
MODEL = Target('model', 'claude-opus-4-8', 'Claude Opus 4.8')
FAMILY = Target('family', 'Gemini', 'Gemini')
INTRO = 'We evaluate coding agents on repository-level bug fixing.'
RESULT = 'Our results show that agents skipped required tests when editing repositories.'


def paper(index, abstract=INTRO + ' ' + RESULT, title='Study of coding agents', submitted=START):
    return Record(f'2606.{index:05d}', 'paper', title, abstract, ('cs.SE',), None, submitted, submitted, 1)


class TestAbstractEvidence(unittest.TestCase):
    def test_study_result_and_clue(self):
        explicit = abstract_evidence('Coding agents', f'{INTRO} {RESULT}')
        clue = abstract_evidence('Coding agents', f'{INTRO} The agents skipped required tests.')
        self.assertEqual(explicit['sourceKind'], 'abstract-result')
        self.assertEqual(clue['sourceKind'], 'abstract-clue')
        self.assertEqual(explicit['evidence'], clue['evidence'])
        self.assertTrue(any('test log' in check for check in explicit['checks']))
        self.assertIn('AI-assisted software development', explicit['scope'])

    def test_joint_method_and_result(self):
        evidence = abstract_evidence(
            'LLM workflows',
            'We benchmark LLM workflows over repeatable tasks and find that agents lost task state after handoffs.',
        )
        self.assertEqual(evidence['scope'], ['AI agents and tool-use workflows'])
        self.assertTrue(any('Resume an unfinished task' in check for check in evidence['checks']))

    def test_measured_result(self):
        explicit = abstract_evidence('Coding agents', 'Across 40 runs, the coding agents skipped required tests.')
        self.assertEqual(explicit['sourceKind'], 'abstract-result')
        self.assertIn('Skipped or broken tests', explicit['evidence'])

    def test_non_observations_and_out_of_scope_abstracts(self):
        for title, abstract in (
            ('Coding agents', 'Prior studies show that coding agents skipped tests.'),
            ('Coding agents', 'We report that prior studies showed that coding agents skipped tests.'),
            ('Coding agents', 'Coding agents often skip tests. We propose a supervised coding workflow.'),
            ('Coding agents', 'We propose a way for coding agents to avoid skipping tests.'),
            ('Coding agents', f'{INTRO} We introduce a new method for inspecting coding agents that skipped tests.'),
            ('Coding agents', f'{INTRO} We measure whether coding agents skipped tests.'),
            ('Coding agents', f'{INTRO} Our results show that no coding agents skipped tests.'),
            ('Coding agents', f'{INTRO} Our experiments show that the new approach prevents agents skipping tests.'),
            ('Coding agents', f'{INTRO} We find that the approach was slower on long tasks.'),
            ('AI image classification', 'Our results show that models ignored constraints in image classification.'),
            ('Software engineering classes', 'We found that students skipped tests in software development.'),
            ('Withdrawn: Coding agents', f'{INTRO} {RESULT}'),
            ('Coding agents', f'This preprint has been withdrawn by the authors. {INTRO} {RESULT}'),
        ):
            with self.subTest(title=title, abstract=abstract):
                self.assertIsNone(abstract_evidence(title, abstract))


class TestFailureReviewExport(unittest.TestCase):
    def test_export_uses_current_matched_abstracts_and_counts_papers_once(self):
        with tempfile.TemporaryDirectory() as directory, State(Path(directory)) as state:
            state.initialize('synthetic', START)
            state.extend(date.fromisoformat(DAY))
            entries = [(paper(index), (MODEL,)) for index in range(1, REVIEW_LIMIT + 2)]
            entries.extend([
                (paper(100, f'{INTRO} {RESULT} Synthetic abstract marker.',
                       'Coding agents <script>Synthetic title marker</script> https://example.test/title', START + 2),
                 (FAMILY, MODEL)),
                (paper(101, submitted=START + 3), ()),
                (paper(102, f'{INTRO} Our results show that tests were thorough.', submitted=START + 3), (MODEL,)),
            ])
            state.checkpoint(DAY, Counters(), entries, [], True)

            export_failure_review(state)
            output = state.directory / 'failure-review.json'
            first_export = output.read_bytes()
            report = json.loads(first_export)
            self.assertEqual(report['source'], 'arxiv')
            self.assertEqual(report['totalCandidates'], REVIEW_LIMIT + 2)
            self.assertEqual(len(report['candidates']), REVIEW_LIMIT)
            newest = report['candidates'][0]
            self.assertEqual(newest['url'], 'https://arxiv.org/abs/2606.00100')
            self.assertEqual(newest['date'], f'{DAY}T00:00:02Z')
            self.assertEqual(newest['status'], 'unverified')
            self.assertEqual(newest['targets'], [
                {'kind': 'model', 'target': 'claude-opus-4-8'}, {'kind': 'family', 'target': 'Gemini'},
            ])
            self.assertEqual(newest['attribution'], 'paper-mentions')
            self.assertEqual(report['candidates'][1]['url'], f'https://arxiv.org/abs/2606.{REVIEW_LIMIT + 1:05d}')
            for private in (b'Synthetic abstract marker', b'Synthetic title marker', b'https://example.test/title'):
                self.assertNotIn(private, first_export)
            export_failure_review(state)
            self.assertEqual(output.read_bytes(), first_export)

            state.checkpoint(DAY, Counters(), [], ['2606.00100'], True)
            export_failure_review(state)
            report = json.loads(output.read_bytes())
            self.assertEqual(report['totalCandidates'], REVIEW_LIMIT + 1)
            self.assertTrue(all(paper['url'] != newest['url'] for paper in report['candidates']))

    def test_run_and_explicit_export_refresh_report_once_each(self):
        with tempfile.TemporaryDirectory() as directory, patch('arxiv_pipeline.os.umask'):
            observation = f'{INTRO} {RESULT} Claude Opus 4.8 was used for the evaluation.'
            targets = Targets([{'id': MODEL.label, 'name': MODEL.name}])
            with (
                patch('arxiv_pipeline.recent_window', return_value=DateWindow(START, START + 2)),
                patch('arxiv_pipeline.today', return_value=date.fromisoformat(DAY)),
                patch('arxiv_pipeline.load_targets', return_value=targets),
                patch('arxiv_pipeline.OaiReader') as reader,
                patch('arxiv_pipeline.stop_flag', return_value=lambda: False),
                patch('arxiv_pipeline.time.monotonic', side_effect=(0, 40, 41)),
                patch('arxiv_pipeline.export_failure_review', wraps=export_failure_review) as report_export,
                patch.object(sys, 'argv', ['arxiv_pipeline.py', 'run', '--state-dir', directory]),
                redirect_stdout(io.StringIO()) as progress,
            ):
                reader.return_value.day.return_value = [[paper(1, observation)]]
                self.assertEqual(main(), 0)
            report_export.assert_called_once()
            self.assertEqual(
                [json.loads(line)['state'] for line in progress.getvalue().splitlines()],
                ['running', 'running', 'complete'],
            )
            output = Path(directory) / 'failure-review.json'
            original = output.read_bytes()
            self.assertEqual(json.loads(original)['totalCandidates'], 1)
            output.unlink()

            with (
                patch.object(sys, 'argv', ['arxiv_pipeline.py', 'export', '--state-dir', directory]),
                patch('arxiv_pipeline.OaiReader') as reader,
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(main(), 0)
            reader.assert_not_called()
            self.assertEqual(output.read_bytes(), original)
