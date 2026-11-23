import { allBenchmarksFor, jobSet, monthStart } from './brief.ts';
import { fieldsPass, openFields } from './fields.ts';
import type { FieldFilter } from './fields.ts';
import type { BriefData } from './brief.ts';
import type { SourceClass } from './model-filter.ts';
import type { EvidenceRecord } from './records.ts';

// Word search: one tokeniser and one ranking for every place that searches.
// scripts/search_index.py holds the same tokeniser, shard mapping and
// document text for the indexes it builds; tests/fixtures/search-tokens.json
// keeps the two in step. The static index in the browser, the named records
// in the browser and the local command all rank through `rank` below.

export const searchLimits = {
  // Query words kept; the rest are listed as not searched.
  words: 12,
  // Ranked records kept per band; the counts still cover every match.
  hits: 1000,
  // Records shown at a time in each band.
  page: 10,
} as const;

export const matchingRule =
  'A record needs at least half of the words; records with all of them come first.';

const stopWords = new Set(
  'a an and are as at be but by for from has have how i if in is it its of on or that the their this to was what when which who with would you your does do should than vs can good best better use using used model models there any some about into over my me we they them not no so get got will just then also more most much very'.split(
    ' ',
  ),
);
const wordPattern = /[a-z]+|[0-9]+(?:\.[0-9]+)*/g;

// The words of a text as the index holds them: lower case, letters or
// numbers (with their dots, as in 5.5), stop words dropped, a final -ing or
// -s cut.
export function tokens(text: string) {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(wordPattern)) {
    let word = match[0];
    if (stopWords.has(word)) continue;
    if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss'))
      word = word.slice(0, -1);
    out.push(word);
  }
  return out;
}

const encoder = new TextEncoder();

// A token's shard: 32-bit FNV-1a over its UTF-8 bytes, modulo the number of
// shards. The only way a searched word reaches a file name.
export function shardOf(token: string, shards: number) {
  let value = 0x811c9dc5;
  for (const byte of encoder.encode(token))
    value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value % shards;
}

function keyName(key: string, modelName: (id: string) => string) {
  const at = key.indexOf('|');
  const value = key.slice(at + 1);
  return key.slice(0, at) === 'model' ? modelName(value) : value;
}

function extra(record: EvidenceRecord, field: string) {
  const value = record.x?.[field];
  return typeof value === 'string' ? value : '';
}

// The words a record is found by: its own text and the names of what it is
// about.
export function docText(
  record: EvidenceRecord,
  modelName: (id: string) => string,
  jobLabel: (id: string) => string,
) {
  return [
    record.text,
    record.quote,
    record.cond,
    record.keys.map(([key]) => keyName(key, modelName)).join(' '),
    record.person,
    record.title,
    record.kind,
    record.tool,
    record.effort,
    record.job ? jobLabel(record.job) : '',
    extra(record, 'named'),
    extra(record, 'task'),
    extra(record, 'cmpNamed'),
  ]
    .filter((part) => part !== '')
    .join(' ');
}

// Each word once, in order; a document's length is their number.
export function docTokens(
  record: EvidenceRecord,
  modelName: (id: string) => string,
  jobLabel: (id: string) => string,
) {
  return [...new Set(tokens(docText(record, modelName, jobLabel)))];
}

// The words searched, each once, and those past the limit.
export function queryWords(query: string) {
  const all = [...new Set(tokens(query))];
  return {
    words: all.slice(0, searchLimits.words),
    dropped: all.slice(searchLimits.words),
  };
}

// The number of the words found that a record must hold.
export const wordsNeeded = (found: number) => Math.ceil(found / 2);

// The words, in query order, that at least one of the searched indexes
// holds. The rest are reported as not in the records and do not count
// toward the half.
export function foundIn(
  words: readonly string[],
  holders: readonly { has: (word: string) => boolean }[],
) {
  return words.filter((word) => holders.some((holder) => holder.has(word)));
}

// ---- Ranking ------------------------------------------------------------------

export type Corpus = { records: number; avgLength: number };
// For each word, the documents of one corpus that hold it, in ascending order.
export type Postings = ReadonlyMap<string, readonly number[]>;
export type Hit = { doc: number; job: string; matched: number; score: number };
export type Ranked = {
  // Every document that passed, and how many per job.
  total: number;
  byJob: Map<string, number>;
  // The best of them, at most searchLimits.hits.
  hits: Hit[];
};

// Inverse document frequency as BM25 weighs it, never below zero.
export function idf(corpus: Corpus, df: number) {
  return Math.log(1 + (corpus.records - df + 0.5) / (df + 0.5));
}

// The documents that hold at least `need` of the words, ascending.
export function candidates(
  words: readonly string[],
  need: number,
  postings: Postings,
) {
  const counts = new Map<number, number>();
  for (const word of words)
    for (const doc of postings.get(word) ?? [])
      counts.set(doc, (counts.get(doc) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count >= need)
    .map(([doc]) => doc)
    .sort((a, b) => a - b);
}

// BM25 with each word counted once per document (k1 1.2, b 0.75). Records
// holding more of the words come first; among those, the higher score, then
// the newer record, then the lower document number.
export function rank({
  words,
  need,
  corpus,
  postings,
  length,
  keep,
  job,
  date,
  limit = searchLimits.hits,
}: {
  words: readonly string[];
  need: number;
  corpus: Corpus;
  postings: Postings;
  length: (doc: number) => number;
  keep: (doc: number) => boolean;
  job: (doc: number) => string;
  // The record's date ('' for none), for ties.
  date: (doc: number) => string;
  limit?: number;
}): Ranked {
  const matched = new Map<number, { count: number; weight: number }>();
  for (const word of words) {
    const docs = postings.get(word);
    if (!docs) continue;
    const weight = idf(corpus, docs.length);
    for (const doc of docs) {
      const entry = matched.get(doc);
      if (entry) {
        entry.count += 1;
        entry.weight += weight;
      } else matched.set(doc, { count: 1, weight });
    }
  }
  const byJob = new Map<string, number>();
  const hits: (Hit & { date: string })[] = [];
  for (const [doc, { count, weight }] of matched) {
    if (count < need || !keep(doc)) continue;
    const jobId = job(doc);
    byJob.set(jobId, (byJob.get(jobId) ?? 0) + 1);
    const norm =
      1 + 1.2 * (0.25 + (0.75 * length(doc)) / (corpus.avgLength || 1));
    hits.push({
      doc,
      job: jobId,
      matched: count,
      score: (weight * 2.2) / norm,
      date: date(doc),
    });
  }
  hits.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      (a.date === b.date ? 0 : a.date < b.date ? 1 : -1) ||
      a.doc - b.doc,
  );
  return {
    total: hits.length,
    byJob,
    hits: hits
      .slice(0, limit)
      .map(({ doc, job: id, matched: count, score }) => ({
        doc,
        job: id,
        matched: count,
        score,
      })),
  };
}

// ---- Filters ------------------------------------------------------------------

export type SearchBand = 'measured' | 'use' | 'advice' | 'crowd';
export const bandClass: Record<SearchBand, SourceClass> = {
  measured: 'measured',
  use: 'named',
  advice: 'named',
  crowd: 'crowd',
};

// What the filters read about a document.
export type DocFacts = {
  band: SearchBand;
  job: string;
  // A measured record's benchmark; '' otherwise.
  benchmark: string;
  date: string;
  keys: readonly string[];
  // A use record's basis class; '' otherwise.
  basis: string;
  // The record's setting and run, and for named records its surface.
  setting: string;
  run: string;
  surface: string;
};

export type SearchFilter = {
  classes: readonly SourceClass[];
  // The jobs that pass, or null for every job. A measured record also passes
  // when its benchmark is one of `benchmarks`.
  jobs: ReadonlySet<string> | null;
  benchmarks: ReadonlySet<string>;
  // First day of the period, or ''. Hacker News records count from the
  // first of that month, as their monthly counts do.
  since: string;
  // The model selection over target keys, or null when nothing is selected.
  key: ((key: string) => boolean) | null;
  // Whether an exact model is current, when only current models are shown.
  current: ((modelId: string) => boolean) | null;
  // Setting and run filter Crowd and named records, surface named records.
  fields: FieldFilter;
  // The basis classes a use record must have, or null for any.
  basis: ReadonlySet<string> | null;
};

export const openFilter: SearchFilter = {
  classes: ['measured', 'named', 'crowd'],
  jobs: null,
  benchmarks: new Set(),
  since: '',
  key: null,
  current: null,
  basis: null,
  fields: openFields,
};

// The job filter as Brief reads it: the job and its sub-jobs, and for
// measured records the benchmarks that order the job.
export function jobFilter(
  data: BriefData,
  jobId: string | null,
): Pick<SearchFilter, 'jobs' | 'benchmarks'> {
  if (jobId === null) return { jobs: null, benchmarks: new Set() };
  return {
    jobs: jobSet(data, jobId),
    benchmarks: new Set(allBenchmarksFor(data, jobId)),
  };
}

const exactIds = (keys: readonly string[]) =>
  keys.filter((key) => key.startsWith('model|')).map((key) => key.slice(6));

// The filter bar applied to one document. Method advice names no model, so
// the model selection and current models leave it in. A measured record is
// within the selection when one of its exact models is; other records when
// any target they name is.
export function passes(facts: DocFacts, filter: SearchFilter) {
  if (!filter.classes.includes(bandClass[facts.band])) return false;
  if (
    filter.jobs !== null &&
    !filter.jobs.has(facts.job) &&
    !(facts.benchmark !== '' && filter.benchmarks.has(facts.benchmark))
  )
    return false;
  const since =
    facts.band === 'crowd' ? monthStart(filter.since) : filter.since;
  if (since && facts.date && facts.date < since) return false;
  if (facts.band === 'use' && filter.basis && !filter.basis.has(facts.basis))
    return false;
  if (
    facts.band !== 'measured' &&
    !fieldsPass(facts, filter.fields, facts.band !== 'crowd')
  )
    return false;
  if (facts.band === 'advice') return true;
  const { key } = filter;
  if (key) {
    const named =
      facts.band === 'measured'
        ? exactIds(facts.keys).map((id) => `model|${id}`)
        : facts.keys;
    if (!named.some(key)) return false;
  }
  const { current } = filter;
  return current === null || exactIds(facts.keys).some(current);
}

// The facts of a record held whole (the local index, the named records).
export function recordFacts(record: EvidenceRecord): DocFacts {
  const band: SearchBand =
    record.cls === 'measured'
      ? 'measured'
      : record.src === 'use' || record.src === 'advice'
        ? record.src
        : 'crowd';
  const x = record.x?.['b'];
  const b = typeof x === 'string' ? x : '';
  return {
    band,
    job: record.job,
    benchmark: band === 'measured' ? b : '',
    date: record.date,
    keys: record.keys.map(([key]) => key),
    basis: band === 'use' ? b : '',
    setting: record.setting,
    run: record.run,
    surface: record.surface,
  };
}

// ---- Records held whole ---------------------------------------------------------

export type MemoryCorpus = {
  corpus: Corpus;
  postings: Postings;
  lengths: readonly number[];
};

// An index of records held in memory, numbered in the order given.
export function memoryCorpus(
  records: readonly EvidenceRecord[],
  modelName: (id: string) => string,
  jobLabel: (id: string) => string,
): MemoryCorpus {
  const postings = new Map<string, number[]>();
  const lengths: number[] = [];
  records.forEach((record, doc) => {
    const words = docTokens(record, modelName, jobLabel);
    lengths.push(words.length);
    for (const word of words) {
      const list = postings.get(word);
      if (list) list.push(doc);
      else postings.set(word, [doc]);
    }
  });
  const total = lengths.reduce((sum, value) => sum + value, 0);
  return {
    corpus: {
      records: records.length,
      avgLength: records.length ? total / records.length : 0,
    },
    postings,
    lengths,
  };
}

// Records held in memory, ranked within the filters.
export function rankRecords(
  records: readonly EvidenceRecord[],
  index: MemoryCorpus,
  words: readonly string[],
  need: number,
  filter: SearchFilter,
) {
  return rank({
    words,
    need,
    corpus: index.corpus,
    postings: index.postings,
    length: (doc) => index.lengths[doc] ?? 0,
    keep: (doc) => {
      const record = records[doc];
      return record !== undefined && passes(recordFacts(record), filter);
    },
    job: (doc) => records[doc]?.job ?? '',
    date: (doc) => records[doc]?.date ?? '',
  });
}

// ---- Presenting ------------------------------------------------------------------

// Items in rank order under their job, the jobs in the order of their best
// item.
export function groupByJob<T>(items: readonly T[], job: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = job(item);
    const list = groups.get(id);
    if (list) list.push(item);
    else groups.set(id, [item]);
  }
  return [...groups].map(([id, list]) => ({ job: id, items: list }));
}
