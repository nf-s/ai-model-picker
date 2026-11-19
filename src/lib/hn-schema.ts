import { z } from 'zod';
import rawCheck from '../../research/hn-classifier-check.json' with { type: 'json' };
const count = z.number().int().nonnegative();
const checkFields = {
  checkedAt: z.iso.date(),
  classifierId: z.string().min(1),
  modelName: z.string().min(1),
  modelUrl: z.httpUrl(),
  referenceAssessments: count,
  agrees: count,
  disagrees: count,
  oppositePolarity: count,
  unclear: count,
  targetMissed: count,
  failed: count,
};
// The backend names match the pipeline's --backend option.
export const hnClassifierCheck = z
  .discriminatedUnion('backend', [
    z.object({
      ...checkFields,
      backend: z.literal('local'),
      downloadGigabytes: z.number().positive(),
    }),
    z.object({ ...checkFields, backend: z.literal('anthropic') }),
  ])
  .refine(
    (value) =>
      value.agrees +
        value.disagrees +
        value.unclear +
        value.targetMissed +
        value.failed ===
        value.referenceAssessments && value.oppositePolarity <= value.disagrees,
    'Invalid evaluation counts',
  )
  .parse(rawCheck);
const nullableDate = z.iso.datetime({ offset: true }).nullable();
export const hnSentimentSchema = z.enum([
  'positive',
  'negative',
  'mixed',
  'neutral',
  'unclear',
]);
export const hnConfidenceSchema = z.enum(['high', 'medium', 'low']);
const runState = z.enum([
  'pending',
  'running',
  'paused',
  'blocked',
  'complete',
]);
const counts = z.object({
  positive: count,
  negative: count,
  mixed: count,
  neutral: count,
  unclear: count,
});
const aspects = z.object({
  coding: count,
  reliability: count,
  cost: count,
  speed: count,
  design: count,
  agents: count,
  writing: count,
  research: count,
  reasoning: count,
});
const evidence = z.object({
  itemId: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  sentiment: hnSentimentSchema,
  aspects: z.array(z.string()),
  confidence: hnConfidenceSchema,
});
export const hnStatusSchema = z.object({
  schemaVersion: z.literal(1),
  state: runState,
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
  classifier: z.string(),
  source: z.enum(['archive-and-tail', 'firebase']),
  archiveRevision: z.string().nullable(),
  startAt: nullableDate,
  endAt: nullableDate,
  firstItem: count.nullable(),
  lastItem: count,
  totals: z.object({
    itemsScanned: count,
    commentsScanned: count,
    commentsEligible: count,
    candidates: count,
    classified: count,
    classificationFailures: count,
    classificationUntracked: count.optional(),
    unavailable: count,
    invalid: count,
    failures: count,
    partitionsComplete: count,
    partitionsTotal: count,
    commentsQueued: count.optional(),
    commentsAboutTargets: count.optional(),
    stories: count.optional(),
    storiesPending: count.optional(),
    threadComments: count.optional(),
  }),
  firstCommentAt: nullableDate,
  lastCommentAt: nullableDate,
  partitions: z.array(
    z.object({
      id: z.string(),
      source: z.enum(['archive', 'firebase', 'clickhouse-and-firebase']),
      state: runState,
      itemsScanned: count,
      expectedItems: count,
      firstCommentAt: nullableDate,
      lastCommentAt: nullableDate,
    }),
  ),
  allPublicItemsScanned: z.boolean(),
  archiveIdsReconciled: z.boolean().optional(),
});
export const hnResultsSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.iso.datetime({ offset: true }),
  classifier: z.string(),
  models: z.array(
    z.object({
      modelId: z.string(),
      counts,
      aspects,
      evidence: z.array(evidence),
    }),
  ),
  families: z.array(
    z.object({
      familyName: z.string(),
      counts,
      aspects,
      evidence: z.array(evidence),
    }),
  ),
});
export const hnResponseSchema = z.object({
  status: hnStatusSchema.nullable(),
  results: hnResultsSchema.nullable(),
  runner: z.object({
    active: z.boolean(),
    runtimeReady: z.boolean(),
    installed: z.boolean(),
    message: z.string().nullable(),
    showingPrevious: z.boolean().optional(),
    external: z.boolean().optional(),
  }),
});
export type HnResponse = z.infer<typeof hnResponseSchema>;
export type HnModelFeedback = z.infer<typeof hnResultsSchema>['models'][number];
