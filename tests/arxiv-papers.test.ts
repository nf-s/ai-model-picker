import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countLabels,
  emptyPaperFilter,
  filterPapers,
  pageCount,
  paperPage,
  paperStanding,
  summariseTargets,
  tallyResults,
  targetResults,
} from '../src/lib/arxiv-papers.ts';
import { arxivSnapshotSchema } from '../src/lib/arxiv-schema.ts';
import type { ArxivPaper } from '../src/lib/arxiv-schema.ts';
import type { TargetRef } from '../src/lib/hn-insights.ts';

const kinds = {
  usage: 1,
  evaluation: 1,
  application: 0,
  behaviour: 0,
  release: 0,
  survey: 0,
  other: 0,
};
const topics = {
  prompting: 1,
  context: 0,
  reasoning: 0,
  agents: 0,
  tools: 0,
  retrieval: 0,
  'structured-output': 0,
  coding: 1,
  cost: 0,
  safety: 0,
  multimodal: 0,
  'fine-tuning': 0,
};
const papers: ArxivPaper[] = [
  {
    id: '2611.00004',
    title: 'Prompt Order Effects in Example Assistants',
    submittedAt: '2026-11-10T09:00:00Z',
    categories: ['cs.CL', 'cs.AI'],
    targets: [
      { kind: 'model', target: 'alpha-2' },
      { kind: 'family', target: 'Beta' },
    ],
    assessment: {
      kind: 'usage',
      topics: ['prompting'],
      takeaway: 'Put worked examples before the question.',
    },
    result: null,
  },
  {
    id: '2610.00003',
    title: 'A Coding Benchmark for Example Models',
    submittedAt: '2026-10-02T09:00:00Z',
    categories: ['cs.SE'],
    targets: [{ kind: 'model', target: 'alpha-2' }],
    assessment: { kind: 'evaluation', topics: ['coding'], takeaway: null },
    result: null,
  },
  {
    id: '2609.12345',
    title: 'Robot Planning with Example Assistants',
    submittedAt: '2026-09-01T09:00:00Z',
    categories: ['cs.RO'],
    targets: [{ kind: 'family', target: 'Beta' }],
    assessment: null,
    result: null,
  },
];
const snapshot = {
  schemaVersion: 1,
  updatedAt: '2026-11-17T11:05:57Z',
  assessor: 'example-assessor-v1',
  startAt: '2026-05-16T14:00:00Z',
  coverage: {
    state: 'running',
    firstDay: '2026-05-16',
    lastDay: '2026-11-17',
    daysComplete: 3,
    daysTotal: 186,
    recordsScanned: 200,
    recordsEligible: 150,
    papers: 3,
    assessed: 2,
    assessmentFailures: 0,
    results: 0,
    resultFailures: 0,
  },
  models: [
    {
      modelId: 'alpha-2',
      papers: 2,
      months: { '2026-10': 1, '2026-11': 1 },
      kinds,
      topics,
    },
  ],
  families: [
    {
      familyName: 'Beta',
      papers: 2,
      months: { '2026-09': 1, '2026-11': 1 },
      kinds: { ...kinds, evaluation: 0 },
      topics: { ...topics, coding: 0 },
    },
  ],
  papers,
};

test('the snapshot schema accepts the local and published shapes', () => {
  assert.equal(arxivSnapshotSchema.parse(snapshot).papers.length, 3);
  const published = arxivSnapshotSchema.parse({
    ...snapshot,
    publishedAt: '2026-11-17T12:00:00.123456+00:00',
  });
  assert.equal(published.publishedAt, '2026-11-17T12:00:00.123456+00:00');
  const unlabelled = arxivSnapshotSchema.parse({
    ...snapshot,
    assessor: null,
    papers: papers.map((paper) => ({ ...paper, assessment: null })),
  });
  assert.equal(unlabelled.assessor, null);
});

test('the snapshot schema rejects unknown keys, bad ids and unknown kinds', () => {
  const withPaper = (change: Record<string, unknown>) => ({
    ...snapshot,
    papers: [{ ...papers[0], ...change }],
  });
  assert.throws(() => arxivSnapshotSchema.parse({ ...snapshot, extra: 1 }));
  assert.throws(() => arxivSnapshotSchema.parse(withPaper({ abstract: 'x' })));
  assert.throws(() =>
    arxivSnapshotSchema.parse({
      ...snapshot,
      coverage: { ...snapshot.coverage, unavailable: 0 },
    }),
  );
  for (const id of ['2611.123', '2611.123456', 'cs/0101001', '26111.00001'])
    assert.throws(() => arxivSnapshotSchema.parse(withPaper({ id })), id);
  assert.throws(() =>
    arxivSnapshotSchema.parse(
      withPaper({
        assessment: { kind: 'opinion', topics: [], takeaway: null },
      }),
    ),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(
      withPaper({
        assessment: { kind: 'usage', topics: ['vibes'], takeaway: null },
      }),
    ),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse({
      ...snapshot,
      models: [{ ...snapshot.models[0], kinds: { ...kinds, opinion: 0 } }],
    }),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse({
      ...snapshot,
      coverage: { ...snapshot.coverage, papers: -1 },
    }),
  );
});

test('papers filter by target, kind, topic and title words in order', () => {
  const ids = (filter: Partial<typeof emptyPaperFilter>) =>
    filterPapers(papers, { ...emptyPaperFilter, ...filter }).map(
      (paper) => paper.id,
    );
  assert.deepEqual(ids({}), ['2611.00004', '2610.00003', '2609.12345']);
  assert.deepEqual(ids({ target: 'model:alpha-2' }), [
    '2611.00004',
    '2610.00003',
  ]);
  assert.deepEqual(ids({ target: 'family:Beta' }), [
    '2611.00004',
    '2609.12345',
  ]);
  assert.deepEqual(ids({ target: 'model:Beta' }), []);
  assert.deepEqual(ids({ kind: 'evaluation' }), ['2610.00003']);
  assert.deepEqual(ids({ kind: 'unlabelled' }), ['2609.12345']);
  assert.deepEqual(ids({ topic: 'prompting' }), ['2611.00004']);
  assert.deepEqual(ids({ query: '  example   ASSISTANTS ' }), [
    '2611.00004',
    '2609.12345',
  ]);
  assert.deepEqual(
    ids({ target: 'family:Beta', kind: 'usage', query: 'prompt' }),
    ['2611.00004'],
  );
});

test('label counts include unlabelled papers', () => {
  const counts = countLabels(papers);
  assert.equal(counts.kinds.usage, 1);
  assert.equal(counts.kinds.evaluation, 1);
  assert.equal(counts.kinds.survey, 0);
  assert.equal(counts.kinds.unlabelled, 1);
  assert.equal(counts.topics.prompting, 1);
  assert.equal(counts.topics.coding, 1);
  assert.equal(counts.topics.safety, 0);
});

test('the target summary counts papers per target', () => {
  assert.deepEqual(
    summariseTargets(papers).map((row) => [row.key, row.kind, row.papers]),
    [
      ['model:alpha-2', 'model', 2],
      ['family:Beta', 'family', 2],
    ],
  );
  assert.deepEqual(summariseTargets([]), []);
});

test('pages are clamped to the available range', () => {
  const items = Array.from({ length: 120 }, (_, index) => index);
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(50), 1);
  assert.equal(pageCount(51), 2);
  const first = paperPage(items, 0);
  assert.deepEqual([first.page, first.pages, first.start], [0, 3, 0]);
  assert.equal(first.rows.length, 50);
  const last = paperPage(items, 2);
  assert.deepEqual(last.rows, items.slice(100));
  assert.equal(paperPage(items, 9).page, 2);
  assert.equal(paperPage(items, -4).page, 0);
  assert.equal(paperPage(items, Number.NaN).page, 0);
  const empty = paperPage([], 3);
  assert.deepEqual([empty.page, empty.pages, empty.rows.length], [0, 1, 0]);
  assert.deepEqual(paperPage(items, 1, 7).rows, [7, 8, 9, 10, 11, 12, 13]);
});

function evaluation(
  id: string,
  submittedAt: string,
  targets: string[],
  result: Partial<NonNullable<ArxivPaper['result']>> & {
    area: NonNullable<ArxivPaper['result']>['area'];
  },
): ArxivPaper {
  return {
    id,
    title: `Evaluation ${id}`,
    submittedAt,
    categories: ['cs.CL'],
    targets: targets.map((target) => ({ kind: 'model', target })),
    assessment: { kind: 'evaluation', topics: [], takeaway: null },
    result: {
      task: 'Example task',
      best: [],
      weak: [],
      finding: null,
      ...result,
    },
  };
}

const alpha: TargetRef = { kind: 'model', target: 'alpha-2' };
const gamma: TargetRef = { kind: 'model', target: 'gamma-1' };
const evaluations: ArxivPaper[] = [
  evaluation('2611.00010', '2026-11-12T09:00:00Z', ['alpha-2', 'gamma-1'], {
    area: 'coding',
    weak: [alpha],
    best: [gamma],
  }),
  evaluation('2611.00009', '2026-11-11T09:00:00Z', ['alpha-2'], {
    area: 'reasoning',
  }),
  evaluation('2610.00008', '2026-10-20T09:00:00Z', ['alpha-2', 'gamma-1'], {
    area: 'coding',
    best: [alpha],
    finding: 'Alpha fixed the most bugs.',
  }),
  evaluation('2609.00007', '2026-09-20T09:00:00Z', ['alpha-2'], {
    area: 'coding',
    best: [alpha],
  }),
  ...papers,
];

test('the snapshot schema accepts a result and rejects bad ones', () => {
  const withResult = (result: unknown) => ({
    ...snapshot,
    papers: [{ ...papers[1], result }],
  });
  const valid = {
    area: 'coding',
    task: 'Fixing bugs in large repositories',
    best: [alpha],
    weak: [],
    finding: null,
  };
  assert.deepEqual(
    arxivSnapshotSchema.parse(withResult(valid)).papers[0]?.result,
    valid,
  );
  assert.equal(
    arxivSnapshotSchema.parse({
      ...snapshot,
      coverage: { ...snapshot.coverage, results: 1, resultFailures: 2 },
    }).coverage.resultFailures,
    2,
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(withResult({ ...valid, area: 'cooking' })),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(withResult({ ...valid, task: 'x'.repeat(121) })),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(withResult({ ...valid, task: '' })),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(withResult({ ...valid, score: 1 })),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(
      withResult({ ...valid, best: [{ ...alpha, rank: 1 }] }),
    ),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse(withResult({ ...valid, finding: '' })),
  );
  const without = (value: object, field: string) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
  assert.throws(() =>
    arxivSnapshotSchema.parse({
      ...snapshot,
      papers: [without(papers[0] ?? {}, 'result')],
    }),
  );
  assert.throws(() =>
    arxivSnapshotSchema.parse({
      ...snapshot,
      coverage: without(snapshot.coverage, 'results'),
    }),
  );
});

test('a standing reads best, weak or unranked from the result', () => {
  const [first, second, third] = evaluations;
  assert.ok(first && second && third);
  assert.equal(paperStanding(first, 'model:alpha-2'), 'weak');
  assert.equal(paperStanding(first, 'model:gamma-1'), 'best');
  assert.equal(paperStanding(second, 'model:alpha-2'), 'unranked');
  assert.equal(paperStanding(third, 'model:gamma-1'), 'unranked');
  assert.equal(paperStanding(second, 'model:gamma-1'), null);
  assert.equal(paperStanding(first, 'family:alpha-2'), null);
  assert.equal(paperStanding(papers[0] ?? first, 'model:alpha-2'), null);
});

test('result tallies count per target and area with an all-areas total', () => {
  const tallies = tallyResults(evaluations);
  assert.deepEqual([...tallies.keys()].sort(), [
    'model:alpha-2',
    'model:gamma-1',
  ]);
  const alphaRow = tallies.get('model:alpha-2');
  assert.deepEqual(alphaRow?.coding, { papers: 3, best: 2, weak: 1 });
  assert.deepEqual(alphaRow?.reasoning, { papers: 1, best: 0, weak: 0 });
  assert.deepEqual(alphaRow?.writing, { papers: 0, best: 0, weak: 0 });
  assert.deepEqual(alphaRow?.all, { papers: 4, best: 2, weak: 1 });
  assert.deepEqual(tallies.get('model:gamma-1')?.all, {
    papers: 2,
    best: 1,
    weak: 0,
  });
  assert.equal(tallyResults(papers).size, 0);
});

test('papers filter by area and count per area', () => {
  const ids = (filter: Partial<typeof emptyPaperFilter>) =>
    filterPapers(evaluations, { ...emptyPaperFilter, ...filter }).map(
      (paper) => paper.id,
    );
  assert.deepEqual(ids({ area: 'coding' }), [
    '2611.00010',
    '2610.00008',
    '2609.00007',
  ]);
  assert.deepEqual(ids({ area: 'reasoning', target: 'model:alpha-2' }), [
    '2611.00009',
  ]);
  assert.deepEqual(ids({ area: 'reasoning', target: 'model:gamma-1' }), []);
  assert.deepEqual(ids({ area: 'safety' }), []);
  const { areas } = countLabels(evaluations);
  assert.equal(areas.coding, 3);
  assert.equal(areas.reasoning, 1);
  assert.equal(areas.safety, 0);
  assert.equal(countLabels(papers).areas.coding, 0);
});

test('results for a target list best, then weak, then unranked, newest first', () => {
  assert.deepEqual(
    targetResults(evaluations, 'model:alpha-2').map((row) => [
      row.paper.id,
      row.standing,
    ]),
    [
      ['2610.00008', 'best'],
      ['2609.00007', 'best'],
      ['2611.00010', 'weak'],
      ['2611.00009', 'unranked'],
    ],
  );
  assert.deepEqual(
    targetResults(evaluations, 'model:gamma-1').map((row) => row.standing),
    ['best', 'unranked'],
  );
  assert.deepEqual(targetResults(evaluations, 'family:Beta'), []);
});
