import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Access } from '../lib/access';
import {
  benchmarkKind,
  briefFilters,
  chooserRows,
  computeBrief,
  costUnit,
  crowdCommentIds,
  findJob,
  guideSelections,
  lowerCostMissing,
  orderExplanation,
  orderRules,
  plural,
  signalLabel,
  usageForJob,
} from '../lib/brief';
import type {
  Benchmark,
  Brief as BriefResult,
  BriefData,
  BriefRow,
  Signal,
  SignalValue,
  WithinOverlap,
} from '../lib/brief';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { CoreJob, CoreModel, CoreUsage } from '../lib/core-schema';
import { guide } from '../lib/guide';
import { dollars } from '../lib/metrics';
import type { FilterBar, Scope } from '../lib/model-filter';
import { modelHref, routeHref } from '../lib/route';
import Bands, {
  BenchmarkName,
  commentSpec,
  measuredSpec,
  preferenceIds,
  RecordsStatus,
} from './Bands';
import type { BandContext } from './Bands';
import { EvidenceButton } from './EvidenceDrawer';
import type { EvidenceSpec } from './EvidenceDrawer';
import { formatDay } from './FilterBar';
import { RankNote } from './ModelFilter';
import './brief.css';

type Context = BandContext;

function priceText(model: CoreModel) {
  return model.input === null || model.output === null
    ? 'no verified API price'
    : `${dollars(model.input)} in / ${dollars(model.output)} out per million tokens`;
}

// The records behind one value in the table or a card.
function valueSpec(
  ctx: Context,
  brief: BriefResult,
  signal: Signal,
  model: CoreModel,
  value: SignalValue,
): EvidenceSpec {
  if (signal.kind === 'benchmark')
    return measuredSpec(
      ctx.data,
      `${model.name} · ${signal.benchmark.name}`,
      value.records,
      `${signal.benchmark.what} The best configuration is listed first.`,
    );
  if (signal.kind === 'preferences')
    return commentSpec(
      `${model.name} · stated preferences · ${brief.job.label}`,
      preferenceIds(value.preferences),
      null,
      '',
      'Comments on this job that say one named model is better than another, where this model is one of the two. Labels are automatic.',
    );
  return commentSpec(
    `${model.name} · Hacker News · ${brief.job.label}`,
    crowdCommentIds(ctx.data, brief.job.id),
    `model:${model.id}`,
    ctx.filters.since,
    'Every comment labelled for this model in this job. Labels are automatic.',
  );
}

export default function Brief({
  job,
  coreData,
  filter,
  onFilterChange,
  scope,
  access,
}: {
  job: string | null;
  coreData: CoreData;
  filter: FilterBar;
  onFilterChange: (next: FilterBar) => void;
  scope: Scope;
  access: Access;
}) {
  const data = useBriefData(coreData);
  if (!data) return <RecordsStatus coreData={coreData} />;
  const filters = briefFilters(data, filter, scope.model);
  const ctx = { data, filters, access };
  if (job === null) return <JobChooser ctx={ctx} />;
  const found = findJob(data, job);
  if (!found)
    return (
      <div className="rd-page">
        <header className="rd-page-head">
          <h1>Brief</h1>
        </header>
        <p className="rd-panel rd-brief-notice" role="status">
          No job has the id “{job}”.{' '}
          <a href={routeHref({ view: 'brief', job: null })}>Choose a job</a>
        </p>
      </div>
    );
  return (
    <JobBrief
      key={found.id}
      ctx={ctx}
      job={found}
      filter={filter}
      onFilterChange={onFilterChange}
      scope={scope}
    />
  );
}

function JobChooser({ ctx }: { ctx: Context }) {
  const rows = chooserRows(ctx.data, ctx.filters);
  return (
    <div className="rd-page">
      <header className="rd-page-head">
        <h1>Choose a job</h1>
        <p>
          A first choice, a second and a lower-cost option for one job, with the
          evidence behind each.
        </p>
      </header>
      <ul className="rd-jobs">
        {rows.map((row) => (
          <li key={row.job.id} className="rd-panel">
            <a
              className="rd-job-link"
              href={routeHref({ view: 'brief', job: row.job.id })}
            >
              {row.job.parent !== undefined && '↳ '}
              {row.job.label}
            </a>
            <p>
              {row.measured.length === 0 ? (
                '0 measured records'
              ) : (
                <EvidenceButton
                  spec={() =>
                    measuredSpec(
                      ctx.data,
                      `${row.job.label} · measured records`,
                      row.measured,
                      'Benchmark results, arena ratings and reports for this job within the filters.',
                    )
                  }
                >
                  {plural(row.measured.length, 'measured record')}
                </EvidenceButton>
              )}
              {ctx.filters.since && ' in the period'}
            </p>
            <p className="rd-note">
              {row.benchmarks.length > 0
                ? `Measures: ${row.benchmarks.map((benchmark) => benchmark.name).join(', ')}${row.from ? ` (from ${row.from.label})` : ''}`
                : 'No measure'}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobBrief({
  ctx,
  job,
  filter,
  onFilterChange,
  scope,
}: {
  ctx: Context;
  job: CoreJob;
  filter: FilterBar;
  onFilterChange: (next: FilterBar) => void;
  scope: Scope;
}) {
  const [within, setWithin] = useState<WithinOverlap>('preferences');
  const { data, filters } = ctx;
  const brief = computeBrief(data, job, filters, within);
  const usage = data.core.usage;
  const head = (
    <header className="rd-page-head">
      <p className="rd-note">
        <a href={routeHref({ view: 'brief', job: null })}>All jobs</a>
      </p>
      <h1>{job.label}</h1>
    </header>
  );
  if (!brief.first) {
    const older =
      filters.current &&
      computeBrief(data, job, { ...filters, current: false }).rows.length > 0;
    return (
      <div className="rd-page">
        {head}
        <OrderNote ctx={ctx} brief={brief} />
        <p className="rd-panel rd-brief-notice">
          No model within the filters has a benchmark result, five stated
          preferences or ten clear Hacker News labels for this job.{' '}
          {older && (
            <>
              <button
                type="button"
                className="rd-button"
                onClick={() => onFilterChange({ ...filter, current: false })}
              >
                Include older models
              </button>{' '}
              Models that are no longer current have results for this job.
            </>
          )}
        </p>
        {usage && <UsageBlock data={data} usage={usage} job={job} />}
      </div>
    );
  }
  const first = brief.first;
  return (
    <div className="rd-page">
      {head}
      <OrderNote ctx={ctx} brief={brief} />
      {!filters.classes.includes('measured') &&
        brief.basis.kind === 'benchmark' && (
          <p className="rd-note">
            Measured records are hidden by the source filter; the order still
            comes from the benchmark.
          </p>
        )}
      <div className="rd-cards">
        <Card role="First choice" row={first} ctx={ctx} brief={brief} first />
        <Card role="Second" row={brief.second} ctx={ctx} brief={brief} />
        <Card
          role="Lower cost"
          row={brief.lower}
          ctx={ctx}
          brief={brief}
          lower
        />
      </div>
      <BriefTable
        ctx={ctx}
        brief={brief}
        within={within}
        onWithin={setWithin}
        narrowed={scope.active || filter.current}
      />
      {usage && <UsageBlock data={data} usage={usage} job={job} />}
    </div>
  );
}

function benchmarkSource(data: BriefData, benchmark: Benchmark) {
  const dates = benchmark.dates
    ? benchmark.dates[0] === benchmark.dates[1]
      ? formatDay(benchmark.dates[0])
      : `${formatDay(benchmark.dates[0])} to ${formatDay(benchmark.dates[1])}`
    : null;
  if (benchmark.source === 'lmarena')
    return `LMArena, published ${benchmark.publishedAt ? formatDay(benchmark.publishedAt) : 'undated'}`;
  if (benchmark.source === 'epoch')
    return `Epoch AI's own runs, ${dates ?? 'undated'}`;
  if (benchmark.source === 'restricted')
    return `${benchmark.publisher}, shown to approved accounts`;
  return `published results checked ${formatDay(data.core.sources.snapshot)}${dates ? `, run ${dates}` : ', undated'}`;
}

function OrderNote({ ctx, brief }: { ctx: Context; brief: BriefResult }) {
  const explanation = orderExplanation(ctx.data, brief);
  const primary = brief.primary;
  if (primary?.kind !== 'benchmark')
    return <p className="rd-panel rd-order-note">{explanation}</p>;
  const benchmark = primary.benchmark;
  return (
    <p className="rd-panel rd-order-note">
      <strong>
        Ordered by <BenchmarkName benchmark={benchmark} />
      </strong>{' '}
      ({benchmarkSource(ctx.data, benchmark)}; {benchmarkKind(benchmark)}):{' '}
      {benchmark.what} {explanation}
    </p>
  );
}

function reason(ctx: Context, brief: BriefResult, row: BriefRow): ReactNode {
  const primary = brief.primary;
  const index = brief.basis.kind === 'none' ? -1 : brief.basis.signal;
  const value = row.values[index];
  const lead = brief.lead;
  if (!primary || !value || !lead) return null;
  const label = signalLabel(primary);
  const open = (text: string) => (
    <EvidenceButton
      spec={() => valueSpec(ctx, brief, primary, row.model, value)}
    >
      {text}
    </EvidenceButton>
  );
  if (row === lead)
    return (
      <>
        {open(`${value.text} on ${label}`)}, the highest result within the
        filters.
      </>
    );
  const leadValue = lead.values[index];
  if (row.overlap && leadValue)
    return (
      <>
        {open(`${value.text} on ${label}`)}: its interval overlaps the highest (
        {lead.model.name}, {leadValue.text}).
      </>
    );
  return (
    <>
      {open(
        `#${row.ranks[index] ?? '?'} of ${brief.field[index] ?? 0} on ${label}`,
      )}{' '}
      overall ({value.text}).
    </>
  );
}

function Card({
  role,
  row,
  ctx,
  brief,
  first = false,
  lower = false,
}: {
  role: string;
  row: BriefRow | null;
  ctx: Context;
  brief: BriefResult;
  first?: boolean;
  lower?: boolean;
}) {
  if (!row)
    return (
      <section className="rd-panel rd-card">
        <h2 className="rd-h">{role}</h2>
        <p className="rd-note">
          {lower
            ? lowerCostMissing(brief)
            : 'No other model meets the filters.'}
        </p>
      </section>
    );
  const primary = brief.primary;
  const index = brief.basis.kind === 'none' ? -1 : brief.basis.signal;
  const value = row.values[index];
  const unit =
    brief.usesCost && primary?.kind === 'benchmark'
      ? costUnit(primary.benchmark.id)
      : 'per million output tokens';
  const firstCost = brief.first?.cost ?? null;
  const selection = guideSelections(guide, brief.job.guideTask, row.model.id);
  return (
    <section
      className={first ? 'rd-panel rd-card rd-card-first' : 'rd-panel rd-card'}
    >
      <h2 className="rd-h">{role}</h2>
      <p className="rd-card-model">
        <a href={modelHref(row.model.id)}>{row.model.name}</a>
      </p>
      <p className="rd-note">
        {row.model.provider} · {priceText(row.model)}
        {row.model.status !== 'current' &&
          ` · ${row.model.status || 'status not settled'}`}
      </p>
      <p>
        {lower &&
        primary &&
        value &&
        row.cost !== null &&
        firstCost !== null ? (
          <>
            <EvidenceButton
              spec={() => valueSpec(ctx, brief, primary, row.model, value)}
            >
              {`${dollars(row.cost)} ${unit}`}
            </EvidenceButton>{' '}
            against {dollars(firstCost)}, at {value.text} on{' '}
            {signalLabel(primary)}.
          </>
        ) : (
          reason(ctx, brief, row)
        )}
      </p>
      {primary?.kind === 'benchmark' && value?.config && (
        <p className="rd-note">
          Configuration: {value.config}
          {brief.usesCost &&
            row.cost !== null &&
            ` · ${dollars(row.cost)} ${costUnit(primary.benchmark.id)}`}
        </p>
      )}
      {selection.lines.length > 0 && selection.task && (
        <p className="rd-note">
          In the apps (
          <a href={routeHref({ view: 'apps' })}>{selection.task.label}</a>):{' '}
          {selection.lines.join('; ')}
        </p>
      )}
      <Bands
        ctx={ctx}
        job={{ id: brief.job.id, label: brief.job.label }}
        model={row.model}
      />
    </section>
  );
}

function BriefTable({
  ctx,
  brief,
  within,
  onWithin,
  narrowed,
}: {
  ctx: Context;
  brief: BriefResult;
  within: WithinOverlap;
  onWithin: (next: WithinOverlap) => void;
  narrowed: boolean;
}) {
  const primary = brief.primary;
  return (
    <section className="rd-panel rd-brief-table">
      <div className="rd-brief-table-head">
        <h2>
          {plural(brief.rows.length, 'model')}, ordered by{' '}
          {primary ? signalLabel(primary) : ''}
        </h2>
        {brief.basis.kind === 'benchmark' && (
          <div className="rd-brief-switch">
            <span className="rd-note">Within overlapping intervals:</span>
            <span className="rd-seg">
              <button
                type="button"
                aria-pressed={within === 'preferences'}
                onClick={() => onWithin('preferences')}
              >
                Stated preferences
              </button>
              <button
                type="button"
                aria-pressed={within === 'cost'}
                onClick={() => onWithin('cost')}
              >
                Cost
              </button>
            </span>
          </div>
        )}
      </div>
      <div className="rd-scroll">
        <table className="rd-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="rd-num">Out $/M</th>
              {brief.usesCost && primary?.kind === 'benchmark' && (
                <th className="rd-num">
                  Cost {costUnit(primary.benchmark.id)}
                </th>
              )}
              {brief.signals.map((signal) => (
                <th
                  key={
                    signal.kind === 'benchmark'
                      ? signal.benchmark.id
                      : signal.kind
                  }
                  title={
                    signal.kind === 'benchmark'
                      ? signal.benchmark.what
                      : undefined
                  }
                >
                  {signal.kind === 'benchmark' ? (
                    <BenchmarkName benchmark={signal.benchmark} />
                  ) : (
                    signalLabel(signal)
                  )}
                  <div className="rd-note rd-th-sub">
                    {signal.kind === 'benchmark'
                      ? benchmarkKind(signal.benchmark)
                      : signal.kind === 'preferences'
                        ? `share preferred, ${ctx.filters.since ? 'in the period' : 'all dates'}`
                        : 'positive share of clear labels'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {brief.rows.map((row) => (
              <tr key={row.model.id}>
                <td>
                  <a href={modelHref(row.model.id)}>
                    <strong>{row.model.name}</strong>
                  </a>
                  <div className="rd-note">
                    {row.model.provider}
                    {row.model.status !== 'current' &&
                      ` · ${row.model.status || 'status not settled'}`}
                    {row.overlap &&
                      row !== brief.lead &&
                      ' · interval overlaps the highest'}
                  </div>
                </td>
                <td className="rd-num">
                  {row.model.output === null ? '—' : dollars(row.model.output)}
                </td>
                {brief.usesCost && (
                  <td className="rd-num">
                    {row.cost === null ? '—' : dollars(row.cost)}
                  </td>
                )}
                {brief.signals.map((signal, i) => {
                  const value = row.values[i];
                  const rank = row.ranks[i];
                  return (
                    <td
                      key={
                        signal.kind === 'benchmark'
                          ? signal.benchmark.id
                          : signal.kind
                      }
                      className="rd-nowrap"
                    >
                      {value ? (
                        <>
                          <span className="rd-rank">#{rank}</span>{' '}
                          <EvidenceButton
                            spec={() =>
                              valueSpec(ctx, brief, signal, row.model, value)
                            }
                          >
                            {value.text}
                          </EvidenceButton>
                        </>
                      ) : (
                        <span className="rd-muted">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rd-note">{orderRules(brief)}</p>
      {narrowed && <RankNote />}
    </section>
  );
}

function UsageBlock({
  data,
  usage,
  job,
}: {
  data: BriefData;
  usage: CoreUsage;
  job: CoreJob;
}) {
  const tags = usageForJob(data, usage, job.id);
  if (tags.length === 0) return null;
  return (
    <details className="rd-panel rd-usage">
      <summary>
        <span className="rd-band-chip rd-band-usage">Usage</span> What
        OpenRouter traffic uses for this job: {plural(tags.length, 'task tag')},
        7 days to {formatDay(usage.tasks.period.end)}
      </summary>
      <p className="rd-note">{usage.note}</p>
      <div className="rd-scroll">
        <table className="rd-table">
          <thead>
            <tr>
              <th>Task tag</th>
              <th className="rd-num">Share of sampled requests</th>
              <th>Top 10 models by share of the tag’s requests</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((tag) => (
              <tr key={tag.tag}>
                <td>
                  {tag.label}
                  <div className="rd-note">
                    {data.jobById.get(tag.job)?.label ?? 'no job'}
                  </div>
                </td>
                <td className="rd-num">{shareText(tag.share)}</td>
                <td>
                  {tag.top.map((top, i) => {
                    const model = data.modelById.get(top.modelId);
                    return (
                      <span key={top.route}>
                        {i > 0 && ' · '}
                        {model ? (
                          <a href={modelHref(model.id)}>{model.name}</a>
                        ) : (
                          <span className="rd-muted">
                            {top.route} (not in the model list)
                          </span>
                        )}{' '}
                        {shareText(top.share)}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rd-note">
        The 7-day task shares are a sample. Models outside a top 10 show
        nothing, not zero.{' '}
        <a href={usage.url} target="_blank" rel="noopener noreferrer">
          {usage.tasks.attribution}
        </a>
      </p>
    </details>
  );
}

// Shares that are often under one per cent.
function shareText(share: number) {
  return share < 0.001 ? 'under 0.1%' : `${(share * 100).toFixed(1)}%`;
}
