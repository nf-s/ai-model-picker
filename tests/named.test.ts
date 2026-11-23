import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBrief, prepareBrief } from '../src/lib/brief.ts';
import type { BriefFilters } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import type { Core } from '../src/lib/core-schema.ts';
import { evidenceByJob, findTarget } from '../src/lib/model-page.ts';
import {
  articlesOf,
  basisText,
  codingAdviceGroups,
  indexNamed,
  moveTrusted,
  namedAdviceSchema,
  namedBand,
  namedColumn,
  namedComparisons,
  namedOrder,
  namedPayloadSchema,
  outcomeTally,
  peopleMatrix,
  personAdvice,
  personSummary,
  readStoredTrusted,
  siteOwners,
  toggleTrusted,
  trustedList,
  trustedStorageKey,
  writeStoredTrusted,
} from '../src/lib/named.ts';
import { requestAdvice, requestNamed } from '../src/lib/named-client.ts';
import type { EvidenceRecord } from '../src/lib/records.ts';

// An invented core.json and invented people: models a, b and c, a product
// line holding a and b, and one coding benchmark. No real person is named.

function result(model: string, score: number): EvidenceRecord {
  return {
    id: `bm:tb-${model}`,
    cls: 'measured',
    src: 'benchmark',
    keys: [[`model|${model}`, 'neutral']],
    job: '',
    how: '',
    via: '',
    stance: 'neutral',
    text: `${model} on tb`,
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
    title: 'tb',
    kind: 'benchmark result',
    x: { b: 'tb', score, config: 'default', cost: null, interval: '' },
    checked: '2026-11-01',
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
      list: [
        { id: 'coding', label: 'Write code', benchmarks: ['tb'] },
        { id: 'fix', label: 'Fix bugs', parent: 'coding', benchmarks: [] },
        { id: 'writing', label: 'Writing', benchmarks: [] },
      ],
      categories: { coding: 'coding' },
      guide: [],
    },
    models: ['a', 'b', 'c'].map((id) => ({
      id,
      name: `Lab ${id.toUpperCase()}`,
      provider: 'Lab',
      status: 'current',
      input: 1,
      output: 10,
      priceUrl: '',
      contextTokens: null,
    })),
    lines: [{ name: 'Lab', models: ['a', 'b'] }],
    benchmarks: [
      {
        id: 'tb',
        name: 'Bench tb',
        category: 'coding',
        general: false,
        unit: 'Resolved tasks (%)',
        scale: 'percent',
        what: 'What tb measures.',
        methodology: '',
        costMethod: '',
        url: 'https://example.test/bench',
        source: 'snapshot',
        publishedAt: '',
        attribution: '',
        rows: null,
      },
    ],
    measured: [result('a', 70), result('b', 60), result('c', 40)],
    crowd: {
      stances: ['positive', 'critical', 'mixed', 'neutral'],
      counts: {},
      themes: {},
      weeks: { start: '', count: 0, targets: {} },
      aspects: {},
      comments: {},
    },
    preferences: [],
    coverage: { sources: [], rows: [] },
    usage: null,
    namedBehindSignIn: true,
  });
}

const ada = 'Ada Example';
const ben = 'Ben Sample';
const cleo = 'Cleo Placeholder';

function person(name: string, extra: object) {
  return {
    name,
    sourceClass: 'first-hand',
    adviceOnly: false,
    trusted: false,
    added: { date: '2026-11-01', reason: 'Invented for tests.' },
    dropped: null,
    use: 0,
    advice: 0,
    useLeftOut: 0,
    ...extra,
  };
}

function use(
  n: number,
  who: string,
  keys: string[],
  extra: {
    job?: string;
    date?: string;
    stance?: 'positive' | 'critical' | 'mixed' | 'neutral';
    b?: 'first' | 'measured' | 'second' | 'vendor';
    basis?: string;
    sec?: boolean;
    cmp?: string;
    cmpId?: string;
    host?: string;
  } = {},
) {
  const job = extra.job ?? 'coding';
  return {
    id: `ur:${'0'.repeat(23)}${who === ada ? 'a' : 'b'}/${n}`,
    cls: 'named',
    src: 'use',
    keys: keys.map((key) => [key, extra.stance ?? 'positive']),
    job,
    how: job ? 'review' : '',
    via: job ? `review:${job}` : '',
    stance: extra.stance ?? 'positive',
    text: `Summary ${n}.`,
    quote: `Quote ${n}.`,
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date: extra.date ?? '2026-10-01',
    person: who,
    url: `https://${extra.host ?? (who === ada ? 'ada.example' : 'ben.example')}/post-${n}`,
    title: `Post ${n}`,
    kind: 'worked',
    x: {
      named: 'Lab',
      exact: true,
      line: 'Lab',
      task: 'A task.',
      basis: extra.basis ?? 'first-hand use',
      b: extra.b ?? 'first',
      sec: extra.sec ?? who === ben,
      cmpNamed: extra.cmpId ? `Lab ${extra.cmpId.toUpperCase()}` : '',
      cmpId: extra.cmpId ?? '',
      cmp: extra.cmp ?? '',
      channel: 'blog',
    },
    checked: '',
  };
}

function advice(n: number, who: string, job = '') {
  return {
    id: `ma:${'0'.repeat(23)}c/${n}`,
    cls: 'named',
    src: 'advice',
    keys: [],
    job,
    how: job ? 'review' : '',
    via: job ? `review:${job}` : '',
    stance: 'neutral',
    text: `Advice ${n}.`,
    quote: `Advice quote ${n}.`,
    cond: '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date: '2026-09-15',
    person: who,
    url: `https://cleo.example/advice-${n}`,
    title: `Advice ${n}`,
    kind: 'method advice',
    x: { channel: 'blog', sec: false },
    checked: '',
  };
}

const rawUse = [
  // A secondary source's figure that the review labelled measured.
  use(1, ben, ['model|a'], {
    b: 'second',
    basis: 'measured',
    sec: true,
    date: '2026-10-05',
  }),
  use(2, ada, ['model|a', 'tool|Editor'], { date: '2026-09-01' }),
  use(3, ada, ['model|a'], {
    b: 'vendor',
    basis: 'vendor statement',
    date: '2026-10-10',
  }),
  use(4, ben, ['model|a'], { date: '2026-10-20', sec: true }),
  // Names only the line: stays under the line.
  use(5, ada, ['line|Lab'], { date: '2026-10-02' }),
  // An exact version outside the model list keeps its own key.
  use(6, ada, ['version|Lab A-preview'], { job: '', date: '2026-08-01' }),
  use(7, ben, ['model|b'], {
    cmp: 'other better',
    cmpId: 'a',
    stance: 'critical',
    date: '2026-10-03',
  }),
  // Many records on the model the benchmark ranks last.
  ...[8, 9, 10, 11, 12].map((n) =>
    use(n, ada, ['model|c'], { job: 'fix', date: '2026-06-0' + (n - 7) }),
  ),
];

const rawPayload = {
  version: 1,
  review: {
    model: 'test-model',
    methodology: 'test',
    passages: {},
    unresolvedByIssue: {},
    jobAgreement: { share: 0.5, check: 'an invented reference set' },
    note: 'Written by a review.',
  },
  people: [
    person(ada, { trusted: true, use: 10 }),
    person(ben, { sourceClass: 'secondary', use: 3 }),
    person(cleo, { adviceOnly: true, advice: 2, useLeftOut: 4 }),
  ],
  coverage: [{ job: 'coding', use: 6, advice: 0 }],
  use: rawUse,
};

const all: BriefFilters = {
  inScope: () => true,
  current: true,
  since: '',
  classes: ['measured', 'named', 'crowd'],
  basis: ['first', 'measured', 'second', 'vendor'],
};

function setup() {
  const data = prepareBrief(makeCore(), null);
  const named = indexNamed(namedPayloadSchema.parse(rawPayload));
  return { data, named };
}

const ids = (records: readonly { id: string }[]) =>
  records.map((record) => Number(record.id.split('/')[1]));

test('the payload is validated at the boundary', () => {
  const { named } = setup();
  assert.equal(named.use.length, rawUse.length);
  assert.equal(named.use[0]?.use.b, 'second');
  const strangers = {
    ...rawPayload,
    use: [use(1, 'Nobody Known', ['model|a'])],
  };
  assert.equal(namedPayloadSchema.safeParse(strangers).success, false);
  const adviceAsUse = { ...rawPayload, use: [advice(1, cleo)] };
  assert.equal(namedPayloadSchema.safeParse(adviceAsUse).success, false);
  const badBasis = {
    ...rawPayload,
    use: [
      { ...use(1, ada, ['model|a']), x: { ...use(1, ada, []).x, b: 'rumour' } },
    ],
  };
  assert.equal(namedPayloadSchema.safeParse(badBasis).success, false);
  assert.equal(
    namedAdviceSchema.safeParse({ version: 1, advice: [advice(1, cleo)] })
      .success,
    true,
  );
  assert.equal(
    namedAdviceSchema.safeParse({ version: 1, advice: [rawUse[0]] }).success,
    false,
  );
});

test('trusted people first, then first-hand and measured, then newest', () => {
  const { named } = setup();
  const onA = named.byKey.get('model|a') ?? [];
  assert.deepEqual(ids(namedOrder(onA, [ada])), [2, 3, 4, 1]);
  assert.deepEqual(ids(namedOrder(onA, [ben, ada])), [4, 1, 2, 3]);
  // Without a trusted list: first-hand before second-hand and vendor.
  assert.deepEqual(ids(namedOrder(onA, [])), [4, 2, 3, 1]);
});

test('a secondary source’s measured record is a reported, second-hand figure', () => {
  const { data, named } = setup();
  const secondary = named.use.find((record) => record.id.endsWith('/1'));
  assert.ok(secondary);
  assert.match(basisText(secondary), /^reported figure/);
  const firstHandOnly = { ...all, basis: ['first', 'measured'] as const };
  const band = namedBand(data, named, 'model|a', null, firstHandOnly, []);
  assert.deepEqual(ids(band.records), [4, 2]);
  const secondHand = { ...all, basis: ['second'] as const };
  assert.deepEqual(
    ids(namedBand(data, named, 'model|a', null, secondHand, []).records),
    [1],
  );
});

test('line records stay under the line; versions keep their own key', () => {
  const { data, named } = setup();
  const band = namedBand(data, named, 'model|a', null, all, [ada]);
  assert.deepEqual(ids(band.records), [2, 3, 4, 1]);
  assert.deepEqual(
    band.lines.map((line) => [line.name, ids(line.records)]),
    [['Lab', [5]]],
  );
  assert.deepEqual(
    ids(namedBand(data, named, 'line|Lab', null, all, []).records),
    [5],
  );
  assert.deepEqual(ids(named.byKey.get('version|Lab A-preview') ?? []), [6]);
  // Evidence by job counts the model's own records only.
  const modelTarget = findTarget(data, { kind: 'model', id: 'a' });
  const lineTarget = findTarget(data, { kind: 'line', name: 'Lab' });
  assert.ok(modelTarget && lineTarget);
  const rows = evidenceByJob(data, modelTarget, all, {
    index: named,
    trusted: [],
  });
  // The sub-job and no-job rows are there for their measured results.
  assert.deepEqual(
    rows.map((row) => [row.job?.id ?? 'all', row.named.length]),
    [
      ['all', 4],
      ['coding', 4],
      ['fix', 0],
      ['', 0],
    ],
  );
  const lineRows = evidenceByJob(data, lineTarget, all, {
    index: named,
    trusted: [],
  });
  assert.deepEqual(
    lineRows.map((row) => [row.job?.id ?? 'all', row.named.length]),
    [
      ['all', 1],
      ['coding', 1],
    ],
  );
  // Without sign-in nothing is counted.
  assert.ok(
    evidenceByJob(data, modelTarget, all).every((r) => r.named.length === 0),
  );
});

test('the job by review, the period and the Named class only filter', () => {
  const { data, named } = setup();
  // A parent job includes its sub-jobs; records with no job pass for all jobs.
  assert.equal(
    namedBand(data, named, 'model|c', 'coding', all, []).records.length,
    5,
  );
  assert.equal(
    namedBand(data, named, 'model|c', 'fix', all, []).records.length,
    5,
  );
  assert.equal(
    namedBand(data, named, 'model|c', 'writing', all, []).records.length,
    0,
  );
  const recent = { ...all, since: '2026-10-04' };
  assert.deepEqual(
    ids(namedBand(data, named, 'model|a', null, recent, []).records),
    [4, 3, 1],
  );
  const off = { ...all, classes: ['measured', 'crowd'] as const };
  assert.equal(
    namedBand(data, named, 'model|a', null, off, []).records.length,
    0,
  );
});

test('named comparisons between two models, in either direction', () => {
  const { data, named } = setup();
  assert.deepEqual(
    ids(namedComparisons(data, named, 'a', 'b', null, all, [])),
    [7],
  );
  assert.deepEqual(
    ids(namedComparisons(data, named, 'b', 'a', null, all, [])),
    [7],
  );
  assert.deepEqual(namedComparisons(data, named, 'a', 'c', null, all, []), []);
});

test('Brief’s order is identical with and without named data', () => {
  const { data, named } = setup();
  const job = data.jobById.get('coding');
  assert.ok(job);
  const before = computeBrief(data, job, all).rows.map((row) => row.model.id);
  // Model c has by far the most named records and the most positive ones.
  const column = namedColumn(
    data,
    named,
    computeBrief(data, job, all).rows,
    job.id,
    all,
    [ada],
  );
  const after = computeBrief(data, job, all).rows.map((row) => row.model.id);
  assert.deepEqual(before, ['a', 'b', 'c']);
  assert.deepEqual(after, before);
  assert.deepEqual(
    column.map(({ row, records }) => [row.model.id, records.length]),
    [
      ['a', 4],
      ['b', 1],
      ['c', 5],
    ],
  );
});

test('the people matrix counts records per person and target', () => {
  const { data, named } = setup();
  const matrix = peopleMatrix(data, named, null, all, [ben], 'targets');
  assert.equal(matrix.records.length, rawUse.length);
  assert.deepEqual(matrix.columns, [
    'model|c',
    'model|a',
    'line|Lab',
    'model|b',
    'version|Lab A-preview',
  ]);
  // Starred people first, then the rest as listed.
  assert.deepEqual(
    matrix.rows.map((row) => [row.person.name, row.records.length]),
    [
      [ben, 3],
      [ada, 9],
      [cleo, 0],
    ],
  );
  const adaRow = matrix.rows.find((row) => row.person.name === ada);
  assert.deepEqual(
    [...(adaRow?.cells ?? [])].map(([key, list]) => [key, list.length]),
    [
      ['model|c', 5],
      ['model|a', 2],
      ['line|Lab', 1],
      ['model|b', 0],
      ['version|Lab A-preview', 1],
    ],
  );
  assert.deepEqual(matrix.top && [matrix.top.person.name, matrix.top.count], [
    ada,
    9,
  ]);
  const tools = peopleMatrix(data, named, null, all, [], 'tools');
  assert.deepEqual(tools.columns, ['tool|Editor']);
  // A model column follows the model selection.
  const onlyB = { ...all, inScope: (id: string) => id === 'b' };
  assert.deepEqual(
    peopleMatrix(data, named, null, onlyB, [], 'targets').columns,
    ['line|Lab', 'model|b', 'version|Lab A-preview'],
  );
  assert.deepEqual(outcomeTally(named.use), [11, 1, 0, 0]);
});

test('a person page: what they name, failures, comparisons and advice', () => {
  const { data, named } = setup();
  const summary = personSummary(data, named, ada, null, all, []);
  assert.deepEqual(
    summary.byName.map((group) => [group.kind, group.records.length]),
    [
      ['model', 7],
      ['version', 1],
      ['line', 1],
    ],
  );
  assert.deepEqual(
    summary.byBasis.map((group) => [group.basis, group.records.length]),
    [
      ['first', 8],
      ['vendor', 1],
    ],
  );
  assert.deepEqual(
    summary.byJob.map((group) => [group.job, group.records.length]),
    [
      ['fix', 5],
      ['coding', 3],
      ['', 1],
    ],
  );
  assert.equal(summary.timeline.months[0], '2026-06');
  assert.equal(summary.timeline.months.at(-1), '2026-11');
  const ben_ = personSummary(data, named, ben, null, all, []);
  assert.deepEqual(ids(ben_.comparisons), [7]);
  assert.deepEqual(ids(ben_.failures), [7]);
  // Advice-only people have method advice and no use records.
  const cleoSummary = personSummary(data, named, cleo, null, all, []);
  assert.equal(cleoSummary.records.length, 0);
  const tips = namedAdviceSchema.parse({
    version: 1,
    advice: [advice(1, cleo), advice(2, cleo, 'coding')],
  }).advice;
  assert.equal(personAdvice(data, tips, cleo, null, all).length, 2);
  assert.equal(personAdvice(data, tips, cleo, 'coding', all).length, 1);
  // Advice is never filed under a target.
  assert.ok(
    [...named.byKey.values()].flat().every((record) => record.src === 'use'),
  );
});

test('the trusted list is the viewer’s own and survives broken storage', () => {
  const people = namedPayloadSchema.parse(rawPayload).people;
  assert.deepEqual(trustedList(null, people), [ada]);
  assert.deepEqual(trustedList([ben, 'Gone Person', ben, ada], people), [
    ben,
    ada,
  ]);
  assert.deepEqual(trustedList([], people), []);
  const store = new Map<string, string>();
  const memory = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(readStoredTrusted(memory), null);
  writeStoredTrusted(memory, [ben]);
  assert.deepEqual(readStoredTrusted(memory), [ben]);
  store.set(trustedStorageKey, 'not json');
  assert.equal(readStoredTrusted(memory), null);
  store.set(trustedStorageKey, '{"name":"x"}');
  assert.equal(readStoredTrusted(memory), null);
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(readStoredTrusted(broken), null);
  assert.doesNotThrow(() => writeStoredTrusted(broken, [ada]));
  assert.equal(readStoredTrusted(null), null);
  assert.deepEqual(toggleTrusted([ada], ben), [ada, ben]);
  assert.deepEqual(toggleTrusted([ada, ben], ada), [ben]);
  assert.deepEqual(moveTrusted([ada, ben, cleo], 2, -1), [ada, cleo, ben]);
  assert.deepEqual(moveTrusted([ada, ben], 0, -1), [ada, ben]);
});

test('articles belong to the one person whose records link to their site', () => {
  const records = [
    { person: ada, url: 'https://ada.example/a' },
    { person: ben, url: 'https://www.ben.example/b' },
    { person: ada, url: 'https://shared.example/x' },
    { person: ben, url: 'https://shared.example/y' },
  ];
  const owners = siteOwners(records);
  const articles = [
    { url: 'https://ada.example/one' },
    { url: 'https://ben.example/two' },
    { url: 'https://shared.example/three' },
  ];
  assert.deepEqual(articlesOf(articles, owners, ada), [articles[0]]);
  assert.deepEqual(articlesOf(articles, owners, ben), [articles[1]]);
});

test('a visitor without a session requests nothing', async () => {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    calls.push(input);
    return new Response(JSON.stringify(rawPayload), { status: 200 });
  };
  for (const access of [
    { kind: 'anonymous' },
    { kind: 'unavailable' },
  ] as const) {
    assert.equal(requestNamed(access, fetcher), null);
    assert.equal(requestAdvice(access, fetcher), null);
  }
  assert.deepEqual(calls, []);
  const signedIn = {
    kind: 'signed-in',
    email: 'viewer@example.test',
    isAdmin: false,
    csrfToken: null,
    restricted: false,
  } as const;
  const answer = await requestNamed(signedIn, fetcher);
  assert.equal(answer?.kind, 'ready');
  assert.deepEqual(calls, ['/api/named']);
  const refused = await requestNamed(
    signedIn,
    async () => new Response('{}', { status: 401 }),
  );
  assert.deepEqual(refused, { kind: 'sign-in' });
  await assert.rejects(
    requestNamed(signedIn, async () => new Response('{}', { status: 500 })) ??
      Promise.resolve(),
  );
});

test('App guide method advice: grouped by what it applies to, trusted people first', () => {
  const jobs = [
    { id: 'coding', guideTask: 'bug-fixes' },
    { id: 'bug-fix', guideTask: 'bug-fixes' },
    { id: 'writing', guideTask: 'writing' },
    { id: 'planning' },
  ];
  const records = [
    { ...advice(1, ada, 'bug-fix'), date: '2026-10-01' },
    { ...advice(2, cleo, 'bug-fix'), date: '2026-11-01' },
    advice(3, cleo, 'writing'),
    advice(4, ada, ''),
    advice(5, cleo, 'planning'),
    advice(6, ada, 'coding'),
  ];
  const groups = codingAdviceGroups(
    namedAdviceSchema.parse({ version: 1, advice: records }).advice,
    jobs,
    new Set(['writing']),
    [ada],
  );
  // Job file order; a job answered in chat apps only is left out; any job last.
  assert.deepEqual(
    groups.map((group) => group.job),
    ['coding', 'bug-fix', 'planning', ''],
  );
  // The trusted person comes first even with older advice.
  assert.deepEqual(
    groups[1]?.records.map((record) => record.person),
    [ada, cleo],
  );
  const untrusted = codingAdviceGroups(
    namedAdviceSchema.parse({ version: 1, advice: records }).advice,
    jobs,
    new Set(['writing']),
    [],
  );
  assert.deepEqual(
    untrusted[1]?.records.map((record) => record.person),
    [cleo, ada],
  );
});
