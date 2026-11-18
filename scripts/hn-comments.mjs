import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  createPublicHnReader,
  ReaderError,
} from '../src/lib/hn-public-items.ts';
import { hnTaskSchema, hnThemeSchema } from '../src/lib/hn-published.ts';
export {
  commentText,
  publicItem,
  ReaderError,
} from '../src/lib/hn-public-items.ts';

const itemId = z
  .number()
  .int()
  .positive()
  .max(2 ** 32 - 1);
const timestamp = z.number().int().nonnegative().max(4_102_444_800);
const sentiment = z.enum([
  'positive',
  'negative',
  'mixed',
  'neutral',
  'unclear',
]);
const kind = z.enum(['model', 'family']);
const label = z.string().min(1).max(128);
const json = (schema) =>
  z
    .string()
    .transform((value) => JSON.parse(value))
    .pipe(schema);
const runSchema = z.object({
  classifier_key: z.string().min(1),
  start_at: timestamp,
  end_at: timestamp,
});
const commentRow = z.object({
  item_id: itemId,
  created: timestamp,
  parent: itemId.nullable(),
  root: itemId.nullable(),
  task: hnTaskSchema.nullable(),
  claim: z.string().max(240).nullable(),
});
const assessmentRow = z.object({
  item_id: itemId,
  kind,
  target: label,
  sentiment,
  aspects: json(z.array(z.string().max(40)).max(20)),
  confidence: z.enum(['high', 'medium', 'low']),
  themes: json(z.array(hnThemeSchema).max(3)),
});
const preferenceRow = z.object({
  item_id: itemId,
  winner_kind: kind,
  winner: label,
  loser_kind: kind,
  loser: label,
});
const storyRow = z.object({
  item_id: itemId,
  created: timestamp.nullable(),
  title: z.string().max(300),
  targets: json(z.array(z.tuple([kind, label])).max(20)),
  state: z.enum(['pending', 'expanded', 'rejected', 'context']),
});
const commentColumns =
  'c.item_id, c.created, c.parent, c.root, c.task, c.claim';
const assessmentColumns =
  'item_id, kind, target, sentiment, aspects, confidence, themes';
const preferenceColumns = 'item_id, winner_kind, winner, loser_kind, loser';

export function readReaderRequest(url) {
  const path = url.pathname;
  const collection =
    path === '/api/hn/comments'
      ? 'comments'
      : path === '/api/hn/index'
        ? 'index'
        : null;
  if (
    !collection &&
    !path.startsWith('/api/hn/thread/') &&
    !path.startsWith('/api/hn/replies/')
  )
    return null;
  const match = /^\/api\/hn\/(thread|replies)\/([1-9]\d{0,9})$/.exec(path);
  if (!collection && !match)
    throw new ReaderError(400, 'Invalid comment identifier.');
  const route = match?.[1] ?? collection;
  const keys =
    route === 'comments'
      ? ['kind', 'target', 'sentiment', 'before', 'limit']
      : route === 'replies'
        ? ['after', 'limit']
        : [];
  for (const key of url.searchParams.keys())
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new ReaderError(400, 'Invalid comment filter.');
  function integer(key, fallback, maximum) {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > maximum
    )
      throw new ReaderError(400, 'Invalid page request.');
    return Number(raw);
  }
  const id = match ? Number(match[2]) : null;
  if (id !== null && !itemId.safeParse(id).success)
    throw new ReaderError(400, 'Invalid comment identifier.');
  const limit = integer('limit', 20, 50);
  const before = integer('before', null, 2 ** 32 - 1);
  const after = integer('after', null, 2 ** 32 - 1);
  const targetKind = url.searchParams.get('kind');
  const target = url.searchParams.get('target');
  const label = url.searchParams.get('sentiment');
  if (
    !limit ||
    before === 0 ||
    after === 0 ||
    (targetKind === null) !== (target === null) ||
    (targetKind !== null && !kind.safeParse(targetKind).success) ||
    (target !== null && (!target.trim() || target.length > 128)) ||
    (label !== null && !sentiment.safeParse(label).success)
  )
    throw new ReaderError(400, 'Invalid comment filter.');
  return {
    route,
    id,
    limit,
    before,
    after,
    kind: targetKind,
    target,
    sentiment: label,
  };
}

async function readCheckpoint(stateDir, read) {
  const path = join(stateDir, 'checkpoint.sqlite3');
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new ReaderError(503, 'Comment storage is unavailable.');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 500');
    const parsed = runSchema.safeParse(
      db.prepare('SELECT * FROM run WHERE id = 1').get(),
    );
    if (!parsed.success)
      throw new ReaderError(
        503,
        'The collection date range is being updated. Try again shortly.',
      );
    return read(db, parsed.data);
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    throw new ReaderError(503, 'Comment storage is unavailable.');
  } finally {
    db.close();
  }
}

const isoTime = (seconds) => new Date(seconds * 1000).toISOString();

function publicAssessment({ item_id, themes, ...assessment }) {
  return themes.length ? { ...assessment, themes } : assessment;
}

function publicPreference(row) {
  return {
    winner: { kind: row.winner_kind, target: row.winner },
    loser: { kind: row.loser_kind, target: row.loser },
  };
}

// Optional review details, omitted when absent so older rows keep their shape.
function reviewDetails(row, prefers) {
  return {
    ...(row.root === null ? {} : { story: row.root }),
    ...(row.parent === null ? {} : { parent: row.parent }),
    ...(row.task === null ? {} : { task: row.task }),
    ...(row.claim ? { claim: row.claim } : {}),
    ...(prefers.length ? { prefers } : {}),
  };
}

function groupByItem(rows, map) {
  const groups = new Map();
  for (const row of rows) {
    const found = groups.get(row.item_id);
    if (found) found.push(map(row));
    else groups.set(row.item_id, [map(row)]);
  }
  return groups;
}

async function readPage(stateDir, request) {
  const page = await readCheckpoint(stateDir, (db, run) => {
    const conditions = ['c.classifier_key = ?', 'c.created BETWEEN ? AND ?'];
    const values = [run.classifier_key, run.start_at, run.end_at];
    // A comment is listed once its review found an opinion about a target.
    const predicates = [
      'a.item_id = c.item_id',
      'a.classifier_key = c.classifier_key',
      'a.failed = 0',
    ];
    if (request.kind) {
      predicates.push('a.kind = ?', 'a.target = ?');
      values.push(request.kind, request.target);
    }
    if (request.sentiment) {
      predicates.push('a.sentiment = ?');
      values.push(request.sentiment);
    }
    conditions.push(
      `EXISTS (SELECT 1 FROM assessment a WHERE ${predicates.join(' AND ')})`,
    );
    const where = conditions.join(' AND ');
    const total = z
      .object({ total: z.number().int().nonnegative() })
      .parse(
        db
          .prepare(`SELECT COUNT(*) AS total FROM comment c WHERE ${where}`)
          .get(...values),
      ).total;
    const pageValues =
      request.before === null ? values : [...values, request.before];
    const rows = z
      .array(commentRow)
      .parse(
        db
          .prepare(
            `SELECT ${commentColumns} FROM comment c WHERE ${where}${request.before === null ? '' : ' AND c.item_id < ?'} ORDER BY c.item_id DESC LIMIT ?`,
          )
          .all(...pageValues, request.limit + 1),
      );
    const page = rows.slice(0, request.limit);
    const labels = db.prepare(
      `SELECT ${assessmentColumns} FROM assessment WHERE item_id = ? AND classifier_key = ? AND failed = 0 ORDER BY kind, target`,
    );
    const choices = db.prepare(
      `SELECT ${preferenceColumns} FROM preference WHERE item_id = ? AND classifier_key = ? ORDER BY winner_kind, winner, loser_kind, loser`,
    );
    return {
      total,
      nextCursor:
        rows.length > request.limit ? (page.at(-1)?.item_id ?? null) : null,
      rows: page.map((row) => ({
        id: row.item_id,
        createdAt: isoTime(row.created),
        assessments: z
          .array(assessmentRow)
          .parse(labels.all(row.item_id, run.classifier_key))
          .map(publicAssessment),
        details: reviewDetails(
          row,
          z
            .array(preferenceRow)
            .parse(choices.all(row.item_id, run.classifier_key))
            .map(publicPreference),
        ),
      })),
    };
  });
  return page ?? { total: 0, nextCursor: null, rows: [] };
}

// Metadata for every listed comment in the run window. No comment text.
async function readIndex(stateDir) {
  const index = await readCheckpoint(stateDir, (db, run) => {
    const window = [run.classifier_key, run.start_at, run.end_at];
    const labels = groupByItem(
      z
        .array(assessmentRow)
        .parse(
          db
            .prepare(
              `SELECT ${assessmentColumns} FROM assessment WHERE classifier_key = ? AND failed = 0 ORDER BY item_id, kind, target`,
            )
            .all(run.classifier_key),
        ),
      publicAssessment,
    );
    const choices = groupByItem(
      z
        .array(preferenceRow)
        .parse(
          db
            .prepare(
              `SELECT ${preferenceColumns} FROM preference WHERE classifier_key = ? ORDER BY item_id, winner_kind, winner, loser_kind, loser`,
            )
            .all(run.classifier_key),
        ),
      publicPreference,
    );
    const comments = [];
    const counts = new Map();
    for (const row of z
      .array(commentRow)
      .parse(
        db
          .prepare(
            `SELECT ${commentColumns} FROM comment c WHERE c.classifier_key = ? AND c.created BETWEEN ? AND ? ORDER BY c.item_id DESC`,
          )
          .all(...window),
      )) {
      const assessments = labels.get(row.item_id);
      if (!assessments) continue;
      if (row.root !== null)
        counts.set(row.root, (counts.get(row.root) ?? 0) + 1);
      comments.push({
        id: row.item_id,
        createdAt: isoTime(row.created),
        assessments,
        ...reviewDetails(row, choices.get(row.item_id) ?? []),
      });
    }
    const stories = z
      .array(storyRow)
      .parse(
        db
          .prepare(
            'SELECT item_id, created, title, targets, state FROM story WHERE item_id IN (SELECT root FROM comment c WHERE c.classifier_key = ? AND c.created BETWEEN ? AND ?) ORDER BY item_id DESC',
          )
          .all(...window),
      )
      .flatMap((story) => {
        const listedComments = counts.get(story.item_id);
        if (!listedComments) return [];
        return [
          {
            id: story.item_id,
            title: story.title,
            createdAt: story.created === null ? null : isoTime(story.created),
            about:
              story.state === 'expanded'
                ? story.targets.map(([targetKind, target]) => ({
                    kind: targetKind,
                    target,
                  }))
                : [],
            comments: listedComments,
          },
        ];
      });
    return {
      startAt: isoTime(run.start_at),
      endAt: isoTime(run.end_at),
      comments,
      stories,
    };
  });
  return index ?? { startAt: null, endAt: null, comments: [], stories: [] };
}

export function createCommentReader(stateDir, fetchItem = fetch) {
  const publicReader = createPublicHnReader(fetchItem);
  return async function read(request) {
    if (request.route === 'index') return readIndex(stateDir);
    if (request.route === 'comments') {
      const page = await readPage(stateDir, request);
      const comments = await publicReader.comments(page.rows);
      return {
        total: page.total,
        nextCursor: page.nextCursor,
        comments: comments.map((entry, index) => ({
          ...entry,
          ...page.rows[index].details,
        })),
      };
    }
    if (request.route === 'replies')
      return publicReader.replies(request.id, request.after, request.limit);
    return publicReader.thread(request.id);
  };
}
