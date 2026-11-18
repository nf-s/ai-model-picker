"""Check the published arXiv projection against a synthetic, mutable local checkpoint."""

import json
import runpy
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from arxiv_local.assess import MAX_FINDING, MAX_TAKEAWAY, MAX_TASK, Assessment, Result
from arxiv_local.sources import Record
from arxiv_local.state import Counters, State
from hn_local.classify import Target
from hn_local.sources import PipelineError, iso_time

export_snapshot = runpy.run_path(str(ROOT / 'scripts/export-arxiv-site.py'))['export_snapshot']
START = 1_780_272_000
END = START + 1000
DAY = '2026-06-01'
MODEL = Target('model', 'claude-opus-4-8', 'Claude Opus 4.8')
FAMILY = Target('family', 'Gemini', 'Gemini')


def paper(paper_id, submitted, title='A synthetic study'):
    return Record(
        paper_id, 'paper', title, 'synthetic-private-abstract', ('cs.CL', 'cs.AI'), None, submitted, submitted, 1,
    )


class TestPublishedExport(unittest.TestCase):
    def setUp(self):
        self.directory = self.checkpoint()
        self.output = self.directory / 'arxiv-snapshot.json'

    def checkpoint(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        with State(directory) as state:
            state.initialize('synthetic-private-registry', START)
            state.extend(date(2026, 6, 1))
            state.checkpoint(DAY, Counters(records=3, eligible=3), [
                (paper('2606.00001', START + 10, 'Prompting Claude Opus 4.8'), (MODEL, FAMILY)),
                (paper('2606.00002', START + 20), (FAMILY,)),
                (paper('2606.00003', START + 30), ()),
            ], [], True)
            state.set_assessor('fixture-assessor', 'current')
            digest = state.connection.execute("SELECT digest FROM paper WHERE id = '2606.00001'").fetchone()[0]
            state.add_assessment('current', '2606.00001', digest, Assessment('usage', ('prompting',), 'Use tools.'))
            state.set_run('blocked', 'synthetic-private-reason')
            with state.connection:
                state.connection.execute('UPDATE run SET updated = ?', (END,))
        return directory

    def test_export_publishes_validated_results(self):
        self.assertEqual(export_snapshot(self.directory, self.output), 2)
        text = self.output.read_text(encoding='utf-8')
        snapshot = json.loads(text)
        self.assertEqual(
            list(snapshot),
            ['schemaVersion', 'publishedAt', 'updatedAt', 'assessor', 'startAt', 'coverage', 'models', 'families',
             'papers'],
        )
        self.assertEqual(snapshot['updatedAt'], iso_time(END))
        self.assertEqual(snapshot['startAt'], iso_time(START))
        self.assertEqual(snapshot['assessor'], 'fixture-assessor')
        self.assertEqual(snapshot['coverage']['state'], 'blocked')
        self.assertEqual((snapshot['coverage']['papers'], snapshot['coverage']['assessed']), (2, 1))
        self.assertEqual([entry['id'] for entry in snapshot['papers']], ['2606.00002', '2606.00001'])
        self.assertEqual(snapshot['papers'][1], {
            'id': '2606.00001',
            'title': 'Prompting Claude Opus 4.8',
            'submittedAt': iso_time(START + 10),
            'categories': ['cs.CL', 'cs.AI'],
            'targets': [{'kind': 'model', 'target': 'claude-opus-4-8'}, {'kind': 'family', 'target': 'Gemini'}],
            'assessment': {'kind': 'usage', 'topics': ['prompting'], 'takeaway': 'Use tools.'},
            'result': None,
        })
        self.assertIsNone(snapshot['papers'][0]['assessment'])
        self.assertEqual((snapshot['coverage']['results'], snapshot['coverage']['resultFailures']), (0, 0))
        self.assertEqual(snapshot['models'][0]['modelId'], 'claude-opus-4-8')
        self.assertEqual(snapshot['families'][0]['papers'], 2)
        self.assertNotIn('synthetic-private-', text)
        self.assertNotIn('2606.00003', text)

    def evaluated(self, kind='evaluation'):
        directory = self.checkpoint()
        with State(directory) as state:
            digest = state.connection.execute("SELECT digest FROM paper WHERE id = '2606.00001'").fetchone()[0]
            state.add_assessment('current', '2606.00001', digest, Assessment(kind, ('coding',), None))
            state.add_result(
                'current', '2606.00001', digest,
                Result('coding', 'Fixing synthetic bugs', (0,), (1,), 'Synthetic finding.'),
                state.paper_targets('2606.00001'),
            )
        return directory, directory / 'arxiv-snapshot.json'

    def test_export_publishes_evaluation_results(self):
        directory, output = self.evaluated()
        export_snapshot(directory, output)
        snapshot = json.loads(output.read_text(encoding='utf-8'))
        self.assertEqual(snapshot['papers'][1]['result'], {
            'area': 'coding',
            'task': 'Fixing synthetic bugs',
            'best': [{'kind': 'model', 'target': 'claude-opus-4-8'}],
            'weak': [{'kind': 'family', 'target': 'Gemini'}],
            'finding': 'Synthetic finding.',
        })
        self.assertIsNone(snapshot['papers'][0]['result'])
        self.assertEqual((snapshot['coverage']['results'], snapshot['coverage']['resultFailures']), (1, 0))
        directory, output = self.evaluated('usage')
        export_snapshot(directory, output)
        snapshot = json.loads(output.read_text(encoding='utf-8'))
        self.assertIsNone(snapshot['papers'][1]['result'])
        self.assertEqual(snapshot['coverage']['results'], 0)

    def test_unapproved_results_stop_export(self):
        for script in (
            "UPDATE result SET area = 'synthetic-area';",
            "UPDATE result SET task = '';",
            "UPDATE result SET task = '" + 'x' * (MAX_TASK + 1) + "';",
            "UPDATE result SET finding = '" + 'x' * (MAX_FINDING + 1) + "';",
            "UPDATE result SET finding = 'Two  spaces.';",
            "UPDATE result SET best = '[[\"model\", \"synthetic-model\"]]';",
            "UPDATE result SET best = '[[\"model\", \"claude-opus-4-8\"], [\"model\", \"claude-opus-4-8\"]]';",
            "UPDATE result SET weak = best;",
            "UPDATE result SET weak = '[[\"model\"]]';",
        ):
            with self.subTest(script=script[:60]):
                directory, output = self.evaluated()
                with State(directory) as state:
                    state.connection.executescript(script)
                with self.assertRaises(PipelineError) as raised:
                    export_snapshot(directory, output)
                self.assertEqual(str(raised.exception), 'invalid-published-checkpoint')
                self.assertFalse(output.exists())

    def test_snapshot_keeps_original_revision_while_writer_commits(self):
        status = State.status

        def commit_during_export(reader):
            with State(self.directory) as writer, writer.connection:
                writer.connection.execute(
                    """INSERT INTO paper VALUES ('2606.00004', ?, 'Late paper', 'synthetic-private-abstract',
                       '["cs.CL"]', NULL, ?, ?, 1, 'synthetic-private-digest')""",
                    (DAY, START + 40, START + 40),
                )
                writer.connection.execute("INSERT INTO mention VALUES ('2606.00004', 'family', 'Gemini')")
                writer.connection.execute('UPDATE run SET updated = ?', (END + 10,))
            return status(reader)

        with patch.object(State, 'status', commit_during_export):
            self.assertEqual(export_snapshot(self.directory, self.output), 2)
        snapshot = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual(snapshot['updatedAt'], iso_time(END))
        self.assertEqual(snapshot['coverage']['papers'], 2)
        self.assertEqual(export_snapshot(self.directory, self.output), 3)
        latest = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual(latest['updatedAt'], iso_time(END + 10))
        self.assertNotEqual(latest['publishedAt'], snapshot['publishedAt'])

    def test_unapproved_values_stop_export(self):
        for script in (
            "UPDATE mention SET target = 'synthetic-private-topic' WHERE kind = 'family';",
            "UPDATE mention SET kind = 'synthetic-kind' WHERE kind = 'family';",
            "UPDATE mention SET target = 'synthetic-model' WHERE kind = 'model';",
            "UPDATE assessment SET kind = 'synthetic-kind';",
            "UPDATE assessment SET topics = '[\"synthetic-topic\"]';",
            "UPDATE assessment SET takeaway = '" + 'x' * (MAX_TAKEAWAY + 1) + "';",
            "UPDATE paper SET categories = '[\"Not A Category!\"]';",
            "UPDATE paper SET submitted = -1 WHERE id = '2606.00002';",
            "UPDATE run SET state = 'synthetic-state';",
            """INSERT INTO paper VALUES ('hep-th/0601001', '2026-06-01', 'Old-style identifier',
                   'synthetic-private-abstract', '["hep-th"]', NULL, 1780272050, 1780272050, 1, 'digest');
               INSERT INTO mention VALUES ('hep-th/0601001', 'family', 'Gemini');""",
        ):
            with self.subTest(script=script[:60]):
                directory = self.checkpoint()
                output = directory / 'arxiv-snapshot.json'
                with State(directory) as state:
                    state.connection.executescript(script)
                with self.assertRaises(PipelineError) as raised:
                    export_snapshot(directory, output)
                self.assertEqual(str(raised.exception), 'invalid-published-checkpoint')
                self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
