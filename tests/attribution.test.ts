import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { attributions } from '../src/lib/attribution.ts';

const imported = z.object({
  checkedAt: z.iso.date(),
  source: z.object({ attribution: z.string().min(1) }),
});

function read(file: string) {
  const raw: unknown = JSON.parse(
    readFileSync(new URL(`../research/${file}`, import.meta.url), 'utf8'),
  );
  return imported.parse(raw);
}

test('the Data page credits each imported source with its file’s attribution line and check date', () => {
  for (const [source, file] of [
    ['LMArena', 'lmarena.json'],
    ['Epoch AI benchmarking hub', 'epoch-runs.json'],
    ['OpenRouter', 'openrouter-usage.json'],
  ]) {
    const entry = attributions.find((item) => item.source === source);
    assert.ok(entry, `${source} has no attribution entry`);
    assert.equal(entry.credit, read(file).source.attribution);
    assert.equal(entry.checkedAt, read(file).checkedAt);
    assert.equal(entry.licence?.name, 'CC BY 4.0');
  }
});

test('every entry gives the day it was checked', () => {
  for (const entry of attributions)
    assert.match(entry.checkedAt, /^2026-\d{2}-\d{2}$/, entry.source);
});

test('attribution entries have distinct sources', () => {
  const sources = attributions.map((item) => item.source);
  assert.equal(new Set(sources).size, sources.length);
});
