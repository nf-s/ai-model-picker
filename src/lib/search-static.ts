import { z } from 'zod';
import { recordSchema } from './records.ts';
import type { EvidenceRecord, JsonValue } from './records.ts';
import { candidates, passes, rank, shardOf } from './search.ts';
import type { DocFacts, Ranked, SearchFilter } from './search.ts';

// The public search index as static files (scripts/search_index.py writes
// them; the published build serves them under /search/). A search reads the
// manifest, the shard of each word searched, the facts of the documents that
// hold enough of the words and, for the results shown, their records. A file
// is named only by a number: a shard number from the hash of a token, or a
// chunk number from a document number.

const version = 2;
const count = z.number().int().nonnegative();
const range = z.tuple([count, count]);

const manifestSchema = z.strictObject({
  version: z.literal(version),
  builtAt: z.string(),
  records: count,
  bands: z.strictObject({ crowd: range, measured: range }),
  avgLength: z.number().nonnegative(),
  shards: z.number().int().min(1).max(4096),
  chunk: z.number().int().min(1),
  factChunk: z.number().int().min(1),
  files: z.strictObject({ records: count, facts: count }),
  jobs: z.array(z.string()),
  benchmarks: z.array(z.string()),
  // Setting and run pairs, 'local|unattended'.
  cells: z.array(z.string().regex(/^(local|hosted)?\|(\w+)?$/)),
  keys: z.array(z.string()),
});
export type SearchManifest = z.infer<typeof manifestSchema>;

const shardSchema = z.strictObject({
  v: z.literal(version),
  release: z.string(),
  terms: z.record(z.string(), z.array(count)),
});
const factsSchema = z.strictObject({
  v: z.literal(version),
  release: z.string(),
  from: count,
  // Length, job, benchmark (-1 for none), day number (-1 for none), setting
  // and run, keys.
  docs: z.array(z.array(z.number().int().min(-1)).min(5)),
});
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
// Public records leave out the quote and the person; a record that carries
// either is refused, and a named record fails the record schema.
const publicRecordSchema = z
  .record(z.string(), jsonValue)
  .refine((record) => !('quote' in record) && !('person' in record))
  .transform((record) => ({ ...record, quote: '', person: '' }))
  .pipe(recordSchema)
  .refine((record) => record.cls !== 'named');
const chunkSchema = z.strictObject({
  v: z.literal(version),
  release: z.string(),
  from: count,
  records: z.array(publicRecordSchema),
});

// Reads one file of the index by its path under /search/.
export type IndexReader = (path: string) => Promise<unknown>;

export const fetchIndexFile: IndexReader = async (path) => {
  const response = await fetch(`/search/${path}`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('The search index is unavailable.');
  return response.json();
};

// The public records as one source a search can rank. Another source (a
// server endpoint, say) can stand in for this one without touching the
// ranking or the view.
export type PublicSource = {
  // The words of `words` the records hold.
  found: (words: readonly string[]) => Promise<Set<string>>;
  search: (
    words: readonly string[],
    need: number,
    filter: SearchFilter,
  ) => Promise<{ measured: Ranked; crowd: Ranked }>;
  records: (docs: readonly number[]) => Promise<Map<number, EvidenceRecord>>;
  builtAt: () => Promise<string>;
};

type Fact = DocFacts & { length: number };

const day = (value: number) =>
  value < 0 ? '' : new Date(value * 86_400_000).toISOString().slice(0, 10);

function cached<T>(
  store: Map<number, Promise<T>>,
  n: number,
  load: () => Promise<T>,
) {
  let found = store.get(n);
  if (!found) {
    found = load().catch((error: unknown) => {
      store.delete(n);
      throw error;
    });
    store.set(n, found);
  }
  return found;
}

export function staticSource(read: IndexReader = fetchIndexFile): PublicSource {
  let manifest: Promise<SearchManifest> | null = null;
  const shards = new Map<number, Promise<Map<string, number[]>>>();
  const facts = new Map<number, Promise<Fact[]>>();
  const chunks = new Map<number, Promise<EvidenceRecord[]>>();

  const loadManifest = () => {
    manifest ??= read('index.json')
      .then((raw) => manifestSchema.parse(raw))
      .catch((error: unknown) => {
        manifest = null;
        throw error;
      });
    return manifest;
  };

  // A file from another build than the manifest's is refused: its
  // document numbers would not agree.
  async function file<T extends { release: string }>(
    path: string,
    schema: z.ZodType<T>,
  ) {
    const [index, raw] = await Promise.all([loadManifest(), read(path)]);
    const parsed = schema.parse(raw);
    if (parsed.release !== index.builtAt)
      throw new Error('The search index changed while it was being read.');
    return parsed;
  }

  const loadShard = (n: number) =>
    cached(shards, n, async () => {
      const { terms } = await file(`t/${n}.json`, shardSchema);
      const decoded = new Map<string, number[]>();
      for (const [word, gaps] of Object.entries(terms)) {
        let doc = 0;
        decoded.set(
          word,
          gaps.map((gap, i) => (doc = i === 0 ? gap : doc + gap)),
        );
      }
      return decoded;
    });

  async function postings(words: readonly string[]) {
    const { shards: total } = await loadManifest();
    const found = new Map<string, number[]>();
    await Promise.all(
      words.map(async (word) => {
        const docs = (await loadShard(shardOf(word, total))).get(word);
        if (docs) found.set(word, docs);
      }),
    );
    return found;
  }

  const loadFacts = (n: number, index: SearchManifest) =>
    cached(facts, n, async () => {
      const part = await file(`a/${n}.json`, factsSchema);
      return part.docs.map((row, i) => {
        const doc = part.from + i;
        const [
          length = 0,
          job = 0,
          benchmark = -1,
          date = -1,
          cell = 0,
          ...keys
        ] = row;
        const [crowdStart, crowdEnd] = index.bands.crowd;
        const [setting = '', run = ''] = (index.cells[cell] ?? '|').split('|');
        return {
          length,
          band: doc >= crowdStart && doc < crowdEnd ? 'crowd' : 'measured',
          job: index.jobs[job] ?? '',
          benchmark: index.benchmarks[benchmark] ?? '',
          date: day(date),
          keys: keys.flatMap((key) => index.keys[key] ?? []),
          basis: '',
          setting,
          run,
          surface: '',
        };
      });
    });

  async function factsOf(docs: readonly number[]) {
    const index = await loadManifest();
    const files = [
      ...new Set(docs.map((doc) => Math.floor(doc / index.factChunk))),
    ];
    const loaded = await Promise.all(files.map((n) => loadFacts(n, index)));
    const byDoc = new Map<number, Fact>();
    files.forEach((n, i) =>
      (loaded[i] ?? []).forEach((fact, j) =>
        byDoc.set(n * index.factChunk + j, fact),
      ),
    );
    return byDoc;
  }

  const loadChunk = (n: number) =>
    cached(
      chunks,
      n,
      async () => (await file(`r/${n}.json`, chunkSchema)).records,
    );

  return {
    found: async (words) => new Set((await postings(words)).keys()),
    async search(words, need, filter) {
      const index = await loadManifest();
      const found = await postings(words);
      const known = await factsOf(candidates(words, need, found));
      const corpus = { records: index.records, avgLength: index.avgLength };
      const inBand = (band: 'measured' | 'crowd') =>
        rank({
          words,
          need,
          corpus,
          postings: found,
          length: (doc) => known.get(doc)?.length ?? 0,
          keep: (doc) => {
            const fact = known.get(doc);
            return fact?.band === band && passes(fact, filter);
          },
          job: (doc) => known.get(doc)?.job ?? '',
          date: (doc) => known.get(doc)?.date ?? '',
        });
      return { measured: inBand('measured'), crowd: inBand('crowd') };
    },
    async records(docs) {
      const { chunk } = await loadManifest();
      const files = [...new Set(docs.map((doc) => Math.floor(doc / chunk)))];
      const loaded = await Promise.all(files.map(loadChunk));
      const byDoc = new Map<number, EvidenceRecord>();
      files.forEach((n, i) =>
        (loaded[i] ?? []).forEach((record, j) =>
          byDoc.set(n * chunk + j, record),
        ),
      );
      return byDoc;
    },
    builtAt: async () => (await loadManifest()).builtAt,
  };
}
