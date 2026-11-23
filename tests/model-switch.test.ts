import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crowdBand,
  measuredBand,
  prepareBrief,
  themeTallies,
} from '../src/lib/brief.ts';
import type { BriefFilters } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import type { Core } from '../src/lib/core-schema.ts';
import {
  evidenceByJob,
  findTarget,
  preferencePairs,
  usageLine,
} from '../src/lib/model-page.ts';
import type { PageTarget } from '../src/lib/model-page.ts';
import type { EvidenceRecord } from '../src/lib/records.ts';
import {
  differenceText,
  preferencesBetween,
  priceChange,
  sharedBenchmarks,
  switchBenchmarks,
} from '../src/lib/switch.ts';

// An invented core.json: models a, b and c, a product line holding a and b,
// a percentage benchmark with intervals, an arena rating, a general index,
// Hacker News counts for a model and for the line alone, and preferences.

function result(
  bench: string,
  model: string,
  score: number,
  interval = '',
  cost: number | null = null,
): EvidenceRecord {
  return {
    id: `bm:${bench}-${model}`,
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
    date: '2026-10-01',
    person: '',
    url: 'https://example.test/result',
    title: bench,
    kind: 'benchmark result',
    x: { b: bench, score, config: 'default', cost, interval },
    checked: '2026-11-01',
  };
}

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
    source: 'snapshot',
    publishedAt: '',
    attribution: '',
    rows: null,
  };
}

function preference(winner: string, loser: string, job: string, n: number) {
  return { winner, loser, job, date: '2026-10-10', id: `hn:${n}` };
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
        { id: 'coding', label: 'Write code', benchmarks: ['tb'] },
        { id: 'fix', label: 'Fix bugs', parent: 'coding', benchmarks: [] },
        { id: 'writing', label: 'Writing', benchmarks: ['arena', 'eci'] },
      ],
      categories: { general: '', coding: 'coding' },
      guide: [],
    },
    models: ['a', 'b', 'c'].map((id, i) => ({
      id,
      name: `Lab ${id.toUpperCase()}`,
      provider: 'Lab',
      status: 'current',
      input: 1,
      output: [10, 25, null][i] ?? null,
      priceUrl: '',
      contextTokens: null,
    })),
    lines: [{ name: 'Lab', models: ['a', 'b'] }],
    benchmarks: [
      benchmark('tb', 'Resolved tasks (%)', 'percent'),
      benchmark('arena', 'Arena rating', 'rating'),
      benchmark('eci', 'ECI points', 'index', true),
    ],
    measured: [
      result('tb', 'a', 60, '±3 · 95%', 4),
      result('tb', 'b', 64, '±3 · 95%', 9),
      result('tb', 'c', 40, '±1 · 95%'),
      result('arena', 'a', 1300, '1290–1310 · bounds'),
      result('arena', 'c', 1250, '1240–1260 · bounds'),
      result('eci', 'b', 150),
      result('eci', 'c', 140),
    ],
    crowd: {
      stances: ['positive', 'critical', 'mixed', 'neutral'],
      counts: {
        'model|a': {
          coding: { '2026-10': [6, 2, 1, 1] },
          fix: { '2026-06': [3, 1, 0, 0] },
          '': { '2026-10': [1, 0, 0, 0] },
        },
        'line|Lab': { coding: { '2026-10': [2, 5, 0, 0] } },
      },
      themes: {
        'model|a': {
          coding: {
            '2026-10': { speed: [2, 1, 0, 0], pricing: [0, 1, 0, 0] },
          },
          fix: { '2026-06': { speed: [1, 0, 0, 0] } },
        },
        'line|Lab': { coding: { '2026-10': { pricing: [0, 3, 0, 0] } } },
      },
      comments: { coding: [1, 2], fix: [3] },
    },
    preferences: [
      preference('model|a', 'model|b', 'coding', 11),
      preference('model|a', 'model|b', 'coding', 12),
      preference('model|b', 'model|a', 'fix', 13),
      preference('model|b', 'model|a', 'writing', 14),
      preference('model|a', 'line|Lab', 'coding', 15),
      preference('line|Lab', 'model|c', 'coding', 16),
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
  classes: ['measured', 'named', 'crowd'],
  basis: ['first', 'measured', 'second', 'vendor'],
};

function target(
  data: ReturnType<typeof prepareBrief>,
  ref: { kind: 'model'; id: string } | { kind: 'line'; name: string },
): PageTarget {
  const found = findTarget(data, ref);
  assert.ok(found);
  return found;
}

test('an unknown model or line is not found and nothing is put in its place', () => {
  const data = prepareBrief(makeCore());
  assert.equal(findTarget(data, { kind: 'model', id: 'no-such' }), null);
  assert.equal(findTarget(data, { kind: 'line', name: 'Nope' }), null);
  assert.equal(findTarget(data, { kind: 'model', id: 'Lab' }), null);
});

test('labels that name only a line never join a model’s counts', () => {
  const data = prepareBrief(makeCore());
  const a = target(data, { kind: 'model', id: 'a' });
  const line = target(data, { kind: 'line', name: 'Lab' });
  const modelBand = crowdBand(data, a.key, 'coding', '');
  // a's own coding labels (and its sub-job's), not the line's.
  assert.deepEqual(modelBand.tally, [9, 3, 1, 1]);
  assert.deepEqual(modelBand.lines, [
    { name: 'Lab', key: 'line|Lab', tally: [2, 5, 0, 0] },
  ]);
  const lineBand = crowdBand(data, line.key, 'coding', '');
  assert.deepEqual(lineBand.tally, [2, 5, 0, 0]);
  assert.deepEqual(lineBand.lines, []);
  // Line preferences stay with the line.
  assert.deepEqual(
    lineBand.preferences.map((entry) => entry.id),
    ['hn:15', 'hn:16'],
  );
  assert.deepEqual(themeTallies(data, a.key, 'coding', ''), [
    { theme: 'speed', tally: [3, 1, 0, 0] },
    { theme: 'pricing', tally: [0, 1, 0, 0] },
  ]);
  assert.deepEqual(themeTallies(data, line.key, 'coding', ''), [
    { theme: 'pricing', tally: [0, 3, 0, 0] },
  ]);
  // The line's evidence holds no measured record: results name exact models.
  const rows = evidenceByJob(data, line, all);
  assert.ok(rows.every((row) => row.measured.length === 0));
  assert.deepEqual(
    rows.map((row) => [row.job?.id ?? 'all', row.tally]),
    [
      ['all', [2, 5, 0, 0]],
      ['coding', [2, 5, 0, 0]],
    ],
  );
});

test('evidence by job equals the bands for each job', () => {
  const data = prepareBrief(makeCore());
  const a = target(data, { kind: 'model', id: 'a' });
  const rows = evidenceByJob(data, a, all);
  assert.deepEqual(
    rows.map((row) => row.job?.id ?? 'all'),
    ['all', 'coding', 'fix', 'writing', ''],
  );
  for (const row of rows) {
    const id = row.job === null ? null : row.job.id;
    const band = measuredBand(data, 'a', id, all);
    assert.equal(
      row.measured.length,
      band.results.length + band.reports.length,
    );
    assert.deepEqual(row.tally, crowdBand(data, a.key, id, '').tally);
  }
  assert.deepEqual(rows[0]?.tally, [10, 3, 1, 1]);
  // The period starts on the first of its month for Hacker News counts;
  // measured records dated before it drop out.
  const recent = evidenceByJob(data, a, { ...all, since: '2026-10-15' });
  assert.deepEqual(
    recent.map((row) => [row.job?.id ?? 'all', row.measured.length, row.tally]),
    [
      ['all', 0, [7, 2, 1, 1]],
      ['coding', 0, [6, 2, 1, 1]],
      ['', 0, [1, 0, 0, 0]],
    ],
  );
  // With Crowd hidden, only measured counts remain.
  const measuredOnly = evidenceByJob(data, a, {
    ...all,
    classes: ['measured'],
  });
  assert.ok(measuredOnly.every((row) => row.tally.every((n) => n === 0)));
});

test('stated preferences are grouped by the other side', () => {
  const data = prepareBrief(makeCore());
  const pairs = preferencePairs(data.core.preferences, 'model|a');
  assert.deepEqual(
    pairs.map((pair) => [pair.other, pair.wins.length, pair.losses.length]),
    [
      ['model|b', 2, 2],
      ['line|Lab', 1, 0],
    ],
  );
});

test('usage shows nothing for a model outside the published top lists', () => {
  const usage = {
    source: 'OpenRouter',
    url: 'https://openrouter.ai/rankings',
    licence: 'CC BY 4.0',
    terms: 'Synthetic.',
    fetchedAt: '2026-11-01',
    checkedAt: '2026-11-01',
    note: 'Synthetic.',
    tokens: {
      asOf: '2026-11-01',
      period: { start: '2026-10-02', end: '2026-11-01' },
      meta: {},
      attribution: 'Synthetic.',
      what: 'Synthetic.',
      models: [{ modelId: 'a', share: 0.03, tokens: 100, days: 30 }],
    },
    tasks: {
      asOf: '2026-11-01',
      period: { start: '2026-10-25', end: '2026-11-01' },
      meta: {},
      attribution: 'Synthetic.',
      what: 'Synthetic.',
      tags: [
        {
          tag: 'code',
          label: 'Code',
          job: 'coding',
          share: 0.4,
          top: [{ modelId: 'b', route: 'lab/b', share: 0.2 }],
        },
      ],
    },
  };
  assert.deepEqual(usageLine(usage, 'a')?.tags, []);
  assert.equal(usageLine(usage, 'a')?.tokens?.share, 0.03);
  assert.equal(usageLine(usage, 'b')?.tokens, null);
  assert.equal(usageLine(usage, 'b')?.tags[0]?.share, 0.2);
  assert.equal(usageLine(usage, 'c'), null);
});

test('Switch compares two models only within one benchmark at a time', () => {
  const data = prepareBrief(makeCore());
  // a has a rating and a percentage; b has a percentage and an index. Only
  // the percentage benchmark holds both.
  const rows = sharedBenchmarks(data, 'a', 'b', null);
  assert.deepEqual(
    rows.map((row) => row.benchmark.id),
    ['tb'],
  );
  for (const row of rows) {
    assert.equal(row.a.records[0]?.x?.b, row.benchmark.id);
    assert.equal(row.b.records[0]?.x?.b, row.benchmark.id);
  }
  // a's rating and c's rating share a leaderboard and are compared; c's index
  // is compared only with b's index.
  assert.deepEqual(
    sharedBenchmarks(data, 'a', 'c', null).map((row) => row.benchmark.id),
    ['tb', 'arena'],
  );
  assert.deepEqual(
    sharedBenchmarks(data, 'b', 'c', null).map((row) => row.benchmark.id),
    ['tb', 'eci'],
  );
});

test('overlapping intervals show no measured difference', () => {
  const data = prepareBrief(makeCore());
  const [tb] = sharedBenchmarks(data, 'a', 'b', 'coding');
  assert.ok(tb);
  // 57–63 against 61–67.
  assert.equal(tb.verdict, 'overlap');
  assert.equal(
    differenceText(tb, 'Lab A', 'Lab B'),
    'Intervals overlap: no measured difference',
  );
  assert.deepEqual([tb.a.cost, tb.b.cost], [4, 9]);
  const [apart, arena] = sharedBenchmarks(data, 'a', 'c', null);
  assert.ok(apart && arena);
  assert.equal(apart.verdict, 'apart');
  assert.equal(
    differenceText(apart, 'Lab A', 'Lab C'),
    'Lab A higher by 20 percentage points, intervals apart',
  );
  assert.equal(
    differenceText(arena, 'Lab A', 'Lab C'),
    'Lab A higher by 50 rating points, intervals apart',
  );
  const [, eci] = sharedBenchmarks(data, 'b', 'c', null);
  assert.ok(eci);
  assert.equal(eci.verdict, 'no-interval');
  assert.equal(
    differenceText(eci, 'Lab B', 'Lab C'),
    'Lab B higher by 10 index points; no interval published',
  );
});

test('a sub-job compares on its parent’s benchmarks too', () => {
  const data = prepareBrief(makeCore());
  assert.deepEqual(
    switchBenchmarks(data, 'fix').map((entry) => entry.id),
    ['tb'],
  );
  assert.deepEqual(
    switchBenchmarks(data, 'writing').map((entry) => entry.id),
    ['arena', 'eci'],
  );
});

test('the price change compares output prices', () => {
  const data = prepareBrief(makeCore());
  const [a, b, c] = data.models;
  assert.ok(a && b && c);
  assert.equal(priceChange(a, b), 'Output costs 2.5× more after switching');
  assert.equal(priceChange(b, a), 'Output costs 2.5× less after switching');
  assert.equal(priceChange(a, a), 'Same output price');
  assert.equal(priceChange(a, c), null);
});

test('preferences between the two need five before a share is given', () => {
  const data = prepareBrief(makeCore());
  const coding = preferencesBetween(data, 'a', 'b', 'coding', '');
  // The parent job includes the sub-job's preference.
  assert.deepEqual(
    [coding.forA.length, coding.forB.length, coding.total, coding.shareB],
    [2, 1, 3, null],
  );
  const core = makeCore();
  core.preferences.push(
    preference('model|b', 'model|a', 'coding', 21),
    preference('model|b', 'model|a', 'coding', 22),
  );
  const five = preferencesBetween(prepareBrief(core), 'a', 'b', 'coding', '');
  assert.equal(five.total, 5);
  assert.equal(five.shareB, 3 / 5);
  // A preference against the line is not one between the two models.
  assert.equal(preferencesBetween(data, 'a', 'b', null, '').total, 4);
});
