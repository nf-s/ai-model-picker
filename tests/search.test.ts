import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { searchLocal } from '../scripts/search.mjs';
import { namedParts } from '../server/named.mjs';
import { prepareBrief } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import type { Core } from '../src/lib/core-schema.ts';
import { namedAdviceSchema, namedPayloadSchema } from '../src/lib/named.ts';
import type { EvidenceRecord } from '../src/lib/records.ts';
import {
  candidates,
  foundIn,
  groupByJob,
  jobFilter,
  memoryCorpus,
  openFilter,
  passes,
  queryWords,
  rank,
  rankRecords,
  recordFacts,
  searchLimits,
  shardOf,
  tokens,
  wordsNeeded,
} from '../src/lib/search.ts';
import type { DocFacts, SearchFilter } from '../src/lib/search.ts';
import { fetchIndexFile, staticSource } from '../src/lib/search-static.ts';

const root = new URL('..', import.meta.url).pathname;
const fixture: {
  shards: number;
  cases: { text: string; tokens: string[]; shards: number[] }[];
} = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/search-tokens.json'), 'utf8'),
);

// ---- Tokens and ranking ---------------------------------------------------------

test('tokens and shards match the Python index builder', () => {
  for (const item of fixture.cases) {
    assert.deepEqual(tokens(item.text), item.tokens, item.text);
    assert.deepEqual(
      item.tokens.map((word) => shardOf(word, fixture.shards)),
      item.shards,
      item.text,
    );
  }
});

test('query words are each kept once, up to the limit', () => {
  const many = Array.from({ length: 15 }, (_, i) => `word${'x'.repeat(i)}`);
  const { words, dropped } = queryWords(`Opus opus ${many.join(' ')}`);
  assert.equal(words[0], 'opu');
  assert.equal(words.length, searchLimits.words);
  assert.equal(dropped.length, 16 - searchLimits.words);
  assert.deepEqual(queryWords('the and of').words, []);
});

const corpus = { records: 6, avgLength: 4 };
const postings = new Map([
  ['a', [0, 1, 2, 3]],
  ['b', [0, 2, 4]],
  ['c', [0, 5]],
]);
const lengths = [8, 2, 2, 4, 1, 4];
const ranked = (words: string[], keep = (_doc: number) => true) =>
  rank({
    words,
    need: wordsNeeded(words.length),
    corpus,
    postings,
    length: (doc) => lengths[doc] ?? 0,
    keep,
    job: (doc) => (doc % 2 === 0 ? 'even' : 'odd'),
    date: () => '',
  });

test('a record needs half of the words, and all of them come first', () => {
  const result = ranked(['a', 'b', 'c']);
  assert.deepEqual(candidates(['a', 'b', 'c'], 2, postings), [0, 2]);
  assert.deepEqual(
    result.hits.map((hit) => [hit.doc, hit.matched]),
    [
      [0, 3],
      [2, 2],
    ],
  );
  assert.equal(result.total, 2);
  assert.deepEqual([...result.byJob], [['even', 2]]);
});

test('among records with the same words, the shorter and rarer rank first', () => {
  const result = ranked(['a', 'b']);
  // Every record with one of two words passes; doc 2 (short) beats doc 0,
  // and doc 4's rarer word beats doc 1's common one.
  assert.deepEqual(
    result.hits.map((hit) => hit.doc),
    [2, 0, 4, 1, 3],
  );
  const [rare] = ranked(['c']).hits;
  const [common] = ranked(['a']).hits;
  assert.ok(rare && common && rare.score > common.score);
});

test('filters apply before the cap, and counts cover every match', () => {
  const result = rank({
    words: ['a'],
    need: 1,
    corpus,
    postings,
    length: () => 1,
    keep: (doc) => doc !== 1,
    job: () => '',
    date: () => '',
    limit: 2,
  });
  assert.equal(result.total, 3);
  assert.equal(result.hits.length, 2);
  assert.ok(result.hits.every((hit) => hit.doc !== 1));
});

test('ties go to the newer record, then the lower document number', () => {
  const tied = new Map([['a', [0, 1, 2]]]);
  const dates = ['2026-01-01', '2026-03-01', ''];
  const result = rank({
    words: ['a'],
    need: 1,
    corpus,
    postings: tied,
    length: () => 2,
    keep: () => true,
    job: () => '',
    date: (doc) => dates[doc] ?? '',
  });
  assert.deepEqual(
    result.hits.map((hit) => hit.doc),
    [1, 0, 2],
  );
});

test('groups keep rank order, jobs in the order of their best item', () => {
  const groups = groupByJob(
    [
      { id: 1, job: 'b' },
      { id: 2, job: 'a' },
      { id: 3, job: 'b' },
    ],
    (item) => item.job,
  );
  assert.deepEqual(
    groups.map((group) => [group.job, group.items.map((item) => item.id)]),
    [
      ['b', [1, 3]],
      ['a', [2]],
    ],
  );
});

const facts = (changes: Partial<DocFacts>): DocFacts => ({
  band: 'crowd',
  job: 'code',
  benchmark: '',
  date: '2026-10-15',
  keys: ['model|gpt-6-astra'],
  basis: '',
  setting: '',
  run: '',
  surface: '',
  ...changes,
});

test('the filter bar: band, job and benchmark, period, models, current, basis', () => {
  const filter = (changes: Partial<SearchFilter>) => ({
    ...openFilter,
    ...changes,
  });
  assert.ok(passes(facts({}), openFilter));
  assert.ok(!passes(facts({}), filter({ classes: ['measured'] })));
  const coding = filter({
    jobs: new Set(['code']),
    benchmarks: new Set(['swe']),
  });
  assert.ok(!passes(facts({ job: 'writing' }), coding));
  assert.ok(
    passes(facts({ band: 'measured', job: 'other', benchmark: 'swe' }), coding),
  );
  // Hacker News counts from the first of the month; others from the day.
  const since = filter({ since: '2026-10-20' });
  assert.ok(passes(facts({ date: '2026-10-02' }), since));
  assert.ok(!passes(facts({ band: 'measured', date: '2026-10-02' }), since));
  assert.ok(passes(facts({ band: 'measured', date: '' }), since));
  // A measured record is in the selection only through an exact model.
  const lines = filter({ key: (key) => key === 'line|GPT' });
  assert.ok(passes(facts({ keys: ['line|GPT'] }), lines));
  assert.ok(!passes(facts({ band: 'measured', keys: ['line|GPT'] }), lines));
  const current = filter({ current: (id) => id === 'gpt-6-astra' });
  assert.ok(passes(facts({}), current));
  assert.ok(!passes(facts({ keys: ['line|GPT'] }), current));
  // Method advice names no model, so model filters leave it in.
  assert.ok(passes(facts({ band: 'advice', keys: [] }), current));
  const basis = filter({ basis: new Set(['first']) });
  assert.ok(!passes(facts({ band: 'use', basis: 'second' }), basis));
  assert.ok(passes(facts({ band: 'use', basis: 'first' }), basis));
  // Setting and run filter Crowd and named records; surface named records
  // only; none of them touches a measured result.
  const local = filter({ fields: { ...openFilter.fields, setting: 'local' } });
  assert.ok(passes(facts({ setting: 'local' }), local));
  assert.ok(!passes(facts({}), local));
  assert.ok(!passes(facts({ band: 'use', basis: 'first' }), local));
  assert.ok(passes(facts({ band: 'measured' }), local));
  const hosted = filter({
    fields: { ...openFilter.fields, setting: 'hosted' },
  });
  assert.ok(passes(facts({}), hosted));
  assert.ok(!passes(facts({ setting: 'local' }), hosted));
  const parallel = filter({
    fields: { ...openFilter.fields, run: 'parallel' },
  });
  assert.ok(passes(facts({ band: 'advice', run: 'parallel' }), parallel));
  assert.ok(!passes(facts({ run: 'unattended' }), parallel));
  const agent = filter({
    fields: { ...openFilter.fields, surface: 'coding-agent' },
  });
  assert.ok(passes(facts({ band: 'use', surface: 'coding-agent' }), agent));
  assert.ok(!passes(facts({ band: 'use', surface: 'chat-app' }), agent));
  assert.ok(passes(facts({ surface: '' }), agent));
});

// ---- The index built by the records build -------------------------------------------

let directory = '';
let core: Core;
const searchDir = () => join(directory, 'build/search');

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'search-test-'));
  const built = spawnSync(
    'python3',
    ['-B', 'tests/test_records_search.py', 'fixture-build', directory],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  core = coreSchema.parse(
    JSON.parse(readFileSync(join(directory, 'build/core.json'), 'utf8')),
  );
});

after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

const filePattern = /^(index|[tar]\/[0-9]+)\.json$/;

function reader(seen: string[] = []) {
  return async (path: string) => {
    assert.match(path, filePattern);
    seen.push(path);
    return JSON.parse(readFileSync(join(searchDir(), path), 'utf8'));
  };
}

async function staticIds(
  query: string,
  filter: SearchFilter = openFilter,
  read = reader(),
) {
  const source = staticSource(read);
  const { words } = queryWords(query);
  const found = foundIn(words, [await source.found(words)]);
  const result = await source.search(found, wordsNeeded(found.length), filter);
  const ids = async (docs: number[]) => {
    const records = await source.records(docs);
    return docs.map((doc) => records.get(doc)?.id);
  };
  return {
    measured: await ids(result.measured.hits.map((hit) => hit.doc)),
    crowd: await ids(result.crowd.hits.map((hit) => hit.doc)),
  };
}

function localIds(query: string, options: { job?: string } = {}) {
  const result = searchLocal({
    query,
    job: options.job ?? null,
    limit: 200,
    index: join(directory, 'build/search.sqlite'),
    core: join(directory, 'build/core.json'),
  });
  const of = (band: string) =>
    result.records
      .filter((record: { band: string }) => record.band === band)
      .map((record: { id: string }) => record.id);
  return { result, measured: of('measured'), crowd: of('crowd') };
}

const queries = [
  'opus',
  'claude opus max effort',
  'terminal bench copilot',
  'root cause stack trace',
  'arena webdev',
  'slow laptop gpt',
];

// The local command lists at most `limit` (200) records a band.
const same = (fromStatic: unknown[], fromLocal: unknown[], what: string) =>
  assert.deepEqual(fromStatic.slice(0, 200), fromLocal, what);

test('the static index and the local command give the same ordered ids', async () => {
  for (const query of queries) {
    const fromStatic = await staticIds(query);
    const fromLocal = localIds(query);
    same(fromStatic.measured, fromLocal.measured, query);
    same(fromStatic.crowd, fromLocal.crowd, query);
  }
  const some = await staticIds('opus');
  assert.ok(some.measured.length > 3);
  assert.deepEqual((await staticIds('root cause')).crowd, ['hn:101']);
});

test('the job filter gives the same ids both ways', async () => {
  const data = prepareBrief(core);
  for (const job of ['code', 'interface', 'maths']) {
    const filter = { ...openFilter, ...jobFilter(data, job) };
    const fromStatic = await staticIds('claude opus gpt', filter);
    const fromLocal = localIds('claude opus gpt', { job });
    same(fromStatic.measured, fromLocal.measured, job);
    same(fromStatic.crowd, fromLocal.crowd, job);
  }
});

test('named records searched in the browser rank as the local command ranks them', () => {
  const named = JSON.parse(
    readFileSync(join(directory, 'build/named-private.json'), 'utf8'),
  );
  const parts = namedParts(named);
  const use = namedPayloadSchema.parse(parts.named).use;
  const advice = namedAdviceSchema.parse(parts.advice).advice;
  const modelName = (id: string) =>
    core.models.find((model) => model.id === id)?.name ?? id;
  const jobLabel = (id: string) =>
    core.jobs.list.find((job) => job.id === id)?.label ?? id;
  const useIndex = memoryCorpus(use, modelName, jobLabel);
  const adviceIndex = memoryCorpus(advice, modelName, jobLabel);
  for (const query of ['claude opus renderer', 'done looks', 'gpt turbo']) {
    const local = localIds(query).result;
    // The view counts a word found when any index holds it: the static one
    // or either named corpus. The local command holds all three.
    const { words } = queryWords(query);
    const inNamed = foundIn(words, [useIndex.postings, adviceIndex.postings]);
    assert.ok(inNamed.every((word) => local.words.includes(word)));
    const found = local.words;
    const need = wordsNeeded(found.length);
    const ids = (records: readonly EvidenceRecord[], index = useIndex) =>
      rankRecords(records, index, found, need, openFilter).hits.map(
        (hit) => records[hit.doc]?.id,
      );
    const of = (band: string) =>
      local.records
        .filter((record: { band: string }) => record.band === band)
        .map((record: { id: string }) => record.id);
    assert.deepEqual(ids(use), of('use'), query);
    assert.deepEqual(ids(advice, adviceIndex), of('advice'), query);
  }
  const quoted = localIds('renderer').result.records.find(
    (record: { band: string }) => record.band === 'use',
  );
  assert.equal(quoted.quote, 'A quote from the source itself.');
});

test('searched words reach file names only through the shard number', async () => {
  const seen: string[] = [];
  await staticIds(
    '../../api/named "opus" OR refactor* NEAR(code) {title}: -x %2F',
    openFilter,
    reader(seen),
  );
  assert.ok(seen.length > 1);
  assert.ok(seen.every((path) => filePattern.test(path)));
});

test('the browser reads the index as static files without credentials', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response('{}');
  };
  try {
    await fetchIndexFile('t/3.json');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0]?.url, '/search/t/3.json');
  assert.equal(calls[0]?.init?.credentials, 'omit');
});

test('a record file holding a quote, a person or a named record is refused', async () => {
  const chunk = JSON.parse(readFileSync(join(searchDir(), 'r/0.json'), 'utf8'));
  const first = chunk.records[0];
  for (const changed of [
    { ...first, quote: 'Copied words.' },
    { ...first, person: 'Ada Example' },
    { ...first, id: 'ur:aaaaaaaaaaaaaaaaaaaaaaaa/1', cls: 'named', src: 'use' },
  ]) {
    const read = async (path: string) =>
      path === 'r/0.json'
        ? { ...chunk, records: [changed, ...chunk.records.slice(1)] }
        : JSON.parse(readFileSync(join(searchDir(), path), 'utf8'));
    await assert.rejects(staticSource(read).records([0]));
  }
});

test('a common word reads one shard, the fact files and a page of records', async () => {
  const manifest = JSON.parse(
    readFileSync(join(searchDir(), 'index.json'), 'utf8'),
  );
  const seen: string[] = [];
  const source = staticSource(reader(seen));
  const result = await source.search(['claude'], 1, openFilter);
  assert.ok(result.measured.total > 50);
  const page = result.measured.hits
    .slice(0, searchLimits.page)
    .map((hit) => hit.doc);
  await source.records(page);
  const shards = seen.filter((path) => path.startsWith('t/'));
  const records = seen.filter((path) => path.startsWith('r/'));
  assert.deepEqual(shards, [`t/${shardOf('claude', manifest.shards)}.json`]);
  assert.ok(records.length <= searchLimits.page);
  // Budget for one word: its shard, every fact file and a page of record
  // files. check:pages measures the same on the real index.
  const bytes = seen.reduce(
    (sum, path) => sum + statSync(join(searchDir(), path)).size,
    0,
  );
  assert.ok(bytes < 1_000_000, `${bytes} bytes`);
});

test('records held whole have the facts the filters read', () => {
  const [record] = core.measured;
  assert.ok(record);
  const fact = recordFacts(record);
  assert.equal(fact.band, 'measured');
  assert.equal(fact.basis, '');
});

test('a file from another build than the manifest is refused', async () => {
  const read = async (path: string) => {
    const value = JSON.parse(readFileSync(join(searchDir(), path), 'utf8'));
    return path.startsWith('t/')
      ? { ...value, release: 'another build' }
      : value;
  };
  await assert.rejects(staticSource(read).found(['claude']));
});
