import { z } from 'zod';

const text = z.string().min(1);
const amount = z.number().finite().nonnegative();
export const categorySchema = z.enum([
  'general',
  'coding',
  'design',
  'research',
  'reasoning',
  'writing',
  'agents',
]);
const rates = {
  input: amount,
  output: amount,
  cachedInput: amount.optional(),
};
const pricingSchema = z.object({
  ...rates,
  url: z.httpUrl(),
  modelUrl: z.httpUrl(),
  notes: text,
  contextTokens: z.number().int().positive().optional(),
  contextType: z.enum(['input', 'unified']).default('unified'),
  offPeak: z.object(rates).optional(),
  longContext: z
    .object({
      ...rates,
      thresholdTokens: z.number().int().positive(),
      inclusive: z.boolean(),
    })
    .optional(),
  nextPricing: z.object({ ...rates, effectiveFrom: z.iso.date() }).optional(),
});
export const modelSchema = z.object({
  id: text,
  name: text,
  provider: text,
  apiId: text.optional(),
  version: text.optional(),
  status: text.optional(),
  description: text.optional(),
  pricing: pricingSchema.optional(),
});
export const benchmarkSchema = z.object({
  id: text,
  name: text,
  source: text,
  category: categorySchema,
  unit: text,
  description: text,
  methodology: text,
  url: z.httpUrl(),
  costMethod: text.optional(),
  timeMethod: text.optional(),
  updatedAt: text.optional(),
  shortName: text.optional(),
});
export const resultSchema = z.object({
  id: text,
  modelId: text,
  benchmarkId: text,
  score: z.number().finite(),
  configuration: text,
  details: z.string(),
  sourceUrl: z.httpUrl(),
  runDate: z.string().optional(),
  costUsd: amount.optional(),
  timeSeconds: amount.optional(),
  interval: text.optional(),
  totalCostUsd: amount.optional(),
  trials: z.number().int().positive().optional(),
});
export const reportSchema = z.object({
  id: text,
  title: text,
  sourceName: text,
  url: z.httpUrl(),
  category: categorySchema,
  evidenceType: text,
  modelIds: z.array(text),
  modelNames: z.array(text),
  summary: text,
  limitation: text,
  publishedAt: z.string().optional(),
  configuration: text.optional(),
  costType: text.optional(),
  costUsd: amount.optional(),
  costContext: text.optional(),
  metrics: z
    .array(
      z.object({
        label: text,
        value: z.union([z.number().finite(), z.string()]),
        unit: z.string(),
      }),
    )
    .optional(),
});
export const sourceSchema = z.object({
  id: text,
  name: text,
  url: z.httpUrl(),
  kind: text,
  coverage: text,
  access: text,
  limitations: text,
});
export const snapshotSchema = z
  .object({
    checkedAt: z.iso.date(),
    models: z.array(modelSchema).min(1),
    benchmarks: z.array(benchmarkSchema).min(1),
    results: z.array(resultSchema).min(1),
    reports: z.array(reportSchema),
    sources: z.array(sourceSchema).min(1),
  })
  .superRefine((snapshot, ctx) => {
    for (const key of [
      'models',
      'benchmarks',
      'results',
      'reports',
      'sources',
    ]) {
      const records =
        key === 'models'
          ? snapshot.models
          : key === 'benchmarks'
            ? snapshot.benchmarks
            : key === 'results'
              ? snapshot.results
              : key === 'reports'
                ? snapshot.reports
                : snapshot.sources;
      if (new Set(records.map((record) => record.id)).size !== records.length)
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate identifiers in ${key}`,
        });
    }
    const modelIds = new Set(snapshot.models.map((model) => model.id));
    const benchmarkIds = new Set(
      snapshot.benchmarks.map((benchmark) => benchmark.id),
    );
    for (const result of snapshot.results) {
      if (
        !modelIds.has(result.modelId) ||
        !benchmarkIds.has(result.benchmarkId)
      )
        ctx.addIssue({
          code: 'custom',
          message: `Broken reference in ${result.id}`,
        });
      const benchmark = snapshot.benchmarks.find(
        (item) => item.id === result.benchmarkId,
      );
      if (result.costUsd !== undefined && !benchmark?.costMethod)
        ctx.addIssue({
          code: 'custom',
          message: `Missing cost methodology for ${result.id}`,
        });
      if (result.timeSeconds !== undefined && !benchmark?.timeMethod)
        ctx.addIssue({
          code: 'custom',
          message: `Missing time methodology for ${result.id}`,
        });
    }
    for (const report of snapshot.reports) {
      if (report.modelIds.some((id) => !modelIds.has(id)))
        ctx.addIssue({
          code: 'custom',
          message: `Broken model reference in ${report.id}`,
        });
      if (report.costUsd !== undefined && !report.costContext)
        ctx.addIssue({
          code: 'custom',
          message: `Missing cost context in ${report.id}`,
        });
    }
  });

export type ModelRecord = z.infer<typeof modelSchema>;
export type Benchmark = z.infer<typeof benchmarkSchema>;
export type BenchmarkResult = z.infer<typeof resultSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
