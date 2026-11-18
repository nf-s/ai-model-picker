import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  restrictedById,
  restrictedResponseSchema,
  restrictedResultId,
  validRestrictedResults,
} from '../src/lib/restricted.ts';
import { snapshotSchema } from '../src/lib/schema.ts';

const snapshot = snapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL('../src/lib/snapshot.json', import.meta.url), 'utf8'),
  ),
);
// The restricted results are kept outside Git; tests that need the real list
// are skipped in a checkout without it.
const localFile = new URL('../.local/restricted/results.json', import.meta.url);
const local = existsSync(localFile);
const restricted = local
  ? restrictedResponseSchema.parse(JSON.parse(readFileSync(localFile, 'utf8')))
      .results
  : [];
const open = snapshot.results;
const known = {
  modelIds: new Set(snapshot.models.map((model) => model.id)),
  benchmarkIds: new Set(snapshot.benchmarks.map((benchmark) => benchmark.id)),
  resultIds: new Set(open.map((result) => result.id)),
};

test('the tracked snapshot holds no restricted results', () => {
  assert.ok(open.every((result) => !restrictedById.has(result.benchmarkId)));
});

test(
  'every restricted benchmark exists and has local results',
  { skip: !local },
  () => {
    for (const id of restrictedById.keys()) {
      assert.ok(known.benchmarkIds.has(id), id);
      assert.ok(
        restricted.some((result) => result.benchmarkId === id),
        id,
      );
    }
    assert.equal(restricted.length, 80);
  },
);

test('result IDs are recognised by their benchmark prefix', () => {
  assert.equal(restrictedResultId('designarena-agentic:1'), true);
  assert.equal(restrictedResultId('epoch-eci:1'), false);
  assert.equal(restrictedResultId('designarena-agentic'), false);
});

test(
  'a restricted payload is accepted only for restricted, unknown results',
  { skip: !local },
  () => {
    assert.deepEqual(
      validRestrictedResults({ results: restricted }, known),
      restricted,
    );
    assert.equal(
      validRestrictedResults({ results: open.slice(0, 1) }, known),
      null,
    );
    assert.equal(
      validRestrictedResults(
        { results: [restricted[0], restricted[0]] },
        known,
      ),
      null,
    );
    assert.equal(
      validRestrictedResults(
        { results: [{ ...restricted[0], modelId: 'missing-model' }] },
        known,
      ),
      null,
    );
    assert.equal(validRestrictedResults({ results: 'none' }, known), null);
  },
);
