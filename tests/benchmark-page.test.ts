import assert from 'node:assert/strict';
import test from 'node:test';
import {
  benchmarkValue,
  coverageLine,
  importedBenchmarkPage,
  importedIndex,
} from '../src/lib/benchmark-page.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import type { Core } from '../src/lib/core-schema.ts';
import type { EvidenceRecord, JsonValue } from '../src/lib/records.ts';

// An invented core.json with one arena leaderboard, one Epoch run and one
// snapshot benchmark. Models a, b and c.

function record(
  id: string,
  model: string,
  src: 'arena' | 'benchmark',
  date: string,
  x: Record<string, JsonValue>,
): EvidenceRecord {
  return {
    id,
    cls: 'measured',
    src,
    keys: [[`model|${model}`, 'neutral']],
    job: 'writing',
    how: 'label',
    via: 'test',
    stance: 'neutral',
    text: `${model} result`,
    quote: '',
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date,
    person: '',
    url: `https://example.test/${id}`,
    title: 'Result',
    kind: src === 'arena' ? 'arena rating' : 'benchmark result',
    x,
    checked: '2026-11-01',
  };
}

function benchmark(
  id: string,
  source: string,
  scale: 'percent' | 'rating',
  rows: number | null,
) {
  return {
    id,
    name: `Bench ${id}`,
    category: 'writing',
    general: false,
    unit: scale === 'rating' ? 'Arena rating' : '%',
    scale,
    what:
      scale === 'rating'
        ? 'Votes between two answers. Preference votes, not a pass rate.'
        : 'Share of problems solved.',
    methodology: '',
    costMethod: '',
    url: 'https://example.test/bench',
    source,
    publishedAt: scale === 'rating' ? '2026-11-01' : '',
    attribution: `Credit for ${source}. Licensed under CC BY 4.0.`,
    rows,
  };
}

function makeCore(): Core {
  const imported = {
    fetchedAt: '2026-11-01',
    checkedAt: '2026-11-01',
    attribution: 'Synthetic.',
    records: 0,
  };
  return coreSchema.parse({
    sources: {
      snapshot: '2026-11-01',
      lmarena: imported,
      epoch: imported,
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
      list: [{ id: 'writing', label: 'Writing', benchmarks: [] }],
      categories: {},
      guide: [],
    },
    models: ['a', 'b', 'c'].map((id) => ({
      id,
      name: `Model ${id.toUpperCase()}`,
      provider: 'Lab',
      status: 'current',
      input: 1,
      output: 2,
      priceUrl: '',
      contextTokens: null,
    })),
    lines: [],
    benchmarks: [
      benchmark('tb', 'snapshot', 'percent', null),
      benchmark('lmarena-text', 'lmarena', 'rating', 9),
      benchmark('epoch-run', 'epoch', 'percent', 40),
    ],
    measured: [
      // The source ranks every row on the leaderboard, including models
      // outside the list, so ranks 2, 3 and 6 are the ones shown.
      record('la:a-high', 'a', 'arena', '2026-11-01', {
        b: 'lmarena-text',
        score: 1402,
        unit: 'Arena rating',
        config: 'Model A (high)',
        interval: '1395–1409 · confidence bounds from the dataset',
        trials: 5120,
        rank: 2,
      }),
      record('la:a-low', 'a', 'arena', '2026-11-01', {
        b: 'lmarena-text',
        score: 1350,
        unit: 'Arena rating',
        config: 'Model A (low)',
        interval: '1340–1360 · confidence bounds from the dataset',
        trials: 2210,
        rank: 6,
      }),
      record('la:b', 'b', 'arena', '2026-11-01', {
        b: 'lmarena-text',
        score: 1398,
        unit: 'Arena rating',
        config: 'Model B',
        interval: '1390–1406 · confidence bounds from the dataset',
        trials: 4300,
        rank: 3,
      }),
      record('ep:b', 'b', 'benchmark', '2026-08-01', {
        b: 'epoch-run',
        score: 71.5,
        unit: '%',
        config: 'model_b_high',
        interval: '±4.1 · 95% interval from the standard error',
      }),
      record('ep:c', 'c', 'benchmark', '2026-09-12', {
        b: 'epoch-run',
        score: 71.5,
        unit: '%',
        config: 'model_c',
        interval: '±4.0 · 95% interval from the standard error',
      }),
      record('ep:a', 'a', 'benchmark', '2026-07-30', {
        b: 'epoch-run',
        score: 80.25,
        unit: '%',
        config: 'model_a',
        interval: '±3.2 · 95% interval from the standard error',
      }),
    ],
    crowd: {
      stances: ['positive', 'critical', 'mixed', 'neutral'],
      cells: {},
      tags: {},
      pending: {},
      counts: {},
      themes: {},
      comments: {},
    },
    preferences: [],
    coverage: { sources: [], rows: [], pending: [] },
    usage: null,
    namedBehindSignIn: false,
  });
}

test('an arena leaderboard: preference votes, never a percentage', () => {
  const page = importedBenchmarkPage(makeCore(), 'lmarena-text');
  assert.ok(page);
  assert.equal(page.source, 'lmarena');
  assert.match(page.benchmark.what, /Preference votes, not a pass rate/);
  assert.match(page.scaleNote, /^Ratings are relative to .* 2026-11-01/);
  assert.match(page.scaleNote, /not percentages/);
  assert.ok(page.rows.every((row) => !row.value.includes('%')));
  assert.deepEqual(
    page.rows.map((row) => [row.config, row.value, row.rank, row.best]),
    [
      ['Model A (high)', '1,402', 2, true],
      ['Model B', '1,398', 3, true],
      ['Model A (low)', '1,350', 6, false],
    ],
  );
  assert.equal(page.countLabel, 'Votes');
  assert.deepEqual(
    page.rows.map((row) => row.count),
    [5120, 4300, 2210],
  );
  assert.equal(
    page.coverage,
    "3 of the source's 9 rows are for models in the model list and are shown here. Rows for other models are not shown.",
  );
  assert.match(page.rankNote, /source's, among all the rows/);
  assert.equal(page.attribution?.source, 'LMArena');
  assert.equal(page.attribution?.licence?.name, 'CC BY 4.0');
});

test('an Epoch run: percentages, ranks among the rows shown, run dates', () => {
  const page = importedBenchmarkPage(makeCore(), 'epoch-run');
  assert.ok(page);
  assert.equal(page.source, 'epoch');
  assert.match(page.scaleNote, /in percent/);
  assert.doesNotMatch(page.scaleNote, /relative/);
  assert.deepEqual(
    page.rows.map((row) => [row.modelId, row.value, row.rank]),
    [
      ['a', '80.3%', 1],
      ['b', '71.5%', 2],
      ['c', '71.5%', 2],
    ],
  );
  assert.equal(page.countLabel, null);
  assert.deepEqual(page.dates, ['2026-07-30', '2026-09-12']);
  assert.match(page.coverage, /^3 of the source's 40 rows/);
  assert.equal(page.attribution?.source, 'Epoch AI benchmarking hub');
  assert.equal(page.attribution?.licence?.name, 'CC BY 4.0');
});

test('only imported benchmarks get this page; the index groups them by source', () => {
  const core = makeCore();
  assert.equal(importedBenchmarkPage(core, 'tb'), null);
  assert.equal(importedBenchmarkPage(core, 'no-such-benchmark'), null);
  assert.deepEqual(
    importedIndex(core).map((group) => [
      group.source,
      group.benchmarks.map((entry) => entry.id),
    ]),
    [
      ['lmarena', ['lmarena-text']],
      ['epoch', ['epoch-run']],
    ],
  );
});

test('ratings print without a percent sign; coverage without a row count', () => {
  const core = makeCore();
  const arena = core.benchmarks.find((entry) => entry.id === 'lmarena-text');
  const run = core.benchmarks.find((entry) => entry.id === 'epoch-run');
  assert.ok(arena && run);
  assert.equal(benchmarkValue(0.274, { ...arena, unit: 'IPS score' }), '0.274');
  assert.equal(benchmarkValue(1822, arena), '1,822');
  assert.equal(benchmarkValue(88.94, run), '88.9%');
  assert.equal(
    coverageLine(null, 4),
    '4 results for models in the model list.',
  );
});
