import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyFilter, indexComments } from '../src/lib/hn-insights.ts';
import type { HnIndexComment, HnStory } from '../src/lib/hn-index.ts';
import {
  groupThreads,
  nestComments,
  nodeIds,
  sortThreads,
  tallyRows,
  trimNodes,
} from '../src/lib/hn-threads.ts';

type Sentiment = HnIndexComment['assessments'][number]['sentiment'];
const comment = (
  id: number,
  day: string,
  sentiment: Sentiment,
  thread?: { story: number; parent: number },
): HnIndexComment => ({
  id,
  createdAt: `2026-06-${day}T10:00:00Z`,
  assessments: [
    {
      kind: 'model',
      target: 'alpha-2',
      sentiment,
      aspects: [],
      confidence: 'high',
    },
  ],
  ...thread,
});
const story = (id: number, title: string): HnStory => ({
  id,
  title,
  createdAt: '2026-06-01T00:00:00Z',
  about: [],
  comments: 0,
});

// Story 100: 110 is top-level, 111 replies to it, 112 replies to 111 and 113
// replies to an unlisted comment. Story 200 holds 210 and 211. 300 has no
// recorded thread.
const index = indexComments(
  [
    comment(300, '20', 'neutral'),
    comment(211, '19', 'negative', { story: 200, parent: 200 }),
    comment(210, '18', 'negative', { story: 200, parent: 200 }),
    comment(113, '12', 'negative', { story: 100, parent: 150 }),
    comment(112, '11', 'positive', { story: 100, parent: 111 }),
    comment(111, '10', 'mixed', { story: 100, parent: 110 }),
    comment(110, '09', 'positive', { story: 100, parent: 100 }),
  ],
  [story(100, 'Alpha 2 released'), story(200, 'Beta 1 pricing')],
);
const threads = groupThreads(index.rows, index.stories, emptyFilter);

test('comments group by story, with the unrecorded thread last', () => {
  assert.deepEqual(
    threads.map((thread) => [thread.storyId, thread.rows.map((row) => row.id)]),
    [
      [200, [211, 210]],
      [100, [113, 112, 111, 110]],
      [null, [300]],
    ],
  );
  assert.equal(threads[0]?.story?.title, 'Beta 1 pricing');
  assert.equal(threads[1]?.latest, '2026-06-12T10:00:00Z');
  assert.equal(threads[2]?.story, null);
  assert.equal(
    groupThreads(index.rows, new Map(), emptyFilter)[0]?.story,
    null,
  );
  assert.deepEqual(threads[1]?.tally, {
    positive: 2,
    negative: 1,
    mixed: 1,
    neutral: 0,
    unclear: 0,
  });
});

test('threads sort by size, latest comment or positive share', () => {
  const ids = (order: Parameters<typeof sortThreads>[1], minimum = 1) =>
    sortThreads(threads, order, minimum).map((thread) => thread.storyId);
  assert.deepEqual(ids('comments'), [100, 200, null]);
  assert.deepEqual(ids('latest'), [200, 100, null]);
  assert.deepEqual(ids('positive'), [100, 200, null]);
  assert.deepEqual(ids('critical'), [200, 100, null]);
  // Story 200 has two clear labels and story 100 has three, so a minimum of
  // three leaves only story 100 with a share, whichever end comes first.
  assert.deepEqual(ids('critical', 3), [100, 200, null]);
});

test('listed comments nest under the listed comment they reply to', () => {
  const rows = index.rows.filter((row) => row.story === 100);
  const roots = nestComments(rows, 100);
  assert.deepEqual(
    roots.map((node) => [node.row.id, node.detached]),
    [
      [110, false],
      [113, true],
    ],
  );
  const first = roots[0];
  assert.deepEqual(
    first?.replies.map((node) => node.row.id),
    [111],
  );
  assert.deepEqual(
    first?.replies[0]?.replies.map((node) => node.row.id),
    [112],
  );
  assert.deepEqual(nodeIds(roots), [110, 111, 112, 113]);
  // Without thread identifiers every comment is a root and none is detached.
  const loose = index.rows.filter((row) => row.story === undefined);
  assert.deepEqual(
    nestComments(loose, null).map((node) => [node.row.id, node.detached]),
    [[300, false]],
  );
});

test('a trimmed tree keeps reading order and records the replies left out', () => {
  const rows = index.rows.filter((row) => row.story === 100);
  const roots = nestComments(rows, 100);
  assert.deepEqual(nodeIds(trimNodes(roots, 10)), [110, 111, 112, 113]);
  const two = trimNodes(roots, 2);
  assert.deepEqual(nodeIds(two), [110, 111]);
  assert.deepEqual(two[0]?.trimmed, []);
  assert.deepEqual(two[0]?.replies[0]?.trimmed, [112]);
  // At least one comment is kept, and the full tree is left as it was.
  const none = trimNodes(roots, 0);
  assert.deepEqual(nodeIds(none), [110]);
  assert.deepEqual(none[0]?.trimmed, [111]);
  assert.deepEqual(nodeIds(roots), [110, 111, 112, 113]);
  // A detached comment costs two: 110, 111 and 112 spend three of four, and
  // 113 with its unlisted parent still fits because the budget is not spent.
  assert.deepEqual(nodeIds(trimNodes(roots, 4)), [110, 111, 112, 113]);
  assert.deepEqual(nodeIds(trimNodes(roots, 3)), [110, 111, 112]);
});

test('a tally counts one label per matching assessment', () => {
  const rows = index.rows.filter((row) => row.story === 100);
  assert.deepEqual(tallyRows(rows, { ...emptyFilter, sentiment: 'positive' }), {
    positive: 2,
    negative: 0,
    mixed: 0,
    neutral: 0,
    unclear: 0,
  });
});
