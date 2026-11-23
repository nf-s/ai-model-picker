// Word search over the local index, for coding agents on this machine:
//
//   npm run search -- <words> [--band measured|named|crowd] [--job <id>]
//                             [--model <model id or line name>] [--limit <n>]
//
// Prints JSON: the words searched, counts per band and job, and the best
// records of each band with their ids, summaries, quotes where held, and
// source links. It reads build/records/search-local.sqlite and
// build/records/core.json (both written by `npm run records:build`) and makes
// no network request. The output holds practitioners' quotes and names: it is
// private and must not be written to a tracked file.

import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareBrief } from '../src/lib/brief.ts';
import { coreSchema } from '../src/lib/core-schema.ts';
import { jobFromAddress, retiredNotice } from '../src/lib/job-rules.ts';
import { recordSchema } from '../src/lib/records.ts';
import {
  foundIn,
  jobFilter,
  matchingRule,
  openFilter,
  passes,
  queryWords,
  rank,
  recordFacts,
  wordsNeeded,
} from '../src/lib/search.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaults = {
  index: `${root}build/records/search-local.sqlite`,
  core: `${root}build/records/core.json`,
};
const bands = ['measured', 'use', 'advice', 'crowd'];
const classes = { measured: 'measured', named: 'named', crowd: 'crowd' };
const corpusOf = {
  measured: 'public',
  crowd: 'public',
  use: 'use',
  advice: 'advice',
};
const token = /^[a-z0-9.]+$/;

function documents(db, words) {
  const safe = words.filter((word) => token.test(word));
  if (safe.length === 0) return [];
  // Each word is quoted, so the index reads it as a word, never as an
  // operator; tokens hold only letters, digits and dots.
  const match = safe.map((word) => `"${word}"`).join(' OR ');
  return db
    .prepare(
      'SELECT d.n, d.corpus, d.pos, d.length, d.tokens, d.record FROM terms JOIN docs d ON d.n = terms.rowid WHERE terms MATCH ? ORDER BY d.n',
    )
    .all(match);
}

/** Search the local index; returns the JSON the command prints. */
export function searchLocal({
  query,
  band = [],
  job = null,
  model = null,
  limit = 10,
  index = defaults.index,
  core: corePath = defaults.core,
}) {
  for (const path of [index, corePath])
    if (!existsSync(path))
      throw new Error(`${path} is missing: run npm run records:build.`);
  const core = coreSchema.parse(JSON.parse(readFileSync(corePath, 'utf8')));
  const data = prepareBrief(core);
  // An old job id lands on the job that replaced it, as in the app's
  // addresses; one that was split or became a field is refused with a notice.
  const asked = jobFromAddress(job);
  if (asked.retired !== null) throw new Error(retiredNotice(asked.retired));
  job = asked.job;
  if (job !== null && !data.jobById.has(job))
    throw new Error(`No job has the id ${job}.`);
  for (const value of band)
    if (!(value in classes))
      throw new Error(`--band takes measured, named or crowd, not ${value}.`);
  const db = new DatabaseSync(index, { readOnly: true });
  try {
    const meta = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM meta')
        .all()
        .map((row) => [row.key, JSON.parse(row.value)]),
    );
    const { words: asked, dropped } = queryWords(query);
    const rows = documents(db, asked);
    const corpora = new Map();
    const docs = new Map();
    for (const row of rows) {
      let corpus = corpora.get(row.corpus);
      if (!corpus) corpora.set(row.corpus, (corpus = new Map()));
      const held = new Set(row.tokens.split(' '));
      for (const word of asked)
        if (held.has(word)) {
          const list = corpus.get(word);
          if (list) list.push(row.pos);
          else corpus.set(word, [row.pos]);
        }
      docs.set(`${row.corpus}:${row.pos}`, row);
    }
    const found = foundIn(asked, [...corpora.values()]);
    const need = wordsNeeded(found.length);
    const parsed = new Map();
    const recordOf = (corpus, pos) => {
      const key = `${corpus}:${pos}`;
      let record = parsed.get(key);
      if (!record) {
        record = recordSchema.parse(JSON.parse(docs.get(key).record));
        parsed.set(key, record);
      }
      return record;
    };
    const filter = {
      ...openFilter,
      ...jobFilter(data, job),
      classes: band.length
        ? band.map((value) => classes[value])
        : openFilter.classes,
      key:
        model === null
          ? null
          : (key) => key === `model|${model}` || key === `line|${model}`,
    };
    const counts = {};
    const records = [];
    for (const name of bands) {
      const corpus = corpusOf[name];
      const postings = corpora.get(corpus) ?? new Map();
      const stats = meta.corpora[corpus];
      const ranked = rank({
        words: found,
        need,
        corpus: stats,
        postings,
        length: (pos) => docs.get(`${corpus}:${pos}`)?.length ?? 0,
        keep: (pos) => {
          const facts = recordFacts(recordOf(corpus, pos));
          return facts.band === name && passes(facts, filter);
        },
        job: (pos) => recordOf(corpus, pos).job,
        date: (pos) => recordOf(corpus, pos).date,
      });
      counts[name] = {
        total: ranked.total,
        jobs: Object.fromEntries(
          [...ranked.byJob].map(([id, n]) => [id || 'none', n]),
        ),
      };
      for (const hit of ranked.hits.slice(0, limit)) {
        const record = recordOf(corpus, hit.doc);
        const benchmark = recordFacts(record).benchmark;
        records.push({
          id: record.id,
          band: name,
          src: record.src,
          job: record.job || null,
          jobBy: record.how || null,
          matched: hit.matched,
          score: Number(hit.score.toFixed(4)),
          summary: record.text,
          quote: record.quote || null,
          person: record.person || null,
          targets: record.keys.map(([key, stance]) => ({ key, stance })),
          tool: record.tool || null,
          effort: record.effort || null,
          conditions: record.cond || null,
          benchmark: benchmark || null,
          date: record.date || null,
          title: record.title || null,
          url: record.url,
        });
      }
    }
    return {
      query,
      words: found,
      notFound: asked.filter((word) => !found.includes(word)),
      notSearched: dropped,
      rule: matchingRule,
      filters: { band, job, model },
      index: { builtAt: meta.builtAt, records: meta.corpora },
      private:
        'Holds practitioners’ quotes and names. Do not copy it into a tracked file or a public page.',
      counts,
      records,
    };
  } finally {
    db.close();
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      band: { type: 'string', multiple: true },
      job: { type: 'string' },
      model: { type: 'string' },
      limit: { type: 'string' },
      index: { type: 'string' },
      core: { type: 'string' },
    },
  });
  const limit = values.limit === undefined ? 10 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error('--limit takes a whole number from 1 to 200.');
  if (positionals.length === 0)
    throw new Error('Give the words to search for: npm run search -- <words>');
  const result = searchLocal({
    query: positionals.join(' '),
    band: (values.band ?? []).flatMap((value) => value.split(',')),
    job: values.job ?? null,
    model: values.model ?? null,
    limit,
    index: values.index ?? defaults.index,
    core: values.core ?? defaults.core,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
