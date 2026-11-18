import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { formatHnDate } from '../lib/hn-client';
import { filterComments, positiveShare } from '../lib/hn-insights';
import type {
  CommentIndex,
  HnFilter,
  HnSentiment,
  IndexedComment,
  Tally,
} from '../lib/hn-insights';
import { readHnItems, readHnThread } from '../lib/hn-reader';
import type { HnItem, HnThread } from '../lib/hn-reader';
import { keyName, percent, weekLabel } from '../lib/site-data';
import { routeHref } from '../lib/route';

/** Stands in for results whose source terms do not allow republishing. */
export function RestrictedNote() {
  return (
    <p className="rd-note">
      This source's terms do not allow public republishing, so its results are
      shown to approved accounts only.{' '}
      <a href={routeHref({ view: 'account', error: null })}>Sign in</a>
    </p>
  );
}

export const sentimentLabels: Record<HnSentiment, string> = {
  positive: 'Positive',
  negative: 'Critical',
  mixed: 'Mixed',
  neutral: 'Neutral',
  unclear: 'Unclear',
};
const barOrder: HnSentiment[] = [
  'positive',
  'mixed',
  'negative',
  'neutral',
  'unclear',
];

export function tallyTitle(tally: Tally) {
  return barOrder
    .filter((sentiment) => tally[sentiment] > 0)
    .map(
      (sentiment) =>
        `${sentimentLabels[sentiment]} ${tally[sentiment].toLocaleString()}`,
    )
    .join(' · ');
}

export function SentimentBar({ tally }: { tally: Tally }) {
  const total = barOrder.reduce((sum, key) => sum + tally[key], 0);
  if (total === 0) return <span className="rd-bar rd-bar-empty" />;
  return (
    <span className="rd-bar" role="img" aria-label={tallyTitle(tally)}>
      {barOrder.map(
        (sentiment) =>
          tally[sentiment] > 0 && (
            <i
              key={sentiment}
              className={`rd-s-${sentiment}`}
              style={{ flexGrow: tally[sentiment] }}
              title={`${sentimentLabels[sentiment]} ${tally[sentiment].toLocaleString()}`}
            />
          ),
      )}
    </span>
  );
}

// Positive share of clearly positive or negative comments, or a dash when
// fewer than `minimum` such comments exist.
export function ShareText({
  tally,
  minimum = 20,
}: {
  tally: Tally;
  minimum?: number;
}) {
  const share = positiveShare(tally, minimum);
  return share === null ? (
    <span
      className="rd-muted"
      title={`Fewer than ${minimum} clearly positive or critical comments`}
    >
      —
    </span>
  ) : (
    <span
      title={`${tally.positive.toLocaleString()} positive of ${(tally.positive + tally.negative).toLocaleString()} clearly positive or critical`}
    >
      {percent(share)}
    </span>
  );
}

export function Sparkline({
  values,
  width = 104,
  height = 22,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
}) {
  const top = Math.max(1, ...values);
  const step = width / Math.max(1, values.length);
  return (
    <svg
      className="rd-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {values.map((value, week) => {
        const bar = value === 0 ? 0 : Math.max(1, (value / top) * height);
        return (
          <rect
            key={week}
            x={week * step}
            y={height - bar}
            width={Math.max(1, step - 1)}
            height={bar}
          />
        );
      })}
    </svg>
  );
}

export type WeekRange = { from: number; to: number };
const monthFormat = new Intl.DateTimeFormat('en-AU', {
  month: 'short',
  timeZone: 'UTC',
});

// Comments per week. Pass `segments` to stack each bar by sentiment.
export function WeekChart({
  weekStarts,
  values,
  segments,
  selected,
  onSelect,
  height = 112,
}: {
  weekStarts: readonly string[];
  values: readonly number[];
  segments?: readonly Tally[];
  selected: WeekRange | null;
  onSelect: (range: WeekRange | null) => void;
  height?: number;
}) {
  const slot = 26;
  const width = Math.max(1, weekStarts.length) * slot;
  const top = Math.max(1, ...values);
  function choose(week: number, extend: boolean) {
    if (extend && selected)
      onSelect({
        from: Math.min(selected.from, week),
        to: Math.max(selected.to, week),
      });
    else if (selected && selected.from === week && selected.to === week)
      onSelect(null);
    else onSelect({ from: week, to: week });
  }
  return (
    <div className="rd-weeks">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
        role="group"
        aria-label="Comments per week. Select a week to filter; shift-select to extend the range."
      >
        {weekStarts.map((start, week) => {
          const value = values[week] ?? 0;
          const tally = segments?.[week];
          const inRange =
            selected !== null && week >= selected.from && week <= selected.to;
          let offset = height;
          const label = `Week of ${weekLabel(start)}: ${value.toLocaleString()} comments`;
          return (
            <g
              key={start}
              className={
                selected === null || inRange ? 'rd-week' : 'rd-week rd-week-dim'
              }
              role="button"
              tabIndex={0}
              aria-pressed={inRange}
              aria-label={label}
              onClick={(event: MouseEvent) => choose(week, event.shiftKey)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                choose(week, event.shiftKey);
              }}
            >
              <title>{tally ? `${label} · ${tallyTitle(tally)}` : label}</title>
              <rect
                className="rd-week-hit"
                x={week * slot}
                y={0}
                width={slot}
                height={height}
              />
              {tally ? (
                barOrder.map((sentiment) => {
                  const size = (tally[sentiment] / top) * height;
                  offset -= size;
                  return (
                    size > 0 && (
                      <rect
                        key={sentiment}
                        className={`rd-s-${sentiment}`}
                        x={week * slot + 3}
                        y={offset}
                        width={slot - 6}
                        height={size}
                      />
                    )
                  );
                })
              ) : (
                <rect
                  className="rd-week-bar"
                  x={week * slot + 3}
                  y={height - (value / top) * height}
                  width={slot - 6}
                  height={(value / top) * height}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div
        className="rd-weeks-axis"
        style={{ gridTemplateColumns: `repeat(${weekStarts.length}, 1fr)` }}
        aria-hidden="true"
      >
        {weekStarts.map(
          (start, week) =>
            (week === 0 ||
              weekStarts[week - 1]?.slice(5, 7) !== start.slice(5, 7)) && (
              <span key={start} style={{ gridColumnStart: week + 1 }}>
                {monthFormat.format(new Date(`${start}T00:00:00Z`))}
              </span>
            ),
        )}
      </div>
    </div>
  );
}

export function rangeLabel(weekStarts: readonly string[], range: WeekRange) {
  const from = weekStarts[range.from];
  const to = weekStarts[range.to];
  if (!from || !to) return '';
  return range.from === range.to
    ? `Week of ${weekLabel(from)}`
    : `${weekLabel(from)} to week of ${weekLabel(to)}`;
}

const itemCache = new Map<number, HnItem>();

function useItems(rows: readonly IndexedComment[]) {
  const [, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const missing = rows.filter((row) => !itemCache.has(row.id));
    if (missing.length === 0) return;
    const controller = new AbortController();
    setFailed(false);
    readHnItems(missing, controller.signal).then(
      (comments) => {
        if (controller.signal.aborted) return;
        for (const comment of comments)
          if (!comment.item.loadError)
            itemCache.set(comment.item.id, comment.item);
        if (comments.some((comment) => comment.item.loadError)) setFailed(true);
        setVersion((version) => version + 1);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [rows, attempt]);
  return { failed, retry: () => setAttempt((value) => value + 1) };
}

function ThreadContext({ id }: { id: number }) {
  const [thread, setThread] = useState<HnThread | 'failed' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readHnThread(id, controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) setThread(loaded);
      },
      () => {
        if (!controller.signal.aborted) setThread('failed');
      },
    );
    return () => controller.abort();
  }, [id]);
  if (thread === null) return <p className="rd-note">Loading thread…</p>;
  if (thread === 'failed')
    return <p className="rd-note">Could not load the thread.</p>;
  const story = thread.ancestors.find((item) => item.type === 'story');
  const parent = thread.ancestors.at(-1);
  return (
    <div className="rd-thread">
      {story?.title && (
        <p>
          <span className="rd-thread-label">Story</span>
          <a
            href={`https://news.ycombinator.com/item?id=${story.id}`}
            target="_blank"
            rel="noreferrer"
          >
            {story.title}
          </a>
        </p>
      )}
      {parent && parent.type === 'comment' && parent.text && (
        <p>
          <span className="rd-thread-label">Replying to</span>
          <span className="rd-thread-parent">{parent.text}</span>
        </p>
      )}
      {!story?.title && !(parent?.type === 'comment' && parent.text) && (
        <p className="rd-note">No thread context available.</p>
      )}
    </div>
  );
}

function CommentItem({
  row,
  focusKey,
  onPickTarget,
}: {
  row: IndexedComment;
  focusKey: string | null;
  onPickTarget?: (key: string) => void;
}) {
  const item = itemCache.get(row.id);
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState(false);
  const labels = useMemo(
    () =>
      [...row.assessments].sort(
        (a, b) => Number(b.key === focusKey) - Number(a.key === focusKey),
      ),
    [row, focusKey],
  );
  const long = (item?.text.length ?? 0) > 700;
  return (
    <article className="rd-comment">
      <header>
        <time dateTime={row.createdAt}>{formatHnDate(row.createdAt)}</time>
        <ul aria-label="Automatic labels">
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
                className={
                  label.key === focusKey ? 'rd-label-focus' : undefined
                }
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
        <a
          href={`https://news.ycombinator.com/item?id=${row.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Open on Hacker News"
        >
          HN <ArrowUpRight size={12} />
        </a>
      </header>
      {!item ? (
        <p className="rd-note">Loading…</p>
      ) : item.deleted || item.unavailable || !item.text ? (
        <p className="rd-note">No longer available on Hacker News.</p>
      ) : (
        <p
          className={long && !expanded ? 'rd-text rd-text-clamped' : 'rd-text'}
        >
          {item.text}
        </p>
      )}
      <footer>
        {long && (
          <button type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
        <button
          type="button"
          aria-expanded={context}
          onClick={() => setContext(!context)}
        >
          {context ? 'Hide thread' : 'Thread'}
        </button>
        {item && item.replyCount > 0 && (
          <span>
            {item.replyCount.toLocaleString()}{' '}
            {item.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        )}
      </footer>
      {context && <ThreadContext id={row.id} />}
    </article>
  );
}

// Comments matching the filter, newest first. Text is fetched page by page.
export function CommentStream({
  index,
  filter,
  focusKey,
  onPickTarget,
  pageSize = 8,
}: {
  index: CommentIndex;
  filter: HnFilter;
  focusKey: string | null;
  onPickTarget?: (key: string) => void;
  pageSize?: number;
}) {
  const matches = useMemo(() => filterComments(index, filter), [index, filter]);
  const [shown, setShown] = useState({ filter, count: pageSize });
  const count = shown.filter === filter ? shown.count : pageSize;
  const rows = useMemo(() => matches.slice(0, count), [matches, count]);
  const { failed, retry } = useItems(rows);
  return (
    <div className="rd-stream">
      <p className="rd-stream-count" role="status">
        {matches.length === 0
          ? 'No comments match.'
          : `${matches.length.toLocaleString()} ${matches.length === 1 ? 'comment' : 'comments'}, newest first`}
      </p>
      {rows.map((row) => (
        <CommentItem
          key={row.id}
          row={row}
          focusKey={focusKey}
          onPickTarget={onPickTarget}
        />
      ))}
      {failed && (
        <p className="rd-note" role="status">
          Some comments could not be loaded from Hacker News.{' '}
          <button type="button" className="rd-link" onClick={retry}>
            Retry
          </button>
        </p>
      )}
      {matches.length > count && (
        <button
          type="button"
          className="rd-more"
          onClick={() => setShown({ filter, count: count + pageSize })}
        >
          Show {Math.min(pageSize, matches.length - count)} more
        </button>
      )}
    </div>
  );
}
