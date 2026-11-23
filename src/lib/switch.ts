import {
  benchmarksFor,
  benchmarkValue,
  jobSet,
  minimums,
  modelKey,
  monthStart,
  recordBenchmark,
  recordInJob,
} from './brief.ts';
import type { Benchmark, BriefData, Scale, SignalValue } from './brief.ts';
import type { CoreModel, Preference } from './core-schema.ts';

// What changes when moving from model A to model B in one job. A benchmark
// compares the two only on its own results: two leaderboards, two scales or
// two benchmarks are never compared with each other, and nothing is summed
// across benchmarks.

export type Verdict =
  // Both intervals are published and overlap: no measured difference.
  | 'overlap'
  // Both intervals are published and apart.
  | 'apart'
  // At least one interval is missing; the difference is shown as it is.
  | 'no-interval';

export type SharedBenchmark = {
  benchmark: Benchmark;
  a: SignalValue;
  b: SignalValue;
  verdict: Verdict;
  // B's best result minus A's, in the benchmark's own unit.
  difference: number;
};

// The benchmarks that measure the job: its own (or its parent's when it has
// none), then its parent's for a sub-job, then any whose records carry the
// job. For all jobs (null), every benchmark.
export function switchBenchmarks(data: BriefData, jobId: string | null) {
  if (jobId === null) return data.benchmarks;
  const job = data.jobById.get(jobId);
  const listed = [
    ...benchmarksFor(data, jobId).ids,
    ...(job?.parent === undefined ? [] : benchmarksFor(data, job.parent).ids),
  ];
  const carried = new Set(
    data.measured
      .filter((record) => recordInJob(data, record, jobId))
      .map(recordBenchmark),
  );
  const ids = [
    ...new Set([
      ...listed,
      ...data.benchmarks
        .map((entry) => entry.id)
        .filter((id) => carried.has(id)),
    ]),
  ];
  return ids.flatMap((id) => data.benchmarkById.get(id) ?? []);
}

export function verdictOf(a: SignalValue, b: SignalValue): Verdict {
  if (a.range === null || b.range === null) return 'no-interval';
  return a.range[1] >= b.range[0] && b.range[1] >= a.range[0]
    ? 'overlap'
    : 'apart';
}

// Each benchmark of the job with a result for both models: each model's best
// result on that benchmark, as Brief shows it.
export function sharedBenchmarks(
  data: BriefData,
  a: string,
  b: string,
  jobId: string | null,
): SharedBenchmark[] {
  return switchBenchmarks(data, jobId).flatMap((benchmark) => {
    const first = benchmarkValue(data, a, benchmark);
    const second = benchmarkValue(data, b, benchmark);
    if (!first || !second) return [];
    return [
      {
        benchmark,
        a: first,
        b: second,
        verdict: verdictOf(first, second),
        difference: round(second.n - first.n),
      },
    ];
  });
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

const differenceUnits: Record<Scale, [string, string]> = {
  percent: ['percentage point', 'percentage points'],
  rating: ['rating point', 'rating points'],
  index: ['index point', 'index points'],
};

// "Claude B higher by 4.2 percentage points" in the benchmark's own unit.
export function differenceText(
  row: SharedBenchmark,
  nameA: string,
  nameB: string,
) {
  if (row.verdict === 'overlap')
    return 'Intervals overlap: no measured difference';
  if (row.difference === 0) return 'Same result';
  const size = Math.abs(row.difference);
  const [one, many] = differenceUnits[row.benchmark.scale];
  const higher = row.difference > 0 ? nameB : nameA;
  const text = `${higher} higher by ${size.toLocaleString('en')} ${size === 1 ? one : many}`;
  return row.verdict === 'apart'
    ? `${text}, intervals apart`
    : `${text}; no interval published`;
}

// How the output price changes after switching from A to B.
export function priceChange(a: CoreModel, b: CoreModel) {
  if (a.output === null || b.output === null || a.output === 0) return null;
  const ratio = b.output / a.output;
  if (ratio === 1) return 'Same output price';
  return ratio > 1
    ? `Output costs ${ratio.toFixed(1)}× more after switching`
    : `Output costs ${(1 / ratio).toFixed(1)}× less after switching`;
}

export type PreferencesBetween = {
  forA: Preference[];
  forB: Preference[];
  total: number;
  // Share preferring B; null below the minimum of stated preferences.
  shareB: number | null;
};

// Comments in the job and period that say one of the two exact models is
// better than the other.
export function preferencesBetween(
  data: BriefData,
  a: string,
  b: string,
  jobId: string | null,
  since: string,
): PreferencesBetween {
  const ka = modelKey(a);
  const kb = modelKey(b);
  const jobs = jobSet(data, jobId);
  const from = monthStart(since);
  const between = data.core.preferences.filter(
    (preference) =>
      ((preference.winner === ka && preference.loser === kb) ||
        (preference.winner === kb && preference.loser === ka)) &&
      jobs.has(preference.job) &&
      (!from || preference.date >= from),
  );
  const forA = between.filter((preference) => preference.winner === ka);
  const forB = between.filter((preference) => preference.winner === kb);
  const total = between.length;
  return {
    forA,
    forB,
    total,
    shareB: total >= minimums.preferences ? forB.length / total : null,
  };
}
