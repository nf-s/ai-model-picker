import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { hnAspects, hnTasks, hnThemes } from '../lib/hn-index';
import type { HnAspect, HnTask, HnTheme } from '../lib/hn-index';
import {
  parseTargetKey,
  positiveShare,
  rankTargets,
  summariseSlice,
  tallyTotal,
  themeLabel,
} from '../lib/hn-insights';
import type {
  HnConfidence,
  HnFilter,
  HnSentiment,
  Tally,
} from '../lib/hn-insights';
import type { Scope } from '../lib/model-filter';
import { keyName, keysRelated } from '../lib/site-data';
import type { HnData } from '../lib/site-data';
import Threads from './comment-views/Threads';
import {
  rangeLabel,
  SentimentBar,
  sentimentLabels,
  ShareText,
  WeekChart,
} from './parts';
import type { WeekRange } from './parts';
import { routeHref } from '../lib/route';
import './discussion.css';

type ReadyHn = Extract<HnData, { status: 'ready' }>;
type RankOrder = 'comments' | 'positive' | 'critical';
const sentiments: HnSentiment[] = [
  'positive',
  'negative',
  'mixed',
  'neutral',
  'unclear',
];
const confidences: HnConfidence[] = ['high', 'medium', 'low'];
const rankMinimum = 10;

function Facet<T extends string>({
  title,
  note,
  options,
  value,
  onChange,
}: {
  title: string;
  note?: string;
  options: { value: T; label: string; count: number; swatch?: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const widest = Math.max(1, ...options.map((option) => option.count));
  return (
    <fieldset className="rd-dx-facet">
      <legend className="rd-h">{title}</legend>
      {note && <p className="rd-note">{note}</p>}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(value === option.value ? null : option.value)}
        >
          {option.swatch && <i className={option.swatch} aria-hidden="true" />}
          <span>{option.label}</span>
          <span className="rd-dx-facet-count">
            {option.count.toLocaleString()}
          </span>
          <span
            className="rd-dx-facet-bar"
            style={{ width: `${(option.count / widest) * 100}%` }}
            aria-hidden="true"
          />
        </button>
      ))}
    </fieldset>
  );
}

function Explorer({
  hn,
  initialTarget,
  filtered,
}: {
  hn: ReadyHn;
  initialTarget: string | null;
  filtered: boolean;
}) {
  const { index, insights } = hn;
  const lastWeek = insights.weekStarts.length - 1;
  const [target, setTarget] = useState<string | null>(
    initialTarget && insights.targets.has(initialTarget) ? initialTarget : null,
  );
  const [alongside, setAlongside] = useState<string | null>(null);
  const [sentiment, setSentiment] = useState<HnSentiment | null>(null);
  const [aspect, setAspect] = useState<HnAspect | null>(null);
  const [theme, setTheme] = useState<HnTheme | null>(null);
  const [task, setTask] = useState<HnTask | null>(null);
  const [confidence, setConfidence] = useState<HnConfidence | null>(null);
  const [range, setRange] = useState<WeekRange | null>(null);
  const [query, setQuery] = useState('');
  const [rankKind, setRankKind] = useState<'model' | 'family'>('model');
  const [order, setOrder] = useState<RankOrder>('comments');

  const filter = useMemo<HnFilter>(
    () => ({
      target,
      alongside,
      sentiment,
      aspect,
      theme,
      task,
      confidence,
      fromWeek: range?.from ?? null,
      toWeek: range?.to ?? null,
    }),
    [target, alongside, sentiment, aspect, theme, task, confidence, range],
  );
  // Each facet is counted with its own selection lifted, so the alternatives
  // stay visible.
  const slice = useMemo(() => summariseSlice(index, filter), [index, filter]);
  const timeline = useMemo(
    () => summariseSlice(index, { ...filter, fromWeek: null, toWeek: null }),
    [index, filter],
  );
  const bySentiment = useMemo(
    () => summariseSlice(index, { ...filter, sentiment: null }).tally,
    [index, filter],
  );
  const byAspect = useMemo(
    () => summariseSlice(index, { ...filter, aspect: null }).aspects,
    [index, filter],
  );
  const byTheme = useMemo(
    () => summariseSlice(index, { ...filter, theme: null }).themes,
    [index, filter],
  );
  const byTask = useMemo(
    () => summariseSlice(index, { ...filter, task: null }).tasks,
    [index, filter],
  );
  const byConfidence = useMemo(() => {
    const counts: Record<HnConfidence, number> = { high: 0, medium: 0, low: 0 };
    for (const level of confidences)
      counts[level] = summariseSlice(index, {
        ...filter,
        confidence: level,
      }).total;
    return counts;
  }, [index, filter]);
  // Without a target: every target in the slice. With one: what is labelled
  // in the same comments.
  const ranked = useMemo(() => {
    const tallies = rankTargets(
      index,
      target ? { ...filter, alongside: target } : filter,
    );
    const rows: { key: string; tally: Tally; total: number }[] = [];
    for (const [key, tally] of tallies) {
      if (parseTargetKey(key)?.kind !== rankKind) continue;
      if (target && (key === target || keysRelated(key, target))) continue;
      rows.push({ key, tally, total: tallyTotal(tally) });
    }
    const share = (tally: Tally) => positiveShare(tally, rankMinimum);
    return rows.sort((a, b) => {
      const first = share(a.tally);
      const second = share(b.tally);
      if (order === 'comments' || first === second) return b.total - a.total;
      if (first === null || second === null)
        return Number(first === null) - Number(second === null);
      return order === 'positive' ? second - first : first - second;
    });
  }, [index, filter, target, rankKind, order]);
  const wanted = query.trim().toLowerCase();
  const found = wanted
    ? [...insights.targets.values()]
        .filter((insight) =>
          keyName(insight.key).toLowerCase().includes(wanted),
        )
        .sort((a, b) => b.total - a.total)
        .slice(0, 8)
    : [];
  const active =
    target !== null ||
    alongside !== null ||
    sentiment !== null ||
    aspect !== null ||
    theme !== null ||
    task !== null ||
    confidence !== null ||
    range !== null;
  function reset() {
    setTarget(null);
    setAlongside(null);
    setSentiment(null);
    setAspect(null);
    setTheme(null);
    setTask(null);
    setConfidence(null);
    setRange(null);
  }
  function pick(key: string) {
    if (target === null) setTarget(key);
    else if (key !== target) setAlongside(key);
    setQuery('');
  }
  const periods: { label: string; range: WeekRange | null }[] = [
    { label: 'All', range: null },
    { label: '4 weeks', range: { from: lastWeek - 3, to: lastWeek } },
    { label: '12 weeks', range: { from: lastWeek - 11, to: lastWeek } },
  ];
  return (
    <div className="rd-dx">
      <aside className="rd-dx-side" aria-label="Filters">
        <div className="rd-dx-find">
          <label className="rd-h" htmlFor="rd-dx-search">
            Model or family
          </label>
          <input
            id="rd-dx-search"
            className="rd-input"
            type="search"
            placeholder="Find by name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {found.length > 0 && (
            <ul>
              {found.map((insight) => (
                <li key={insight.key}>
                  <button type="button" onClick={() => pick(insight.key)}>
                    <span>{keyName(insight.key)}</span>
                    <span className="rd-muted">
                      {insight.kind} · {insight.total.toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {wanted && found.length === 0 && <p className="rd-note">No match.</p>}
        </div>
        <Facet
          title="Sentiment"
          options={sentiments.map((value) => ({
            value,
            label: sentimentLabels[value],
            count: bySentiment[value],
            swatch: `rd-s-${value}`,
          }))}
          value={sentiment}
          onChange={setSentiment}
        />
        {index.detailed ? (
          <>
            <Facet
              title="Theme"
              note="What the comment says about the model."
              options={hnThemes
                .map((value) => ({
                  value,
                  label: themeLabel(value),
                  count: byTheme.get(value) ?? 0,
                }))
                .filter((option) => option.count > 0 || option.value === theme)
                .sort((a, b) => b.count - a.count)}
              value={theme}
              onChange={setTheme}
            />
            <Facet
              title="Task"
              note="What the commenter was doing."
              options={hnTasks
                .map((value) => ({
                  value,
                  label: value,
                  count: byTask.get(value) ?? 0,
                }))
                .filter((option) => option.count > 0 || option.value === task)
                .sort(
                  (a, b) =>
                    Number(a.value === 'other') - Number(b.value === 'other') ||
                    b.count - a.count,
                )}
              value={task}
              onChange={setTask}
            />
          </>
        ) : (
          <Facet
            title="Topic tag"
            note="Automatic and coarse."
            options={hnAspects
              .map((value) => ({
                value,
                label: value,
                count: byAspect[value],
              }))
              .sort((a, b) => b.count - a.count)}
            value={aspect}
            onChange={setAspect}
          />
        )}
        <Facet
          title="Label confidence"
          options={confidences.map((value) => ({
            value,
            label: value,
            count: byConfidence[value],
          }))}
          value={confidence}
          onChange={setConfidence}
        />
      </aside>
      <div className="rd-dx-main">
        <section className="rd-panel rd-dx-time" aria-label="Period">
          <div className="rd-dx-time-head">
            <p>
              <strong>{slice.total.toLocaleString()}</strong>{' '}
              {slice.total === 1 ? 'comment' : 'comments'}
              {range && (
                <span className="rd-muted">
                  {' '}
                  · {rangeLabel(insights.weekStarts, range)}
                </span>
              )}
            </p>
            <div className="rd-seg" role="group" aria-label="Period">
              {periods.map((period) => (
                <button
                  key={period.label}
                  type="button"
                  aria-pressed={
                    period.range === null
                      ? range === null
                      : range?.from === period.range.from &&
                        range.to === period.range.to
                  }
                  onClick={() => setRange(period.range)}
                >
                  {period.label}
                </button>
              ))}
            </div>
          </div>
          <WeekChart
            weekStarts={insights.weekStarts}
            values={timeline.weeks}
            selected={range}
            onSelect={setRange}
            height={88}
          />
        </section>
        <div className="rd-chips" role="group" aria-label="Active filters">
          {target ? (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => {
                setTarget(alongside);
                setAlongside(null);
              }}
            >
              {keyName(target)} <X size={12} />
            </button>
          ) : (
            <span className="rd-chip">
              {filtered
                ? 'All models and families in the filter'
                : 'All models and families'}
            </span>
          )}
          {alongside && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setAlongside(null)}
            >
              with {keyName(alongside)} <X size={12} />
            </button>
          )}
          {sentiment && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setSentiment(null)}
            >
              {sentimentLabels[sentiment]} <X size={12} />
            </button>
          )}
          {aspect && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setAspect(null)}
            >
              Topic: {aspect} <X size={12} />
            </button>
          )}
          {theme && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setTheme(null)}
            >
              Theme: {themeLabel(theme)} <X size={12} />
            </button>
          )}
          {task && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setTask(null)}
            >
              Task: {task} <X size={12} />
            </button>
          )}
          {confidence && (
            <button
              type="button"
              className="rd-chip rd-chip-active"
              onClick={() => setConfidence(null)}
            >
              {confidence} confidence <X size={12} />
            </button>
          )}
          {active && (
            <button type="button" className="rd-link" onClick={reset}>
              Clear all
            </button>
          )}
          {target && (
            <a href={routeHref({ view: 'model', key: target })}>
              Open {keyName(target)} file
            </a>
          )}
        </div>
        <div className="rd-dx-columns">
          <section className="rd-panel rd-dx-rank" aria-labelledby="rd-dx-rank">
            <div className="rd-dx-rank-head">
              <h2 className="rd-h" id="rd-dx-rank">
                {target ? `Labelled with ${keyName(target)}` : 'In this slice'}
              </h2>
              <div className="rd-seg" role="group" aria-label="Rows">
                <button
                  type="button"
                  aria-pressed={rankKind === 'model'}
                  onClick={() => setRankKind('model')}
                >
                  Models
                </button>
                <button
                  type="button"
                  aria-pressed={rankKind === 'family'}
                  onClick={() => setRankKind('family')}
                >
                  Families
                </button>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th scope="col">
                    {rankKind === 'model' ? 'Model' : 'Family'}
                  </th>
                  <th
                    scope="col"
                    aria-sort={order === 'comments' ? 'descending' : 'none'}
                  >
                    <button type="button" onClick={() => setOrder('comments')}>
                      Comments
                    </button>
                  </th>
                  <th scope="col">Sentiment</th>
                  <th
                    scope="col"
                    aria-sort={
                      order === 'positive'
                        ? 'descending'
                        : order === 'critical'
                          ? 'ascending'
                          : 'none'
                    }
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setOrder(order === 'positive' ? 'critical' : 'positive')
                      }
                    >
                      Positive
                      {order === 'positive' && ' ↓'}
                      {order === 'critical' && ' ↑'}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 40).map((row) => (
                  <tr key={row.key}>
                    <th scope="row">
                      <button
                        type="button"
                        className="rd-link"
                        onClick={() => pick(row.key)}
                      >
                        {keyName(row.key)}
                      </button>
                    </th>
                    <td>{row.total.toLocaleString()}</td>
                    <td>
                      <SentimentBar tally={row.tally} />
                    </td>
                    <td>
                      <ShareText tally={row.tally} minimum={rankMinimum} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ranked.length === 0 && <p className="rd-note">None.</p>}
            {ranked.length > 40 && (
              <p className="rd-note">
                Top 40 of {ranked.length.toLocaleString()}.
              </p>
            )}
            <p className="rd-note">
              Sentiment split ignores the sentiment filter. Positive share needs{' '}
              {rankMinimum} clearly positive or critical comments.
            </p>
          </section>
          <section aria-label="Comments" className="rd-dx-stream">
            <Threads
              index={index}
              filter={filter}
              focusKey={target}
              onPickTarget={pick}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

// `hn` holds only the labels in scope, so every count, the ranking, the
// name search and the comment stream follow the model filter. The explorer
// starts over when the filter changes, because its selections may be gone.
export default function Discussion({
  hn,
  initialTarget,
  scope,
}: {
  hn: HnData;
  initialTarget: string | null;
  scope: Scope;
}) {
  if (hn.status === 'loading')
    return <p className="rd-note rd-dx-wait">Loading Hacker News comments…</p>;
  if (hn.status === 'failed') return null;
  if (scope.active && hn.index.rows.length === 0)
    return (
      <p className="rd-note rd-dx-wait">
        No collected comments are labelled with a model in the filter.
      </p>
    );
  return (
    <Explorer
      key={`${initialTarget ?? 'all'}|${scope.id}`}
      hn={hn}
      initialTarget={initialTarget}
      filtered={scope.active}
    />
  );
}
