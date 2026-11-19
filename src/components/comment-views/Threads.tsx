import { useCallback, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatHnDate } from '../../lib/hn-client';
import {
  groupThreads,
  nestComments,
  nodeIds,
  sortThreads,
  trimNodes,
  unclaimedIds,
} from '../../lib/hn-threads';
import type { Thread, ThreadOrder } from '../../lib/hn-threads';
import { SentimentBar, ShareText } from '../parts';
import {
  HnLink,
  ItemsNote,
  MoreButton,
  ThreadNodes,
  countLabel,
  useHnItems,
  useMatches,
  usePaged,
  useStoryTitle,
} from './shared';
import type { CommentViewProps, ContextProps } from './shared';
import './threads.css';

type Density = 'claims' | 'comments' | 'titles';

const shareMinimum = 10;
// Comments shown when a thread opens, and how many "Show more" adds. A claim
// is one sentence, so more of them fit.
const firstComments = 6;
const firstClaims = 12;
const moreComments = 20;
const pageSizes: Record<Density, number> = {
  claims: 5,
  comments: 5,
  titles: 25,
};
const orders: { id: ThreadOrder; label: string }[] = [
  { id: 'comments', label: 'Most comments' },
  { id: 'latest', label: 'Latest comment' },
  { id: 'positive', label: 'Most positive' },
  { id: 'critical', label: 'Most critical' },
];
const densities: { id: Density; label: string }[] = [
  { id: 'claims', label: 'Claims' },
  { id: 'comments', label: 'With comments' },
  { id: 'titles', label: 'Titles only' },
];
const storageKey = 'model-picker:thread-density';

function storedDensity(): Density | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return densities.find((entry) => entry.id === stored)?.id ?? null;
  } catch {
    return null;
  }
}

// How threads start, remembered in this browser when storage works. Claims
// are the start when the analysis has them and are not offered otherwise. A
// thread opened from its title shows claims too when there are any.
function useDensity(detailed: boolean) {
  const [chosen, setChosen] = useState(storedDensity);
  const change = useCallback((next: Density) => {
    setChosen(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The choice then lasts for this page only.
    }
  }, []);
  const density: Density =
    chosen === null || (chosen === 'claims' && !detailed)
      ? detailed
        ? 'claims'
        : 'comments'
      : chosen;
  return [density, change] as const;
}

function threadKey(thread: Thread) {
  return String(thread.storyId ?? 'unrecorded');
}

function StoryName({
  id,
  title,
}: {
  id: number;
  title: string | null | undefined;
}) {
  return useStoryTitle(id, title);
}

// One story: a header row that reads like a table row, and under it the
// matching comments as a reply tree once the thread is open.
function ThreadPanel({
  thread,
  open,
  claims,
  onToggle,
  index,
  focusKey,
  onPickTarget,
}: ContextProps & {
  thread: Thread;
  open: boolean;
  claims: boolean;
  onToggle: () => void;
}) {
  const { storyId, story, rows, tally, latest } = thread;
  const first = claims ? firstClaims : firstComments;
  const [budget, setBudget] = useState(first);
  const nodes = useMemo(() => nestComments(rows, storyId), [rows, storyId]);
  const shown = useMemo(() => trimNodes(nodes, budget), [nodes, budget]);
  const ids = useMemo(() => nodeIds(shown), [shown]);
  const toRead = useMemo(
    () => (claims ? unclaimedIds(shown) : ids),
    [claims, shown, ids],
  );
  const { failed, retry } = useHnItems(open ? toRead : []);
  const remaining = rows.length - ids.length;
  const bodyId = useId();
  return (
    <article className="cv-threads-thread">
      <header className="cv-threads-head">
        <h3 className="cv-threads-title">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onToggle}
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <span>
              {storyId === null ? (
                'Story not recorded'
              ) : (
                <StoryName id={storyId} title={story?.title} />
              )}
            </span>
          </button>
        </h3>
        <div className="cv-threads-meta">
          {story?.createdAt && (
            <span className="cv-threads-posted">
              Posted{' '}
              <time dateTime={story.createdAt}>
                {formatHnDate(story.createdAt)}
              </time>
            </span>
          )}
          <span className="cv-threads-num">
            {rows.length.toLocaleString()}
            <span className="cv-threads-unit">
              {rows.length === 1 ? ' comment' : ' comments'}
            </span>
          </span>
          <span className="cv-threads-bar">
            <SentimentBar tally={tally} />
          </span>
          <span className="cv-threads-share">
            <ShareText tally={tally} minimum={shareMinimum} />
            <span className="cv-threads-unit"> positive</span>
          </span>
          <span className="cv-threads-latest">
            <span className="cv-threads-unit">Latest </span>
            <time dateTime={latest}>{formatHnDate(latest)}</time>
          </span>
          {storyId !== null && (
            <span className="cv-threads-link">
              <HnLink id={storyId} />
            </span>
          )}
        </div>
      </header>
      {open && (
        <div className="cv-threads-body" id={bodyId}>
          {storyId === null && (
            <p className="rd-note">
              The story of these comments could not be read, so they are listed
              without it.
            </p>
          )}
          <ThreadNodes
            nodes={shown}
            claims={claims}
            index={index}
            focusKey={focusKey}
            onPickTarget={onPickTarget}
          />
          <ItemsNote failed={failed} retry={retry} />
          {(remaining > 0 || budget > first) && (
            <p className="cv-threads-more">
              {remaining > 0 && (
                <button
                  type="button"
                  className="cv-toggle"
                  onClick={() => setBudget(budget + moreComments)}
                >
                  Show more of {countLabel(rows.length, 'comment', 'comments')}
                </button>
              )}
              {budget > first && (
                <button
                  type="button"
                  className="cv-toggle"
                  onClick={() => setBudget(first)}
                >
                  Show fewer
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

// The comment section of Discussion: the matching comments grouped under
// their stories. Each story is a row with its counts, so the list works as
// an index, and opens into its comments nested by reply.
export default function Threads({
  index,
  filter,
  focusKey,
  onPickTarget,
}: CommentViewProps) {
  const [density, setDensity] = useDensity(index.detailed);
  const [order, setOrder] = useState<ThreadOrder>('comments');
  const [query, setQuery] = useState('');
  // Threads switched away from what the density gives them.
  const [flipped, setFlipped] = useState<{
    density: Density;
    keys: ReadonlySet<string>;
  }>({ density, keys: new Set() });
  const matches = useMatches(index, filter);
  const threads = useMemo(
    () => groupThreads(matches, index.stories, filter),
    [matches, index.stories, filter],
  );
  const found = useMemo(() => {
    const text = query.trim().toLowerCase();
    const sorted = sortThreads(threads, order, shareMinimum);
    return text
      ? sorted.filter((thread) =>
          thread.story?.title.toLowerCase().includes(text),
        )
      : sorted;
  }, [threads, order, query]);
  const resetKey = useMemo(
    () => ({ filter, order, query, density }),
    [filter, order, query, density],
  );
  const pageSize = pageSizes[density];
  const { page, remaining, showMore } = usePaged(found, resetKey, pageSize);
  const keys = flipped.density === density ? flipped.keys : new Set<string>();
  const toggle = (key: string) => {
    const next = new Set(keys);
    if (!next.delete(key)) next.add(key);
    setFlipped({ density, keys: next });
  };
  const searchId = useId();
  const sortId = useId();
  if (matches.length === 0)
    return (
      <p className="cv-count" role="status">
        No comments match.
      </p>
    );
  return (
    <div className="cv-threads">
      <div className="cv-threads-tools">
        <p className="cv-count" role="status">
          {query.trim()
            ? `${found.length.toLocaleString()} of ${countLabel(threads.length, 'thread', 'threads')}`
            : `${countLabel(matches.length, 'comment', 'comments')} in ${countLabel(threads.length, 'thread', 'threads')}`}
        </p>
        <div className="rd-seg" role="group" aria-label="Threads start">
          {densities
            .filter((entry) => index.detailed || entry.id !== 'claims')
            .map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === density}
                onClick={() => setDensity(entry.id)}
              >
                {entry.label}
              </button>
            ))}
        </div>
        <div className="cv-threads-find">
          <label className="rd-visually-hidden" htmlFor={searchId}>
            Find a story by title
          </label>
          <input
            id={searchId}
            className="rd-input"
            type="search"
            placeholder="Find a story by title"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="cv-threads-sort">
          <label htmlFor={sortId}>Sort</label>
          <select
            id={sortId}
            className="rd-select"
            value={order}
            onChange={(event) => {
              const next = orders.find(
                (entry) => entry.id === event.target.value,
              );
              if (next) setOrder(next.id);
            }}
          >
            {orders.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {density !== 'comments' && index.detailed && (
        <p className="rd-note">
          A claim is one sentence written by the classifier about what the
          comment says. Open a comment for its own words.
        </p>
      )}
      {found.length === 0 ? (
        <p className="rd-note">No story title contains “{query.trim()}”.</p>
      ) : (
        <div className="cv-threads-list rd-panel">
          <div className="cv-threads-cols" aria-hidden="true">
            <span>Story</span>
            <span>Comments</span>
            <span>Sentiment</span>
            <span>Positive</span>
            <span>Latest</span>
          </div>
          {page.map((thread) => {
            const key = threadKey(thread);
            return (
              <ThreadPanel
                key={`${key}|${density}`}
                thread={thread}
                open={(density !== 'titles') !== keys.has(key)}
                claims={density !== 'comments' && index.detailed}
                onToggle={() => toggle(key)}
                index={index}
                focusKey={focusKey}
                onPickTarget={onPickTarget}
              />
            );
          })}
        </div>
      )}
      <MoreButton
        remaining={remaining}
        pageSize={pageSize}
        onClick={showMore}
        what="threads"
      />
    </div>
  );
}
