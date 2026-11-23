import rawSnapshot from './snapshot.json';
import { attributions } from './attribution';
import type { Core } from './core-schema';
import { publicDownload } from './download';
import { validRestrictedPayload } from './restricted';
import type { RestrictedPayload } from './restricted';
import { snapshotSchema } from './schema';
import type { ModelRecord, Snapshot } from './schema';

export type { Benchmark, BenchmarkResult, Category, Report } from './schema';
export const snapshot = snapshotSchema.parse(rawSnapshot);
export const { checkedAt, benchmarks, results, reports, sources } = snapshot;
export type Model = ModelRecord;
export const models: Model[] = snapshot.models;

// Copied before any restricted records are added, so the download stays public.
const publicSnapshot: Snapshot = {
  ...snapshot,
  benchmarks: [...benchmarks],
  results: [...results],
  sources: [...sources],
};

// The published build calls /api/restricted for signed-in accounts; local
// builds read the same payload from .local/restricted/ through the dev server.
export const restrictedRemote = import.meta.env?.VITE_RESTRICTED === 'remote';
export const restrictedEvidence: RestrictedPayload['evidence'] = [];
// The payload's own benchmarks and results, for views that add them to the
// shared records.
export const restrictedData: Pick<
  RestrictedPayload,
  'checkedAt' | 'benchmarks' | 'results'
> = { checkedAt: '', benchmarks: [], results: [] };
export const restrictedAttributions: RestrictedPayload['attributions'] = [];
let restrictedLoaded = false;

/** Adds the restricted records once, before the app renders. */
export function addRestricted(payload: unknown) {
  if (restrictedLoaded) return true;
  const added = validRestrictedPayload(payload, {
    modelIds: new Set(models.map((model) => model.id)),
    benchmarkIds: new Set(benchmarks.map((benchmark) => benchmark.id)),
    resultIds: new Set(results.map((result) => result.id)),
    sourceIds: new Set(sources.map((source) => source.id)),
  });
  if (!added) return false;
  benchmarks.push(...added.benchmarks);
  results.push(...added.results);
  sources.push(...added.sources);
  restrictedEvidence.push(...added.evidence);
  restrictedData.checkedAt = added.checkedAt;
  restrictedData.benchmarks.push(...added.benchmarks);
  restrictedData.results.push(...added.results);
  restrictedAttributions.push(...added.attributions);
  restrictedLoaded = true;
  return true;
}

export function downloadPublicData(core: Core) {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          publicDownload(publicSnapshot, core, attributions),
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
