import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { snapshotSchema } from '../src/lib/schema.ts';
import {
  axisBounds,
  estimateCost,
  getResult,
  horizontalValue,
} from '../src/lib/metrics.ts';

const raw: unknown = JSON.parse(
  readFileSync(new URL('../src/lib/snapshot.json', import.meta.url), 'utf8'),
);
const snapshot = snapshotSchema.parse(raw);
function model(id: string) {
  const found = snapshot.models.find((record) => record.id === id);
  if (!found) throw new Error(`Missing model ${id}`);
  return found;
}
function close(actual: number | undefined, expected: number) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 0.000001,
    `${actual} != ${expected}`,
  );
}

test('snapshot validates every record, source URL, unique identifier and relationship', () => {
  assert.equal(snapshot.benchmarks.length, 8);
  // Restricted results are kept outside Git (see restricted.test.ts).
  assert.equal(snapshot.results.length, 107);
  assert.equal(snapshot.models.filter((entry) => entry.pricing).length, 20);
  assert.ok(snapshot.reports.length >= 14);
  assert.ok(snapshot.sources.length >= 30);
  assert.equal(
    new Set(snapshot.models.map((entry) => entry.id)).size,
    snapshot.models.length,
  );
});

test('invalid links and result references are rejected, not silently displayed', () => {
  const first = snapshot.results[0];
  assert.ok(first);
  assert.equal(
    snapshotSchema.safeParse({
      ...snapshot,
      results: [{ ...first, modelId: 'missing' }],
    }).success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({
      ...snapshot,
      results: [{ ...first, sourceUrl: 'javascript:alert(1)' }],
    }).success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({
      ...snapshot,
      results: [{ ...first, score: NaN }],
    }).success,
    false,
  );
  assert.equal(
    snapshotSchema.safeParse({ ...snapshot, results: [first, first] }).success,
    false,
  );
});

test('cost and time require their methodology, report spend requires context', () => {
  const benchmarks = snapshot.benchmarks.map((entry) => ({
    ...entry,
    costMethod: undefined,
  }));
  assert.equal(
    snapshotSchema.safeParse({ ...snapshot, benchmarks }).success,
    false,
  );
  const report = snapshot.reports.find((entry) => entry.costUsd !== undefined);
  assert.ok(report);
  assert.equal(
    snapshotSchema.safeParse({
      ...snapshot,
      reports: [{ ...report, costContext: undefined }],
    }).success,
    false,
  );
});

test('Terminal-Bench mean costs retain correct trial denominators', () => {
  const rows = snapshot.results.filter(
    (entry) => entry.benchmarkId === 'terminal-bench-4-1',
  );
  assert.equal(rows.length, 59);
  for (const row of rows) {
    assert.ok(row.totalCostUsd !== undefined && row.trials !== undefined);
    close(row.costUsd, row.totalCostUsd / row.trials);
  }
});

test('configuration selection keeps the score, cost and duration from the same run', () => {
  const candidates = snapshot.results.filter(
    (entry) =>
      entry.modelId === 'gpt-6-astra' &&
      entry.benchmarkId === 'terminal-bench-4-1',
  );
  const alternative = candidates[1];
  assert.ok(alternative);
  const selected = getResult(
    snapshot.results,
    'gpt-6-astra',
    'terminal-bench-4-1',
    alternative.id,
  );
  assert.deepEqual(selected, alternative);
  assert.notEqual(selected.score, candidates[0]?.score);
  assert.equal(
    getResult(snapshot.results, 'gpt-6-astra', 'terminal-bench-4-1', 'unknown')
      ?.id,
    candidates[0]?.id,
  );
  assert.equal(
    getResult(
      snapshot.results,
      'gpt-6.1-sol',
      'swe-rebench-2026-05-15-2026-07-01',
    ),
    undefined,
  );
});

test('usage estimation uses billed tokens and does not turn missing pricing into zero', () => {
  close(
    estimateCost(model('gpt-6.1-sol'), 10000, 2000, snapshot.checkedAt),
    0.04,
  );
  close(estimateCost(model('gpt-6.1-sol'), 0, 0, snapshot.checkedAt), 0);
  assert.equal(
    estimateCost(model('gpt-6.1-sol'), -1, 1000, snapshot.checkedAt),
    undefined,
  );
  const unpriced = snapshot.models.find((entry) => !entry.pricing);
  assert.ok(unpriced);
  assert.equal(
    estimateCost(unpriced, 10000, 2000, snapshot.checkedAt),
    undefined,
  );
});

test('long-context pricing respects inclusive and exclusive thresholds', () => {
  close(
    estimateCost(model('claude-haiku-5-5'), 100000, 1000, snapshot.checkedAt),
    0.0105,
  );
  close(
    estimateCost(model('claude-haiku-5-5'), 100001, 1000, snapshot.checkedAt),
    0.0525005,
  );
  close(
    estimateCost(model('grok-4.7'), 200000, 1000, snapshot.checkedAt),
    0.812,
  );
  close(
    estimateCost(model('gpt-6.1-sol'), 272000, 1000, snapshot.checkedAt),
    0.554,
  );
  close(
    estimateCost(model('gpt-6.1-sol'), 272001, 1000, snapshot.checkedAt),
    1.103004,
  );
});

test('announced rate changes and input-only versus unified limits are handled', () => {
  close(
    estimateCost(model('gemini-4-carbon'), 10000, 2000, '2026-11-30'),
    0.04,
  );
  close(
    estimateCost(model('gemini-4-carbon'), 10000, 2000, '2026-12-01'),
    0.08,
  );
  assert.equal(
    horizontalValue(
      model('gemini-4-carbon'),
      undefined,
      'output',
      10000,
      2000,
      '2026-12-01',
    ),
    20,
  );
  assert.equal(
    estimateCost(model('gemini-4-carbon'), 1048576, 100, snapshot.checkedAt),
    undefined,
  );
  assert.notEqual(
    estimateCost(
      model('gemini-3.1-flash-lite'),
      1048576,
      100,
      snapshot.checkedAt,
    ),
    undefined,
  );
});

test('unreported benchmark costs stay missing and ECI retains its unbounded scale', () => {
  const record = model('gpt-6.1-sol');
  const result = getResult(snapshot.results, record.id, 'epoch-eci');
  assert.ok(result && result.score > 100);
  assert.equal(
    horizontalValue(
      record,
      result,
      'benchmarkCost',
      10000,
      2000,
      snapshot.checkedAt,
    ),
    undefined,
  );
  assert.equal(
    horizontalValue(record, result, 'output', 10000, 2000, snapshot.checkedAt),
    10,
  );
  const [min, max] = axisBounds([-10, 173.44]);
  assert.ok(min < -10 && max > 173.44);
});

test('dated aliases join only reviewed identities; older versions remain separate', () => {
  assert.equal(model('deepseek-flash').version, 'DeepSeek-V4.1-Flash-1017');
  assert.ok(
    snapshot.results.some(
      (entry) =>
        entry.modelId === 'deepseek-flash' &&
        entry.benchmarkId === 'terminal-bench-4-1',
    ),
  );
  const historical = snapshot.results.find(
    (entry) =>
      entry.benchmarkId === 'swe-rebench-2026-05-15-2026-07-01' &&
      entry.modelId === 'reported-deepseek-v4-pro',
  );
  assert.ok(historical);
  assert.equal(model(historical.modelId).pricing, undefined);
});
