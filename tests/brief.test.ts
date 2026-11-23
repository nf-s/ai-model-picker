import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseOrder,
  computeBrief,
  findJob,
  guideSelections,
  lowerCostMissing,
  orderExplanation,
  orderRules,
  parseInterval,
  periodStart,
  prepareBrief,
  signalLabel,
  signalScale,
} from '../src/lib/brief.ts';
import type { BriefFilters, Signal } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import type { Core } from '../src/lib/core-schema.ts';
import type { EvidenceRecord } from '../src/lib/records.ts';

// A small invented core.json: models a to f, a coding job with two
// benchmarks and a sub-job without one, a reasoning job measured only by a
// general index, a writing job ordered by an arena rating beside a percentage
// benchmark, and a planning job with no benchmark.

const models = ['a', 'b', 'c', 'd', 'e', 'f'];
const prices: Record<string, number> = {
  a: 40,
  b: 20,
  c: 10,
  d: 5,
  e: 2,
  f: 1,
};

function benchmark(
  id: string,
  unit: string,
  scale: 'percent' | 'index' | 'rating',
  general = false,
) {
  return {
    id,
    name: `Bench ${id}`,
    category: general ? 'general' : 'coding',
    general,
    unit,
    scale,
    what: `What ${id} measures.`,
    methodology: '',
    costMethod: '',
    url: 'https://example.test/bench',
    source: scale === 'rating' ? 'lmarena' : 'snapshot',
    publishedAt: scale === 'rating' ? '2026-11-01' : '',
    attribution: '',
  };
}

function result(
  bench: string,
  model: string,
  score: number,
  options: { interval?: string; cost?: number; date?: string; n?: number } = {},
): EvidenceRecord {
  return {
    id: `bm:${bench}-${model}-${options.n ?? 0}`,
    cls: 'measured',
    src: 'benchmark',
    keys: [[`model|${model}`, 'neutral']],
    job: '',
    how: '',
    via: '',
    stance: 'neutral',
    text: `${model} on ${bench}`,
    quote: '',
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date: options.date ?? '',
    person: '',
    url: 'https://example.test/result',
    title: bench,
    kind: 'benchmark result',
    x: {
      b: bench,
      score,
      config: `${model} config`,
      cost: options.cost ?? null,
      interval: options.interval ?? '',
    },
    checked: '2026-11-01',
  };
}

let preferenceId = 1;
function preferences(
  winner: string,
  loser: string,
  job: string,
  count: number,
  date = '2026-10-10',
) {
  return Array.from({ length: count }, () => ({
    winner: `model|${winner}`,
    loser: `model|${loser}`,
    job,
    date,
    id: `hn:${preferenceId++}`,
  }));
}

function makeCore(): Core {
  return coreSchema.parse({
    sources: {
      snapshot: '2026-11-01',
      lmarena: {
        fetchedAt: '2026-11-01',
        checkedAt: '2026-11-01',
        attribution: 'Synthetic.',
        records: 0,
      },
      epoch: {
        fetchedAt: '2026-11-01',
        checkedAt: '2026-11-01',
        attribution: 'Synthetic.',
        records: 0,
      },
      hn: {
        from: 'export',
        publishedAt: '',
        classifier: 'synthetic',
        startAt: '2026-05-01T00:00:00Z',
        endAt: '2026-11-20T00:00:00Z',
        comments: 0,
        labels: 0,
      },
    },
    jobs: {
      version: 1,
      status: 'draft',
      list: [
        {
          id: 'coding',
          label: 'Write code',
          benchmarks: ['tb', 'swe'],
          guideTask: 'fixes',
        },
        { id: 'refactor', label: 'Refactor', parent: 'coding', benchmarks: [] },
        {
          id: 'bug-fix',
          label: 'Fix bugs',
          parent: 'coding',
          benchmarks: ['swe'],
        },
        { id: 'reasoning', label: 'Reasoning', benchmarks: ['eci'] },
        { id: 'writing', label: 'Writing', benchmarks: ['arena', 'pct'] },
        { id: 'planning', label: 'Planning', benchmarks: [] },
      ],
      categories: { general: '', coding: 'coding', writing: 'writing' },
    },
    models: models.map((id) => ({
      id,
      name: `Model ${id.toUpperCase()}`,
      provider: id < 'd' ? 'Lab One' : 'Lab Two',
      status: id === 'f' ? 'previous' : 'current',
      input: prices[id] ?? null,
      output: prices[id] ?? null,
      priceUrl: '',
      contextTokens: null,
    })),
    lines: [],
    benchmarks: [
      benchmark('tb', 'Resolved tasks (%)', 'percent'),
      benchmark('swe', 'Resolved problems (%)', 'percent'),
      benchmark('eci', 'ECI points', 'index', true),
      benchmark('arena', 'Arena rating', 'rating'),
      benchmark('pct', '%', 'percent'),
    ],
    measured: [
      // tb: a leads; b's interval overlaps a's; c is far below; e is cheap and close.
      result('tb', 'a', 70, { interval: '±3 · 95%', cost: 10 }),
      result('tb', 'a', 60, { interval: '±3 · 95%', cost: 4, n: 1 }),
      result('tb', 'b', 66, { interval: '±3 · 95%', cost: 8 }),
      result('tb', 'c', 40, { interval: '±3 · 95%', cost: 1 }),
      result('tb', 'e', 61, { interval: '±2 · 95%', cost: 4 }),
      result('tb', 'f', 90, { interval: '±2 · 95%', cost: 1 }),
      result('swe', 'a', 50),
      result('swe', 'b', 49),
      result('eci', 'a', 150),
      result('eci', 'b', 160),
      result('eci', 'c', 140),
      // arena: d leads, a overlaps and costs more, e overlaps at a fifth of d's price.
      result('arena', 'd', 1300, { interval: '1290–1310 · bounds' }),
      result('arena', 'a', 1295, { interval: '1285–1305 · bounds' }),
      result('arena', 'e', 1294, { interval: '1289–1299 · bounds' }),
      result('arena', 'c', 1200, { interval: '1190–1210 · bounds' }),
      result('pct', 'a', 80),
    ],
    crowd: {
      stances: ['positive', 'critical', 'mixed', 'neutral'],
      counts: {
        'model|a': {
          planning: { '2026-10': [8, 2, 0, 0], '2026-06': [4, 0, 0, 0] },
        },
        'model|b': { planning: { '2026-10': [5, 4, 1, 0] } },
        'model|c': { planning: { '2026-10': [5, 4, 0, 0] } },
      },
      themes: {},
      comments: { planning: [11, 12] },
    },
    preferences: [
      ...preferences('b', 'a', 'coding', 4, '2026-10-10'),
      ...preferences('b', 'a', 'coding', 2, '2026-06-10'),
      ...preferences('a', 'b', 'coding', 1, '2026-10-10'),
    ],
    coverage: { sources: [], rows: [] },
    usage: null,
    namedBehindSignIn: false,
  });
}

const all: BriefFilters = {
  inScope: () => true,
  current: true,
  since: '',
  classes: ['measured', 'crowd'],
};

function brief(
  jobId: string,
  filters: BriefFilters = all,
  within: 'preferences' | 'cost' = 'preferences',
) {
  const data = prepareBrief(makeCore());
  const job = findJob(data, jobId);
  assert.ok(job);
  return { data, brief: computeBrief(data, job, filters, within) };
}

function bench(id: string) {
  const found = prepareBrief(makeCore()).benchmarkById.get(id);
  assert.ok(found);
  return found;
}

const names = (rows: readonly { model: { id: string } }[]) =>
  rows.map((row) => row.model.id);

test('the job’s own benchmark with the most models sets the order', () => {
  const { brief: coding } = brief('coding');
  assert.equal(coding.primary && signalLabel(coding.primary), 'Bench tb');
  assert.deepEqual(coding.basis, {
    kind: 'benchmark',
    signal: 0,
    why: 'job',
    covered: 4,
  });
  // f has the highest result but is not current.
  assert.equal(coding.lead?.model.id, 'a');
});

test('on a tie the first benchmark listed in the job file sets the order', () => {
  const signals: Signal[] = [
    { kind: 'benchmark', benchmark: bench('tb') },
    { kind: 'benchmark', benchmark: bench('swe') },
    { kind: 'preferences' },
    { kind: 'crowd' },
  ];
  assert.deepEqual(chooseOrder(signals, [3, 3, 0, 0]), {
    kind: 'benchmark',
    signal: 0,
    why: 'job',
    covered: 3,
  });
  assert.deepEqual(chooseOrder(signals, [3, 4, 0, 0]), {
    kind: 'benchmark',
    signal: 1,
    why: 'job',
    covered: 4,
  });
});

test('models whose interval overlaps the highest come first, ordered by stated preferences', () => {
  const { brief: coding } = brief('coding');
  // b overlaps a (63–69 against 67–73) and is preferred in 6 of 7 comparisons.
  assert.deepEqual(names(coding.rows), ['b', 'a', 'e', 'c']);
  assert.deepEqual(
    coding.rows.map((row) => row.overlap),
    [true, true, false, false],
  );
  assert.equal(coding.first?.model.id, 'b');
  assert.match(
    orderRules(coding),
    /ordered by stated preferences on this job over all dates/,
  );
});

test('the switch to cost orders the overlapping models by cost', () => {
  const { brief: coding } = brief('coding', all, 'cost');
  assert.deepEqual(names(coding.rows), ['b', 'a', 'e', 'c']);
  assert.equal(coding.rows[0]?.cost, 8);
  assert.match(orderRules(coding), /ordered by cost per trial/);
});

test('the period filter never changes an order a benchmark sets', () => {
  // From October only one stated preference favours b (4 against 1 is under
  // the minimum of 5), yet the order inside the overlap uses all dates.
  const since = periodStart('2026-11-20', 3);
  assert.equal(since, '2026-08-20');
  const { brief: recent } = brief('coding', { ...all, since });
  assert.deepEqual(names(recent.rows), names(brief('coding').brief.rows));
});

test('lower cost is the cheapest at most half the first choice’s cost and 85% of the highest', () => {
  const { brief: coding } = brief('coding');
  // First choice b costs 8 per trial; e costs 4 and scores 61 against 70 × 0.85 = 59.5.
  // c costs 1 but scores 40.
  assert.equal(coding.lower?.model.id, 'e');
  assert.equal(coding.second?.model.id, 'a');
});

test('lower cost under an arena rating needs an overlapping interval', () => {
  const { brief: writing } = brief('writing');
  assert.equal(writing.rating, true);
  assert.equal(writing.first?.model.id, 'd');
  // a overlaps but costs 40 against 5; e overlaps at 2 (under half); c is far below.
  assert.equal(writing.lower?.model.id, 'e');
  assert.equal(writing.second?.model.id, 'a');
  assert.match(orderRules(writing), /interval overlaps the highest result/);
});

test('with no lower-cost model the card says which rule was not met', () => {
  const { brief: coding } = brief('coding', {
    ...all,
    inScope: (id) => id === 'a' || id === 'b',
  });
  assert.equal(coding.lower, null);
  assert.equal(
    lowerCostMissing(coding),
    'No model at 85% or more of the highest result for half the cost or less.',
  );
});

test('arena ratings and percentages never share a column', () => {
  const { brief: writing } = brief('writing');
  const scales = writing.signals.map(signalScale);
  assert.deepEqual(scales, ['rating', 'percent', 'share', 'share']);
  writing.signals.forEach((signal, i) => {
    for (const row of writing.rows) {
      const value = row.values[i];
      if (value && signal.kind === 'benchmark')
        assert.ok(
          value.records.every((record) => record.x?.b === signal.benchmark.id),
        );
    }
  });
});

test('ranks are overall ranks, never renumbered inside a filter', () => {
  const { brief: open } = brief('coding');
  const { brief: narrow } = brief('coding', {
    ...all,
    inScope: (id) => id === 'c' || id === 'e',
  });
  const rank = (b: typeof open, id: string) =>
    b.rows.find((row) => row.model.id === id)?.ranks[0];
  // f (not current) holds rank 1 overall.
  assert.equal(rank(open, 'a'), 2);
  assert.equal(rank(narrow, 'e'), rank(open, 'e'));
  assert.equal(rank(narrow, 'c'), 5);
  assert.equal(narrow.field[0], 5);
});

test('the general index sets the order only when no job benchmark covers three models', () => {
  const { data, brief: reasoning } = brief('reasoning');
  assert.deepEqual(reasoning.basis, {
    kind: 'benchmark',
    signal: 0,
    why: 'general',
    covered: 3,
  });
  assert.match(
    orderExplanation(data, reasoning),
    /so the general index sets the order/,
  );
  const signals: Signal[] = [
    { kind: 'benchmark', benchmark: bench('swe') },
    { kind: 'benchmark', benchmark: bench('eci') },
    { kind: 'preferences' },
    { kind: 'crowd' },
  ];
  assert.deepEqual(chooseOrder(signals, [3, 9, 0, 0]), {
    kind: 'benchmark',
    signal: 0,
    why: 'job',
    covered: 3,
  });
  assert.deepEqual(chooseOrder(signals, [2, 3, 0, 0]), {
    kind: 'benchmark',
    signal: 1,
    why: 'general',
    covered: 3,
  });
  // Fewer than three on both: the job's own benchmark still orders, and says so.
  assert.deepEqual(chooseOrder(signals, [2, 1, 9, 9]), {
    kind: 'benchmark',
    signal: 0,
    why: 'few',
    covered: 2,
  });
});

test('a sub-job without a benchmark uses its parent’s and says so', () => {
  const { data, brief: refactor } = brief('refactor');
  assert.equal(refactor.from, 'coding');
  assert.equal(refactor.primary && signalLabel(refactor.primary), 'Bench tb');
  assert.equal(
    orderExplanation(data, refactor),
    'No benchmark measures refactor itself; this is the benchmark of write code with the most models in the filters.',
  );
});

test('a sub-job whose own benchmark covers fewer than three models takes its parent’s order', () => {
  const { data, brief: fix } = brief('bug-fix');
  // swe covers a and b only; the parent's tb covers four current models.
  assert.equal(fix.primary && signalLabel(fix.primary), 'Bench tb');
  assert.deepEqual(
    fix.signals.map((signal) =>
      signal.kind === 'benchmark' ? signal.benchmark.id : signal.kind,
    ),
    ['swe', 'tb', 'preferences', 'crowd'],
  );
  assert.equal(fix.borrowed?.parent.id, 'coding');
  assert.equal(fix.borrowed?.covered, 2);
  assert.equal(fix.from, null);
  // No stated preference is on this sub-job, so the overlap keeps the result order.
  assert.deepEqual(names(fix.rows), ['a', 'b', 'e', 'c']);
  assert.equal(
    orderExplanation(data, fix),
    'Bench swe, the benchmark of fix bugs itself, has results for only 2 models within the filters, so the order comes from the benchmark of write code. Bench swe stays in the table and in the Measured band.',
  );
  // Its own benchmark still holds its results.
  assert.equal(fix.rows.find((row) => row.model.id === 'a')?.values[0]?.n, 50);
});

test('a sub-job keeps its own order when its benchmark covers three models', () => {
  const core = makeCore();
  core.measured.push(result('swe', 'c', 30));
  const data = prepareBrief(core);
  const job = findJob(data, 'bug-fix');
  assert.ok(job);
  const fix = computeBrief(data, job, all);
  assert.equal(fix.borrowed, null);
  assert.equal(fix.primary && signalLabel(fix.primary), 'Bench swe');
  assert.deepEqual(names(fix.rows), ['a', 'b', 'c']);
});

test('a sub-job keeps its own few results when the parent’s benchmark covers fewer than three', () => {
  const { brief: fix } = brief('bug-fix', {
    ...all,
    inScope: (id) => id === 'a' || id === 'b',
  });
  assert.equal(fix.borrowed, null);
  assert.equal(fix.primary && signalLabel(fix.primary), 'Bench swe');
  assert.deepEqual(fix.basis, {
    kind: 'benchmark',
    signal: 0,
    why: 'few',
    covered: 2,
  });
});

test('without a benchmark the order is reported evidence and the note says so', () => {
  const { data, brief: planning } = brief('planning');
  // Under three models with five preferences: positive share, which needs ten clear labels.
  assert.equal(planning.basis.kind, 'reported');
  assert.equal(planning.primary?.kind, 'crowd');
  assert.deepEqual(names(planning.rows), ['a']);
  assert.equal(planning.left, 4);
  assert.equal(
    orderExplanation(data, planning),
    'No benchmark in the data measures this job. The order below comes from Hacker News positive share, which is reported evidence and not a measurement.',
  );
  assert.match(
    orderRules(planning),
    /5 stated preferences, 10 clear Hacker News labels/,
  );
  // From October, a has 10 clear labels; b has 9, under the minimum.
  const { brief: recent } = brief('planning', { ...all, since: '2026-10-05' });
  assert.deepEqual(names(recent.rows), ['a']);
  assert.equal(recent.rows[0]?.values[1]?.text, '80% of 10');
});

test('stated preferences order a job without a benchmark when three models have five', () => {
  const core = makeCore();
  core.preferences.push(
    ...preferences('c', 'd', 'planning', 5),
    ...preferences('d', 'e', 'planning', 5),
  );
  const data = prepareBrief(core);
  const job = findJob(data, 'planning');
  assert.ok(job);
  const planning = computeBrief(data, job, all);
  assert.equal(planning.primary?.kind, 'preferences');
  assert.deepEqual(names(planning.rows), ['c', 'd', 'e']);
  assert.match(
    orderExplanation(data, planning),
    /Hacker News stated preferences, which is reported evidence/,
  );
});

test('a job with nothing to order it says which evidence is missing', () => {
  const { data, brief: none } = brief('planning', {
    ...all,
    inScope: (id) => id === 'e',
  });
  assert.equal(none.basis.kind, 'none');
  assert.equal(none.first, null);
  assert.equal(
    orderExplanation(data, none),
    'No benchmark in the data measures this job.',
  );
});

test('an unknown job id finds no job', () => {
  const data = prepareBrief(makeCore());
  assert.equal(findJob(data, 'no-such-job'), null);
  assert.equal(findJob(data, null), null);
});

test('intervals are read from both published forms', () => {
  assert.deepEqual(
    parseInterval(70, '±2.5 · 95% confidence interval'),
    [67.5, 72.5],
  );
  assert.deepEqual(
    parseInterval(1822, '1807–1838 · confidence bounds from the dataset'),
    [1807, 1838],
  );
  assert.equal(parseInterval(70, ''), null);
});

test('a restricted benchmark joins the job its payload category maps to, after the listed ones', () => {
  const core = makeCore();
  const data = prepareBrief(core, {
    checkedAt: '2026-11-02',
    benchmarks: [
      {
        id: 'hidden',
        name: 'Hidden bench',
        source: 'Synthetic publisher',
        category: 'writing',
        unit: 'Elo',
        description: 'Synthetic restricted benchmark.',
        methodology: 'Synthetic.',
        url: 'https://example.test/hidden',
      },
    ],
    results: ['a', 'b', 'c', 'd', 'e'].map((model, i) => ({
      id: `hidden-${model}`,
      modelId: model,
      benchmarkId: 'hidden',
      score: 1000 + i,
      configuration: 'default',
      details: '',
      sourceUrl: 'https://example.test/hidden',
    })),
  });
  const writing = findJob(data, 'writing');
  assert.ok(writing);
  const result = computeBrief(data, writing, all);
  assert.deepEqual(
    result.signals.map(
      (signal) => signal.kind === 'benchmark' && signal.benchmark.id,
    ),
    ['arena', 'pct', 'hidden', false, false],
  );
  // It covers five models against the arena's four, so it sets the order.
  assert.equal(result.primary && signalLabel(result.primary), 'Hidden bench');
  assert.equal(data.benchmarkById.get('hidden')?.scale, 'rating');
  assert.equal(
    data.measured.filter((record) => record.x?.b === 'hidden')[0]?.job,
    'writing',
  );
});

test('the App guide selection is the one for the job’s guide task', () => {
  const guide = {
    choices: [
      {
        id: 'one',
        name: 'Model A',
        surface: 'Claude',
        setting: 'Extended',
        modelId: 'a',
      },
      {
        id: 'two',
        name: 'Model B',
        surface: 'ChatGPT',
        setting: 'Default',
        modelId: 'b',
      },
    ],
    tasks: [
      {
        id: 'fixes',
        label: 'Fixes',
        default: { choiceId: 'one' },
        alternatives: [{ choiceId: 'two' }],
      },
    ],
  };
  assert.deepEqual(guideSelections(guide, 'fixes', 'b').lines, [
    'ChatGPT: Model B · Default',
  ]);
  assert.deepEqual(guideSelections(guide, undefined, 'b').lines, []);
});
