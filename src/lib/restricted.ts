import { z } from 'zod';
import rawRestricted from './restricted-benchmarks.json' with { type: 'json' };
import { resultSchema } from './schema.ts';
import type { BenchmarkResult } from './schema.ts';

const restrictedListSchema = z.object({
  checkedAt: z.iso.date(),
  benchmarks: z
    .array(
      z.object({
        id: z.string().min(1),
        termsUrl: z.url(),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});
export const restrictedList = restrictedListSchema.parse(rawRestricted);
export type RestrictedBenchmark = (typeof restrictedList.benchmarks)[number];
export const restrictedById = new Map(
  restrictedList.benchmarks.map((benchmark) => [benchmark.id, benchmark]),
);

// Result IDs are `<benchmark id>:<n>`, so guide references to results that
// are not in the public bundle can still be recognised.
export function restrictedResultId(id: string) {
  const mark = id.lastIndexOf(':');
  return mark > 0 && restrictedById.has(id.slice(0, mark));
}

export const restrictedResponseSchema = z.object({
  results: z.array(resultSchema),
});

/** Checks that a restricted payload only adds results for known records. */
export function validRestrictedResults(
  payload: unknown,
  known: {
    modelIds: ReadonlySet<string>;
    benchmarkIds: ReadonlySet<string>;
    resultIds: ReadonlySet<string>;
  },
): BenchmarkResult[] | null {
  const parsed = restrictedResponseSchema.safeParse(payload);
  if (!parsed.success) return null;
  const ids = new Set<string>();
  for (const result of parsed.data.results) {
    if (
      !restrictedById.has(result.benchmarkId) ||
      !known.modelIds.has(result.modelId) ||
      !known.benchmarkIds.has(result.benchmarkId) ||
      known.resultIds.has(result.id) ||
      ids.has(result.id)
    )
      return null;
    ids.add(result.id);
  }
  return parsed.data.results;
}
