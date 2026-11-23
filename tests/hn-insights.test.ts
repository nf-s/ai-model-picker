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
// The first three comments as the thread pipeline writes them. Comment 1 has
// no review of that kind.
const reviewed: HnIndexComment[] = [
  {
    id: 4,
    createdAt: '2026-06-16T10:00:00Z',
    assessments: [
      { ...label('model', 'alpha-2', 'negative'), themes: ['pricing'] },
      {
        ...label('model', 'beta-1', 'positive'),
        themes: ['pricing', 'speed'],
      },
    ],
    task: 'coding',
    claim: 'Beta 1 costs less than Alpha 2 for the same work.',
    prefers: [
      {
        winner: { kind: 'model', target: 'beta-1' },
        loser: { kind: 'model', target: 'alpha-2' },
      },
    ],
  },
  {
    id: 3,
    createdAt: '2026-06-09T10:00:00Z',
    assessments: [
      label('family', 'Alpha', 'positive'),
      { ...label('model', 'alpha-2', 'positive'), themes: ['code-quality'] },
      { ...label('model', 'beta-1', 'negative'), themes: ['code-quality'] },
    ],
    task: 'coding',
    claim: 'Alpha 2 writes better code than Beta 1.',
    prefers: [
      {
        winner: { kind: 'model', target: 'alpha-2' },
        loser: { kind: 'model', target: 'beta-1' },
      },
      {
        winner: { kind: 'model', target: 'alpha-2' },
        loser: { kind: 'family', target: 'Alpha' },
      },
    ],
  },
  {
    id: 2,
    createdAt: '2026-06-08T00:00:00Z',
    assessments: [{ ...label('model', 'alpha-2', 'mixed'), themes: ['speed'] }],
    task: 'other',
    prefers: [],
  },
  {
    id: 1,
    createdAt: '2026-06-03T10:00:00Z',
    assessments: [label('model', 'alpha-2', 'positive')],
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
    detailed: false,
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

test('task, claim and stated preferences are kept when the index has them', () => {
  const index = indexComments(reviewed);
  assert.equal(index.detailed, true);
  assert.equal(indexComments(comments).detailed, false);
  const [first, second, third, last] = index.rows;
  assert.ok(first && second && third && last);
  assert.equal(first.task, 'coding');
  assert.equal(
    first.claim,
    'Beta 1 costs less than Alpha 2 for the same work.',
  );
  assert.deepEqual(first.preferences, [
    { winner: 'model:beta-1', loser: 'model:alpha-2' },
  ]);
  assert.deepEqual(second.preferences, [
    { winner: 'model:alpha-2', loser: 'model:beta-1' },
    { winner: 'model:alpha-2', loser: 'family:Alpha' },
  ]);
  assert.equal(third.task, 'other');
  assert.equal('claim' in third, false);
  assert.equal('preferences' in third, false);
  assert.equal('task' in last, false);
  assert.equal('claim' in last, false);
  assert.equal('preferences' in last, false);
});

test('insights tally themes, tasks and stated preferences', () => {
  const insights = buildInsights(indexComments(reviewed), related);
  const alpha = insights.targets.get('model:alpha-2');
  const beta = insights.targets.get('model:beta-1');
  assert(alpha && beta);
  assert.deepEqual(alpha.themes.get('pricing'), {
    positive: 0,
    negative: 1,
    mixed: 0,
    neutral: 0,
    unclear: 0,
  });
  assert.equal(alpha.themes.get('code-quality')?.positive, 1);
  assert.equal(alpha.themes.get('speed')?.mixed, 1);
  assert.equal(beta.themes.get('speed')?.positive, 1);
  assert.equal(beta.themes.get('pricing')?.positive, 1);
  assert.equal(alpha.themes.has('context'), false);
  // Comment 1 has no task, so three of the four labels are counted.
  assert.deepEqual([...alpha.tasks.keys()], ['coding', 'other']);
  assert.deepEqual(alpha.tasks.get('coding'), {
    positive: 1,
    negative: 1,
    mixed: 0,
    neutral: 0,
    unclear: 0,
  });
  assert.equal(alpha.tasks.get('other')?.mixed, 1);
  // One comment prefers each side. The preference for Alpha 2 over its own
  // family is left out.
  assert.deepEqual(alpha.preferences.get('model:beta-1'), {
    over: 1,
    under: 1,
  });
  assert.deepEqual(beta.preferences.get('model:alpha-2'), {
    over: 1,
    under: 1,
  });
  assert.equal(alpha.preferences.has('family:Alpha'), false);
  assert.equal(insights.targets.get('family:Alpha')?.preferences.size, 0);
  // An analysis without these fields has empty tallies.
  const plain = buildInsights(indexComments(comments), related);
  const before = plain.targets.get('model:alpha-2');
  assert(before);
  assert.equal(before.themes.size, 0);
  assert.equal(before.tasks.size, 0);
  assert.equal(before.preferences.size, 0);
});

test('theme and task filters narrow the comments and are counted in a slice', () => {
  const index = indexComments(reviewed);
  const alpha = targetKey({ kind: 'model', target: 'alpha-2' });
  const beta = targetKey({ kind: 'model', target: 'beta-1' });
  const ids = (filter: Partial<typeof emptyFilter>) =>
    filterComments(index, { ...emptyFilter, ...filter }).map((row) => row.id);
  assert.deepEqual(ids({ theme: 'speed' }), [4, 2]);
  // With a target, the theme has to be on that target's label.
  assert.deepEqual(ids({ target: alpha, theme: 'speed' }), [2]);
  assert.deepEqual(ids({ target: beta, theme: 'speed' }), [4]);
  assert.deepEqual(ids({ theme: 'context' }), []);
  // The task belongs to the comment, whichever label is selected.
  assert.deepEqual(ids({ task: 'coding' }), [4, 3]);
  assert.deepEqual(ids({ target: beta, task: 'coding' }), [4, 3]);
  assert.deepEqual(ids({ task: 'other' }), [2]);
  assert.deepEqual(ids({ task: 'coding', theme: 'pricing' }), [4]);
  const slice = summariseSlice(index, { ...emptyFilter, target: alpha });
  assert.deepEqual(
    [...slice.themes],
    [
      ['pricing', 1],
      ['code-quality', 1],
      ['speed', 1],
    ],
  );
  assert.deepEqual(
    [...slice.tasks],
    [
      ['coding', 2],
      ['other', 1],
    ],
  );
  // A comment counts once for a theme carried by two of its labels.
  assert.equal(summariseSlice(index, emptyFilter).themes.get('pricing'), 1);
  const ranked = rankTargets(index, { ...emptyFilter, theme: 'speed' });
  assert.equal(ranked.get(alpha)?.mixed, 1);
  assert.equal(ranked.get(beta)?.positive, 1);
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
