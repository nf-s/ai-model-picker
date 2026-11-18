import { z } from 'zod';

const itemId = z
  .number()
  .int()
  .positive()
  .max(2 ** 32 - 1);
const timestamp = z.number().int().nonnegative().max(4_102_444_800);
const itemSchema = z.object({
  id: itemId,
  type: z.enum(['comment', 'story', 'poll', 'pollopt', 'job']).optional(),
  time: timestamp.optional(),
  text: z.string().max(1_000_000).default(''),
  title: z.string().max(20_000).optional(),
  parent: itemId.optional(),
  kids: z.array(itemId).max(50_000).default([]),
  dead: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

export type HnItem = {
  id: number;
  type: 'comment' | 'story' | 'poll' | 'job' | null;
  createdAt: string | null;
  text: string;
  title: string | null;
  parentId: number | null;
  replyIds: number[];
  replyCount: number;
  unavailable: boolean;
  deleted: boolean;
  loadError: boolean;
};

export class ReaderError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Source markup becomes plain text. The browser renders it as escaped React text.
// Bodies and account fields never enter inference, logs, disk caches or exports.
const entities = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

export function commentText(html: string) {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<\/?(?:p|pre|div|blockquote)\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (original: string, entity: string) => {
        if (!entity.startsWith('#'))
          return entities.get(entity.toLowerCase()) ?? original;
        const value = entity.toLowerCase().startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return value > 0 &&
          value <= 0x10ffff &&
          !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value)
          : '\uFFFD';
      },
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unavailableItem(id: number): HnItem {
  return {
    id,
    type: null,
    createdAt: null,
    text: '',
    title: null,
    parentId: null,
    replyIds: [],
    replyCount: 0,
    unavailable: true,
    deleted: false,
    loadError: false,
  };
}

export function publicItem(payload: unknown, id: number): HnItem {
  if (payload === null) return unavailableItem(id);
  const parsed = itemSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== id)
    throw new ReaderError(502, 'A comment could not be validated. Try again.');
  const item = parsed.data;
  const hidden = Boolean(item.dead || item.deleted);
  const replies = [...new Set(item.kids)].sort((a, b) => a - b);
  return {
    id,
    type: item.type === 'pollopt' ? null : (item.type ?? null),
    createdAt:
      item.time === undefined ? null : new Date(item.time * 1000).toISOString(),
    text: hidden ? '' : commentText(item.text),
    title: hidden || !item.title ? null : commentText(item.title),
    parentId: item.parent ?? null,
    replyIds: replies,
    replyCount: replies.length,
    unavailable: hidden,
    deleted: Boolean(item.deleted),
    loadError: false,
  };
}

async function readItemResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Unavailable item.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel().catch(() => {});
        throw new Error('Item exceeded the response limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export function createPublicHnReader(fetchItem: typeof fetch = fetch) {
  const cache = new Map<
    number,
    { item: HnItem; size: number; expires: number }
  >();
  const inFlight = new Map<number, Promise<HnItem>>();
  const waiting: Array<() => void> = [];
  const encoder = new TextEncoder();
  let active = 0;
  let cacheBytes = 0;
  async function limited(work: () => Promise<HnItem>) {
    if (active >= 8)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  }

  async function item(id: number) {
    const found = cache.get(id);
    if (found && found.expires > Date.now()) return found.item;
    const existing = inFlight.get(id);
    if (existing) return existing;
    if (!itemId.safeParse(id).success)
      throw new ReaderError(400, 'Invalid comment identifier.');
    const promise = limited(async () => {
      try {
        const response = await fetchItem(
          `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
          {
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
            headers: { Accept: 'application/json' },
          },
        );
        const value = publicItem(await readItemResponse(response), id);
        const size = encoder.encode(JSON.stringify(value)).byteLength;
        const previous = cache.get(id);
        if (previous) {
          cacheBytes -= previous.size;
          cache.delete(id);
        }
        cache.set(id, { item: value, size, expires: Date.now() + 5 * 60_000 });
        cacheBytes += size;
        while (cache.size > 512 || cacheBytes > 8 * 1024 * 1024) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          const entry = cache.get(oldest);
          if (!entry) break;
          cacheBytes -= entry.size;
          cache.delete(oldest);
        }
        return value;
      } catch (error) {
        if (error instanceof ReaderError) throw error;
        throw new ReaderError(
          502,
          'HN comments could not be loaded. Try again.',
        );
      }
    });
    inFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(id);
    }
  }

  async function readableItem(id: number) {
    try {
      return await item(id);
    } catch {
      return { ...unavailableItem(id), loadError: true };
    }
  }

  async function comments<T>(
    rows: readonly { id: number; createdAt: string; assessments: T[] }[],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    return Promise.all(
      rows.map(async (row) => {
        const value = await readableItem(row.id);
        return {
          item: { ...value, createdAt: value.createdAt ?? row.createdAt },
          assessments: row.assessments,
        };
      }),
    );
  }

  // Items by identifier, in the order given. A failed read becomes a
  // retryable placeholder.
  async function items(ids: readonly number[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    return Promise.all(ids.map(readableItem));
  }

  async function replies(
    id: number,
    after: number | null,
    limit: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const selected = await item(id);
    signal?.throwIfAborted();
    const remaining = selected.replyIds.filter(
      (replyId) => after === null || replyId > after,
    );
    const ids = remaining.slice(0, limit);
    const loaded = await Promise.all(ids.map(readableItem));
    return {
      parentId: selected.id,
      total: selected.replyCount,
      nextCursor: remaining.length > ids.length ? (ids.at(-1) ?? null) : null,
      replies: loaded.map((reply) =>
        !reply.unavailable && reply.parentId !== selected.id
          ? { ...unavailableItem(reply.id), loadError: true }
          : reply,
      ),
    };
  }

  async function thread(id: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const selected = await item(id);
    const ancestors: HnItem[] = [];
    const visited = new Set([selected.id]);
    const deadline = Date.now() + 15_000;
    let parent = selected.parentId;
    let missingContext =
      (selected.unavailable || selected.type === 'comment') && parent === null;
    while (
      parent !== null &&
      !visited.has(parent) &&
      ancestors.length < 40 &&
      Date.now() < deadline
    ) {
      signal?.throwIfAborted();
      visited.add(parent);
      const ancestor = await readableItem(parent);
      ancestors.unshift(ancestor);
      parent = ancestor.parentId;
      missingContext ||=
        (ancestor.unavailable || ancestor.type === 'comment') &&
        parent === null;
    }
    signal?.throwIfAborted();
    return {
      item: selected,
      ancestors,
      contextTruncated: missingContext || parent !== null,
    };
  }

  return { comments, items, replies, thread };
}
