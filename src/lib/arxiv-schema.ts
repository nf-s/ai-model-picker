import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();
export const arxivKindSchema = z.enum([
  'usage',
  'evaluation',
  'application',
  'behaviour',
  'release',
  'survey',
  'other',
]);
export const arxivTopicSchema = z.enum([
  'prompting',
  'context',
  'reasoning',
  'agents',
  'tools',
  'retrieval',
  'structured-output',
  'coding',
  'cost',
  'safety',
  'multimodal',
  'fine-tuning',
]);
// What an evaluation paper tested. `domain` is a specialist field such as
// medicine, law or finance; `vision` is understanding images, video or audio;
// `design` is generating images, video or interfaces.
export const arxivAreaSchema = z.enum([
  'coding',
  'agents',
  'reasoning',
  'research',
  'writing',
  'design',
  'vision',
  'domain',
  'safety',
  'other',
]);
const runState = z.enum([
  'pending',
  'running',
  'paused',
  'blocked',
  'complete',
]);
const targetName = z.string().min(1).max(128);
const targetRef = z.strictObject({
  kind: z.enum(['model', 'family']),
  target: targetName,
});
const summary = {
  papers: count,
  months: z.record(z.string().regex(/^\d{4}-\d{2}$/), count),
  kinds: z.record(arxivKindSchema, count),
  topics: z.record(arxivTopicSchema, count),
};
const assessment = z.strictObject({
  kind: arxivKindSchema,
  topics: z.array(arxivTopicSchema).max(arxivTopicSchema.options.length),
  takeaway: z.string().min(1).max(300).nullable(),
});
// Recorded only for papers labelled `evaluation`. `best` and `weak` hold the
// paper's own targets that the abstract explicitly ranks first among the
// models it compares, or ranks last or clearly behind another model. `weak`
// is recorded only beside a non-empty `best`. A target in neither list is
// named without a ranking.
const result = z.strictObject({
  area: arxivAreaSchema,
  task: z.string().min(1).max(120),
  best: z.array(targetRef),
  weak: z.array(targetRef),
  finding: z.string().min(1).max(300).nullable(),
});
export const arxivPaperSchema = z.strictObject({
  id: z.string().regex(/^\d{4}\.\d{4,5}$/),
  title: z.string().min(1),
  submittedAt: timestamp,
  // Primary category first.
  categories: z.array(z.string().min(1)).min(1),
  targets: z.array(targetRef).min(1),
  assessment: assessment.nullable(),
  result: result.nullable(),
});
export const arxivSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  updatedAt: timestamp,
  assessor: z.string().min(1).nullable(),
  startAt: timestamp,
  publishedAt: timestamp.optional(),
  coverage: z.strictObject({
    state: runState,
    firstDay: z.iso.date(),
    lastDay: z.iso.date(),
    daysComplete: count,
    daysTotal: count,
    recordsScanned: count,
    recordsEligible: count,
    papers: count,
    assessed: count,
    assessmentFailures: count,
    results: count,
    resultFailures: count,
  }),
  models: z.array(z.strictObject({ modelId: targetName, ...summary })),
  families: z.array(z.strictObject({ familyName: targetName, ...summary })),
  // Newest first.
  papers: z.array(arxivPaperSchema),
});

export type ArxivKind = z.infer<typeof arxivKindSchema>;
export type ArxivTopic = z.infer<typeof arxivTopicSchema>;
export type ArxivArea = z.infer<typeof arxivAreaSchema>;
export type ArxivResult = z.infer<typeof result>;
export type ArxivPaper = z.infer<typeof arxivPaperSchema>;
export type ArxivSnapshot = z.infer<typeof arxivSnapshotSchema>;
