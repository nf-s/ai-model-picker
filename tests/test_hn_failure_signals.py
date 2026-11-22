"""The HN and paper review reports use the same local checks for a symptom."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))

from failure_review import matching_checks, signal_labels


class FailureSignalsTests(unittest.TestCase):
    def test_observations_return_distinct_checks(self):
        checks = matching_checks('The workers skipped tests, ignored constraints and skipped tests again.')
        self.assertEqual(signal_labels(checks), ['Skipped or broken tests', 'Missed instructions or scope'])
        self.assertEqual(len(checks), 2)

    def test_improvements_hypotheses_and_general_criticism_are_excluded(self):
        for text in (
            'Neither worker skipped tests.',
            'The new release no longer invents APIs.',
            'They measured whether the workers lost context.',
            'The approach reduces coordination failures.',
            'Parallel agents do not reduce accuracy.',
            'The model is expensive and unreliable.',
        ):
            with self.subTest(text=text):
                self.assertEqual(matching_checks(text), [])

    def test_negation_stays_with_its_clause(self):
        text = 'It did not invent an API, but failed to run tests.'
        self.assertEqual(signal_labels(matching_checks(text)), ['Skipped or broken tests'])

    def test_task_specific_outcome(self):
        text = 'In our tasks the agent could not retrieve the modified files.'
        self.assertEqual(signal_labels(matching_checks(text)), ['Unsuccessful task action'])
