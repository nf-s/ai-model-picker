import { z } from 'zod';
import { benchmarkSchema, resultSchema, sourceSchema } from './schema.ts';

const text = z.string().min(1);

// Benchmarks whose source terms do not allow republishing reach the browser
// only through this payload, for approved accounts.
export const restrictedPayloadSchema = z.object({
  checkedAt: z.iso.date(),
  benchmarks: z.array(benchmarkSchema),
  results: z.array(resultSchema),
  sources: z.array(sourceSchema),
  evidence: z.array(
    z.object({
      taskId: text,
      kind: z.literal('result'),
      id: text,
      note: text,
    }),
  ),
  attributions: z.array(
    z.object({
      source: text,
      material: text,
      url: z.httpUrl(),
      licence: z.object({ name: text, url: z.httpUrl() }).nullable(),
      credit: text,
      changes: text.nullable(),
      termsUrl: z.httpUrl(),
    }),
  ),
});
export type RestrictedPayload = z.infer<typeof restrictedPayloadSchema>;

/** Accepts a payload only if it adds new records that refer to known ones. */
export function validRestrictedPayload(
  payload: unknown,
  known: {
    modelIds: ReadonlySet<string>;
    benchmarkIds: ReadonlySet<string>;
    resultIds: ReadonlySet<string>;
    sourceIds: ReadonlySet<string>;
  },
): RestrictedPayload | null {
  const parsed = restrictedPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { benchmarks, results, sources, evidence } = parsed.data;
  const benchmarkIds = new Set(benchmarks.map((benchmark) => benchmark.id));
  const resultIds = new Set(results.map((result) => result.id));
  const sourceIds = new Set(sources.map((source) => source.id));
  const fresh = (
    ids: ReadonlySet<string>,
    count: number,
    old: ReadonlySet<string>,
  ) => ids.size === count && [...ids].every((id) => !old.has(id));
  if (
    !fresh(benchmarkIds, benchmarks.length, known.benchmarkIds) ||
    !fresh(resultIds, results.length, known.resultIds) ||
    !fresh(sourceIds, sources.length, known.sourceIds) ||
    results.some(
      (result) =>
        !benchmarkIds.has(result.benchmarkId) ||
        !known.modelIds.has(result.modelId),
    ) ||
    evidence.some((item) => !resultIds.has(item.id))
  )
    return null;
  return parsed.data;
}
