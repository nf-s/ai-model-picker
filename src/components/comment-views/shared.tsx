import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { formatHnDate } from '../../lib/hn-client';
import { filterComments } from '../../lib/hn-insights';
import type {
  CommentIndex,
  HnFilter,
  IndexedComment,
} from '../../lib/hn-insights';
import type { CommentNode } from '../../lib/hn-threads';
import { readHnAncestors, readHnItemsById } from '../../lib/hn-reader';
import type { HnItem } from '../../lib/hn-reader';
import { keyName } from '../../lib/site-data';
import { sentimentLabels } from '../parts';
import './comment-views.css';

// What every comment view receives. `index` holds all comments in the model
// filter; `filter` selects the ones to list.
export type CommentViewProps = {
  index: CommentIndex;
  filter: HnFilter;
  focusKey: string | null;
  onPickTarget?: (key: string) => void;
};
export type LabelProps = Pick<CommentViewProps, 'focusKey' | 'onPickTarget'>;
export type ContextProps = LabelProps & { index: CommentIndex };

// Items read from Hacker News, shared by every view. Text stays in memory
// for this page only.
const cache = new Map<number, HnItem>();
const listeners = new Set<() => void>();
const cacheLimit = 6000;
let version = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentVersion() {
  return version;
}

function remember(items: readonly HnItem[]) {
  for (const item of items) if (!item.loadError) cache.set(item.id, item);
  for (const id of cache.keys()) {
    if (cache.size <= cacheLimit) break;
    cache.delete(id);
  }
  version += 1;
  for (const listener of listeners) listener();
}

// An item already read, or undefined. Call it from a component that also
// calls useHnItems or useHnItem, so it renders again when the item arrives.
export function hnItem(id: number | null | undefined) {
  return id === null || id === undefined ? undefined : cache.get(id);
}

// Reads the items that are not in memory yet. The array may be new on every
// render.
export function useHnItems(ids: readonly number[]) {
  useSyncExternalStore(subscribe, currentVersion);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const missing = ids.filter((id) => !cache.has(id)).join(',');
  useEffect(() => {
    if (missing === '') return;
    const controller = new AbortController();
    setFailed(false);
    readHnItemsById(missing.split(',').map(Number), controller.signal).then(
      (items) => {
        remember(items);
        if (!controller.signal.aborted)
          setFailed(items.some((item) => item.loadError));
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [missing, attempt]);
  return { failed, retry: () => setAttempt((value) => value + 1) };
}

export function useHnItem(id: number | null | undefined) {
  useHnItems(id === null || id === undefined ? [] : [id]);
  return hnItem(id);
}

type Ancestry = { ancestors: HnItem[]; truncated: boolean };

// Everything above an item, story first and its direct parent last. Pass
// null to read nothing yet.
export function useAncestors(id: number | null) {
  const [loaded, setLoaded] = useState<{
    id: number;
    result: Ancestry | 'failed';
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (id === null) return;
    const controller = new AbortController();
    readHnAncestors(id, controller.signal).then(
      (thread) => {
        remember([thread.item, ...thread.ancestors]);
        if (!controller.signal.aborted)
          setLoaded({
            id,
            result: {
              ancestors: thread.ancestors,
              truncated: thread.contextTruncated,
            },
          });
      },
      () => {
        if (!controller.signal.aborted) setLoaded({ id, result: 'failed' });
      },
    );
    return () => controller.abort();
  }, [id, attempt]);
  const result = loaded && loaded.id === id ? loaded.result : null;
  return {
    ancestry: result === 'failed' ? null : result,
    failed: result === 'failed',
    retry: () => {
      setLoaded(null);
      setAttempt((value) => value + 1);
    },
  };
}

// The direct replies to an item, oldest first, a page at a time. Replies in
// `exclude` are shown elsewhere and left out.
export function useReplies(
  id: number,
  pageSize = 5,
  exclude?: ReadonlySet<number>,
) {
  const parent = useHnItem(id);
  const [count, setCount] = useState(pageSize);
  const all = parent
    ? parent.replyIds.filter((replyId) => !exclude?.has(replyId))
    : [];
  const ids = all.slice(0, count);
  const { failed, retry } = useHnItems(ids);
  return {
    parent,
    ids,
    total: all.length,
    remaining: Math.max(0, all.length - count),
    showMore: () => setCount(count + pageSize),
    failed,
    retry,
  };
}

export function useMatches(index: CommentIndex, filter: HnFilter) {
  return useMemo(() => filterComments(index, filter), [index, filter]);
}

// The first `pageSize` entries, growing on request and starting over when
// `resetKey` changes.
export function usePaged<T>(
  items: readonly T[],
  resetKey: unknown,
  pageSize: number,
) {
  const [shown, setShown] = useState({ resetKey, count: pageSize });
  const count = shown.resetKey === resetKey ? shown.count : pageSize;
  const page = useMemo(() => items.slice(0, count), [items, count]);
  return {
    page,
    remaining: Math.max(0, items.length - count),
    showMore: () => setShown({ resetKey, count: count + pageSize }),
  };
}

const lookups = new WeakMap<CommentIndex, Map<number, IndexedComment>>();

// The labelled comment with this identifier, if the index lists one.
export function labelledRow(index: CommentIndex, id: number) {
  let lookup = lookups.get(index);
  if (!lookup) {
    lookup = new Map(index.rows.map((row) => [row.id, row]));
    lookups.set(index, lookup);
  }
  return lookup.get(id);
}

export function hnUrl(id: number) {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function countLabel(count: number, one: string, many: string) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function HnLink({ id, children }: { id: number; children?: ReactNode }) {
  return (
    <a
      className="cv-hn"
      href={hnUrl(id)}
      target="_blank"
      rel="noreferrer"
      aria-label={children ? undefined : 'Open on Hacker News'}
    >
      {children ?? 'HN'} <ArrowUpRight size={12} />
    </a>
  );
}

// Model and family labels of one comment, the focused target first.
export function Labels({
  row,
  focusKey,
  onPickTarget,
}: LabelProps & { row: IndexedComment }) {
  const labels = useMemo(
    () =>
      [...row.assessments].sort(
        (a, b) => Number(b.key === focusKey) - Number(a.key === focusKey),
      ),
    [row, focusKey],
  );
  return (
    <ul className="cv-labels" aria-label="Automatic labels">
      {labels.map((label) => {
        const text = (
          <>
            <i className={`rd-s-${label.sentiment}`} aria-hidden="true" />
            {keyName(label.key)}
            <span className="rd-visually-hidden">
              , {sentimentLabels[label.sentiment]}
            </span>
          </>
        );
        return (
          <li
            key={label.key}
            className={label.key === focusKey ? 'cv-label-focus' : undefined}
            title={`${sentimentLabels[label.sentiment]} · ${label.confidence} confidence${label.aspects.length ? ` · ${label.aspects.join(', ')}` : ''}`}
          >
            {onPickTarget && label.key !== focusKey ? (
              <button type="button" onClick={() => onPickTarget(label.key)}>
                {text}
              </button>
            ) : (
              <span>{text}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Date, labels when the index has them, and the Hacker News link of one
// comment.
export function CommentHead({
  id,
  createdAt,
  row,
  focusKey,
  onPickTarget,
  children,
}: LabelProps & {
  id: number;
  createdAt: string | null;
  row?: IndexedComment;
  children?: ReactNode;
}) {
  return (
    <header className="cv-head">
      {createdAt && <time dateTime={createdAt}>{formatHnDate(createdAt)}</time>}
      {children}
      {row ? (
        <Labels row={row} focusKey={focusKey} onPickTarget={onPickTarget} />
      ) : (
        <span className="cv-head-fill" />
      )}
      <HnLink id={id} />
    </header>
  );
}

// Comment text. With `lines` set, longer text is cut there until opened.
export function ItemText({
  item,
  lines,
}: {
  item: HnItem | undefined;
  lines?: number;
}) {
  const [open, setOpen] = useState(false);
  if (!item) return <p className="rd-note">Loading…</p>;
  if (item.deleted || item.unavailable || !item.text)
    return <p className="rd-note">No longer available on Hacker News.</p>;
  const long =
    lines !== undefined &&
    (item.text.length > lines * 95 || item.text.split('\n').length > lines);
  return (
    <div className="cv-text-block">
      <p
        className={long && !open ? 'cv-text cv-clamp' : 'cv-text'}
        style={long && !open ? { WebkitLineClamp: lines } : undefined}
      >
        {item.text}
      </p>
      {long && (
        <button
          type="button"
          className="cv-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

// A story's title: the one given when there is one, otherwise the one read
// from Hacker News.
export function useStoryTitle(id: number, title: string | null | undefined) {
  const item = useHnItem(title ? null : id);
  return title || item?.title || `Story ${id}`;
}

// A story title linking to its Hacker News page.
export function StoryTitle({
  id,
  title,
}: {
  id: number;
  title: string | null | undefined;
}) {
  return (
    <a className="cv-story" href={hnUrl(id)} target="_blank" rel="noreferrer">
      {useStoryTitle(id, title)}
    </a>
  );
}

function LoadNote({
  failed,
  retry,
  what,
}: {
  failed: boolean;
  retry: () => void;
  what: string;
}) {
  if (!failed) return null;
  return (
    <p className="rd-note" role="status">
      {what} could not be loaded from Hacker News.{' '}
      <button type="button" className="rd-link" onClick={retry}>
        Retry
      </button>
    </p>
  );
}

// Everything above a comment: the story, then each comment down to the one
// it replies to. Ancestors that are labelled themselves show their labels.
export function AncestorChain({
  id,
  index,
  focusKey,
  onPickTarget,
  lines = 4,
  showStory = true,
}: ContextProps & { id: number; lines?: number; showStory?: boolean }) {
  const { ancestry, failed, retry } = useAncestors(id);
  if (failed) return <LoadNote failed retry={retry} what="The thread" />;
  if (!ancestry) return <p className="rd-note">Loading thread…</p>;
  const steps = ancestry.ancestors.filter(
    (item) => showStory || item.type === 'comment',
  );
  return (
    <ol className="cv-chain" aria-label="Earlier in the thread">
      {ancestry.truncated && (
        <li className="rd-note">Earlier items could not be loaded.</li>
      )}
      {steps.map((item) =>
        item.type === 'comment' || item.type === null ? (
          <li key={item.id} className="cv-chain-comment">
            <CommentHead
              id={item.id}
              createdAt={item.createdAt}
              row={labelledRow(index, item.id)}
              focusKey={focusKey}
              onPickTarget={onPickTarget}
            />
            <ItemText item={item} lines={lines} />
          </li>
        ) : (
          <li key={item.id} className="cv-chain-story">
            <span className="cv-kicker">Story</span>
            <StoryTitle id={item.id} title={item.title} />
            {item.text && <ItemText item={item} lines={lines} />}
          </li>
        ),
      )}
      {steps.length === 0 && !ancestry.truncated && (
        <li className="rd-note">Top-level comment.</li>
      )}
    </ol>
  );
}

function Reply({
  id,
  depth,
  index,
  focusKey,
  onPickTarget,
}: ContextProps & { id: number; depth: number }) {
  const item = hnItem(id);
  const [open, setOpen] = useState(false);
  return (
    <li className="cv-reply">
      <CommentHead
        id={id}
        createdAt={item?.createdAt ?? null}
        row={labelledRow(index, id)}
        focusKey={focusKey}
        onPickTarget={onPickTarget}
      />
      <ItemText item={item} lines={5} />
      {item &&
        item.replyCount > 0 &&
        (depth >= 5 ? (
          <HnLink id={id}>
            {countLabel(item.replyCount, 'reply', 'replies')}
          </HnLink>
        ) : (
          <button
            type="button"
            className="cv-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide' : 'Show'}{' '}
            {countLabel(item.replyCount, 'reply', 'replies')}
          </button>
        ))}
      {open && (
        <ReplyTree
          id={id}
          depth={depth + 1}
          index={index}
          focusKey={focusKey}
          onPickTarget={onPickTarget}
        />
      )}
    </li>
  );
}

// The replies to an item, oldest first. Each reply opens its own replies.
export function ReplyTree({
  id,
  index,
  focusKey,
  onPickTarget,
  depth = 0,
  pageSize = 5,
  exclude,
}: ContextProps & {
  id: number;
  depth?: number;
  pageSize?: number;
  exclude?: ReadonlySet<number>;
}) {
  const { parent, ids, total, remaining, showMore, failed, retry } = useReplies(
    id,
    pageSize,
    exclude,
  );
  if (!parent)
    return failed ? (
      <LoadNote failed retry={retry} what="Replies" />
    ) : (
      <p className="rd-note">Loading replies…</p>
    );
  if (total === 0) return <p className="rd-note">No replies.</p>;
  return (
    <div className="cv-replies">
      <ol aria-label="Replies">
        {ids.map((replyId) => (
          <Reply
            key={replyId}
            id={replyId}
            depth={depth}
            index={index}
            focusKey={focusKey}
            onPickTarget={onPickTarget}
          />
        ))}
      </ol>
      <LoadNote failed={failed} retry={retry} what="Some replies" />
      {remaining > 0 && (
        <button type="button" className="cv-toggle" onClick={showMore}>
          Show {Math.min(pageSize, remaining)} more of{' '}
          {countLabel(total, 'reply', 'replies')}
        </button>
      )}
    </div>
  );
}

// The comment a labelled comment replies to, cut to `lines`. Renders nothing
// for a top-level comment or one whose parent is unknown.
export function ParentQuote({
  row,
  index,
  focusKey,
  onPickTarget,
  lines = 2,
}: ContextProps & { row: IndexedComment; lines?: number }) {
  const own = useHnItem(row.parent === undefined ? row.id : null);
  const parentId = row.parent ?? own?.parentId ?? null;
  const top = parentId !== null && parentId === row.story;
  const parent = useHnItem(top ? null : parentId);
  if (parentId === null || top) return null;
  if (parent && parent.type !== 'comment' && !parent.unavailable) return null;
  return (
    <blockquote className="cv-quote">
      <CommentHead
        id={parentId}
        createdAt={parent?.createdAt ?? null}
        row={labelledRow(index, parentId)}
        focusKey={focusKey}
        onPickTarget={onPickTarget}
      >
        <span className="cv-kicker">Replying to</span>
      </CommentHead>
      <ItemText item={parent} lines={lines} />
    </blockquote>
  );
}

function ThreadNode({
  node,
  lines,
  index,
  focusKey,
  onPickTarget,
}: ContextProps & { node: CommentNode; lines: number }) {
  const { row } = node;
  const item = hnItem(row.id);
  const [path, setPath] = useState(false);
  const [replies, setReplies] = useState(false);
  // Labelled replies are nested below or held back by trimming, so the
  // plain reply list leaves both out.
  const nested = useMemo(
    () =>
      new Set([...node.replies.map((reply) => reply.row.id), ...node.trimmed]),
    [node],
  );
  const others = item ? Math.max(0, item.replyCount - nested.size) : 0;
  return (
    <li className="cv-node">
      {node.detached && (
        <div className="cv-node-above">
          {path ? (
            <AncestorChain
              id={row.id}
              index={index}
              focusKey={focusKey}
              onPickTarget={onPickTarget}
              showStory={false}
            />
          ) : (
            <ParentQuote
              row={row}
              index={index}
              focusKey={focusKey}
              onPickTarget={onPickTarget}
            />
          )}
          <button
            type="button"
            className="cv-toggle"
            aria-expanded={path}
            onClick={() => setPath(!path)}
          >
            {path ? 'Only the parent' : 'Everything above'}
          </button>
        </div>
      )}
      <div
        className={node.detached ? 'cv-node-own cv-node-reply' : 'cv-node-own'}
      >
        <CommentHead
          id={row.id}
          createdAt={row.createdAt}
          row={row}
          focusKey={focusKey}
          onPickTarget={onPickTarget}
        />
        <ItemText item={item} lines={lines} />
        {others > 0 && (
          <button
            type="button"
            className="cv-toggle"
            aria-expanded={replies}
            onClick={() => setReplies(!replies)}
          >
            {replies ? 'Hide' : 'Show'}{' '}
            {nested.size > 0
              ? countLabel(others, 'other reply', 'other replies')
              : countLabel(others, 'reply', 'replies')}
          </button>
        )}
      </div>
      {(replies || node.replies.length > 0) && (
        <div className="cv-node-below">
          {node.replies.length > 0 && (
            <ThreadNodes
              nodes={node.replies}
              lines={lines}
              index={index}
              focusKey={focusKey}
              onPickTarget={onPickTarget}
            />
          )}
          {replies && (
            <ReplyTree
              id={row.id}
              index={index}
              focusKey={focusKey}
              onPickTarget={onPickTarget}
              exclude={nested}
            />
          )}
        </div>
      )}
    </li>
  );
}

// Labelled comments of one story as a reply tree, from nestComments or
// trimNodes. A comment whose parent is not labelled shows that parent above
// it. The caller reads the comments' text with useHnItems(nodeIds(nodes)).
export function ThreadNodes({
  nodes,
  index,
  focusKey,
  onPickTarget,
  lines = 8,
}: ContextProps & { nodes: readonly CommentNode[]; lines?: number }) {
  return (
    <ol className="cv-nodes">
      {nodes.map((node) => (
        <ThreadNode
          key={node.row.id}
          node={node}
          lines={lines}
          index={index}
          focusKey={focusKey}
          onPickTarget={onPickTarget}
        />
      ))}
    </ol>
  );
}

export function ItemsNote({
  failed,
  retry,
}: {
  failed: boolean;
  retry: () => void;
}) {
  return <LoadNote failed={failed} retry={retry} what="Some comments" />;
}

export function MoreButton({
  remaining,
  pageSize,
  onClick,
  what = '',
}: {
  remaining: number;
  pageSize: number;
  onClick: () => void;
  what?: string;
}) {
  if (remaining <= 0) return null;
  return (
    <button type="button" className="rd-more" onClick={onClick}>
      Show {Math.min(pageSize, remaining)} more{what && ` ${what}`}
    </button>
  );
}
