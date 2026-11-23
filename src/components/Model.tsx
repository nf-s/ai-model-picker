import { useEffect, useMemo, useRef } from 'react';
import {
  briefFilters,
  crowdCommentIds,
  findJob,
  monthStart,
  plural,
  taggedCommentIds,
  tallyTotal,
} from '../lib/brief';
import type { BriefData, BriefFilters } from '../lib/brief';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { CoreJob, CoreUsage } from '../lib/core-schema';
import { emptyFilter } from '../lib/hn-insights';
import { jobRules } from '../lib/job-rules';
import { dollars } from '../lib/metrics';
import type { FilterBar, Scope } from '../lib/model-filter';
import {
  compareOptions,
  evidenceByJob,
  findTarget,
  lineModels,
  linesOf,
  modelList,
  usageLine,
} from '../lib/model-page';
import type { JobEvidence, PageTarget } from '../lib/model-page';
import { namedOrder, namedPasses, outcomeTally } from '../lib/named';
import { lineHref, modelHref, routeHref } from '../lib/route';
import type { Route } from '../lib/route';
import { percent, scopeHnData, useHnData } from '../lib/site-data';
import Bands, {
  allJobs,
  CrowdBand,
  commentSpec,
  hnTally,
  indexKey,
  measuredSpec,
  NamedBand,
  namedSpec,
  RecordsStatus,
  tallyNote,
} from './Bands';
import type { BandContext, BandJob } from './Bands';
import Threads from './comment-views/Threads';
import { EvidenceButton } from './EvidenceDrawer';
import { formatDay } from './FilterBar';
import { namedNote, OutcomeBar, useNamed } from './Named';
import { SentimentBar } from './parts';
import './model.css';

type ModelRoute = Extract<Route, { view: 'model' }>;

export default function Model({
  route,
  coreData,
  filter,
  scope,
}: {
  route: ModelRoute;
  coreData: CoreData;
  filter: FilterBar;
  scope: Scope;
}) {
  const data = useBriefData(coreData);
  if (!data) return <RecordsStatus coreData={coreData} />;
  const ctx: BandContext = {
    data,
    filters: briefFilters(data, filter, scope.model),
  };
  if (route.target === null) return <ModelList ctx={ctx} />;
  const target = findTarget(data, route.target);
  if (!target)
    return (
      <div className="rd-page">
        <header className="rd-page-head">
          <p className="rd-note">
            <a href={routeHref({ ...route, target: null, comments: false })}>
              All models
            </a>
          </p>
          <h1>{route.target.kind === 'model' ? 'Model' : 'Product line'}</h1>
        </header>
        <p className="rd-panel rd-brief-notice" role="status">
          {route.target.kind === 'model'
            ? `No model has the id “${route.target.id}”.`
            : `No product line is named “${route.target.name}”.`}
        </p>
      </div>
    );
  const job = route.job === null ? null : findJob(data, route.job);
  return (
    <TargetPage
      key={target.key}
      ctx={ctx}
      route={route}
      target={target}
      job={job}
      scope={scope}
    />
  );
}

function TargetPage({
  ctx,
  route,
  target,
  job,
  scope,
}: {
  ctx: BandContext;
  route: ModelRoute;
  target: PageTarget;
  job: CoreJob | null;
  scope: Scope;
}) {
  const { data } = ctx;
  const band: BandJob = job ? { id: job.id, label: job.label } : allJobs;
  const unknownJob = route.job !== null && job === null;
  const openAll = () => {
    window.location.hash = routeHref({ ...route, comments: true });
  };
  return (
    <div className="rd-page rd-model">
      <header className="rd-page-head">
        <p className="rd-note">
          <a href={routeHref({ ...route, target: null, comments: false })}>
            All models
          </a>
        </p>
        <h1>{target.name}</h1>
        {target.kind === 'model' ? (
          <ModelFacts data={data} target={target} jobId={route.job} />
        ) : (
          <p className="rd-note">
            Product line. These records name the line without a version; they
            are never added to a model’s counts.
          </p>
        )}
      </header>
      {target.kind === 'model' ? (
        <CompareWith ctx={ctx} modelId={target.model.id} jobId={route.job} />
      ) : (
        <LineModels data={data} target={target} jobId={route.job} />
      )}
      <EvidenceByJob ctx={ctx} route={route} target={target} />
      <TaggedRecords ctx={ctx} target={target} job={band} />
      {unknownJob ? (
        <p className="rd-panel rd-brief-notice" role="status">
          No job has the id “{route.job}”.{' '}
          <a href={routeHref({ ...route, job: null })}>Show all jobs</a>
        </p>
      ) : (
        <section className="rd-panel rd-model-section">
          <h2 className="rd-h">Evidence · {band.label}</h2>
          {target.kind === 'model' ? (
            <Bands
              ctx={ctx}
              job={band}
              model={{ id: target.model.id, name: target.name }}
              detail
              onOpenAll={openAll}
            />
          ) : (
            <div className="rd-bands">
              <p className="rd-band rd-note">
                Measured results name exact models; open a model above.
              </p>
              <NamedBand
                ctx={ctx}
                job={band}
                target={{ key: target.key, name: target.name }}
              />
              {ctx.filters.classes.includes('crowd') && (
                <CrowdBand
                  ctx={ctx}
                  job={band}
                  target={{ key: target.key, name: target.name }}
                  detail
                  onOpenAll={openAll}
                />
              )}
            </div>
          )}
        </section>
      )}
      {route.comments && !unknownJob && (
        <ThreadReader
          data={data}
          target={target}
          job={band}
          filters={ctx.filters}
          scope={scope}
          onClose={() => {
            window.location.hash = routeHref({ ...route, comments: false });
          }}
        />
      )}
      {target.kind === 'model' && data.core.usage && (
        <UsageLine
          usage={data.core.usage}
          data={data}
          modelId={target.model.id}
        />
      )}
    </div>
  );
}

function priceText(input: number | null, output: number | null) {
  return input === null || output === null
    ? 'no verified API price'
    : `${dollars(input)} in / ${dollars(output)} out per million tokens`;
}

function ModelFacts({
  data,
  target,
  jobId,
}: {
  data: BriefData;
  target: Extract<PageTarget, { kind: 'model' }>;
  jobId: string | null;
}) {
  const { model } = target;
  const lines = linesOf(data, model.id);
  const facts = [
    model.provider,
    model.status || 'status not settled',
    priceText(model.input, model.output),
    model.contextTokens === null
      ? ''
      : `${(model.contextTokens / 1000).toLocaleString('en')}k context`,
  ].filter(Boolean);
  return (
    <p className="rd-note">
      {facts.join(' · ')}
      {lines.length > 0 && (
        <>
          {' · lines: '}
          {lines.map((line, i) => (
            <span key={line.name}>
              {i > 0 && ', '}
              <a href={lineHref(line.name, jobId)}>{line.name}</a>
            </span>
          ))}
        </>
      )}
      {model.priceUrl && (
        <>
          {' · '}
          <a href={model.priceUrl} target="_blank" rel="noopener noreferrer">
            price source
          </a>
        </>
      )}
    </p>
  );
}

function CompareWith({
  ctx,
  modelId,
  jobId,
}: {
  ctx: BandContext;
  modelId: string;
  jobId: string | null;
}) {
  const options = compareOptions(ctx.data, ctx.filters, modelId);
  return (
    <div className="rd-panel rd-model-compare">
      <label>
        <span className="rd-note">Compare with</span>{' '}
        <select
          className="rd-select"
          value=""
          onChange={(event) => {
            if (event.target.value)
              window.location.hash = routeHref({
                view: 'switch',
                a: modelId,
                b: event.target.value,
                job: jobId,
              });
          }}
        >
          <option value="">Choose a model</option>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function LineModels({
  data,
  target,
  jobId,
}: {
  data: BriefData;
  target: Extract<PageTarget, { kind: 'line' }>;
  jobId: string | null;
}) {
  const members = lineModels(data, target.line);
  return (
    <section className="rd-panel rd-model-section">
      <h2 className="rd-h">Models in this line</h2>
      {members.length === 0 ? (
        <p className="rd-note">No model in the list has this name.</p>
      ) : (
        <ul className="rd-model-members">
          {members.map((model) => (
            <li key={model.id}>
              <a href={modelHref(model.id, jobId)}>{model.name}</a>{' '}
              <span className="rd-note">
                {model.provider}
                {model.status !== 'current' &&
                  ` · ${model.status || 'status not settled'}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Records a tracked tag rule matched, such as drawing tests, with counts that
// open them. A tag never gives a job and never counts toward one; practitioner
// records are counted only for granted accounts.
function TaggedRecords({
  ctx,
  target,
  job,
}: {
  ctx: BandContext;
  target: PageTarget;
  job: BandJob;
}) {
  const { data, filters } = ctx;
  const { state, trusted } = useNamed();
  const index = state.status === 'ready' ? state.value : null;
  const rows = jobRules.tags.rules.map((rule) => {
    const crowd = filters.classes.includes('crowd')
      ? taggedCommentIds(data, rule.tag, target.key, job.id, filters)
      : new Set<number>();
    const named = (index?.byKey.get(target.key) ?? []).filter(
      (record) =>
        record.use.tags?.includes(rule.tag) &&
        namedPasses(data, record, job.id, filters),
    );
    return { rule, crowd, named };
  });
  const shown = rows.filter(
    (row) => row.crowd.size > 0 || row.named.length > 0,
  );
  if (shown.length === 0) return null;
  return (
    <section className="rd-panel rd-model-section">
      <h2 className="rd-h">Tagged records · {job.label}</h2>
      <ul className="rd-tagged">
        {shown.map(({ rule, crowd, named }) => (
          <li key={rule.tag}>
            <strong>{rule.label}</strong>
            {crowd.size > 0 && (
              <EvidenceButton
                spec={() =>
                  commentSpec(
                    `${target.name} · ${rule.label} · Hacker News`,
                    crowd,
                    indexKey(target.key),
                    filters.since,
                    'Comments whose claim the tag rule matched. Labels are automatic.',
                  )
                }
              >
                {plural(crowd.size, 'Hacker News label')}
              </EvidenceButton>
            )}
            {named.length > 0 && (
              <EvidenceButton
                spec={() =>
                  namedSpec(
                    `${target.name} · ${rule.label} · practitioner records`,
                    namedOrder(named, trusted),
                    'Use records whose task the tag rule matched.',
                  )
                }
              >
                {plural(named.length, 'practitioner record')}
              </EvidenceButton>
            )}
          </li>
        ))}
      </ul>
      <p className="rd-note">
        Found by a keyword rule on the record’s own task or claim. A tag never
        gives a job or counts toward one.
      </p>
    </section>
  );
}

function EvidenceByJob({
  ctx,
  route,
  target,
}: {
  ctx: BandContext;
  route: ModelRoute;
  target: PageTarget;
}) {
  const { data, filters } = ctx;
  const { state, trusted } = useNamed();
  const index = state.status === 'ready' ? state.value : null;
  const rows = evidenceByJob(
    data,
    target,
    filters,
    index && { index, trusted },
  );
  const measured =
    target.kind === 'model' && filters.classes.includes('measured');
  const named = index !== null && filters.classes.includes('named');
  const crowd = filters.classes.includes('crowd');
  return (
    <section className="rd-panel rd-model-section">
      <h2 className="rd-h">Evidence by job</h2>
      <div className="rd-scroll">
        <table className="rd-table">
          <thead>
            <tr>
              <th>Job</th>
              {measured && <th className="rd-num">Measured</th>}
              {named && (
                <th className="rd-num">
                  Named use records
                  <div className="rd-note rd-th-sub">job by review</div>
                </th>
              )}
              {named && <th>Outcome</th>}
              {crowd && <th className="rd-num">Crowd labels</th>}
              {crowd && <th>Crowd stance</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <JobRow
                key={row.job?.id ?? 'all'}
                ctx={ctx}
                route={route}
                target={target}
                row={row}
                measured={measured}
                named={named}
                crowd={crowd}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p className="rd-note">
        Choose a job to see its bands below. A parent job includes its sub-jobs.
        {named &&
          ' Named use records carry the job the model review gave them; they never order a model.'}{' '}
        Hacker News labels are automatic and count{' '}
        {target.kind === 'model'
          ? 'this exact model only'
          : 'comments that name only the line'}
        {filters.since &&
          `; from ${formatDay(monthStart(filters.since))}, as the counts are monthly`}
        .
      </p>
    </section>
  );
}

function JobRow({
  ctx,
  route,
  target,
  row,
  measured,
  named,
  crowd,
}: {
  ctx: BandContext;
  route: ModelRoute;
  target: PageTarget;
  row: JobEvidence;
  measured: boolean;
  named: boolean;
  crowd: boolean;
}) {
  const { data, filters } = ctx;
  const { state } = useNamed();
  const id = row.job === null ? null : row.job.id;
  const label = row.job === null ? allJobs.label : row.job.label;
  const total = tallyTotal(row.tally);
  const selected = route.job === id;
  return (
    <tr aria-current={selected ? 'true' : undefined}>
      <td>
        {row.job?.parent !== undefined && '↳ '}
        {id === '' ? (
          label
        ) : (
          <a href={routeHref({ ...route, job: id, comments: false })}>
            {label}
          </a>
        )}
      </td>
      {measured && (
        <td className="rd-num">
          {row.measured.length === 0 ? (
            <span className="rd-muted">—</span>
          ) : (
            <EvidenceButton
              spec={() =>
                measuredSpec(
                  data,
                  `${target.name} · ${label} · measured`,
                  row.measured,
                )
              }
            >
              {row.measured.length.toLocaleString()}
            </EvidenceButton>
          )}
        </td>
      )}
      {named && (
        <td className="rd-num">
          {row.named.length === 0 ? (
            <span className="rd-muted">—</span>
          ) : (
            <EvidenceButton
              spec={() =>
                namedSpec(
                  `${target.name} · ${label} · use records`,
                  row.named,
                  namedNote(state),
                )
              }
            >
              {row.named.length.toLocaleString()}
            </EvidenceButton>
          )}
        </td>
      )}
      {named && (
        <td>
          {row.named.length > 0 && (
            <span className="rd-model-stance">
              <OutcomeBar tally={outcomeTally(row.named)} />
            </span>
          )}
        </td>
      )}
      {crowd && (
        <td className="rd-num">
          {total === 0 ? (
            <span className="rd-muted">—</span>
          ) : (
            <EvidenceButton
              spec={() =>
                commentSpec(
                  `${target.name} · Hacker News · ${label}`,
                  crowdCommentIds(data, id, filters.fields),
                  indexKey(target.key),
                  filters.since,
                  tallyNote(row.tally),
                )
              }
            >
              {total.toLocaleString()}
            </EvidenceButton>
          )}
        </td>
      )}
      {crowd && (
        <td className="rd-nowrap">
          {total > 0 && (
            <span className="rd-model-stance">
              <SentimentBar tally={hnTally(row.tally)} />
              <span className="rd-note">
                {row.share === null
                  ? 'under 10 clear'
                  : `${percent(row.share)} positive`}
              </span>
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

// The comments behind the Crowd band in the thread reader, limited to the
// target, the job and the period. The comment index loads when it opens.
function ThreadReader({
  data,
  target,
  job,
  filters,
  scope,
  onClose,
}: {
  data: BriefData;
  target: PageTarget;
  job: BandJob;
  filters: BriefFilters;
  scope: Scope;
  onClose: () => void;
}) {
  const hn = useHnData(true);
  const scoped = useMemo(() => scopeHnData(hn, scope), [hn, scope]);
  const from = monthStart(filters.since);
  const index = useMemo(() => {
    if (scoped.status !== 'ready') return null;
    const ids = crowdCommentIds(data, job.id, filters.fields);
    return {
      ...scoped.index,
      rows: scoped.index.rows.filter(
        (row) =>
          (ids === null || ids.has(row.id)) &&
          (from === '' || row.createdAt >= from),
      ),
    };
  }, [scoped, data, job.id, from]);
  const key = indexKey(target.key);
  const filter = useMemo(() => ({ ...emptyFilter, target: key }), [key]);
  const section = useRef<HTMLElement>(null);
  // After the app has placed a newly opened page at the top.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      section.current?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section
      ref={section}
      className="rd-panel rd-model-section"
      aria-label="Thread reader"
    >
      <div className="rd-model-reader-head">
        <h2 className="rd-h">
          Comments · {target.name} · {job.label}
        </h2>
        <button type="button" className="rd-button" onClick={onClose}>
          Close
        </button>
      </div>
      {hn.status === 'failed' ? (
        <p className="rd-note">The comment index could not be loaded.</p>
      ) : index === null ? (
        <p className="rd-note">Loading Hacker News comments…</p>
      ) : (
        <Threads index={index} filter={filter} focusKey={key} />
      )}
    </section>
  );
}

function shareText(share: number) {
  return share < 0.001 ? 'under 0.1%' : `${(share * 100).toFixed(1)}%`;
}

// One line of OpenRouter usage. Nothing when the model is outside the
// published top lists: that is not zero use.
function UsageLine({
  usage,
  data,
  modelId,
}: {
  usage: CoreUsage;
  data: BriefData;
  modelId: string;
}) {
  const line = usageLine(usage, modelId);
  if (!line) return null;
  const { tokens, tags } = line;
  return (
    <section className="rd-panel rd-model-section">
      <p>
        <span className="rd-band-chip rd-band-usage">Usage</span> OpenRouter,{' '}
        {formatDay(usage.tokens.period.start)} to{' '}
        {formatDay(usage.tokens.period.end)}:{' '}
        {tokens
          ? `${shareText(tokens.share)} of public tokens, in the daily top list on ${plural(tokens.days, 'day')}`
          : 'not in the 30-day token list'}
        {tags.length > 0
          ? `; in the top 10 for ${tags
              .map((tag) => {
                const job = data.jobById.get(tag.job);
                return `${tag.label}${job ? ` (${job.label.toLowerCase()})` : ''} with ${shareText(tag.share)} of its requests`;
              })
              .join(', ')}, 7 days to ${formatDay(usage.tasks.period.end)}`
          : '; in no task tag’s top 10'}
        .
      </p>
      <p className="rd-note">
        {usage.note}{' '}
        <a href={usage.url} target="_blank" rel="noopener noreferrer">
          {usage.tokens.attribution}
        </a>
      </p>
    </section>
  );
}

function ModelList({ ctx }: { ctx: BandContext }) {
  const { data, filters } = ctx;
  const models = modelList(data, filters);
  const lines = data.core.lines;
  return (
    <div className="rd-page">
      <header className="rd-page-head">
        <h1>Models</h1>
        <p>
          {plural(models.length, 'model')} within the filters. A model page
          shows its evidence by job; a product line holds the records that name
          only the line.
        </p>
      </header>
      <section className="rd-panel rd-model-section">
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Status</th>
                <th className="rd-num">In $/M</th>
                <th className="rd-num">Out $/M</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <td>
                    <a href={modelHref(model.id)}>{model.name}</a>
                  </td>
                  <td>{model.provider}</td>
                  <td>{model.status || 'not settled'}</td>
                  <td className="rd-num">
                    {model.input === null ? '—' : dollars(model.input)}
                  </td>
                  <td className="rd-num">
                    {model.output === null ? '—' : dollars(model.output)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rd-panel rd-model-section">
        <h2 className="rd-h">Product lines</h2>
        <ul className="rd-model-lines">
          {lines.map((line) => (
            <li key={line.name}>
              <a href={lineHref(line.name)}>{line.name}</a>{' '}
              <span className="rd-note">
                {line.models.length === 0
                  ? 'no model in the list'
                  : plural(line.models.length, 'model')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
