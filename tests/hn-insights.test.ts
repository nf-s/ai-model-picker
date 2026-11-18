import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInsights,
  emptyFilter,
  filterComments,
  indexComments,
  positiveShare,
  rankTargets,
  relatedNames,
  summariseSlice,
  sumWeeks,
  targetKey,
} from '../src/lib/hn-insights.ts';
import type { HnIndexComment } from '../src/lib/hn-index.ts';

type Label = HnIndexComment['assessments'][number];
const label = (
  kind: Label['kind'],
  target: string,
  sentiment: Label['sentiment'],
  aspects: Label['aspects'] = [],
  confidence: Label['confidence'] = 'high',
): Label => ({ kind, target, sentiment, aspects, confidence });

// Wednesday 3 June 2026 is in the week starting Monday 1 June.
const comments: HnIndexComment[] = [
  {
    id: 4,
    createdAt: '2026-06-16T10:00:00Z',
    assessments: [
      label('model', 'alpha-2', 'negative', ['cost']),
      label('model', 'beta-1', 'positive', ['cost', 'speed']),
    ],
  },
  {
    id: 3,
    createdAt: '2026-06-09T10:00:00Z',
    assessments: [
      label('family', 'Alpha', 'positive'),
      label('model', 'alpha-2', 'positive', ['coding'], 'low'),
      label('model', 'beta-1', 'negative', ['coding']),
    ],
  },
  {
    id: 2,
    createdAt: '2026-06-08T00:00:00Z',
    assessments: [label('model', 'alpha-2', 'mixed', ['coding'])],
  },
  {
    id: 1,
    createdAt: '2026-06-03T10:00:00Z',
    assessments: [label('model', 'alpha-2', 'positive', ['coding'])],
  },
];
const names = new Map([
  ['family:Alpha', 'Alpha'],
  ['model:alpha-2', 'Alpha 2'],
  ['model:beta-1', 'Beta 1'],
]);
const related = (a: string, b: string) =>
  relatedNames(names.get(a) ?? a, names.get(b) ?? b);

test('names in one lineage are related and adjacent versions are not', () => {
  assert.equal(relatedNames('Claude', 'Claude Opus 5.5'), true);
  assert.equal(relatedNames('Claude Opus', 'Claude Opus 5.5'), true);
  assert.equal(relatedNames('Gemini Argon', 'Gemini 4 Argon'), true);
  assert.equal(relatedNames('GPT', 'GPT-6.1 Sol'), true);
  assert.equal(relatedNames('Qwen', 'Qwen3.6-27B'), true);
  assert.equal(relatedNames('Claude Opus 5', 'Claude Opus 5.5'), false);
  assert.equal(relatedNames('DeepSeek V4 Flash', 'DeepSeek V4.1 Flash'), false);
  assert.equal(relatedNames('Gemma', 'Gemini 4 Argon'), false);
  assert.equal(relatedNames('', 'Claude'), false);
});

test('comments are bucketed into weeks that start on Monday', () => {
  const index = indexComments(comments);
  assert.deepEqual(index.weekStarts, [
    '2026-06-01',
    '2026-06-08',
    '2026-06-15',
  ]);
  assert.deepEqual(
    index.rows.map((row) => row.week),
    [2, 1, 1, 0],
  );
  assert.deepEqual(indexComments([]), {
    rows: [],
    weekStarts: [],
    stories: new Map(),
  });
});

test('thread identifiers and stories are kept when the index has them', () => {
  const story = {
    id: 90,
    title: 'Alpha 2 released',
    createdAt: '2026-06-16T09:00:00Z',
    about: [],
    comments: 1,
  };
  const [first, second] = comments;
  assert.ok(first && second);
  const index = indexComments(
    [{ ...first, story: 90, parent: 91 }, second],
    [story],
  );
  assert.deepEqual(
    index.rows.map((row) => [row.story, row.parent]),
    [
      [90, 91],
      [undefined, undefined],
    ],
  );
  assert.equal('story' in (index.rows[1] ?? {}), false);
  assert.deepEqual(index.stories.get(90), story);
});

test('insights tally sentiment by target, week, aspect and unrelated pair', () => {
  const insights = buildInsights(indexComments(comments), related);
  assert.equal(insights.commentCount, 4);
  assert.deepEqual(insights.weekTotals, [1, 2, 1]);
  const alpha = insights.targets.get('model:alpha-2');
  assert(alpha);
  assert.equal(alpha.total, 4);
  assert.deepEqual(alpha.tally, {
    positive: 2,
    negative: 1,
    mixed: 1,
    neutral: 0,
    unclear: 0,
  });
  assert.equal(positiveShare(alpha.tally), 2 / 3);
  assert.equal(positiveShare(alpha.tally, 4), null);
  assert.equal(sumWeeks(alpha.weeks, 1, 2).negative, 1);
  assert.equal(sumWeeks(alpha.weeks, 1, 2).positive, 1);
  assert.equal(alpha.aspects.coding.positive, 2);
  assert.equal(alpha.aspects.cost.negative, 1);
  assert.equal(alpha.firstAt, '2026-06-03T10:00:00Z');
  assert.equal(alpha.lastAt, '2026-06-16T10:00:00Z');
  assert.equal(alpha.pairs.has('family:Alpha'), false);
  assert.deepEqual(alpha.pairs.get('model:beta-1'), {
    total: 2,
    ahead: 1,
    behind: 1,
    bothPositive: 0,
    bothNegative: 0,
  });
  assert.equal(insights.targets.get('family:Alpha')?.pairs.size, 1);
});

test('filters apply to the selected target label and summarise the slice', () => {
  const index = indexComments(comments);
  const alpha = targetKey({ kind: 'model', target: 'alpha-2' });
  const beta = targetKey({ kind: 'model', target: 'beta-1' });
  const ids = (filter: Partial<typeof emptyFilter>) =>
    filterComments(index, { ...emptyFilter, ...filter }).map((row) => row.id);
  assert.deepEqual(ids({}), [4, 3, 2, 1]);
  assert.deepEqual(ids({ target: alpha, sentiment: 'positive' }), [3, 1]);
  assert.deepEqual(ids({ sentiment: 'negative' }), [4, 3]);
  assert.deepEqual(ids({ target: alpha, alongside: beta }), [4, 3]);
  assert.deepEqual(ids({ target: beta, aspect: 'speed' }), [4]);
  assert.deepEqual(ids({ target: alpha, confidence: 'low' }), [3]);
  assert.deepEqual(ids({ fromWeek: 1, toWeek: 1 }), [3, 2]);
  const slice = summariseSlice(index, { ...emptyFilter, target: alpha });
  assert.equal(slice.total, 4);
  assert.equal(slice.tally.positive, 2);
  assert.deepEqual(slice.weeks, [1, 2, 1]);
  assert.equal(slice.aspects.coding, 3);
  assert.equal(slice.targets.get(beta), 2);
  assert.equal(slice.targets.get('family:Alpha'), 1);
});

test('targets are ranked inside a slice with their full sentiment split', () => {
  const index = indexComments(comments);
  const alpha = targetKey({ kind: 'model', target: 'alpha-2' });
  const beta = targetKey({ kind: 'model', target: 'beta-1' });
  const coding = rankTargets(index, {
    ...emptyFilter,
    target: alpha,
    sentiment: 'positive',
    aspect: 'coding',
  });
  assert.deepEqual(coding.get(alpha), {
    positive: 2,
    negative: 0,
    mixed: 1,
    neutral: 0,
    unclear: 0,
  });
  assert.equal(coding.get(beta)?.negative, 1);
  assert.equal(coding.has('family:Alpha'), false);
  const together = rankTargets(index, { ...emptyFilter, alongside: beta });
  assert.equal(together.get(alpha)?.positive, 1);
  assert.equal(together.get(alpha)?.negative, 1);
  assert.equal(together.get('family:Alpha')?.positive, 1);
});
