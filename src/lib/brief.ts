import type {
  Core,
  CoreJob,
  CoreModel,
  CoreUsage,
  Preference,
} from './core-schema.ts';
import { hnThemeSchema } from './hn-published.ts';
import type { HnTheme } from './hn-index.ts';
import type { BasisClass, SourceClass } from './model-filter.ts';
import type { EvidenceRecord, JsonValue } from './records.ts';
import type {
  Benchmark as SnapshotBenchmark,
  BenchmarkResult,
} from './schema.ts';

// The rules Brief applies: which measure sets the order, who comes first,
// the second and lower-cost choices, and the counts each part shows. Only a
// measured result orders models while one exists; reported evidence orders
// them only where no benchmark has a result, or inside overlapping intervals.

export const minimums = {
  // Stated preferences a model needs before its share is used.
  preferences: 5,
  // Clearly positive or critical Hacker News labels for a positive share.
  clearLabels: 10,
  // Models a job's own benchmark must cover before the general index is not
  // used, and before a sub-job orders by its own benchmark, not its parent's.
  models: 3,
} as const;
// Lower cost: at most this share of the first choice's cost ...
export const lowerCostPrice = 0.5;
// ... and at least this share of the highest result (not for arena ratings).
export const lowerCostResult = 0.85;

export type Scale = 'percent' | 'index' | 'rating';
export type Benchmark = {
  id: string;
  name: string;
  unit: string;
  scale: Scale;
  general: boolean;
  what: string;
  url: string;
  // snapshot, lmarena, epoch, or restricted for the signed-in payload.
  source: string;
  // The publisher named by a restricted benchmark.
  publisher: string;
  publishedAt: string;
  attribution: string;
  // First and last date of its results, when they carry dates.
  dates: [string, string] | null;
};
export type Tally = [number, number, number, number];
export type RestrictedInput = {
  checkedAt: string;
  benchmarks: readonly SnapshotBenchmark[];
  results: readonly BenchmarkResult[];
};
export type BriefData = {
  core: Core;
  jobs: CoreJob[];
  jobById: Map<string, CoreJob>;
  models: CoreModel[];
  modelById: Map<string, CoreModel>;
  benchmarks: Benchmark[];
  benchmarkById: Map<string, Benchmark>;
  measured: EvidenceRecord[];
  measuredByModel: Map<string, EvidenceRecord[]>;
  // Restricted benchmarks by the job their category maps to.
  restrictedByJob: Map<string, string[]>;
  // The last day of the Hacker News collection; periods count back from it.
  end: string;
};
export type BriefFilters = {
  inScope: (modelId: string) => boolean;
  current: boolean;
  // First day of the period, or '' for all dates.
  since: string;
  classes: readonly SourceClass[];
  // The bases of named use records shown; they never touch measured or
  // crowd records.
  basis: readonly BasisClass[];
};
export type WithinOverlap = 'preferences' | 'cost';

export const modelKey = (modelId: string) => `model|${modelId}`;
export const lineKey = (name: string) => `line|${name}`;

function xNumber(record: EvidenceRecord, field: string): number | null {
  const value: JsonValue | undefined = record.x?.[field];
  return typeof value === 'number' ? value : null;
}
function xString(record: EvidenceRecord, field: string): string {
  const value: JsonValue | undefined = record.x?.[field];
  return typeof value === 'string' ? value : '';
}
export const recordBenchmark = (record: EvidenceRecord) => xString(record, 'b');
export const recordScore = (record: EvidenceRecord) => xNumber(record, 'score');
export const recordConfig = (record: EvidenceRecord) =>
  xString(record, 'config');
export const recordCost = (record: EvidenceRecord) => xNumber(record, 'cost');
export const recordInterval = (record: EvidenceRecord) =>
  xString(record, 'interval');
export const recordRank = (record: EvidenceRecord) => xNumber(record, 'rank');
export const recordTrials = (record: EvidenceRecord) =>
  xNumber(record, 'trials');

// "±2.88 · 95% confidence interval" or "1807–1838 · confidence bounds".
export function parseInterval(
  score: number,
  text: string,
): [number, number] | null {
  const plusMinus = /±\s*([\d.]+)/.exec(text);
  if (plusMinus?.[1]) {
    const half = Number(plusMinus[1]);
    return [score - half, score + half];
  }
  const span = /^(-?[\d.]+)\s*[–-]\s*(-?[\d.]+)/.exec(text);
  return span?.[1] && span[2] ? [Number(span[1]), Number(span[2])] : null;
}

export function scaleOf(unit: string, general: boolean): Scale {
  if (unit.includes('%')) return 'percent';
  if (!general && /\b(elo|rating)\b/i.test(unit)) return 'rating';
  return 'index';
}

export function scoreText(score: number, benchmark: Benchmark) {
  return benchmark.unit.includes('%')
    ? `${score}%`
    : `${score} ${benchmark.unit.replace(/ points$/, '')}`;
}

// What one cost figure covers differs by benchmark.
export function costUnit(benchmarkId: string) {
  if (benchmarkId.startsWith('swe-rebench')) return 'per problem';
  if (benchmarkId.startsWith('plato')) return 'per run';
  if (benchmarkId === 'lmarena-agent-overall') return 'median per task';
  return 'per trial';
}

// A short name for the kind of number a benchmark gives.
export function benchmarkKind(
  benchmark: Pick<Benchmark, 'general' | 'scale' | 'unit'>,
) {
  if (benchmark.general) return 'general index';
  if (benchmark.scale === 'rating')
    return benchmark.unit.includes('IPS')
      ? 'session score, not a pass rate'
      : 'preference votes, not a pass rate';
  if (benchmark.scale === 'percent') return 'share solved or correct';
  return 'index points';
}

function snapshotRecord(
  result: BenchmarkResult,
  benchmark: SnapshotBenchmark,
  job: string,
  model: string,
  checked: string,
): EvidenceRecord {
  const unit = benchmark.unit.includes('%')
    ? '%'
    : ` ${benchmark.unit.replace(/ points$/, '')}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(result.runDate ?? '')
    ? (result.runDate ?? '')
    : '';
  return {
    id: `bm:${result.id}`,
    cls: 'measured',
    src: 'benchmark',
    keys: [[modelKey(result.modelId), 'neutral']],
    job,
    how: job ? 'label' : '',
    via: job ? `category:${benchmark.category}` : '',
    stance: 'neutral',
    text: `${model}: ${result.score}${unit} on ${benchmark.name}`,
    quote: '',
    cond:
      result.costUsd !== undefined && benchmark.costMethod
        ? benchmark.costMethod
        : '',
    tool: '',
    effort: '',
    setting: '',
    run: '',
    surface: '',
    date,
    person: '',
    url: result.sourceUrl,
    title: benchmark.name,
    kind: 'benchmark result',
    x: {
      b: benchmark.id,
      score: result.score,
      config: result.configuration,
      cost: result.costUsd ?? null,
      time: result.timeSeconds ?? null,
      interval: result.interval ?? '',
      trials: result.trials ?? null,
    },
    checked,
  };
}

function datesOf(records: readonly EvidenceRecord[]): [string, string] | null {
  const dates = records
    .map((record) => record.date)
    .filter((date) => date !== '')
    .sort();
  const first = dates[0];
  const last = dates.at(-1);
  return first && last ? [first, last] : null;
}

// The records the app shows, with the restricted payload's added for a
// signed-in, granted account. Which job a restricted benchmark measures comes
// from its category in the payload, through the job file's category table.
export function prepareBrief(
  core: Core,
  restricted: RestrictedInput | null = null,
): BriefData {
  const modelById = new Map(core.models.map((model) => [model.id, model]));
  const measured = [...core.measured];
  const added: Benchmark[] = [];
  const restrictedByJob = new Map<string, string[]>();
  if (restricted) {
    const known = new Set(core.benchmarks.map((entry) => entry.id));
    for (const benchmark of restricted.benchmarks) {
      if (known.has(benchmark.id)) continue;
      const job = core.jobs.categories[benchmark.category] ?? '';
      const general = benchmark.category === 'general';
      added.push({
        id: benchmark.id,
        name: benchmark.name,
        unit: benchmark.unit,
        scale: scaleOf(benchmark.unit, general),
        general,
        what: benchmark.description,
        url: benchmark.url,
        source: 'restricted',
        publisher: benchmark.source,
        publishedAt: '',
        attribution: '',
        dates: null,
      });
      if (job)
        restrictedByJob.set(job, [
          ...(restrictedByJob.get(job) ?? []),
          benchmark.id,
        ]);
      for (const result of restricted.results) {
        const model = modelById.get(result.modelId);
        if (result.benchmarkId === benchmark.id && model)
          measured.push(
            snapshotRecord(
              result,
              benchmark,
              job,
              model.name,
              restricted.checkedAt,
            ),
          );
      }
    }
  }
  const measuredByModel = new Map<string, EvidenceRecord[]>();
  const byBenchmark = new Map<string, EvidenceRecord[]>();
  for (const record of measured) {
    for (const [key] of record.keys)
      if (key.startsWith('model|')) {
        const id = key.slice(6);
        measuredByModel.set(id, [...(measuredByModel.get(id) ?? []), record]);
      }
    const benchmark = recordBenchmark(record);
    if (benchmark)
      byBenchmark.set(benchmark, [
        ...(byBenchmark.get(benchmark) ?? []),
        record,
      ]);
  }
  const benchmarks: Benchmark[] = [
    ...core.benchmarks.map((entry) => ({
      id: entry.id,
      name: entry.name,
      unit: entry.unit,
      scale: entry.scale,
      general: entry.general,
      what: entry.what,
      url: entry.url,
      source: entry.source,
      publisher: '',
      publishedAt: entry.publishedAt,
      attribution: entry.attribution,
      dates: null,
    })),
    ...added,
  ].map((entry) => ({
    ...entry,
    dates: datesOf(byBenchmark.get(entry.id) ?? []),
  }));
  return {
    core,
    jobs: core.jobs.list,
    jobById: new Map(core.jobs.list.map((job) => [job.id, job])),
    models: core.models,
    modelById,
    benchmarks,
    benchmarkById: new Map(benchmarks.map((entry) => [entry.id, entry])),
    measured,
    measuredByModel,
    restrictedByJob,
    end: core.sources.hn.endAt.slice(0, 10),
  };
}

// The filter bar's period, sources and current-models setting as the rules
// read them.
export function briefFilters(
  data: BriefData,
  bar: {
    period: number;
    current: boolean;
    classes: readonly SourceClass[];
    basis: readonly BasisClass[];
  },
  inScope: (modelId: string) => boolean,
): BriefFilters {
  return {
    inScope,
    current: bar.current,
    since: periodStart(data.end, bar.period),
    classes: bar.classes,
    basis: bar.basis,
  };
}

export function findJob(data: BriefData, id: string | null) {
  return id === null ? null : (data.jobById.get(id) ?? null);
}

// The first day of a period of `months` ending on `end`; '' for all dates.
export function periodStart(end: string, months: number) {
  if (months === 0) return '';
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

// Hacker News counts are monthly, so for them a period starts on the first
// of its month.
export function monthStart(since: string) {
  return since ? `${since.slice(0, 7)}-01` : '';
}

// A job and its sub-jobs; for null (all jobs), every job and records with
// no job.
export function jobSet(data: BriefData, id: string | null) {
  if (id === null) return new Set(['', ...data.jobs.map((job) => job.id)]);
  return new Set([
    id,
    ...data.jobs.filter((job) => job.parent === id).map((job) => job.id),
  ]);
}

// The benchmarks that measure a job in its order of preference, with
// restricted ones after the listed ones; a sub-job without any uses its
// parent's and says so through `from`.
export function benchmarksFor(data: BriefData, id: string) {
  const own = (job: CoreJob) => [
    ...job.benchmarks,
    ...(data.restrictedByJob.get(job.id) ?? []),
  ];
  const job = data.jobById.get(id);
  if (!job) return { ids: [], from: null };
  const ids = own(job);
  if (ids.length > 0 || job.parent === undefined) return { ids, from: null };
  const parent = data.jobById.get(job.parent);
  return parent
    ? { ids: own(parent), from: parent.id }
    : { ids: [], from: null };
}

export function recordInJob(
  data: BriefData,
  record: EvidenceRecord,
  jobId: string | null,
) {
  if (jobId === null || jobSet(data, jobId).has(record.job)) return true;
  const benchmark = recordBenchmark(record);
  return benchmark !== '' && benchmarksFor(data, jobId).ids.includes(benchmark);
}

function exactModels(record: EvidenceRecord) {
  return record.keys
    .map(([key]) => key)
    .filter((key) => key.startsWith('model|'))
    .map((key) => key.slice(6));
}

// The filter bar applied to one measured record. A band about one model
// passes `anyModel`, since it names its own model.
export function measuredPasses(
  data: BriefData,
  record: EvidenceRecord,
  jobId: string | null,
  filters: BriefFilters,
  anyModel = false,
) {
  if (!filters.classes.includes('measured')) return false;
  if (!recordInJob(data, record, jobId)) return false;
  if (filters.since && record.date && record.date < filters.since) return false;
  if (anyModel) return true;
  const ids = exactModels(record);
  if (!ids.some((id) => filters.inScope(id))) return false;
  return (
    !filters.current ||
    ids.some((id) => data.modelById.get(id)?.status === 'current')
  );
}

export function inPool(model: CoreModel, filters: BriefFilters) {
  return (
    (!filters.current || model.status === 'current') &&
    filters.inScope(model.id)
  );
}

// ---- Reported evidence -------------------------------------------------------

export function crowdTally(
  data: BriefData,
  key: string,
  jobId: string | null,
  since: string,
): Tally {
  const tally: Tally = [0, 0, 0, 0];
  const byJob = data.core.crowd.counts[key];
  if (!byJob) return tally;
  const from = monthStart(since).slice(0, 7);
  for (const job of jobSet(data, jobId))
    for (const [month, counts] of Object.entries(byJob[job] ?? {}))
      if (month >= from)
        for (const i of [0, 1, 2, 3] as const) tally[i] += counts[i];
  return tally;
}

export const tallyTotal = (tally: Tally) =>
  tally[0] + tally[1] + tally[2] + tally[3];

// Positive share of clearly positive or critical labels; null below the minimum.
export function positiveShare(tally: Tally) {
  const clear = tally[0] + tally[1];
  return clear >= minimums.clearLabels ? tally[0] / clear : null;
}

export function preferencesFor(
  data: BriefData,
  key: string,
  jobId: string | null,
  since: string,
): Preference[] {
  const jobs = jobSet(data, jobId);
  const from = monthStart(since);
  return data.core.preferences.filter(
    (preference) =>
      (preference.winner === key || preference.loser === key) &&
      jobs.has(preference.job) &&
      (!from || preference.date >= from),
  );
}

// Theme tallies toward one target, most labels first. A theme belongs to one
// label, so a comment counts toward the themes of each target it names.
export function themeTallies(
  data: BriefData,
  key: string,
  jobId: string | null,
  since: string,
) {
  const byTheme = new Map<HnTheme, Tally>();
  const byJob = data.core.crowd.themes[key];
  if (!byJob) return [];
  const from = monthStart(since).slice(0, 7);
  for (const job of jobSet(data, jobId))
    for (const [month, themes] of Object.entries(byJob[job] ?? {}))
      if (month >= from)
        for (const theme of hnThemeSchema.options) {
          const counts = themes[theme];
          if (!counts) continue;
          const tally = byTheme.get(theme) ?? [0, 0, 0, 0];
          for (const i of [0, 1, 2, 3] as const) tally[i] += counts[i];
          byTheme.set(theme, tally);
        }
  return [...byTheme]
    .map(([theme, tally]) => ({ theme, tally }))
    .sort((a, b) => tallyTotal(b.tally) - tallyTotal(a.tally));
}

// The comments behind a crowd count: item ids of the job and its sub-jobs, or
// null for all jobs, which is every comment.
export function crowdCommentIds(
  data: BriefData,
  jobId: string | null,
): ReadonlySet<number> | null {
  if (jobId === null) return null;
  const ids = new Set<number>();
  for (const job of jobSet(data, jobId))
    for (const id of data.core.crowd.comments[job] ?? []) ids.add(id);
  return ids;
}

// ---- Signals -------------------------------------------------------------------

export type Signal =
  | { kind: 'benchmark'; benchmark: Benchmark }
  | { kind: 'preferences' }
  | { kind: 'crowd' };
export type SignalValue = {
  n: number;
  text: string;
  config: string;
  cost: number | null;
  range: [number, number] | null;
  // The records behind the value: every result on the benchmark, or the
  // stated preferences.
  records: EvidenceRecord[];
  preferences: Preference[];
  tally: Tally | null;
};

export function signalLabel(signal: Signal) {
  if (signal.kind === 'benchmark') return signal.benchmark.name;
  return signal.kind === 'preferences'
    ? 'HN stated preferences'
    : 'HN positive share';
}

// The scale a column of the table holds; one column holds one signal.
export function signalScale(signal: Signal): Scale | 'share' {
  return signal.kind === 'benchmark' ? signal.benchmark.scale : 'share';
}

export function benchmarkValue(
  data: BriefData,
  modelId: string,
  benchmark: Benchmark,
): SignalValue | null {
  const records = (data.measuredByModel.get(modelId) ?? []).filter(
    (record) => recordBenchmark(record) === benchmark.id,
  );
  let best: EvidenceRecord | null = null;
  let bestScore = -Infinity;
  for (const record of records) {
    const score = recordScore(record);
    if (score !== null && score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  if (!best) return null;
  return {
    n: bestScore,
    text: scoreText(bestScore, benchmark),
    config: recordConfig(best),
    cost: recordCost(best),
    range: parseInterval(bestScore, recordInterval(best)),
    records: [best, ...records.filter((record) => record !== best)],
    preferences: [],
    tally: null,
  };
}

function preferenceValue(
  data: BriefData,
  modelId: string,
  jobId: string,
  since: string,
): SignalValue | null {
  const key = modelKey(modelId);
  const preferences = preferencesFor(data, key, jobId, since);
  if (preferences.length < minimums.preferences) return null;
  const wins = preferences.filter((preference) => preference.winner === key);
  return {
    n: wins.length / preferences.length,
    text: `preferred in ${wins.length} of ${preferences.length}`,
    config: '',
    cost: null,
    range: null,
    records: [],
    preferences,
    tally: null,
  };
}

function crowdValue(
  data: BriefData,
  modelId: string,
  jobId: string,
  since: string,
): SignalValue | null {
  const tally = crowdTally(data, modelKey(modelId), jobId, since);
  const share = positiveShare(tally);
  if (share === null) return null;
  return {
    n: share,
    text: `${Math.round(share * 100)}% of ${tally[0] + tally[1]}`,
    config: '',
    cost: null,
    range: null,
    records: [],
    preferences: [],
    tally,
  };
}

const benchmarkSignals = (data: BriefData, ids: readonly string[]) =>
  ids.flatMap((id): Signal[] => {
    const benchmark = data.benchmarkById.get(id);
    return benchmark ? [{ kind: 'benchmark', benchmark }] : [];
  });

export function signalsFor(data: BriefData, jobId: string): Signal[] {
  return [
    ...benchmarkSignals(data, benchmarksFor(data, jobId).ids),
    { kind: 'preferences' },
    { kind: 'crowd' },
  ];
}

export function signalValue(
  data: BriefData,
  signal: Signal,
  modelId: string,
  jobId: string,
  since: string,
) {
  if (signal.kind === 'benchmark')
    return benchmarkValue(data, modelId, signal.benchmark);
  return signal.kind === 'preferences'
    ? preferenceValue(data, modelId, jobId, since)
    : crowdValue(data, modelId, jobId, since);
}

// ---- What sets the order --------------------------------------------------------

export type OrderBasis =
  | {
      kind: 'benchmark';
      signal: number;
      // job: the job's own benchmark covers three models; general: the
      // general index replaced it; few: the best covers fewer than three.
      why: 'job' | 'general' | 'few';
      covered: number;
    }
  | { kind: 'reported'; signal: number }
  | { kind: 'none' };

// `covered[i]` is the number of models in the filters with a value for
// signals[i]. A job's own benchmark with the most models sets the order, the
// first listed on a tie. The general index replaces it only when no
// job-specific benchmark covers three models. Without any benchmark result:
// stated preferences when three models have enough, then positive share.
export function chooseOrder(
  signals: readonly Signal[],
  covered: readonly number[],
): OrderBasis {
  const most = (wanted: (signal: Signal) => boolean) => {
    let best = -1;
    signals.forEach((signal, i) => {
      if (
        wanted(signal) &&
        (best < 0 || (covered[i] ?? 0) > (covered[best] ?? 0))
      )
        best = i;
    });
    return best;
  };
  const own = most(
    (signal) => signal.kind === 'benchmark' && !signal.benchmark.general,
  );
  const general = most(
    (signal) => signal.kind === 'benchmark' && signal.benchmark.general,
  );
  const count = (i: number) => (i < 0 ? 0 : (covered[i] ?? 0));
  if (count(own) >= minimums.models)
    return { kind: 'benchmark', signal: own, why: 'job', covered: count(own) };
  if (count(general) >= minimums.models)
    return {
      kind: 'benchmark',
      signal: general,
      why: 'general',
      covered: count(general),
    };
  if (count(own) > 0 || count(general) > 0) {
    const signal = count(own) >= count(general) ? own : general;
    return { kind: 'benchmark', signal, why: 'few', covered: count(signal) };
  }
  const preferences = signals.findIndex(
    (signal) => signal.kind === 'preferences',
  );
  const crowd = signals.findIndex((signal) => signal.kind === 'crowd');
  if (count(preferences) >= minimums.models)
    return { kind: 'reported', signal: preferences };
  if (count(crowd) > 0) return { kind: 'reported', signal: crowd };
  if (count(preferences) > 0) return { kind: 'reported', signal: preferences };
  return { kind: 'none' };
}

// ---- The brief -------------------------------------------------------------------

export type BriefRow = {
  model: CoreModel;
  values: (SignalValue | null)[];
  // Overall ranks among every model with a value, never renumbered inside a
  // filter; equal values share a rank.
  ranks: (number | null)[];
  // The interval overlaps the highest result (true for the highest itself).
  overlap: boolean;
  // Cost per task on the ordering benchmark where it reports one, else the
  // output price per million tokens.
  cost: number | null;
  // Share of stated preferences on the job over all dates, used inside
  // overlapping intervals.
  preference: number | null;
};
export type Brief = {
  job: CoreJob;
  signals: Signal[];
  // Models with a value for each signal: in the filters, and overall.
  covered: number[];
  field: number[];
  basis: OrderBasis;
  // The signal that sets the order, or null when nothing does.
  primary: Signal | null;
  rows: BriefRow[];
  lead: BriefRow | null;
  first: BriefRow | null;
  second: BriefRow | null;
  lower: BriefRow | null;
  usesCost: boolean;
  rating: boolean;
  within: WithinOverlap;
  // Models in the filters left out for want of a value.
  left: number;
  pool: number;
  hasBenchmarks: boolean;
  from: string | null;
  // A sub-job whose own benchmarks cover fewer than three models within the
  // filters is ordered by its parent's; its own stay in the table.
  borrowed: Borrowed | null;
};
export type Borrowed = {
  parent: CoreJob;
  own: Benchmark[];
  // The most models one of its own benchmarks covers within the filters.
  covered: number;
};

function competitionRanks(values: readonly (SignalValue | null)[]) {
  const scores = values.flatMap((value) => (value ? [value.n] : []));
  return values.map((value) =>
    value ? 1 + scores.filter((score) => score > value.n).length : null,
  );
}

function evaluate(
  data: BriefData,
  job: CoreJob,
  filters: BriefFilters,
  signals: Signal[],
) {
  const all = data.models.map((model, index) => ({
    model,
    index,
    values: signals.map((signal) =>
      signalValue(data, signal, model.id, job.id, filters.since),
    ),
  }));
  const pool = all.filter((entry) => inPool(entry.model, filters));
  const covered = signals.map(
    (_, i) => pool.filter((entry) => entry.values[i]).length,
  );
  return { signals, all, pool, covered, basis: chooseOrder(signals, covered) };
}

// A sub-job whose own benchmarks cover fewer than three models within the
// filters takes its parent's benchmarks as further columns, and the order
// comes from those when one covers three; otherwise its own still orders.
function borrowParent(
  data: BriefData,
  job: CoreJob,
  filters: BriefFilters,
  own: ReturnType<typeof evaluate>,
) {
  const { ids, from } = benchmarksFor(data, job.id);
  const parent =
    job.parent === undefined ? undefined : data.jobById.get(job.parent);
  if (!parent || from !== null || ids.length === 0) return null;
  const ownCovered = Math.max(
    0,
    ...own.signals.map((signal, i) =>
      signal.kind === 'benchmark' && !signal.benchmark.general
        ? (own.covered[i] ?? 0)
        : 0,
    ),
  );
  if (ownCovered >= minimums.models) return null;
  const added = benchmarksFor(data, parent.id).ids.filter(
    (id) => !ids.includes(id),
  );
  const signals = [
    ...benchmarkSignals(data, [...ids, ...added]),
    { kind: 'preferences' } satisfies Signal,
    { kind: 'crowd' } satisfies Signal,
  ];
  const combined = evaluate(data, job, filters, signals);
  // Only the parent's benchmarks may set the order.
  const basis = chooseOrder(
    signals,
    combined.covered.map((count, i) => {
      const signal = signals[i];
      return signal?.kind === 'benchmark' && added.includes(signal.benchmark.id)
        ? count
        : 0;
    }),
  );
  if (basis.kind !== 'benchmark' || basis.covered < minimums.models)
    return null;
  return {
    evaluated: { ...combined, basis },
    borrowed: {
      parent,
      own: ids.flatMap((id) => data.benchmarkById.get(id) ?? []),
      covered: ownCovered,
    },
  };
}

export function computeBrief(
  data: BriefData,
  job: CoreJob,
  filters: BriefFilters,
  within: WithinOverlap = 'preferences',
): Brief {
  const own = evaluate(data, job, filters, signalsFor(data, job.id));
  const fallback = borrowParent(data, job, filters, own);
  const { signals, all, pool, covered, basis } = fallback?.evaluated ?? own;
  const ranks = signals.map((_, i) =>
    competitionRanks(all.map((entry) => entry.values[i] ?? null)),
  );
  const field = signals.map(
    (_, i) => all.filter((entry) => entry.values[i]).length,
  );
  const { ids, from } = benchmarksFor(data, job.id);
  const base = {
    job,
    signals,
    covered,
    field,
    basis,
    within,
    pool: pool.length,
    hasBenchmarks: ids.length > 0,
    from,
    borrowed: fallback?.borrowed ?? null,
  };
  if (basis.kind === 'none')
    return {
      ...base,
      primary: null,
      rows: [],
      lead: null,
      first: null,
      second: null,
      lower: null,
      usesCost: false,
      rating: false,
      left: pool.length,
    };
  const index = basis.signal;
  const primary = signals[index] ?? null;
  const measured = basis.kind === 'benchmark';
  const rating =
    primary?.kind === 'benchmark' && primary.benchmark.scale === 'rating';
  const ranked = pool
    .flatMap((entry) => {
      const value = entry.values[index];
      return value ? [{ ...entry, value }] : [];
    })
    .sort((a, b) => b.value.n - a.value.n);
  const usesCost =
    measured && ranked.some((entry) => entry.value.cost !== null);
  const top = ranked[0];
  const rows: (BriefRow & { n: number })[] = ranked.map((entry) => {
    const range = entry.value.range;
    const topRange = top?.value.range ?? null;
    const preferences = measured
      ? preferencesFor(data, modelKey(entry.model.id), job.id, '')
      : [];
    const wins = preferences.filter(
      (preference) => preference.winner === modelKey(entry.model.id),
    ).length;
    return {
      model: entry.model,
      values: entry.values,
      ranks: ranks.map((column) => column[entry.index] ?? null),
      overlap:
        entry === top ||
        (measured &&
          range !== null &&
          topRange !== null &&
          range[1] >= topRange[0]),
      cost: usesCost ? entry.value.cost : entry.model.output,
      preference:
        preferences.length >= minimums.preferences
          ? wins / preferences.length
          : null,
      n: entry.value.n,
    };
  });
  const overlapping = rows.filter((row) => row.overlap);
  if (within === 'cost')
    overlapping.sort((a, b) => {
      const ca = a.cost ?? Infinity;
      const cb = b.cost ?? Infinity;
      return ca === cb ? b.n - a.n : ca - cb;
    });
  else
    overlapping.sort(
      (a, b) => (b.preference ?? 0.5) - (a.preference ?? 0.5) || b.n - a.n,
    );
  const ordered = [...overlapping, ...rows.filter((row) => !row.overlap)];
  const lead = rows[0] ?? null;
  const first = ordered[0] ?? null;
  const firstCost = first?.cost ?? null;
  let lower: (BriefRow & { n: number }) | null = null;
  if (first && lead && firstCost !== null)
    for (const row of ordered) {
      const close = rating ? row.overlap : row.n >= lead.n * lowerCostResult;
      if (
        row !== first &&
        row.cost !== null &&
        row.cost <= firstCost * lowerCostPrice &&
        close &&
        (lower === null || (lower.cost !== null && row.cost < lower.cost))
      )
        lower = row;
    }
  const second = ordered.find((row) => row !== first && row !== lower) ?? null;
  return {
    ...base,
    primary,
    rows: ordered,
    lead,
    first,
    second,
    lower,
    usesCost,
    rating,
    left: pool.length - rows.length,
  };
}

// What the note above the cards says besides naming the benchmark.
export function orderExplanation(data: BriefData, brief: Brief) {
  const job = brief.job.label.toLowerCase();
  const borrowed = brief.borrowed;
  if (borrowed) {
    const names = borrowed.own.map((entry) => entry.name).join(', ');
    return `${names}, the benchmark of ${job} itself, has results for only ${plural(borrowed.covered, 'model')} within the filters, so the order comes from the benchmark of ${borrowed.parent.label.toLowerCase()}. ${names} stays in the table and in the Measured band.`;
  }
  const parent = brief.from ? data.jobById.get(brief.from) : undefined;
  const parentText = parent
    ? `No benchmark measures ${job} itself; this is the benchmark of ${parent.label.toLowerCase()} with the most models in the filters.`
    : '';
  const basis = brief.basis;
  if (basis.kind === 'benchmark') {
    if (basis.why === 'general')
      return `No benchmark of ${job} itself has results for three models within the filters, so the general index sets the order.`;
    if (basis.why === 'few')
      return [
        `It has results for only ${plural(basis.covered, 'model')} within the filters.`,
        parentText,
      ]
        .filter(Boolean)
        .join(' ');
    return parentText;
  }
  const none = brief.hasBenchmarks
    ? 'No benchmark of this job has a result for a model within the filters.'
    : 'No benchmark in the data measures this job.';
  if (basis.kind === 'none') return none;
  const source =
    brief.signals[basis.signal]?.kind === 'preferences'
      ? 'stated preferences'
      : 'positive share';
  return `${none} The order below comes from Hacker News ${source}, which is reported evidence and not a measurement.`;
}

// The line under the table: the order, the minimums and what never changes it.
export function orderRules(brief: Brief) {
  const label = brief.primary ? signalLabel(brief.primary) : '';
  const cost =
    brief.usesCost && brief.primary?.kind === 'benchmark'
      ? `cost ${costUnit(brief.primary.benchmark.id)}`
      : 'output price';
  const parts = [`Order: ${label}.`];
  if (brief.basis.kind === 'benchmark')
    parts.push(
      `Models whose published interval overlaps the highest result come first, ordered by ${brief.within === 'cost' ? cost : 'stated preferences on this job over all dates'}.`,
    );
  parts.push(
    brief.rating
      ? 'Lower cost is the cheapest model whose interval overlaps the highest result, at most half the first choice’s cost. An arena rating compares models on its own leaderboard only.'
      : 'Lower cost is the cheapest model at 85% or more of the highest result and at most half the first choice’s cost.',
    `Reported signals need a minimum: ${minimums.preferences} stated preferences, ${minimums.clearLabels} clear Hacker News labels. Hacker News labels are automatic and count exact model names only.`,
    'The period filter does not change the order when a benchmark sets it. Practitioner records and OpenRouter usage never change it.',
    `${plural(brief.left, 'model')} in the filters without a ${label} result left out.`,
  );
  return parts.join(' ');
}

export function lowerCostMissing(brief: Brief) {
  if (brief.first && brief.first.cost === null)
    return 'The first choice has no published cost to compare with.';
  return brief.rating
    ? 'No model whose interval overlaps the highest result for half the cost or less.'
    : 'No model at 85% or more of the highest result for half the cost or less.';
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
}

// ---- Job chooser, bands and usage -----------------------------------------------

export function chooserRows(data: BriefData, filters: BriefFilters) {
  return data.jobs.map((job) => {
    const { ids, from } = benchmarksFor(data, job.id);
    return {
      job,
      measured: data.measured.filter((record) =>
        measuredPasses(data, record, job.id, filters),
      ),
      benchmarks: ids.flatMap((id) => data.benchmarkById.get(id) ?? []),
      from: from ? (data.jobById.get(from) ?? null) : null,
    };
  });
}

export function measuredBand(
  data: BriefData,
  modelId: string,
  jobId: string | null,
  filters: BriefFilters,
) {
  const records = (data.measuredByModel.get(modelId) ?? []).filter((record) =>
    measuredPasses(data, record, jobId, filters, true),
  );
  const results = records
    .filter((record) => recordBenchmark(record) !== '')
    .sort(
      (a, b) =>
        recordBenchmark(a).localeCompare(recordBenchmark(b)) ||
        (recordScore(b) ?? 0) - (recordScore(a) ?? 0),
    );
  return {
    results,
    reports: records.filter((record) => record.src === 'report'),
  };
}

// The Crowd band for a model (`model|<id>`) or a product line
// (`line|<name>`). A model's band lists the labels that name only one of its
// lines apart; they are never added to the model's own counts.
export function crowdBand(
  data: BriefData,
  key: string,
  jobId: string | null,
  since: string,
) {
  const preferences = preferencesFor(data, key, jobId, since);
  const modelId = key.startsWith('model|') ? key.slice(6) : null;
  return {
    key,
    tally: crowdTally(data, key, jobId, since),
    preferences,
    wins: preferences.filter((preference) => preference.winner === key),
    lines: data.core.lines
      .filter((line) => modelId !== null && line.models.includes(modelId))
      .map((line) => ({
        name: line.name,
        key: lineKey(line.name),
        tally: crowdTally(data, lineKey(line.name), jobId, since),
      }))
      .filter((line) => tallyTotal(line.tally) > 0),
  };
}

export function usageForJob(data: BriefData, usage: CoreUsage, jobId: string) {
  const jobs = jobSet(data, jobId);
  return usage.tasks.tags.filter((tag) => tag.job !== '' && jobs.has(tag.job));
}

type GuideLike = {
  choices: readonly {
    id: string;
    name: string;
    surface: string;
    setting: string;
    modelId?: string;
  }[];
  tasks: readonly {
    id: string;
    label: string;
    default: { choiceId: string };
    codingDefault?: { choiceId: string };
    alternatives: readonly { choiceId: string }[];
  }[];
};

// The App guide's selections of one model for the job's guide task.
export function guideSelections(
  guide: GuideLike,
  taskId: string | undefined,
  modelId: string,
) {
  const task = guide.tasks.find((entry) => entry.id === taskId);
  if (!task) return { task: null, lines: [] };
  const options = [
    task.default,
    ...(task.codingDefault ? [task.codingDefault] : []),
    ...task.alternatives,
  ];
  const lines = options.flatMap((option) => {
    const choice = guide.choices.find((entry) => entry.id === option.choiceId);
    return choice?.modelId === modelId
      ? [`${choice.surface}: ${choice.name} · ${choice.setting}`]
      : [];
  });
  return { task, lines: [...new Set(lines)] };
}
