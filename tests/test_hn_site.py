"""Check the public projection against a synthetic, mutable local checkpoint."""

import json
import runpy
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from hn_local.sources import DateWindow, Partition, PipelineError, SourcePlan, iso_time
from hn_local.state import State

export_module = runpy.run_path(str(ROOT / 'scripts/export-hn-site.py'))
export_snapshot = export_module['export_snapshot']
published_directory = export_module['published_directory']
CLASSIFIER = json.loads((ROOT / 'research/hn-classifier-check.json').read_text())['classifierId']
START = 1_780_000_000
END = START + 1000
CLAIM = 'Synthetic claim about the example model.'
COMMENT = """INSERT INTO comment (item_id, classifier_key, digest, created, priority, failed_groups,
                 root, task, claim) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"""


class TestPublishedExport(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.output = self.directory / 'hn-snapshot.json'
        self.comments = self.directory / 'hn-comments.json'
        plan = SourcePlan(
            'firebase', None, 1, 100, (Partition('items-1-100', 'firebase', 100, 1, 100),),
            False, DateWindow(START, END),
        )
        with State(self.directory) as state:
            state.initialize(plan, CLASSIFIER, 'current')
            with state.connection:
                state.connection.execute(
                    """UPDATE run SET state = 'blocked', updated = ?,
                       reason = 'synthetic-private-reason'""", (END,),
                )
                state.connection.executemany(
                    COMMENT,
                    [
                        (10, 'current', 'synthetic-private-digest', START, 0, 0, None, None, None),
                        (11, 'current', 'synthetic-private-digest', END, 0, 1, None, None, None),
                        (12, 'current', 'synthetic-private-digest', START - 1, 0, 0, None, None, None),
                        (13, 'current', 'synthetic-private-digest', END + 1, 0, 0, None, None, None),
                        (14, 'old', 'synthetic-private-digest', END, 0, 0, None, None, None),
                        (16, 'current', 'synthetic-private-digest', END - 1, 0, None, 900, None, None),
                        (17, 'current', 'synthetic-private-digest', END - 2, 0, 0, 900, 'chat', None),
                        (18, 'current', 'synthetic-private-digest', START + 10, 0, 0, 900, 'coding', CLAIM),
                        (19, 'current', 'synthetic-private-digest', START + 11, 0, 0, 901, None, None),
                    ],
                )
                state.connection.executemany(
                    'INSERT INTO assessment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        (10, 'current', 'model', 'gpt-6-astra', 'positive', '["coding"]', 'high', 0, '[]'),
                        (11, 'current', 'family', 'GPT', 'unclear', '[]', 'low', 1, '[]'),
                        (12, 'current', 'family', 'GPT', 'negative', '[]', 'high', 0, '[]'),
                        (13, 'current', 'family', 'GPT', 'neutral', '[]', 'high', 0, '[]'),
                        (14, 'old', 'family', 'GPT', 'mixed', '[]', 'high', 0, '[]'),
                        (18, 'current', 'model', 'gpt-6-astra', 'negative', '["coding"]', 'high', 0,
                         '["code-quality"]'),
                        (18, 'current', 'family', 'GPT', 'positive', '[]', 'medium', 0, '[]'),
                        (19, 'current', 'family', 'GPT', 'neutral', '[]', 'high', 0, '[]'),
                    ],
                )
                state.connection.execute(
                    'INSERT INTO preference VALUES (?, ?, ?, ?, ?, ?)',
                    (18, 'current', 'family', 'GPT', 'model', 'gpt-6-astra'),
                )
                state.connection.execute('UPDATE comment SET parent = ? WHERE item_id = ?', (950, 18))
                state.connection.executemany(
                    'INSERT INTO story (item_id, created, title, targets, state) VALUES (?, ?, ?, ?, ?)',
                    [
                        (900, START + 5, 'Synthetic story about a model', '[["model","gpt-6-astra"]]', 'expanded'),
                        (901, None, 'Synthetic context story', '[]', 'context'),
                        (902, START, 'Synthetic unreferenced story', '[]', 'pending'),
                    ],
                )

    def read(self):
        return (
            json.loads(self.output.read_text(encoding='utf-8')),
            json.loads(self.comments.read_text(encoding='utf-8')),
        )

    def test_export_has_one_revision_and_current_inclusive_window(self):
        self.assertEqual(export_snapshot(self.directory, self.output), 3)
        snapshot_text = self.output.read_text(encoding='utf-8')
        comments_text = self.comments.read_text(encoding='utf-8')
        snapshot, collection = self.read()
        self.assertEqual(snapshot['publishedAt'], collection['publishedAt'])
        self.assertEqual([row['id'] for row in collection['comments']], [19, 18, 10])
        self.assertEqual(collection['comments'][2]['createdAt'], iso_time(START))
        totals = snapshot['status']['totals']
        self.assertEqual(totals['candidates'], 6)
        self.assertEqual(totals['classified'], 4)
        self.assertEqual(totals['classificationFailures'], 1)
        self.assertEqual(totals['classificationUntracked'], 1)
        self.assertEqual(totals['commentsQueued'], 1)
        self.assertEqual(totals['commentsAboutTargets'], 3)
        self.assertEqual(totals['stories'], 2)
        self.assertEqual(totals['storiesPending'], 1)
        self.assertEqual(totals['threadComments'], 0)
        self.assertEqual(snapshot['results']['models'][0]['counts']['positive'], 1)
        self.assertEqual(snapshot['results']['models'][0]['counts']['negative'], 1)
        self.assertEqual(snapshot['results']['families'][0]['counts']['positive'], 1)
        self.assertNotIn('comments', snapshot)
        self.assertNotIn('synthetic-private-', snapshot_text + comments_text)
        self.assertNotIn('classifier_key', snapshot_text + comments_text)

    def test_queued_failed_and_off_topic_comments_are_not_listed(self):
        export_snapshot(self.directory, self.output)
        _snapshot, collection = self.read()
        ids = {row['id'] for row in collection['comments']}
        self.assertTrue(ids.isdisjoint({11, 16, 17}))
        self.assertTrue(all(row['assessments'] for row in collection['comments']))

    def test_review_details_and_stories_are_published_only_when_present(self):
        export_snapshot(self.directory, self.output)
        _snapshot, collection = self.read()
        rows = {row['id']: row for row in collection['comments']}
        self.assertEqual(list(rows[10]), ['id', 'createdAt', 'assessments'])
        self.assertEqual(list(rows[10]['assessments'][0]), ['kind', 'target', 'sentiment', 'aspects', 'confidence'])
        self.assertEqual(rows[19]['story'], 901)
        self.assertNotIn('parent', rows[19])
        self.assertEqual(rows[18], {
            'id': 18,
            'createdAt': iso_time(START + 10),
            'assessments': [
                {'kind': 'family', 'target': 'GPT', 'sentiment': 'positive', 'aspects': [], 'confidence': 'medium'},
                {
                    'kind': 'model', 'target': 'gpt-6-astra', 'sentiment': 'negative', 'aspects': ['coding'],
                    'confidence': 'high', 'themes': ['code-quality'],
                },
            ],
            'story': 900,
            'parent': 950,
            'task': 'coding',
            'claim': CLAIM,
            'prefers': [{
                'winner': {'kind': 'family', 'target': 'GPT'},
                'loser': {'kind': 'model', 'target': 'gpt-6-astra'},
            }],
        })
        self.assertEqual(collection['stories'], [
            {'id': 901, 'title': 'Synthetic context story', 'createdAt': None, 'about': [], 'comments': 1},
            {
                'id': 900, 'title': 'Synthetic story about a model', 'createdAt': iso_time(START + 5),
                'about': [{'kind': 'model', 'target': 'gpt-6-astra'}], 'comments': 1,
            },
        ])

    def test_snapshot_keeps_original_revision_while_writer_commits(self):
        status = State.status

        def commit_during_export(reader):
            with State(self.directory) as writer, writer.connection:
                writer.connection.execute(
                    COMMENT, (15, 'current', 'synthetic-private-digest', END, 0, 0, None, None, None),
                )
                writer.connection.execute(
                    'INSERT INTO assessment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (15, 'current', 'family', 'GPT', 'mixed', '[]', 'high', 0, '[]'),
                )
                writer.connection.execute('UPDATE run SET updated = ?', (END + 10,))
            return status(reader)

        with patch.object(State, 'status', commit_during_export):
            self.assertEqual(export_snapshot(self.directory, self.output), 3)
        snapshot = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual(snapshot['status']['updatedAt'], iso_time(END))
        self.assertEqual(snapshot['results']['updatedAt'], iso_time(END))
        self.assertEqual(export_snapshot(self.directory, self.output), 4)
        self.assertNotEqual(
            json.loads(self.output.read_text(encoding='utf-8'))['publishedAt'],
            snapshot['publishedAt'],
        )

    def test_unapproved_or_invalid_values_stop_export(self):
        for statement, value in (
            ('UPDATE assessment SET target = ? WHERE item_id = 10', 'synthetic-private-topic'),
            ("UPDATE assessment SET themes = ? WHERE item_id = 18 AND kind = 'model'", '["synthetic"]'),
            ("UPDATE assessment SET themes = ? WHERE item_id = 18 AND kind = 'model'",
             '["code-quality","code-quality"]'),
            ('UPDATE comment SET task = ? WHERE item_id = 18', 'synthetic'),
            ('UPDATE comment SET claim = ? WHERE item_id = 18', 'x' * 241),
            ('UPDATE comment SET root = ? WHERE item_id = 18', 2**32),
            ('UPDATE comment SET parent = ? WHERE item_id = 18', 0),
            ('UPDATE comment SET parent = ? WHERE item_id = 18', -950),
            ('UPDATE comment SET parent = ? WHERE item_id = 18', 'synthetic'),
            ('UPDATE story SET title = ? WHERE item_id = 900', 'x' * 301),
            ('UPDATE story SET state = ? WHERE item_id = 900', 'synthetic'),
            ('UPDATE story SET targets = ? WHERE item_id = 900', '[["model","synthetic-private-topic"]]'),
            ('UPDATE preference SET loser = ? WHERE item_id = 18', 'synthetic-private-topic'),
        ):
            with self.subTest(statement=statement):
                self.setUp()
                with State(self.directory) as state, state.connection:
                    state.connection.execute(statement, (value,))
                with self.assertRaises(PipelineError):
                    export_snapshot(self.directory, self.output)
                self.assertFalse(self.output.exists())
                self.assertFalse(self.comments.exists())

    def test_thread_run_is_published_only_after_its_review_finishes(self):
        self.assertEqual(published_directory(self.directory), self.directory)
        threads = self.directory / 'threads'
        threads.mkdir()
        self.assertEqual(published_directory(self.directory), self.directory)
        shutil.copy(self.directory / 'checkpoint.sqlite3', threads / 'checkpoint.sqlite3')
        for statement in (
            "UPDATE partition SET state = 'complete', position = expected_items",
            "UPDATE story SET state = 'rejected' WHERE state = 'pending'",
            'UPDATE comment SET failed_groups = 1 WHERE failed_groups IS NULL',
        ):
            with self.subTest(statement=statement):
                self.assertEqual(published_directory(self.directory), self.directory)
                with State(threads) as state, state.connection:
                    state.connection.execute(statement)
        # A blocked run with unresolved failures and nothing queued is finished.
        with State(threads, readonly=True) as state:
            self.assertEqual(state.job()['state'], 'blocked')
        self.assertEqual(published_directory(self.directory), threads)
