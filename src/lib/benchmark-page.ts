import { attributions } from './attribution.ts';
import type { Attribution } from './attribution.ts';
import {
  recordBenchmark,
  recordConfig,
  recordCost,
  recordInterval,
  recordRank,
  recordScore,
  recordTrials,
} from './brief.ts';
import type { Core, CoreBenchmark } from './core-schema.ts';
import type { EvidenceRecord, JsonValue } from './records.ts';

// A Benchmark page for an imported LMArena leaderboard or Epoch run, read from
// core.json. Only rows for models in the model list are records, so the page
// says how many of the source's rows that covers. Arena ratings are
// preference votes: they are never shown as percentages or on a percentage
// axis.

export type ImportedSource = 'lmarena' | 'epoch';

export const sourceNames: Record<ImportedSource, string> = {
  lmarena: 'LMArena',
  epoch: 'Epoch AI runs',
};

// The Data page's credit entry for each imported source.
const attributionNames: Record<ImportedSource, string> = {
  lmarena: 'LMArena',
  epoch: 'Epoch AI benchmarking hub',
};

export type BenchmarkRow = {
  id: string;
  modelId: string;
  config: string;
  score: number;
  value: string;
  interval: string;
  // Votes or observations on an arena; null for a run.
  count: number | null;
  sessions: number | null;
  cost: number | null;
  date: string;
  url: string;
  // The source's rank among all its rows on an arena; among the rows shown
  // here (equal scores share a rank) for a run.
  rank: number;
  // The model's highest result on this benchmark.
  best: boolean;
};

export type ImportedBenchmarkPage = {
  benchmark: CoreBenchmark;
  source: ImportedSource;
  // What the number is and is not.
  scaleNote: string;
  // How many of the source's rows are for models in the model list.
  coverage: string;
  rankNote: string;
  countLabel: string | null;
  dates: [string, string] | null;
  attribution: Attribution | null;
  rows: BenchmarkRow[];
};

export function importedSource(benchmark: CoreBenchmark) {
  return benchmark.source === 'lmarena' || benchmark.source === 'epoch'
    ? benchmark.source
    : null;
}

// An arena rating or session score as a plain number; a run's share with %.
export function benchmarkValue(score: number, benchmark: CoreBenchmark) {
  if (benchmark.scale === 'percent')
    return `${score.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  return score.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

// The leaderboard's own text already says "Preference votes, not a pass
// rate" (the records build refuses an arena without it); this adds the date
// the ratings are relative to.
export function scaleNote(benchmark: CoreBenchmark) {
  if (benchmark.scale === 'rating')
    return `${benchmark.unit === 'Arena rating' ? 'Ratings' : 'Scores'} are relative to the other models on this leaderboard${benchmark.publishedAt ? ` as published on ${benchmark.publishedAt}` : ''}. They are not percentages and are not compared with other leaderboards or benchmarks.`;
  if (benchmark.scale === 'percent')
    return `Share of the benchmark's problems solved or answered correctly, in percent (${benchmark.unit}).`;
  return `Index points (${benchmark.unit}).`;
}

export function coverageLine(rows: number | null, shown: number) {
  if (rows === null)
    return `${shown.toLocaleString()} results for models in the model list.`;
  return `${shown.toLocaleString()} of the source's ${rows.toLocaleString()} rows are for models in the model list and are shown here. Rows for other models are not shown.`;
}

function xNumber(record: EvidenceRecord, field: string) {
  const value: JsonValue | undefined = record.x?.[field];
  return typeof value === 'number' ? value : null;
}

// Equal scores share a rank.
function ranks(scores: readonly number[]) {
  const ordered = [...scores].sort((a, b) => b - a);
  return scores.map((score) => ordered.indexOf(score) + 1);
}

export function importedBenchmarkPage(
  core: Core,
  id: string,
): ImportedBenchmarkPage | null {
  const benchmark = core.benchmarks.find((entry) => entry.id === id);
  const source = benchmark ? importedSource(benchmark) : null;
  if (!benchmark || !source) return null;
  const records = core.measured.filter(
    (record) => recordBenchmark(record) === id,
  );
  const scores = records.map((record) => recordScore(record) ?? 0);
  const ownRanks = ranks(scores);
  const bestScore = new Map<string, number>();
  const rows = records.flatMap((record, position): BenchmarkRow[] => {
    const key = record.keys.find(([entry]) => entry.startsWith('model|'));
    const score = recordScore(record);
    if (!key || score === null) return [];
    const modelId = key[0].slice(6);
    bestScore.set(
      modelId,
      Math.max(bestScore.get(modelId) ?? -Infinity, score),
    );
    return [
      {
        id: record.id,
        modelId,
        config: recordConfig(record),
        score,
        value: benchmarkValue(score, benchmark),
        interval: recordInterval(record),
        count: source === 'lmarena' ? recordTrials(record) : null,
        sessions: xNumber(record, 'sessions'),
        cost: recordCost(record),
        date: record.date,
        url: record.url,
        rank:
          source === 'lmarena'
            ? (recordRank(record) ?? ownRanks[position] ?? 0)
            : (ownRanks[position] ?? 0),
        best: false,
      },
    ];
  });
  for (const row of rows) row.best = bestScore.get(row.modelId) === row.score;
  rows.sort((a, b) => a.rank - b.rank || a.config.localeCompare(b.config));
  const dates = rows
    .map((row) => row.date)
    .filter(Boolean)
    .sort();
  const first = dates[0];
  const last = dates.at(-1);
  const observed = rows.some((row) => row.sessions !== null);
  return {
    benchmark,
    source,
    scaleNote: scaleNote(benchmark),
    coverage: coverageLine(benchmark.rows, rows.length),
    rankNote:
      source === 'lmarena'
        ? "Rank is the source's, among all the rows on this leaderboard, including models not shown."
        : 'Rank is among the results shown here; equal scores share a rank.',
    countLabel:
      source === 'lmarena' ? (observed ? 'Observations' : 'Votes') : null,
    dates: first && last ? [first, last] : null,
    attribution:
      attributions.find((entry) => entry.source === attributionNames[source]) ??
      null,
    rows,
  };
}

// The imported benchmarks for the index, by source in the order core.json
// lists them.
export function importedIndex(core: Core) {
  return (['lmarena', 'epoch'] as const).map((source) => ({
    source,
    name: sourceNames[source],
    benchmarks: core.benchmarks.filter((entry) => entry.source === source),
  }));
}
