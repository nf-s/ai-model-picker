import assert from 'node:assert/strict';
import test from 'node:test';
import { coreSchema } from '../src/lib/core-schema.ts';
import { labelTotal } from '../src/lib/crowd-totals.ts';

// The App guide's Hacker News figures come from core.json's
// aggregates, not from the comment parts. Invented counts.

const core = coreSchema.parse({
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
      comments: 6,
      labels: 7,
    },
  },
  jobs: {
    version: 1,
    status: 'draft',
    list: [{ id: 'coding', label: 'Coding', benchmarks: [] }],
    categories: {},
    guide: [],
  },
  models: [
    {
      id: 'a',
      name: 'Model A',
      provider: 'Lab',
      status: 'current',
      input: null,
      output: null,
      priceUrl: '',
      contextTokens: null,
    },
  ],
  lines: [],
  benchmarks: [],
  measured: [],
  crowd: {
    stances: ['positive', 'critical', 'mixed', 'neutral'],
    counts: {
      'model|a': {
        coding: { '2026-10': [2, 1, 0, 0] },
        '': { '2026-11': [1, 0, 1, 1] },
      },
      'line|Lab': { coding: { '2026-10': [0, 1, 0, 0] } },
    },
    themes: {},
    comments: {},
  },
  preferences: [],
  coverage: { sources: [], rows: [] },
  usage: null,
  namedBehindSignIn: false,
});

test('comment totals sum every job and month of a target', () => {
  assert.equal(labelTotal(core, 'model|a'), 6);
  assert.equal(labelTotal(core, 'line|Lab'), 1);
  assert.equal(labelTotal(core, 'model|none'), 0);
});
