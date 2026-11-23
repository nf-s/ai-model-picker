import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { attributions } from '../src/lib/attribution.ts';

const imported = z.object({
  source: z.object({ attribution: z.string().min(1) }),
});

function line(file: string) {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../research/${file}`, import.meta.url), 'utf8'),
  );
  return imported.parse(raw).source.attribution;
}

test('the Data page credits each imported source with its file’s attribution line', () => {
  for (const [source, file] of [
    ['LMArena', 'lmarena.json'],
    ['Epoch AI benchmarking hub', 'epoch-runs.json'],
  ]) {
    const entry = attributions.find((item) => item.source === source);
    assert.ok(entry, `${source} has no attribution entry`);
    assert.equal(entry.credit, line(file));
    assert.equal(entry.licence?.name, 'CC BY 4.0');
  }
});

test('attribution entries have distinct sources', () => {
  const sources = attributions.map((item) => item.source);
  assert.equal(new Set(sources).size, sources.length);
});
