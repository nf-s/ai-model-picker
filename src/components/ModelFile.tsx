import { useMemo, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { benchmarks, models, reports } from '../lib/data';
import type { Model } from '../lib/data';
import { formatHnDate, formatHnRange } from '../lib/hn-client';
import { hnAspects, hnTasks, hnThemes } from '../lib/hn-index';
import type { HnAspect, HnTask, HnTheme } from '../lib/hn-index';
import {
  emptyFilter,
  filterComments,
  parseTargetKey,
  positiveShare,
  relatedNames,
  tallyTotal,
  themeLabel,
} from '../lib/hn-insights';
import type {
  CommentIndex,
  HnFilter,
  HnSentiment,
  Tally,
  TargetInsight,
} from '../lib/hn-insights';
import { dollars, duration } from '../lib/metrics';
import type { Scope } from '../lib/model-filter';
import {
  appSelections,
  benchmarkLabel,
  formatPrice,
  formatScore,
  keyName,
  modelById,
  modelKey,
  momentum,
  percent,
  standing,
  standings,
} from '../lib/site-data';
import type { HnData } from '../lib/site-data';
import {
  CommentStream,
  rangeLabel,
  SentimentBar,
  sentimentLabels,
  ShareText,
  WeekChart,
} from './parts';
import type { WeekRange } from './parts';
import { RankNote } from './ModelFilter';
import ModelPapers from './ModelPapers';
import Reports from './Reports';
import { routeHref } from '../lib/route';
import { themesFor } from '../lib/hn-themes';
import type { ThemeGroup } from '../lib/hn-themes';
import './model-file.css';

type ReadyHn = Extract<HnData, { status: 'ready' }>;
const legendOrder: HnSentiment[] = [
  'positive',
  'mixed',
  'negative',
  'neutral',
  'unclear',
];
const filterSentiments: HnSentiment[] = [
  'positive',
  'negative',
  'mixed',
  'neutral',
];
// Claims listed when a theme opens, and how many "Show more" adds.
const claimPage = 8;

function Rail({
  hn,
  selected,
  scope,
}: {
  hn: HnData;
  selected: string;
  scope: Scope;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'model' | 'family'>(
    parseTargetKey(selected)?.kind ?? 'model',
  );
  const entries = useMemo(() => {
    const insights = hn.status === 'ready' ? hn.insights.targets : null;
    const rows =
      kind === 'model'
        ? models
            .filter((model) => scope.model(model.id))
            .map((model) => ({
              key: modelKey(model.id),
              name: model.name,
              detail: model.provider,
              insight: insights?.get(modelKey(model.id)) ?? null,
            }))
        : [...(insights?.values() ?? [])]
            .filter((insight) => insight.kind === 'family')
            .map((insight) => ({
              key: insight.key,
              name: insight.target,
              detail: 'Family',
              insight,
            }));
    const wanted = query.trim().toLowerCase();
    return rows
      .filter((row) => row.name.toLowerCase().includes(wanted))
      .sort(
        (a, b) =>
          (b.insight?.total ?? 0) - (a.insight?.total ?? 0) ||
          a.name.localeCompare(b.name),
      );
  }, [hn, kind, query, scope]);
  return (
    <aside className="rd-mf-rail" aria-label="Models and families">
      <div className="rd-mf-rail-controls">
        <input
          className="rd-input"
          type="search"
          placeholder="Find a model"
          aria-label="Find a model or family"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="rd-seg">
          <button
            type="button"
            aria-pressed={kind === 'model'}
            onClick={() => setKind('model')}
          >
            Models
          </button>
          <button
            type="button"
            aria-pressed={kind === 'family'}
            onClick={() => setKind('family')}
          >
            Families
          </button>
        </div>
      </div>
      <ol>
        {entries.map((entry) => (
          <li key={entry.key}>
            <a
              href={routeHref({ view: 'model', key: entry.key })}
              aria-current={entry.key === selected ? 'page' : undefined}
            >
              <span className="rd-mf-rail-name">{entry.name}</span>
              <span className="rd-mf-rail-count">
                {entry.insight ? entry.insight.total.toLocaleString() : '—'}
              </span>
              <span className="rd-mf-rail-detail">{entry.detail}</span>
              {entry.insight && <SentimentBar tally={entry.insight.tally} />}
            </a>
          </li>
        ))}
      </ol>
      {entries.length === 0 && (
        <p className="rd-note">
          {kind === 'family' && hn.status !== 'ready'
            ? 'Families come from the comment index.'
            : scope.active && kind === 'family' && !query.trim()
              ? 'Families are listed only for providers selected in the filter.'
              : 'No match.'}
        </p>
      )}
    </aside>
  );
}

function BenchmarkTiles({ model, scope }: { model: Model; scope: Scope }) {
  return (
    <section aria-labelledby="rd-mf-benchmarks">
      <h2 className="rd-h" id="rd-mf-benchmarks">
        Benchmarks
      </h2>
      {scope.active && <RankNote />}
      <div className="rd-mf-tiles">
        {benchmarks.map((benchmark) => {
          const own = standing(model.id, benchmark.id);
          const field = standings.get(benchmark.id);
          return (
            <article
              key={benchmark.id}
              className={own ? 'rd-mf-tile' : 'rd-mf-tile rd-mf-tile-empty'}
            >
              <h3>
                <a href={routeHref({ view: 'benchmark', id: benchmark.id })}>
                  {benchmarkLabel(benchmark)}
                </a>
                <span>{benchmark.category}</span>
              </h3>
              {own ? (
                <>
                  <p className="rd-mf-score">
                    <strong>{formatScore(own.result.score, benchmark)}</strong>
                    <span>
                      #{own.rank} of {own.fieldSize}
                    </span>
                  </p>
                  <div
                    className="rd-mf-strip"
                    role="img"
                    aria-label={`Rank ${own.rank} of ${own.fieldSize} models`}
                  >
                    {[...(field?.entries() ?? [])].map(([id, other]) => (
                      <i
                        key={id}
                        className={id === model.id ? 'rd-mf-strip-own' : ''}
                        style={{ left: `${other.position * 100}%` }}
                      />
                    ))}
                  </div>
                  <p className="rd-mf-config">
                    {own.result.configuration}
                    {own.configurations > 1 &&
                      ` · best of ${own.configurations}`}
                    {own.result.costUsd !== undefined &&
                      ` · ${dollars(own.result.costUsd)}`}
                    {own.result.timeSeconds !== undefined &&
                      ` · ${duration(own.result.timeSeconds)}`}
                  </p>
                </>
              ) : (
                <p className="rd-note">No published result</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ModelReports({ model }: { model: Model }) {
  const own = reports.filter((report) => report.modelIds.includes(model.id));
  if (own.length === 0) return null;
  return (
    <details className="rd-mf-reports">
      <summary className="rd-h">Reports and experiments · {own.length}</summary>
      <Reports reports={own} omitModelId={model.id} />
    </details>
  );
}

function ModelHeader({ model, hn }: { model: Model; hn: HnData }) {
  const price = formatPrice(model);
  const selections = appSelections(model.id);
  const families =
    hn.status === 'ready'
      ? [...hn.insights.targets.values()]
          .filter(
            (insight) =>
              insight.kind === 'family' &&
              relatedNames(insight.target, model.name),
          )
          .sort((a, b) => a.total - b.total)
      : [];
  return (
    <header className="rd-mf-head">
      <h1>{model.name}</h1>
      <p className="rd-mf-sub">
        {model.provider}
        {model.status && ` · ${model.status}`}
        {model.apiId && (
          <>
            {' · '}
            <code>{model.apiId}</code>
          </>
        )}
      </p>
      {model.description && <p>{model.description}</p>}
      <dl>
        {price && model.pricing && (
          <div>
            <dt>API price per 1M tokens</dt>
            <dd>
              <a href={model.pricing.url} target="_blank" rel="noreferrer">
                {price}
              </a>{' '}
              <span className="rd-muted">input / output</span>
            </dd>
          </div>
        )}
        {model.pricing?.contextTokens && (
          <div>
            <dt>Context</dt>
            <dd>
              {(model.pricing.contextTokens / 1000).toLocaleString()}K tokens
            </dd>
          </div>
        )}
        {selections.length > 0 && (
          <div>
            <dt>In the apps</dt>
            <dd>
              {selections
                .map((choice) => `${choice.surface}: ${choice.name}`)
                .join(' · ')}{' '}
              · <a href={routeHref({ view: 'apps' })}>App guide</a>
            </dd>
          </div>
        )}
        {families.length > 0 && (
          <div>
            <dt>Family discussion</dt>
            <dd>
              {families.map((family, position) => (
                <span key={family.key}>
                  {position > 0 && ' · '}
                  <a href={routeHref({ view: 'model', key: family.key })}>
                    {family.target}
                  </a>{' '}
                  <span className="rd-muted">
                    {family.total.toLocaleString()}
                  </span>
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </header>
  );
}

function FamilyHeader({
  insight,
  hn,
  scope,
}: {
  insight: TargetInsight;
  hn: ReadyHn;
  scope: Scope;
}) {
  const members = models
    .filter(
      (model) =>
        scope.model(model.id) && relatedNames(insight.target, model.name),
    )
    .map((model) => ({
      model,
      insight: hn.insights.targets.get(modelKey(model.id)),
    }))
    .sort((a, b) => (b.insight?.total ?? 0) - (a.insight?.total ?? 0));
  return (
    <header className="rd-mf-head">
      <h1>{insight.target}</h1>
      <p className="rd-mf-sub">
        Family · every collected comment that names it, with or without a
        version
      </p>
      {members.length > 0 && (
        <table className="rd-mf-members">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Comments</th>
              <th scope="col">Sentiment</th>
              <th scope="col">Positive</th>
            </tr>
          </thead>
          <tbody>
            {members.map(({ model, insight: own }) => (
              <tr key={model.id}>
                <th scope="row">
                  <a
                    href={routeHref({ view: 'model', key: modelKey(model.id) })}
                  >
                    {model.name}
                  </a>
                </th>
                <td>{own ? own.total.toLocaleString() : '—'}</td>
                <td>{own && <SentimentBar tally={own.tally} />}</td>
                <td>{own ? <ShareText tally={own.tally} /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </header>
  );
}

function ThemeRow({ group, open }: { group: ThemeGroup; open: boolean }) {
  return (
    <details className="rd-mf-theme" open={open}>
      <summary>
        <span className="rd-mf-theme-name">{group.label}</span>
        <span className="rd-mf-theme-count">{group.entries.length}</span>
        <SentimentBar tally={{ ...group.stances, unclear: 0 }} />
      </summary>
      <ul>
        {group.entries.map((entry) => (
          <li key={entry.id}>
            <i className={`rd-s-${entry.stance}`} aria-hidden="true" />
            <p>
              <span className="rd-visually-hidden">
                {sentimentLabels[entry.stance]}:{' '}
              </span>
              {entry.summary}{' '}
              <a
                href={`https://news.ycombinator.com/item?id=${entry.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {formatHnDate(entry.createdAt)}
                <ArrowUpRight size={11} />
              </a>
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Themes({ modelId }: { modelId: string }) {
  const sample = themesFor(modelId);
  if (!sample)
    return (
      <section className="rd-panel rd-mf-card">
        <h2 className="rd-h">What people say</h2>
        <p className="rd-note">
          No reviewed theme sample for this model. The automatic labels only
          record sentiment and a coarse topic.
        </p>
      </section>
    );
  const { coverage, groups, compared } = sample;
  const verdicts = [...compared.entries()]
    .map(([name, tally]) => ({ name, ...tally }))
    .sort(
      (a, b) =>
        b.better + b.worse + b.similar - (a.better + a.worse + a.similar),
    )
    .slice(0, 6);
  return (
    <section className="rd-panel rd-mf-card">
      <h2 className="rd-h">What people say</h2>
      <p className="rd-note">
        Reviewed sample: the {coverage.reviewedCommentCount} most recent of{' '}
        {coverage.collectedCommentCount.toLocaleString()} comments.{' '}
        {coverage.offTopicCount} only mention the model in passing and are left
        out. A comment can fall under several themes.
      </p>
      <div className="rd-mf-themes">
        {groups.map((group, position) => (
          <ThemeRow key={group.id} group={group} open={position === 0} />
        ))}
      </div>
      {verdicts.length > 0 && (
        <>
          <h3 className="rd-mf-subhead">Stated preferences in the sample</h3>
          <table className="rd-mf-verdicts">
            <thead>
              <tr>
                <th scope="col">Compared with</th>
                <th scope="col">Other preferred</th>
                <th scope="col">This preferred</th>
                <th scope="col">Similar</th>
              </tr>
            </thead>
            <tbody>
              {verdicts.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.name}</th>
                  <td>{row.better || '·'}</td>
                  <td>{row.worse || '·'}</td>
                  <td>{row.similar || '·'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

// With `stated`, the two sides count comments that say one is better than the
// other. Without, they are read off the two sentiment labels of one comment.
function Pairs({
  insight,
  stated,
  active,
  onPick,
}: {
  insight: TargetInsight;
  stated: boolean;
  active: string | null;
  onPick: (key: string | null) => void;
}) {
  const keys = new Set([
    ...insight.pairs.keys(),
    ...insight.preferences.keys(),
  ]);
  const rows = [...keys]
    .map((key) => {
      const pair = insight.pairs.get(key);
      const preference = insight.preferences.get(key);
      return {
        key,
        total: pair?.total ?? 0,
        behind: stated ? (preference?.under ?? 0) : (pair?.behind ?? 0),
        ahead: stated ? (preference?.over ?? 0) : (pair?.ahead ?? 0),
      };
    })
    .sort(
      (a, b) =>
        (stated ? b.ahead + b.behind - (a.ahead + a.behind) : 0) ||
        b.total - a.total,
    )
    .slice(0, 10);
  const widest = Math.max(1, ...rows.map((row) => row.ahead + row.behind));
  return (
    <section className="rd-panel rd-mf-card">
      <h2 className="rd-h">
        {stated ? 'Stated preferences' : 'Mentioned together'}
      </h2>
      <p className="rd-note">
        {stated
          ? 'Comments that say one is better than the other, beside the comments that label both.'
          : 'Comments that label both. Ahead: this positive, the other critical. Behind: the reverse.'}
      </p>
      <table className="rd-mf-pairs">
        <thead>
          <tr>
            <th scope="col">Other</th>
            <th scope="col">Comments</th>
            <th scope="col">{stated ? 'Other preferred' : 'Behind'}</th>
            <th scope="col" aria-label="Balance" />
            <th scope="col">{stated ? 'This preferred' : 'Ahead'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, ...pair }) => (
            <tr key={key}>
              <th scope="row">
                <button
                  type="button"
                  className="rd-link"
                  aria-pressed={active === key}
                  onClick={() => onPick(active === key ? null : key)}
                >
                  {keyName(key)}
                </button>
              </th>
              <td>{pair.total.toLocaleString()}</td>
              <td>{pair.behind}</td>
              <td>
                <span className="rd-mf-balance" aria-hidden="true">
                  <i
                    className="rd-s-negative"
                    style={{ width: `${(pair.behind / widest) * 50}%` }}
                  />
                  <i
                    className="rd-s-positive"
                    style={{ width: `${(pair.ahead / widest) * 50}%` }}
                  />
                </span>
              </td>
              <td>{pair.ahead}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="rd-note">None.</p>}
    </section>
  );
}

// Sentiment toward the target split by one property of its comments. A row
// filters the comment stream.
function Breakdown<Value extends string>({
  title,
  note,
  heading,
  rows,
  active,
  onPick,
}: {
  title: string;
  note: string;
  heading: string;
  rows: { value: Value; tally: Tally }[];
  active: Value | null;
  onPick: (value: Value | null) => void;
}) {
  return (
    <section className="rd-panel rd-mf-card">
      <h2 className="rd-h">{title}</h2>
      <p className="rd-note">{note}</p>
      <table className="rd-mf-topics">
        <thead>
          <tr>
            <th scope="col">{heading}</th>
            <th scope="col">Comments</th>
            <th scope="col">Sentiment</th>
            <th scope="col">Positive</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ value, tally }) => (
            <tr key={value}>
              <th scope="row">
                <button
                  type="button"
                  className="rd-link"
                  aria-pressed={active === value}
                  onClick={() => onPick(active === value ? null : value)}
                >
                  {value}
                </button>
              </th>
              <td>{tallyTotal(tally).toLocaleString()}</td>
              <td>
                <SentimentBar tally={tally} />
              </td>
              <td>
                <ShareText tally={tally} minimum={10} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="rd-note">None.</p>}
    </section>
  );
}

function Topics({
  insight,
  active,
  onPick,
}: {
  insight: TargetInsight;
  active: HnAspect | null;
  onPick: (aspect: HnAspect | null) => void;
}) {
  return (
    <Breakdown
      title="Automatic topic tags"
      note="Coarse: “reliability” and “design” are applied to about half of all comments."
      heading="Topic"
      rows={hnAspects
        .map((value) => ({ value, tally: insight.aspects[value] }))
        .sort((a, b) => tallyTotal(b.tally) - tallyTotal(a.tally))}
      active={active}
      onPick={onPick}
    />
  );
}

function Tasks({
  insight,
  active,
  onPick,
}: {
  insight: TargetInsight;
  active: HnTask | null;
  onPick: (task: HnTask | null) => void;
}) {
  return (
    <Breakdown
      title="By task"
      note="What the commenter was doing. “Other” covers comments about no particular task."
      heading="Task"
      rows={hnTasks
        .flatMap((value) => {
          const tally = insight.tasks.get(value);
          return tally ? [{ value, tally }] : [];
        })
        .sort(
          (a, b) =>
            Number(a.value === 'other') - Number(b.value === 'other') ||
            tallyTotal(b.tally) - tallyTotal(a.tally),
        )}
      active={active}
      onPick={onPick}
    />
  );
}

// One theme of a target: its sentiment split and, once opened, the claims of
// the comments under it, newest first.
function SaidTheme({
  index,
  target,
  theme,
  tally,
  start,
  active,
  onPick,
}: {
  index: CommentIndex;
  target: string;
  theme: HnTheme;
  tally: Tally;
  start: boolean;
  active: boolean;
  onPick: (theme: HnTheme | null) => void;
}) {
  const [open, setOpen] = useState(start);
  const [count, setCount] = useState(claimPage);
  const rows = useMemo(
    () =>
      open
        ? filterComments(index, { ...emptyFilter, target, theme }).filter(
            (row) => row.claim !== undefined,
          )
        : [],
    [open, index, target, theme],
  );
  return (
    <details
      className="rd-mf-theme"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="rd-mf-theme-name">{themeLabel(theme)}</span>
        <span className="rd-mf-theme-count">
          {tallyTotal(tally).toLocaleString()}
        </span>
        <SentimentBar tally={tally} />
        <span className="rd-mf-theme-share">
          <ShareText tally={tally} minimum={10} />
        </span>
      </summary>
      {open && (
        <>
          <ul>
            {rows.slice(0, count).map((row) => {
              const sentiment =
                row.assessments.find((label) => label.key === target)
                  ?.sentiment ?? 'unclear';
              return (
                <li key={row.id}>
                  <i className={`rd-s-${sentiment}`} aria-hidden="true" />
                  <p>
                    <span className="rd-visually-hidden">
                      {sentimentLabels[sentiment]}:{' '}
                    </span>
                    {row.claim}{' '}
                    <a
                      href={`https://news.ycombinator.com/item?id=${row.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {formatHnDate(row.createdAt)}
                      <ArrowUpRight size={11} />
                    </a>
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="rd-mf-theme-actions">
            {rows.length > count && (
              <button
                type="button"
                className="rd-link"
                onClick={() => setCount(count + claimPage)}
              >
                Show {Math.min(claimPage, rows.length - count)} more
              </button>
            )}
            <button
              type="button"
              className="rd-link"
              aria-pressed={active}
              onClick={() => onPick(active ? null : theme)}
            >
              {active ? 'Stop filtering the comments' : 'Filter the comments'}
            </button>
          </p>
        </>
      )}
    </details>
  );
}

// What the classifier recorded for every comment about the target: themes
// with their sentiment, each opening into one-sentence claims.
function Said({
  index,
  insight,
  active,
  onPick,
}: {
  index: CommentIndex;
  insight: TargetInsight;
  active: HnTheme | null;
  onPick: (theme: HnTheme | null) => void;
}) {
  const rows = hnThemes
    .flatMap((theme) => {
      const tally = insight.themes.get(theme);
      return tally ? [{ theme, tally }] : [];
    })
    .sort((a, b) => tallyTotal(b.tally) - tallyTotal(a.tally));
  return (
    <section className="rd-panel rd-mf-card">
      <h2 className="rd-h">What people say</h2>
      <p className="rd-note">
        Themes and one-sentence claims written by the classifier, newest first.
        A comment can fall under up to three themes.
      </p>
      {rows.length === 0 ? (
        <p className="rd-note">None.</p>
      ) : (
        <div className="rd-mf-themes rd-mf-said">
          <div className="rd-mf-said-cols" aria-hidden="true">
            <span>Theme</span>
            <span>Comments</span>
            <span>Sentiment</span>
            <span>Positive</span>
          </div>
          {rows.map(({ theme, tally }, position) => (
            <SaidTheme
              key={theme}
              index={index}
              target={insight.key}
              theme={theme}
              tally={tally}
              start={position === 0}
              active={active === theme}
              onPick={onPick}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HnSection({
  hn,
  insight,
  modelId,
}: {
  hn: ReadyHn;
  insight: TargetInsight;
  modelId: string | null;
}) {
  const [sentiment, setSentiment] = useState<HnSentiment | null>(null);
  const [aspect, setAspect] = useState<HnAspect | null>(null);
  const [theme, setTheme] = useState<HnTheme | null>(null);
  const [task, setTask] = useState<HnTask | null>(null);
  const [alongside, setAlongside] = useState<string | null>(null);
  const [range, setRange] = useState<WeekRange | null>(null);
  const { detailed } = hn.index;
  const filter = useMemo<HnFilter>(
    () => ({
      ...emptyFilter,
      target: insight.key,
      sentiment,
      aspect,
      theme,
      task,
      alongside,
      fromWeek: range?.from ?? null,
      toWeek: range?.to ?? null,
    }),
    [insight.key, sentiment, aspect, theme, task, alongside, range],
  );
  const share = positiveShare(insight.tally, 20);
  const trend = momentum(insight);
  const weekly = insight.weeks.map(tallyTotal);
  return (
    <section aria-labelledby="rd-mf-hn" className="rd-mf-hn">
      <h2 className="rd-h" id="rd-mf-hn">
        Hacker News
      </h2>
      <div className="rd-panel rd-mf-card">
        <p className="rd-mf-hn-summary">
          <strong>{insight.total.toLocaleString()}</strong> comments
          {hn.startAt && hn.endAt && (
            <span className="rd-muted">
              {' '}
              · {formatHnRange(hn.startAt, hn.endAt)}
            </span>
          )}
          {share !== null && (
            <>
              {' · '}
              <strong>{percent(share)}</strong> positive of{' '}
              {(
                insight.tally.positive + insight.tally.negative
              ).toLocaleString()}{' '}
              clearly positive or critical
            </>
          )}
          {trend && (
            <>
              {' · last 4 weeks '}
              <strong>{percent(trend.recent)}</strong>
              <span className="rd-muted">
                {' '}
                ({trend.change >= 0 ? '+' : '−'}
                {Math.abs(Math.round(trend.change * 100))} pts on the 4 before)
              </span>
            </>
          )}
        </p>
        <SentimentBar tally={insight.tally} />
        <WeekChart
          weekStarts={hn.insights.weekStarts}
          values={weekly}
          segments={insight.weeks}
          selected={range}
          onSelect={setRange}
        />
        <ul className="rd-legend">
          {legendOrder.map((key) => (
            <li key={key}>
              <i className={`rd-s-${key}`} />
              {sentimentLabels[key]} {insight.tally[key].toLocaleString()}
            </li>
          ))}
          <li className="rd-muted">Select a week to filter the comments.</li>
        </ul>
      </div>
      <div className="rd-mf-columns">
        {detailed ? (
          <Said
            index={hn.index}
            insight={insight}
            active={theme}
            onPick={setTheme}
          />
        ) : modelId ? (
          <Themes modelId={modelId} />
        ) : null}
        <div className="rd-mf-stack">
          <Pairs
            insight={insight}
            stated={detailed}
            active={alongside}
            onPick={setAlongside}
          />
          {detailed ? (
            <Tasks insight={insight} active={task} onPick={setTask} />
          ) : (
            <Topics insight={insight} active={aspect} onPick={setAspect} />
          )}
        </div>
      </div>
      <h2 className="rd-h">Comments</h2>
      <div className="rd-chips" role="group" aria-label="Comment filters">
        <button
          type="button"
          className="rd-chip"
          aria-pressed={sentiment === null}
          onClick={() => setSentiment(null)}
        >
          All
        </button>
        {filterSentiments.map((value) => (
          <button
            key={value}
            type="button"
            className="rd-chip"
            aria-pressed={sentiment === value}
            onClick={() => setSentiment(sentiment === value ? null : value)}
          >
            <i className={`rd-s-${value}`} aria-hidden="true" />
            {sentimentLabels[value]}
            <small>{insight.tally[value].toLocaleString()}</small>
          </button>
        ))}
        {range && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => setRange(null)}
          >
            {rangeLabel(hn.insights.weekStarts, range)} <X size={12} />
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
        {alongside && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => setAlongside(null)}
          >
            With {keyName(alongside)} <X size={12} />
          </button>
        )}
      </div>
      <CommentStream
        index={hn.index}
        filter={filter}
        focusKey={insight.key}
        onPickTarget={setAlongside}
      />
    </section>
  );
}

// `hn` holds only the labels in scope; the caller keeps an opened model or
// family in scope even when the filter leaves it out.
export default function ModelFile({
  hn,
  selected,
  scope,
}: {
  hn: HnData;
  selected: string | null;
  scope: Scope;
}) {
  const fallback = useMemo(() => {
    const listed = models.filter((model) => scope.model(model.id));
    const current = listed.filter((model) => model.status === 'current');
    const pool = current.length > 0 ? current : listed;
    const insights = hn.status === 'ready' ? hn.insights.targets : null;
    const best = [...pool].sort(
      (a, b) =>
        (insights?.get(modelKey(b.id))?.total ?? 0) -
        (insights?.get(modelKey(a.id))?.total ?? 0),
    )[0];
    return best ? modelKey(best.id) : null;
  }, [hn, scope]);
  const key = selected ?? fallback;
  const ref = key ? parseTargetKey(key) : null;
  const model = ref?.kind === 'model' ? modelById.get(ref.target) : undefined;
  const insight =
    key && hn.status === 'ready' ? hn.insights.targets.get(key) : undefined;
  return (
    <div className="rd-mf">
      {key && <Rail key={ref?.kind} hn={hn} selected={key} scope={scope} />}
      <div className="rd-mf-main">
        {model && <ModelHeader model={model} hn={hn} />}
        {!model && insight && hn.status === 'ready' && (
          <FamilyHeader insight={insight} hn={hn} scope={scope} />
        )}
        {!model && !insight && hn.status !== 'loading' && (
          <p className="rd-note">Nothing is recorded under this name.</p>
        )}
        {model && <BenchmarkTiles model={model} scope={scope} />}
        {model && <ModelReports model={model} />}
        {key && <ModelPapers key={key} target={key} />}
        {hn.status === 'loading' && (
          <p className="rd-note">Loading Hacker News comments…</p>
        )}
        {hn.status === 'ready' && insight && (
          <HnSection
            key={`${insight.key}|${scope.id}`}
            hn={hn}
            insight={insight}
            modelId={model?.id ?? null}
          />
        )}
        {hn.status === 'ready' && model && !insight && (
          <p className="rd-note">
            No collected Hacker News comments name this model.
          </p>
        )}
      </div>
    </div>
  );
}
