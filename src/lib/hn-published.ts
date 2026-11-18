import { z } from 'zod';
import {
  hnClassifierCheck,
  hnConfidenceSchema,
  hnResultsSchema,
  hnSentimentSchema,
  hnStatusSchema,
} from './hn-schema.ts';

const timestamp = z.iso.datetime({ offset: true });
const itemId = z
  .number()
  .int()
  .positive()
  .max(2 ** 32 - 1);
export const hnAspectSchema = z.enum([
  'coding',
  'reliability',
  'cost',
  'speed',
  'design',
  'agents',
  'writing',
  'research',
  'reasoning',
]);
export const hnTaskSchema = z.enum([
  'coding',
  'agents',
  'design',
  'writing',
  'research',
  'reasoning',
  'images',
  'chat',
  'other',
]);
export const hnThemeSchema = z.enum([
  'code-quality',
  'agentic-work',
  'instruction-following',
  'hallucination',
  'regression',
  'rate-limits',
  'pricing',
  'speed',
  'context',
  'reasoning-depth',
  'writing-style',
  'frontend-design',
  'refusals',
  'benchmarks',
  'availability',
  'harness',
  'model-choice',
  'local-use',
  'policy',
  'release',
]);
const targetSchema = z.strictObject({
  kind: z.enum(['model', 'family']),
  target: z.string().min(1).max(128),
});
const assessment = targetSchema.extend({
  sentiment: hnSentimentSchema,
  confidence: hnConfidenceSchema,
  aspects: z.array(hnAspectSchema).max(hnAspectSchema.options.length),
  themes: z.array(hnThemeSchema).max(3).optional(),
});
export const hnIndexCommentSchema = z.strictObject({
  id: itemId,
  createdAt: timestamp,
  assessments: z.array(assessment),
  story: itemId.optional(),
  parent: itemId.optional(),
  task: hnTaskSchema.optional(),
  claim: z.string().min(1).max(240).optional(),
  prefers: z
    .array(z.strictObject({ winner: targetSchema, loser: targetSchema }))
    .optional(),
});
export const hnStorySchema = z.strictObject({
  id: itemId,
  title: z.string().max(300),
  createdAt: timestamp.nullable(),
  about: z.array(targetSchema),
  comments: z.number().int().nonnegative(),
});
const status = hnStatusSchema.extend({
  classifier: z.literal(hnClassifierCheck.classifierId),
  reason: z.null(),
  archiveRevision: z.null(),
  startAt: timestamp,
  endAt: timestamp,
});
export const hnPublishedSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    publishedAt: timestamp,
    status,
    results: hnResultsSchema.extend({
      classifier: z.literal(hnClassifierCheck.classifierId),
      startAt: timestamp,
      endAt: timestamp,
    }),
  })
  .refine((snapshot) => {
    const { startAt, endAt, totals } = snapshot.status;
    return (
      Date.parse(startAt) <= Date.parse(endAt) &&
      snapshot.results.updatedAt === snapshot.status.updatedAt &&
      snapshot.results.startAt === startAt &&
      snapshot.results.endAt === endAt &&
      totals.classified +
        totals.classificationFailures +
        (totals.classificationUntracked ?? 0) ===
        totals.candidates
    );
  }, 'Invalid published collection coverage');

const commentsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  publishedAt: timestamp,
  comments: z.array(hnIndexCommentSchema),
  stories: z.array(hnStorySchema).default([]),
});
export type HnPublishedSnapshot = z.infer<typeof hnPublishedSnapshotSchema>;
type Collection = z.infer<typeof commentsSchema>;
type Assessment = z.infer<typeof assessment>;
type Target = z.infer<typeof targetSchema>;

export const hnPublished = import.meta.env?.VITE_HN_MODE === 'published';
let loaded: HnPublishedSnapshot | null = null;
let loading: Promise<HnPublishedSnapshot> | null = null;
let commentRequest: {
  publishedAt: string;
  data: Promise<Pick<Collection, 'comments' | 'stories'>>;
} | null = null;

async function publishedJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('Snapshot unavailable.');
  return response.json();
}

export function loadHnSnapshot(refresh = false) {
  if (loading) return loading;
  if (loaded && !refresh) return Promise.resolve(loaded);
  loading = (async () => {
    try {
      loaded = hnPublishedSnapshotSchema.parse(
        await publishedJson('/hn-snapshot.json'),
      );
      return loaded;
    } catch {
      throw new Error('Could not load the published Hacker News snapshot.');
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export function parsePublishedCollection(
  snapshot: HnPublishedSnapshot,
  raw: unknown,
) {
  const collection = commentsSchema.parse(raw);
  const { totals } = snapshot.status;
  const start = Date.parse(snapshot.status.startAt);
  const end = Date.parse(snapshot.status.endAt);
  let before = Infinity;
  if (
    snapshot.publishedAt !== collection.publishedAt ||
    (totals.commentsAboutTargets ?? totals.candidates) !==
      collection.comments.length ||
    !collection.comments.every((comment) => {
      const date = Date.parse(comment.createdAt);
      const included = comment.id < before && date >= start && date <= end;
      before = comment.id;
      return included;
    })
  )
    throw new Error('Invalid published comments.');
  return { comments: collection.comments, stories: collection.stories };
}

export function parsePublishedComments(
  snapshot: HnPublishedSnapshot,
  raw: unknown,
) {
  return parsePublishedCollection(snapshot, raw).comments;
}

export function loadPublishedCollection(snapshot: HnPublishedSnapshot) {
  const { publishedAt } = snapshot;
  if (commentRequest?.publishedAt === publishedAt) return commentRequest.data;
  const data = publishedJson('/hn-comments.json')
    .then((raw) => parsePublishedCollection(snapshot, raw))
    .catch(() => {
      if (commentRequest?.publishedAt === publishedAt) commentRequest = null;
      throw new Error('Could not load the published Hacker News comments.');
    });
  commentRequest = { publishedAt, data };
  return data;
}

export async function loadPublishedComments(snapshot: HnPublishedSnapshot) {
  return (await loadPublishedCollection(snapshot)).comments;
}

export function publishedCommentPage(
  comments: Collection['comments'],
  target: Target | null,
  sentiment: Assessment['sentiment'] | null,
  before: number | null,
  limit: number,
) {
  const matches =
    target || sentiment
      ? comments.filter((comment) =>
          comment.assessments.some(
            (label) =>
              (!target ||
                (label.kind === target.kind &&
                  label.target === target.target)) &&
              (!sentiment || label.sentiment === sentiment),
          ),
        )
      : comments;
  const boundary =
    before === null ? 0 : matches.findIndex((comment) => comment.id < before);
  const start = boundary < 0 ? matches.length : boundary;
  const rows = matches.slice(start, start + limit);
  return {
    rows,
    total: matches.length,
    nextCursor:
      matches.length > start + limit ? (rows.at(-1)?.id ?? null) : null,
  };
}
