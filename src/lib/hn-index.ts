import { z } from 'zod';
import {
  hnAspectSchema,
  hnIndexCommentSchema,
  hnPublished,
  hnStorySchema,
  hnTaskSchema,
  hnThemeSchema,
  loadHnSnapshot,
  loadPublishedCollection,
} from './hn-published.ts';

const timestamp = z.iso.datetime({ offset: true });
const localIndexSchema = z.strictObject({
  startAt: timestamp.nullable(),
  endAt: timestamp.nullable(),
  comments: z.array(hnIndexCommentSchema),
  stories: z.array(hnStorySchema).default([]),
});

export type HnIndexComment = z.infer<typeof hnIndexCommentSchema>;
export type HnAssessment = HnIndexComment['assessments'][number];
export type HnAspect = z.infer<typeof hnAspectSchema>;
export type HnStory = z.infer<typeof hnStorySchema>;
export type HnTask = z.infer<typeof hnTaskSchema>;
export type HnTheme = z.infer<typeof hnThemeSchema>;
export type HnIndex = z.infer<typeof localIndexSchema>;
export const hnAspects = hnAspectSchema.options;
export const hnTasks = hnTaskSchema.options;
export const hnThemes = hnThemeSchema.options;

let request: Promise<HnIndex> | null = null;

async function readIndex(): Promise<HnIndex> {
  if (hnPublished) {
    const snapshot = await loadHnSnapshot();
    const { comments, stories } = await loadPublishedCollection(snapshot);
    return {
      startAt: snapshot.status.startAt,
      endAt: snapshot.status.endAt,
      comments,
      stories,
    };
  }
  const response = await fetch('/api/hn/index', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read the comment index.');
  const raw: unknown = await response.json();
  return localIndexSchema.parse(raw);
}

// Metadata for every listed comment, newest first. Loaded once per session.
export function loadHnIndex() {
  request ??= readIndex().catch((error: unknown) => {
    request = null;
    throw error;
  });
  return request;
}
