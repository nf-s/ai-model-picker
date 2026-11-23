import { useCallback, useEffect, useState } from 'react';
import { benchmarks, models, results } from './data';
import type { Benchmark, BenchmarkResult, Model } from './data';
import { guide } from './guide';
import { loadHnIndex } from './hn-index';
import {
  cleanFilterBar,
  readStoredFilter,
  scopeIndex,
  writeStoredFilter,
} from './model-filter';
import type { FilterBar, Scope } from './model-filter';
import {
  buildInsights,
  indexComments,
  parseTargetKey,
  relatedNames,
  targetKey,
} from './hn-insights';
import { positiveShare, sumWeeks } from './hn-insights';
import type { CommentIndex, HnInsights, TargetInsight } from './hn-insights';

// Each model's best published result per benchmark, ranked within the field.
export type Standing = {
  result: BenchmarkResult;
  rank: number;
  fieldSize: number;
  // 0 at the lowest best score in the field, 1 at the highest.
  position: number;
  configurations: number;
};

const shortBenchmarkNames: Record<string, string> = {
  'epoch-eci': 'Epoch ECI',
  'terminal-bench-4-1': 'Terminal-Bench',
  'swe-rebench-2026-05-15-2026-07-01': 'SWE-rebench',
  'plato-web-clone-bench': 'Web Clone',
};

export const modelById = new Map(models.map((model) => [model.id, model]));
export const benchmarkById = new Map(
  benchmarks.map((benchmark) => [benchmark.id, benchmark]),
);

export function benchmarkLabel(benchmark: Benchmark) {
  return (
    benchmark.shortName ?? shortBenchmarkNames[benchmark.id] ?? benchmark.name
  );
}

export const standings = new Map<string, Map<string, Standing>>(
  benchmarks.map((benchmark) => {
    const best = new Map<string, { result: BenchmarkResult; count: number }>();
    for (const result of results) {
      if (result.benchmarkId !== benchmark.id) continue;
      const found = best.get(result.modelId);
      if (!found) best.set(result.modelId, { result, count: 1 });
      else {
        found.count += 1;
        if (result.score > found.result.score) found.result = result;
      }
    }
    const ordered = [...best.values()].sort(
      (a, b) => b.result.score - a.result.score,
    );
    const top = ordered[0]?.result.score ?? 0;
    const bottom = ordered.at(-1)?.result.score ?? 0;
    const spread = top - bottom;
    return [
      benchmark.id,
      new Map(
        ordered.map(({ result, count }) => [
          result.modelId,
          {
            result,
            // Tied scores share a rank.
            rank:
              ordered.findIndex(
                (entry) => entry.result.score === result.score,
              ) + 1,
            fieldSize: ordered.length,
            position: spread > 0 ? (result.score - bottom) / spread : 1,
            configurations: count,
          },
        ]),
      ),
    ];
  }),
);

export function standing(modelId: string, benchmarkId: string) {
  return standings.get(benchmarkId)?.get(modelId);
}

export function formatScore(score: number, benchmark: Benchmark) {
  const percent = benchmark.unit.includes('%');
  const whole = /elo|rating/i.test(benchmark.unit);
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: whole ? 0 : 1,
    maximumFractionDigits: whole ? 0 : 1,
  }).format(score);
  return percent ? `${text}%` : text;
}

export function formatPrice(model: Model) {
  const pricing = model.pricing;
  if (!pricing) return null;
  const money = (value: number) =>
    `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${money(pricing.input)} / ${money(pricing.output)}`;
}

export function percent(share: number) {
  return `${Math.round(share * 100)}%`;
}

export function keyName(key: string) {
  const ref = parseTargetKey(key);
  if (!ref) return key;
  return ref.kind === 'model'
    ? (modelById.get(ref.target)?.name ?? ref.target)
    : ref.target;
}

export function keysRelated(first: string, second: string) {
  return relatedNames(keyName(first), keyName(second));
}

export function modelKey(modelId: string) {
  return targetKey({ kind: 'model', target: modelId });
}

// Where a model can be selected in the ChatGPT and Claude apps.
export function appSelections(modelId: string) {
  const seen = new Set<string>();
  return guide.choices.filter((choice) => {
    const label = `${choice.surface}/${choice.name}`;
    if (choice.modelId !== modelId || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

export type HnData =
  // Not requested: the comment index loads only when a view lists comments.
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'ready';
      index: CommentIndex;
      insights: HnInsights;
      startAt: string | null;
      endAt: string | null;
    };

type ReadyHnData = Extract<HnData, { status: 'ready' }>;
let shared: Promise<ReadyHnData> | null = null;

function loadHnData() {
  shared ??= loadHnIndex()
    .then((raw): ReadyHnData => {
      const index = indexComments(raw.comments, raw.stories);
      return {
        status: 'ready',
        index,
        insights: buildInsights(index, keysRelated),
        startAt: raw.startAt,
        endAt: raw.endAt,
      };
    })
    .catch((error: unknown) => {
      shared = null;
      throw error;
    });
  return shared;
}

// The comment index for views that list comments. In the published build it
// is every comment part, so other views pass `enabled` false and render their
// counts from core.json.
export function useHnData(enabled = true): HnData {
  const [data, setData] = useState<HnData>({
    status: enabled ? 'loading' : 'idle',
  });
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    setData((previous) =>
      previous.status === 'idle' ? { status: 'loading' } : previous,
    );
    loadHnData().then(
      (ready) => {
        if (current) setData(ready);
      },
      () => {
        if (current) setData({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled]);
  return data;
}

// Comment data limited to the labels the model filter covers.
export function scopeHnData(data: HnData, scope: Scope): HnData {
  if (data.status !== 'ready' || !scope.active) return data;
  const index = scopeIndex(data.index, scope.key);
  return { ...data, index, insights: buildInsights(index, keysRelated) };
}

export function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// The site-wide filter bar, remembered in this browser when storage works.
export function useModelFilter() {
  const [filter, setFilter] = useState(() =>
    readStoredFilter(browserStorage(), models),
  );
  const change = useCallback((next: FilterBar) => {
    const cleaned = cleanFilterBar(next, models);
    setFilter(cleaned);
    writeStoredFilter(browserStorage(), cleaned);
  }, []);
  return { filter, setFilter: change };
}

const dayFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export function weekLabel(weekStart: string) {
  return dayFormat.format(new Date(`${weekStart}T00:00:00Z`));
}

// Positive share in the latest `span` weeks against the `span` weeks before.
// Null unless both periods have at least `minimum` clearly positive or
// negative comments.
export function momentum(
  insight: Pick<TargetInsight, 'weeks'>,
  span = 4,
  minimum = 10,
) {
  const last = insight.weeks.length - 1;
  const recent = positiveShare(
    sumWeeks(insight.weeks, last - span + 1, last),
    minimum,
  );
  const earlier = positiveShare(
    sumWeeks(insight.weeks, last - 2 * span + 1, last - span),
    minimum,
  );
  return recent === null || earlier === null
    ? null
    : { recent, earlier, change: recent - earlier };
}
