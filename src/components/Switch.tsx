import type { Access } from '../lib/access';
import {
  benchmarkKind,
  briefFilters,
  costUnit,
  findJob,
  inPool,
  minimums,
} from '../lib/brief';
import type { BriefData } from '../lib/brief';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { CoreModel } from '../lib/core-schema';
import { dollars } from '../lib/metrics';
import type { FilterBar, Scope } from '../lib/model-filter';
import { modelHref, routeHref } from '../lib/route';
import type { Route } from '../lib/route';
import { percent } from '../lib/site-data';
import {
  differenceText,
  preferencesBetween,
  priceChange,
  sharedBenchmarks,
} from '../lib/switch';
import Bands, {
  allJobs,
  BenchmarkName,
  commentSpec,
  measuredSpec,
  preferenceIds,
  RecordsStatus,
} from './Bands';
import type { BandContext, BandJob } from './Bands';
import { EvidenceButton } from './EvidenceDrawer';
import './switch.css';

type SwitchRoute = Extract<Route, { view: 'switch' }>;

export default function Switch({
  route,
  coreData,
  filter,
  scope,
  access,
}: {
  route: SwitchRoute;
  coreData: CoreData;
  filter: FilterBar;
  scope: Scope;
  access: Access;
}) {
  const data = useBriefData(coreData);
  if (!data) return <RecordsStatus coreData={coreData} />;
  const ctx: BandContext = {
    data,
    filters: briefFilters(data, filter, scope.model),
    access,
  };
  const a = route.a === null ? null : (data.modelById.get(route.a) ?? null);
  const b = route.b === null ? null : (data.modelById.get(route.b) ?? null);
  const job = route.job === null ? null : findJob(data, route.job);
  const band: BandJob = job ? { id: job.id, label: job.label } : allJobs;
  // An unknown id is reported; no other model is put in its place.
  const unknown = [
    route.a !== null && a === null ? route.a : null,
    route.b !== null && b === null ? route.b : null,
  ].filter((id) => id !== null);
  let body;
  if (unknown.length > 0 || (route.job !== null && job === null))
    body = (
      <p className="rd-panel rd-brief-notice" role="status">
        {unknown.map((id) => `No model has the id “${id}”. `)}
        {route.job !== null && job === null && (
          <>
            No job has the id “{route.job}”.{' '}
            <a href={routeHref({ ...route, job: null })}>Show all jobs</a>
          </>
        )}
      </p>
    );
  else if (!a || !b)
    body = <p className="rd-panel rd-brief-notice">Choose two models.</p>;
  else if (a.id === b.id)
    body = (
      <p className="rd-panel rd-brief-notice">Choose two different models.</p>
    );
  else body = <Comparison ctx={ctx} a={a} b={b} job={band} />;
  return (
    <div className="rd-page">
      <header className="rd-page-head">
        <h1>Switch</h1>
        <p>
          What changes when moving from one model to another, in{' '}
          {job ? `the job “${job.label}”` : 'all jobs'}. Choose the job in the
          filter bar.
        </p>
      </header>
      <Picker data={data} ctx={ctx} route={route} />
      {body}
    </div>
  );
}

function Picker({
  data,
  ctx,
  route,
}: {
  data: BriefData;
  ctx: BandContext;
  route: SwitchRoute;
}) {
  // The choices follow the filter bar; the chosen models always stay listed.
  const options = data.models
    .filter(
      (model) =>
        inPool(model, ctx.filters) ||
        model.id === route.a ||
        model.id === route.b,
    )
    .sort((x, y) => x.name.localeCompare(y.name));
  const select = (side: 'a' | 'b', label: string) => {
    const value = route[side];
    return (
      <label className="rd-switch-pick">
        <span className="rd-note">{label}</span>
        <select
          className="rd-select"
          value={value ?? ''}
          onChange={(event) => {
            window.location.hash = routeHref({
              ...route,
              [side]: event.target.value || null,
            });
          }}
        >
          <option value="">Choose a model</option>
          {value !== null && !data.modelById.has(value) && (
            <option value={value}>Unknown model</option>
          )}
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
              {model.status !== 'current' &&
                ` (${model.status || 'status not settled'})`}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="rd-panel rd-switch-picker">
      {select('a', 'In use')}
      <a href={routeHref({ ...route, a: route.b, b: route.a })}>Swap</a>
      {select('b', 'Considering')}
    </div>
  );
}

function priceText(model: CoreModel) {
  return model.input === null || model.output === null
    ? 'no verified price'
    : `${dollars(model.input)} in / ${dollars(model.output)} out`;
}

function Comparison({
  ctx,
  a,
  b,
  job,
}: {
  ctx: BandContext;
  a: CoreModel;
  b: CoreModel;
  job: BandJob;
}) {
  const { data, filters } = ctx;
  const rows = sharedBenchmarks(data, a.id, b.id, job.id);
  const change = priceChange(a, b);
  const value = (
    model: CoreModel,
    records: Parameters<typeof measuredSpec>[2],
    title: string,
    text: string,
  ) => (
    <EvidenceButton
      spec={() =>
        measuredSpec(
          data,
          `${model.name} · ${title}`,
          records,
          'The best configuration is listed first.',
        )
      }
    >
      {text}
    </EvidenceButton>
  );
  return (
    <>
      <section className="rd-panel rd-switch-section">
        <h2 className="rd-h">Measured differences · {job.label}</h2>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th />
                <th className="rd-num">
                  <a href={modelHref(a.id, job.id)}>{a.name}</a>
                </th>
                <th className="rd-num">
                  <a href={modelHref(b.id, job.id)}>{b.name}</a>
                </th>
                <th>Difference</th>
                <th className="rd-num">Cost per task</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>API price per million tokens</td>
                <td className="rd-num">{priceText(a)}</td>
                <td className="rd-num">{priceText(b)}</td>
                <td>{change ?? 'A price is missing'}</td>
                <td />
              </tr>
              {rows.map((row) => (
                <tr key={row.benchmark.id}>
                  <td>
                    <BenchmarkName benchmark={row.benchmark} />
                    <div className="rd-note" title={row.benchmark.what}>
                      {benchmarkKind(row.benchmark)}
                    </div>
                  </td>
                  <td className="rd-num">
                    {value(a, row.a.records, row.benchmark.name, row.a.text)}
                    <div className="rd-note">{row.a.config}</div>
                  </td>
                  <td className="rd-num">
                    {value(b, row.b.records, row.benchmark.name, row.b.text)}
                    <div className="rd-note">{row.b.config}</div>
                  </td>
                  <td>{differenceText(row, a.name, b.name)}</td>
                  <td className="rd-num rd-nowrap">
                    {row.a.cost !== null && row.b.cost !== null ? (
                      <>
                        {dollars(row.a.cost)} → {dollars(row.b.cost)}
                        <div className="rd-note">
                          {costUnit(row.benchmark.id)}
                        </div>
                      </>
                    ) : (
                      <span className="rd-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="rd-muted">
                    No benchmark {job.id === null ? '' : 'of this job '}has a
                    result for both.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="rd-note">
          Each row compares the two on one benchmark only, with each model’s
          best published result; percentages, ratings and index points are never
          compared with each other. Where both intervals are published and
          overlap, the benchmark does not separate the two.
        </p>
      </section>
      <Preferences ctx={ctx} a={a} b={b} job={job} />
      <div className="rd-switch-cols">
        {[a, b].map((model, i) => (
          <section key={model.id} className="rd-panel rd-switch-section">
            <h2 className="rd-h">
              <span className="rd-note">
                {i === 0 ? 'In use' : 'Considering'}
              </span>{' '}
              <a href={modelHref(model.id, job.id)}>{model.name}</a>
            </h2>
            <Bands ctx={ctx} job={job} model={model} />
          </section>
        ))}
      </div>
      {!filters.classes.includes('measured') && (
        <p className="rd-note">
          Measured records are hidden from the bands by the source filter.
        </p>
      )}
    </>
  );
}

function Preferences({
  ctx,
  a,
  b,
  job,
}: {
  ctx: BandContext;
  a: CoreModel;
  b: CoreModel;
  job: BandJob;
}) {
  const since = ctx.filters.since;
  const between = preferencesBetween(ctx.data, a.id, b.id, job.id, since);
  const open = (
    title: string,
    rows: readonly { id: string }[],
    text: string,
  ) =>
    rows.length === 0 ? (
      <span>{text}</span>
    ) : (
      <EvidenceButton
        spec={() =>
          commentSpec(
            `${title} · ${job.label}`,
            preferenceIds(rows),
            null,
            since,
            'Comments that say one of the two is better than the other. Labels are automatic.',
          )
        }
      >
        {text}
      </EvidenceButton>
    );
  return (
    <section className="rd-panel rd-switch-section">
      <h2 className="rd-h">Stated preferences between the two · {job.label}</h2>
      {between.total === 0 ? (
        <p className="rd-note">
          No comment {job.id === null ? '' : 'in this job '}
          {since ? 'in the period ' : ''}states a preference between these two
          exact models.
        </p>
      ) : (
        <>
          <p className="rd-switch-prefs">
            {open(
              `Prefer ${a.name} to ${b.name}`,
              between.forA,
              `${between.forA.length} prefer ${a.name}`,
            )}
            <span className="rd-split" aria-hidden="true">
              <i
                className="rd-split-a"
                style={{
                  width: `${(between.forA.length / between.total) * 100}%`,
                }}
              />
              <i
                className="rd-split-b"
                style={{
                  width: `${(between.forB.length / between.total) * 100}%`,
                }}
              />
            </span>
            {open(
              `Prefer ${b.name} to ${a.name}`,
              between.forB,
              `${between.forB.length} prefer ${b.name}`,
            )}
          </p>
          <p className="rd-note">
            {between.shareB === null
              ? `Fewer than ${minimums.preferences} stated preferences between the two, so no share is given.`
              : `${percent(between.shareB)} of ${between.total} prefer ${b.name}. Reported evidence, not a measurement.`}
          </p>
        </>
      )}
      <p className="rd-note">
        Practitioner comparisons need sign-in.
        {ctx.access.kind === 'anonymous' && (
          <>
            {' '}
            <a href={routeHref({ view: 'account', error: null })}>Sign in</a>
          </>
        )}
      </p>
    </section>
  );
}
