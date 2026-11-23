import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { attributions } from '../src/lib/attribution.ts';
import { prepareBrief } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import {
  byJob,
  crowdInFilters,
  inFilters,
  limitsOf,
  measuredFrom,
  nameKindOf,
} from '../src/lib/data-page.ts';
import { publicDownload } from '../src/lib/download.ts';
import { indexComments } from '../src/lib/hn-insights.ts';
import type { HnIndexComment } from '../src/lib/hn-index.ts';
import { indexNamed, namedPayloadSchema } from '../src/lib/named.ts';
import type { EvidenceRecord } from '../src/lib/records.ts';
import { openFilter } from '../src/lib/search.ts';
import { snapshotSchema } from '../src/lib/schema.ts';

// An invented core.json with one snapshot benchmark, one arena leaderboard,
// one Epoch run and a report, and invented named records. No real person.

function record(
  id: string,
  src: string,
  model: string,
  job: string,
  bench: string,
  date = '',
): EvidenceRecord {
  return {
    id,
    cls: 'measured',
    src,
    keys: [[`model|${model}`, 'neutral']],
    job,
    how: job ? 'label' : '',
    via: job ? `benchmark:${bench}` : '',
    stance: 'neutral',
    text: `${model} on ${bench}`,
    quote: '',
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date,
    person: '',
    url: 'https://example.test/result',
    title: bench,
    kind: 'benchmark result',
    x: bench ? { b: bench, score: 50 } : {},
    checked: '2026-11-01',
  };
}

function benchmark(id: string, source: string, scale: 'percent' | 'rating') {
  return {
    id,
    name: `Bench ${id}`,
    category: 'coding',
    general: false,
    unit: scale === 'rating' ? 'Arena rating' : '%',
    scale,
    what: `What ${id} measures.`,
    methodology: '',
    costMethod: '',
    url: 'https://example.test/bench',
    source,
    publishedAt: source === 'lmarena' ? '2026-11-01' : '',
    attribution: '',
    rows: null,
  };
}

const core = coreSchema.parse({
  sources: {
    snapshot: '2026-11-01',
    lmarena: {
      fetchedAt: '2026-11-01',
      checkedAt: '2026-11-01',
      attribution: 'Synthetic arena line.',
      records: 1,
    },
    epoch: {
      fetchedAt: '2026-11-01',
      checkedAt: '2026-11-01',
      attribution: 'Synthetic run line.',
      records: 1,
    },
    hn: {
      from: 'export',
      publishedAt: '',
      classifier: 'synthetic',
      startAt: '2026-05-01T00:00:00Z',
      endAt: '2026-11-20T00:00:00Z',
      comments: 4,
      labels: 6,
    },
  },
  jobs: {
    version: 1,
    status: 'draft',
    list: [
      { id: 'coding', label: 'Write code', benchmarks: ['snap'] },
      { id: 'fix', label: 'Fix bugs', parent: 'coding', benchmarks: [] },
    ],
    categories: {},
    guide: [],
  },
  models: ['a', 'b'].map((id) => ({
    id,
    name: `Model ${id.toUpperCase()}`,
    provider: 'Lab',
    status: id === 'a' ? 'current' : 'previous',
    input: 1,
    output: 2,
    priceUrl: '',
    contextTokens: null,
  })),
  lines: [],
  benchmarks: [
    benchmark('snap', 'snapshot', 'percent'),
    benchmark('run', 'epoch', 'percent'),
    benchmark('arena', 'lmarena', 'rating'),
  ],
  measured: [
    record('bm:snap-a', 'benchmark', 'a', 'coding', 'snap'),
    record('bm:snap-b', 'benchmark', 'b', 'coding', 'snap'),
    record('ep:run-a', 'benchmark', 'a', 'fix', 'run', '2026-10-01'),
    record('la:arena-a', 'arena', 'a', 'coding', 'arena', '2026-11-01'),
    record('rp:one', 'report', 'b', '', '', '2026-03-01'),
  ],
  crowd: {
    stances: ['positive', 'critical', 'mixed', 'neutral'],
    counts: {},
    themes: {},
    comments: { coding: [1, 2], fix: [3], '': [4] },
  },
  preferences: [],
  coverage: {
    sources: ['benchmark', 'arena', 'report', 'hn'],
    rows: [],
  },
  usage: null,
  namedBehindSignIn: true,
});
const data = prepareBrief(core);

test('sources are told apart by the benchmark a result is on', () => {
  const ids = (source: string) =>
    measuredFrom(data, source).map((entry) => entry.id);
  assert.deepEqual(ids('snapshot'), ['bm:snap-a', 'bm:snap-b']);
  assert.deepEqual(ids('epoch'), ['ep:run-a']);
  assert.deepEqual(ids('arena'), ['la:arena-a']);
  assert.deepEqual(ids('report'), ['rp:one']);
  assert.deepEqual(ids('restricted'), []);
});

test('coverage is by each record’s own job; the filters apply as Search applies them', () => {
  const jobs = byJob(core.measured);
  assert.deepEqual(
    [...jobs].map(([job, records]) => [job, records.length]),
    [
      ['coding', 3],
      ['fix', 1],
      ['', 1],
    ],
  );
  const current = (id: string) => data.modelById.get(id)?.status === 'current';
  const within = inFilters(core.measured, { ...openFilter, current });
  assert.deepEqual(
    within.map((entry) => entry.id),
    ['bm:snap-a', 'ep:run-a', 'la:arena-a'],
  );
  assert.equal(
    inFilters(core.measured, { ...openFilter, classes: ['crowd'] }).length,
    0,
  );
});

test('crowd comments within the filters keep their job and read line labels', () => {
  const label = (
    kind: 'model' | 'family',
    target: string,
  ): HnIndexComment['assessments'][number] => ({
    kind,
    target,
    sentiment: 'positive',
    aspects: [],
    confidence: 'high',
  });
  const comments: HnIndexComment[] = [
    {
      id: 1,
      createdAt: '2026-06-01T10:00:00Z',
      assessments: [label('model', 'a')],
    },
    {
      id: 2,
      createdAt: '2026-10-01T10:00:00Z',
      assessments: [label('model', 'b')],
    },
    {
      id: 3,
      createdAt: '2026-10-02T10:00:00Z',
      assessments: [label('family', 'Lab')],
    },
    {
      id: 4,
      createdAt: '2026-10-03T10:00:00Z',
      assessments: [label('model', 'a')],
    },
  ];
  const index = indexComments(comments);
  const ids = (filter: typeof openFilter) =>
    Object.fromEntries(
      [...crowdInFilters(index, core.crowd.comments, filter)].map(
        ([job, set]) => [job, [...set].sort()],
      ),
    );
  assert.deepEqual(ids(openFilter), { coding: [1, 2], fix: [3], '': [4] });
  // From 15 September: Hacker News counts from the first of that month.
  assert.deepEqual(ids({ ...openFilter, since: '2026-09-15' }), {
    coding: [2],
    fix: [3],
    '': [4],
  });
  // Only the line: the model selection reads it as `line|Lab`.
  assert.deepEqual(ids({ ...openFilter, key: (key) => key === 'line|Lab' }), {
    fix: [3],
  });
});

const person = (
  name: string,
  sourceClass: 'first-hand' | 'secondary',
  use: number,
) => ({
  name,
  sourceClass,
  adviceOnly: false,
  trusted: false,
  added: { date: '2026-11-01', reason: 'Invented.' },
  dropped: null,
  use,
  advice: 0,
  useLeftOut: 0,
});

function use(
  n: number,
  who: string,
  keys: string[],
  basis = 'first-hand use',
  sec = false,
) {
  return {
    id: `ur:${'0'.repeat(23)}a/${n}`,
    cls: 'named',
    src: 'use',
    keys: keys.map((key) => [key, 'positive']),
    job: 'coding',
    how: 'review',
    via: 'review:coding',
    stance: 'positive',
    text: `Summary ${n}.`,
    quote: `Quote ${n}.`,
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date: '2026-10-01',
    person: who,
    url: `https://example.test/post-${n}`,
    title: `Post ${n}`,
    kind: 'worked',
    x: {
      named: 'Lab',
      exact: true,
      line: 'Lab',
      task: 'A task.',
      basis,
      b: sec && basis === 'measured' ? 'second' : 'first',
      sec,
      cmpNamed: '',
      cmpId: '',
      cmp: '',
      channel: 'blog',
    },
    checked: '',
  };
}

test('the limits of the use records count without naming anyone', () => {
  const named = indexNamed(
    namedPayloadSchema.parse({
      version: 1,
      review: {
        model: 'test-model',
        methodology: 'test',
        passages: { valid: 9, unresolved: 1 },
        unresolvedByIssue: { 'quote-not-verbatim': 1 },
        jobAgreement: { share: 0.5, check: 'an invented reference set' },
        note: 'Written by a review.',
      },
      people: [
        person('Ada Example', 'first-hand', 4),
        person('Ben Sample', 'secondary', 2),
      ],
      coverage: [{ job: 'coding', use: 6, advice: 0 }],
      use: [
        use(1, 'Ada Example', ['model|a', 'tool|Editor']),
        use(2, 'Ada Example', ['version|Lab A-preview', 'line|Lab']),
        use(3, 'Ada Example', ['line|Lab']),
        use(4, 'Ada Example', ['tool|Editor']),
        use(5, 'Ben Sample', ['model|b'], 'measured', true),
        use(6, 'Ben Sample', ['model|a'], 'first-hand use', true),
      ],
    }),
  );
  const limits = limitsOf(named);
  assert.equal(limits.total, 6);
  assert.equal(limits.largest.length, 4);
  assert.deepEqual(
    [...limits.kinds].map(([kind, records]) => [kind, records.length]),
    [
      ['model', 3],
      ['version', 1],
      ['line', 1],
      ['none', 1],
    ],
  );
  assert.equal(nameKindOf(named.use[1]), 'version');
  assert.equal(limits.secondaryPeople, 1);
  assert.deepEqual(
    limits.secondaryMeasured.map((entry) => entry.id),
    [named.use[4]?.id],
  );
});

const snapshot = snapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL('../src/lib/snapshot.json', import.meta.url), 'utf8'),
  ),
);

test('the download holds public records and their attribution only', () => {
  const download = publicDownload(snapshot, core, attributions);
  const text = JSON.stringify(download);
  assert.deepEqual(Object.keys(download), [
    'snapshot',
    'records',
    'attribution',
  ]);
  assert.equal(download.records.measured.length, core.measured.length);
  assert.equal(download.snapshot.results.length, snapshot.results.length);
  // No usage, no named record, person or quote.
  assert.equal('usage' in download.records, false);
  assert.doesNotMatch(text, /"cls":"named"/);
  assert.doesNotMatch(text, /"person":"[^"]/);
  assert.doesNotMatch(text, /"quote":"[^"]/);
  assert.doesNotMatch(text, /practitionerFindings|openrouter\.ai\/api/);
  // Every credit, each with the day it was checked.
  assert.equal(download.attribution.length, attributions.length);
  for (const entry of download.attribution)
    assert.match(entry.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
});
