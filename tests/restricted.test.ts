import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { restrictedFixture } from '../server/auth/restricted-fixture.mjs';
import {
  restrictedPayloadSchema,
  validRestrictedPayload,
} from '../src/lib/restricted.ts';
import { snapshotSchema } from '../src/lib/schema.ts';

const snapshot = snapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL('../src/lib/snapshot.json', import.meta.url), 'utf8'),
  ),
);
const known = {
  modelIds: new Set(snapshot.models.map((model) => model.id)),
  benchmarkIds: new Set(snapshot.benchmarks.map((benchmark) => benchmark.id)),
  resultIds: new Set(snapshot.results.map((result) => result.id)),
  sourceIds: new Set(snapshot.sources.map((source) => source.id)),
};

// The real payload is kept outside Git; its test is skipped without it.
const localFile = new URL('../.local/restricted/payload.json', import.meta.url);
const local = existsSync(localFile);

test(
  'the local payload adds only new records that refer to known models',
  { skip: !local },
  () => {
    const payload = restrictedPayloadSchema.parse(
      JSON.parse(readFileSync(localFile, 'utf8')),
    );
    assert.ok(validRestrictedPayload(payload, known));
    const ids = new Set(payload.benchmarks.map((benchmark) => benchmark.id));
    assert.ok(snapshot.results.every((result) => !ids.has(result.benchmarkId)));
    const urls = new Set(payload.sources.map((source) => source.url));
    assert.ok(snapshot.sources.every((source) => !urls.has(source.url)));
  },
);

test('a payload is rejected when it repeats or breaks references', () => {
  assert.deepEqual(
    validRestrictedPayload(restrictedFixture, known),
    restrictedFixture,
  );
  const [result] = restrictedFixture.results;
  const [benchmark] = restrictedFixture.benchmarks;
  assert.ok(result && benchmark);
  for (const broken of [
    { ...restrictedFixture, results: [result, result] },
    {
      ...restrictedFixture,
      results: [{ ...result, modelId: 'missing-model' }],
    },
    {
      ...restrictedFixture,
      results: [{ ...result, benchmarkId: 'epoch-eci' }],
    },
    {
      ...restrictedFixture,
      benchmarks: [{ ...benchmark, id: 'epoch-eci' }],
    },
    {
      ...restrictedFixture,
      evidence: [
        { taskId: 'coding', kind: 'result', id: 'missing:1', note: 'Note.' },
      ],
    },
    { ...restrictedFixture, results: 'none' },
  ])
    assert.equal(validRestrictedPayload(broken, known), null);
});
