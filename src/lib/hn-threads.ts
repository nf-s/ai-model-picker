import {
  emptyTally,
  matchingAssessments,
  positiveShare,
} from './hn-insights.ts';
import type { HnFilter, IndexedComment, Tally } from './hn-insights.ts';
import type { HnStory } from './hn-index.ts';

// The matching comments of one story, with the sentiment of their matching
// labels. storyId is null for comments whose story is not recorded.
export type Thread = {
  storyId: number | null;
  story: HnStory | null;
  rows: IndexedComment[];
  latest: string;
  tally: Tally;
};
export type ThreadOrder = 'comments' | 'latest' | 'positive' | 'critical';
// A comment with the listed comments that reply to it. detached marks a
// comment whose parent is neither the story nor another listed comment.
// trimmed names the listed replies that trimNodes left out.
export type CommentNode = {
  row: IndexedComment;
  replies: CommentNode[];
  detached: boolean;
  trimmed: number[];
};

// Sentiment counts for the labels that match the filter, one per label.
export function tallyRows(
  rows: readonly IndexedComment[],
  filter: HnFilter,
): Tally {
  const tally = emptyTally();
  for (const row of rows)
    for (const assessment of matchingAssessments(row, filter))
      tally[assessment.sentiment] += 1;
  return tally;
}

// Comments grouped by the story they belong to. Rows keep their given order
// inside a thread, and threads the order of their first row. Comments with
// no recorded story form one last thread.
export function groupThreads(
  rows: readonly IndexedComment[],
  stories: ReadonlyMap<number, HnStory>,
  filter: HnFilter,
): Thread[] {
  const groups = new Map<number | null, Omit<Thread, 'tally'>>();
  for (const row of rows) {
    const storyId = row.story ?? null;
    const group = groups.get(storyId);
    if (group) {
      group.rows.push(row);
      if (row.createdAt > group.latest) group.latest = row.createdAt;
    } else
      groups.set(storyId, {
        storyId,
        story: storyId === null ? null : (stories.get(storyId) ?? null),
        rows: [row],
        latest: row.createdAt,
      });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, tally: tallyRows(group.rows, filter) }))
    .sort((a, b) => Number(a.storyId === null) - Number(b.storyId === null));
}

// Threads by size, by latest comment, or by positive share from either end.
// A thread with fewer than `minimum` clearly positive or critical labels has
// no share and follows the ones that do. The unrecorded thread stays last.
export function sortThreads(
  threads: readonly Thread[],
  order: ThreadOrder,
  minimum: number,
): Thread[] {
  const byShare = (a: Thread, b: Thread) => {
    const first = positiveShare(a.tally, minimum);
    const second = positiveShare(b.tally, minimum);
    if (first === null || second === null)
      return Number(first === null) - Number(second === null);
    return order === 'critical' ? first - second : second - first;
  };
  return [...threads].sort(
    (a, b) =>
      Number(a.storyId === null) - Number(b.storyId === null) ||
      (order === 'positive' || order === 'critical' ? byShare(a, b) : 0) ||
      (order === 'latest' ? 0 : b.rows.length - a.rows.length) ||
      b.latest.localeCompare(a.latest),
  );
}

// The listed comments of one story as a reply tree, oldest first.
export function nestComments(
  rows: readonly IndexedComment[],
  storyId: number | null,
): CommentNode[] {
  const nodes = new Map<number, CommentNode>();
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  for (const row of ordered)
    nodes.set(row.id, { row, replies: [], detached: false, trimmed: [] });
  const roots: CommentNode[] = [];
  for (const row of ordered) {
    const node = nodes.get(row.id);
    if (!node) continue;
    const parent = row.parent === undefined ? undefined : nodes.get(row.parent);
    if (parent) parent.replies.push(node);
    else {
      node.detached = row.parent !== undefined && row.parent !== storyId;
      roots.push(node);
    }
  }
  return roots;
}

// The first comments of a reply tree in reading order, until `budget` is
// spent. A reply is kept only with its parent and at least one comment is
// kept. A detached comment costs two, because its parent is shown with it.
export function trimNodes(
  nodes: readonly CommentNode[],
  budget: number,
): CommentNode[] {
  let spent = 0;
  const take = (list: readonly CommentNode[]): CommentNode[] => {
    const taken: CommentNode[] = [];
    for (const node of list) {
      if (spent > 0 && spent >= budget) break;
      spent += node.detached ? 2 : 1;
      const replies = take(node.replies);
      taken.push({
        ...node,
        replies,
        trimmed: node.replies
          .slice(replies.length)
          .map((reply) => reply.row.id),
      });
    }
    return taken;
  };
  return take(nodes);
}

// Every comment identifier in a reply tree.
export function nodeIds(nodes: readonly CommentNode[]): number[] {
  return nodes.flatMap((node) => [node.row.id, ...nodeIds(node.replies)]);
}
