import { z } from 'zod';
import { models } from './data';
import { hnConfidenceSchema, hnSentimentSchema } from './hn-schema';
import { createPublicHnReader } from './hn-public-items';
import {
  hnPublished,
  loadHnSnapshot,
  loadPublishedComments,
  publishedCommentPage,
} from './hn-published';
import type { HnIndexComment } from './hn-index';

const pageSize = 20;
const publicReader = hnPublished ? createPublicHnReader() : null;
let itemReader = publicReader;
const itemId = z.number().int().positive();
const count = z.number().int().nonnegative();
const itemSchema = z.object({
  id: itemId,
  type: z.enum(['comment', 'story', 'poll', 'job']).nullable(),
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  text: z.string(),
  title: z.string().nullable(),
  parentId: itemId.nullable(),
  replyIds: z.array(itemId),
  replyCount: count,
  unavailable: z.boolean(),
  deleted: z.boolean(),
  loadError: z.boolean().default(false),
});
const targetSchema = z.object({
  kind: z.enum(['model', 'family']),
  target: z.string().min(1),
});
const assessmentSchema = targetSchema.extend({
  sentiment: hnSentimentSchema,
  aspects: z.array(z.string()),
  confidence: hnConfidenceSchema,
});
const commentSchema = z.object({
  item: itemSchema,
  assessments: z.array(assessmentSchema),
});
const commentsSchema = z.object({
  total: count,
  nextCursor: itemId.nullable(),
  comments: z.array(commentSchema),
});
const threadSchema = z.object({
  item: itemSchema,
  ancestors: z.array(itemSchema),
  contextTruncated: z.boolean(),
});
const repliesSchema = z.object({
  parentId: itemId,
  total: count,
  nextCursor: itemId.nullable(),
  replies: z.array(itemSchema),
});

export type HnItem = z.infer<typeof itemSchema>;
export type HnTarget = z.infer<typeof targetSchema>;
export type HnSentiment = z.infer<typeof hnSentimentSchema>;
export type HnComment = z.infer<typeof commentSchema>;
export type HnThread = z.infer<typeof threadSchema>;
export type HnReaderPage<T> = {
  entries: T[];
  next: number | null;
  total: number;
};

export function hnTargetName(target: HnTarget) {
  return target.kind === 'family'
    ? target.target
    : (models.find((model) => model.id === target.target)?.name ??
        target.target);
}

async function readHnJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/hn/${path}`, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Could not read Hacker News items.');
  return response.json();
}

export async function readHnComments(
  target: HnTarget | null,
  sentiment: HnSentiment | null,
  before: number | null,
  signal: AbortSignal,
): Promise<HnReaderPage<HnComment>> {
  if (publicReader) {
    const snapshot = await loadHnSnapshot();
    signal.throwIfAborted();
    const comments = await loadPublishedComments(snapshot);
    const { rows, total, nextCursor } = publishedCommentPage(
      comments,
      target,
      sentiment,
      before,
      pageSize,
    );
    return {
      entries: await publicReader.comments(rows, signal),
      next: nextCursor,
      total,
    };
  }
  const search = new URLSearchParams({ limit: String(pageSize) });
  if (target) {
    search.set('kind', target.kind);
    search.set('target', target.target);
  }
  if (sentiment) search.set('sentiment', sentiment);
  if (before !== null) search.set('before', String(before));
  const page = commentsSchema.parse(
    await readHnJson(`comments?${search}`, signal),
  );
  if (page.nextCursor !== null && before !== null && page.nextCursor >= before)
    throw new Error('Invalid comment cursor.');
  return { entries: page.comments, next: page.nextCursor, total: page.total };
}

// Text for rows selected in the browser from the comment index.
export function readHnItems(
  rows: readonly HnIndexComment[],
  signal: AbortSignal,
): Promise<HnComment[]> {
  itemReader ??= createPublicHnReader();
  return itemReader.comments(rows, signal);
}

// Public items by identifier: parents, stories and other thread context.
export function readHnItemsById(
  ids: readonly number[],
  signal: AbortSignal,
): Promise<HnItem[]> {
  itemReader ??= createPublicHnReader();
  return itemReader.items(ids, signal);
}

// An item with its ancestors, story first, read the same way as
// readHnItemsById so both share one cache.
export function readHnAncestors(
  id: number,
  signal: AbortSignal,
): Promise<HnThread> {
  itemReader ??= createPublicHnReader();
  return itemReader.thread(id, signal);
}

export async function readHnThread(id: number, signal: AbortSignal) {
  if (publicReader) return publicReader.thread(id, signal);
  const thread = threadSchema.parse(await readHnJson(`thread/${id}`, signal));
  if (thread.item.id !== id) throw new Error('Invalid discussion item.');
  return thread;
}

export async function readHnReplies(
  id: number,
  after: number | null,
  signal: AbortSignal,
): Promise<HnReaderPage<HnItem>> {
  if (publicReader) {
    const { replies, total, nextCursor } = await publicReader.replies(
      id,
      after,
      pageSize,
      signal,
    );
    return { entries: replies, next: nextCursor, total };
  }
  const search = new URLSearchParams({ limit: String(pageSize) });
  if (after !== null) search.set('after', String(after));
  const page = repliesSchema.parse(
    await readHnJson(`replies/${id}?${search}`, signal),
  );
  if (
    page.parentId !== id ||
    (page.nextCursor !== null && after !== null && page.nextCursor <= after)
  )
    throw new Error('Invalid reply page.');
  return { entries: page.replies, next: page.nextCursor, total: page.total };
}
