import rawSnapshot from './snapshot.json';
import { attributionCheckedAt, attributions } from './attribution';
import { restrictedById, validRestrictedResults } from './restricted';
import { snapshotSchema } from './schema';
import type { ModelRecord } from './schema';

export type { Benchmark, BenchmarkResult, Category, Report } from './schema';
export const snapshot = snapshotSchema.parse(rawSnapshot);
export const { checkedAt, benchmarks, results, reports, sources } = snapshot;
export type Model = ModelRecord;
export const models: Model[] = snapshot.models;

// The published build leaves out results whose source terms do not allow
// republishing; approved accounts load them before the app renders.
export const restrictedRemote = import.meta.env?.VITE_RESTRICTED === 'remote';
let restrictedLoaded = results.some((result) =>
  restrictedById.has(result.benchmarkId),
);

export function restrictedHidden(benchmarkId: string) {
  return !restrictedLoaded && restrictedById.has(benchmarkId);
}

/** Adds the restricted results once; returns false for an invalid payload. */
export function addRestrictedResults(payload: unknown) {
  if (restrictedLoaded) return true;
  const added = validRestrictedResults(payload, {
    modelIds: new Set(models.map((model) => model.id)),
    benchmarkIds: new Set(benchmarks.map((benchmark) => benchmark.id)),
    resultIds: new Set(results.map((result) => result.id)),
  });
  if (!added) return false;
  results.push(...added);
  restrictedLoaded = true;
  return true;
}

export function downloadSnapshot() {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            ...snapshot,
            // Restricted results are for viewing only and are never exported.
            results: results.filter(
              (result) => !restrictedById.has(result.benchmarkId),
            ),
            attribution: { checkedAt: attributionCheckedAt, attributions },
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `model-reference-${checkedAt}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
