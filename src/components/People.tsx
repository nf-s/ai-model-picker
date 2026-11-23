import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { briefFilters, findJob, plural } from '../lib/brief';
import type { BriefData, BriefFilters } from '../lib/brief';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { CoreJob } from '../lib/core-schema';
import { loadExpertArticles } from '../lib/expert-articles';
import type { ExpertArticle } from '../lib/expert-articles';
import type { FilterBar, Scope } from '../lib/model-filter';
import { keyLabel } from '../lib/model-page';
import {
  articlesOf,
  basisLabels,
  keyKind,
  moveTrusted,
  nameKindLabels,
  outcomeTally,
  peopleMatrix,
  peopleOrder,
  personAdvice,
  personSummary,
  siteOwners,
} from '../lib/named';
import type {
  AdviceRecord,
  MatrixKind,
  NamedIndex,
  NamedRecord,
} from '../lib/named';
import { canLoadNamed, useNamedAdvice } from '../lib/named-client';
import { lineHref, modelHref, personHref, routeHref } from '../lib/route';
import type { Route } from '../lib/route';
import { percent } from '../lib/site-data';
import { namedSpec, RecordsStatus } from './Bands';
import { EvidenceButton } from './EvidenceDrawer';
import { formatDay } from './FilterBar';
import {
  NamedCard,
  namedNote,
  NamedUnavailable,
  OutcomeBar,
  SecondaryTag,
  StarButton,
  useNamed,
} from './Named';
import './people.css';

type PeopleRoute = Extract<Route, { view: 'people' }>;
type PageContext = {
  data: BriefData;
  filters: BriefFilters;
  index: NamedIndex;
  job: CoreJob | null;
  route: PeopleRoute;
};

// People who publish their work with these models, and what their records
// name. Everything here is behind sign-in; without it the page is one line.
export default function People({
  route,
  coreData,
  filter,
  scope,
}: {
  route: PeopleRoute;
  coreData: CoreData;
  filter: FilterBar;
  scope: Scope;
}) {
  const data = useBriefData(coreData);
  const { state } = useNamed();
  const head = (
    <header className="rd-page-head">
      {route.name !== null && (
        <p className="rd-note">
          <a href={routeHref({ ...route, name: null })}>People</a>
        </p>
      )}
      <h1>
        {route.name === null || state.status !== 'ready'
          ? 'People'
          : route.name}
      </h1>
    </header>
  );
  if (state.status !== 'ready')
    return (
      <div className="rd-page">
        {head}
        <p className="rd-panel rd-brief-notice">
          <NamedUnavailable what="Practitioner records" />
        </p>
      </div>
    );
  if (!data) return <RecordsStatus coreData={coreData} />;
  const job = route.job === null ? null : findJob(data, route.job);
  if (route.job !== null && job === null)
    return (
      <div className="rd-page">
        {head}
        <p className="rd-panel rd-brief-notice" role="status">
          No job has the id “{route.job}”.{' '}
          <a href={routeHref({ ...route, job: null })}>Show all jobs</a>
        </p>
      </div>
    );
  const ctx: PageContext = {
    data,
    filters: briefFilters(data, filter, scope.model),
    index: state.value,
    job,
    route,
  };
  return route.name === null ? (
    <PeopleList ctx={ctx} />
  ) : (
    <Person key={route.name} ctx={ctx} name={route.name} />
  );
}

function scopeText(ctx: PageContext) {
  return [
    ctx.job ? `job “${ctx.job.label}” (by review)` : 'all jobs',
    ctx.filters.since ? `from ${formatDay(ctx.filters.since)}` : 'all dates',
  ].join(', ');
}

// A target's name with what kind of target it is.
function TargetName({ data, keyText }: { data: BriefData; keyText: string }) {
  const kind = keyKind(keyText);
  const name = keyLabel(data, keyText);
  if (kind === 'model') return <a href={modelHref(keyText.slice(6))}>{name}</a>;
  if (kind === 'line')
    return (
      <>
        <a href={lineHref(name)}>{name}</a>{' '}
        <span className="rd-note">(line)</span>
      </>
    );
  if (kind === 'version')
    return (
      <>
        {name} <span className="rd-note">(not in the model list)</span>
      </>
    );
  return <>{name}</>;
}

// The slate accent at a strength that follows a count.
const shade = (strength: number) => `rgba(53, 80, 111, ${strength.toFixed(2)})`;

function Shade({
  count,
  peak,
  children,
}: {
  count: number;
  peak: number;
  children: ReactNode;
}) {
  const share = peak === 0 ? 0 : count / peak;
  return (
    <span
      className={share > 0.45 ? 'rd-pp-cell rd-pp-cell-dark' : 'rd-pp-cell'}
      style={{ background: shade(0.06 + 0.74 * share) }}
    >
      {children}
    </span>
  );
}

function PeopleList({ ctx }: { ctx: PageContext }) {
  const { state, trusted } = useNamed();
  const [kind, setKind] = useState<MatrixKind>('targets');
  const matrix = peopleMatrix(
    ctx.data,
    ctx.index,
    ctx.job?.id ?? null,
    ctx.filters,
    trusted,
    kind,
  );
  const note = namedNote(state);
  const peak = Math.max(
    0,
    ...matrix.rows.flatMap((row) =>
      [...row.cells.values()].map((records) => records.length),
    ),
  );
  const open = (title: string, records: NamedRecord[], text: ReactNode) => (
    <EvidenceButton spec={() => namedSpec(title, records, note)}>
      {text}
    </EvidenceButton>
  );
  return (
    <div className="rd-page rd-people">
      <header className="rd-page-head">
        <h1>People</h1>
        <p>
          {plural(
            ctx.index.people.length,
            'person or outlet',
            'people and outlets',
          )}{' '}
          who publish their work with these models. Use records within the
          filters: {scopeText(ctx)}.
        </p>
      </header>
      {!ctx.filters.classes.includes('named') && (
        <p className="rd-panel rd-brief-notice">
          Named records are hidden by the source filter.
        </p>
      )}
      <section className="rd-panel rd-pp-section">
        <div className="rd-pp-head">
          <h2 className="rd-h">
            Who has reported on what ·{' '}
            {plural(matrix.records.length, 'use record')}
          </h2>
          <span className="rd-seg">
            <button
              type="button"
              aria-pressed={kind === 'targets'}
              onClick={() => setKind('targets')}
            >
              Models and lines
            </button>
            <button
              type="button"
              aria-pressed={kind === 'tools'}
              onClick={() => setKind('tools')}
            >
              Tools
            </button>
          </span>
        </div>
        <div className="rd-scroll">
          <table className="rd-table rd-pp-matrix">
            <thead>
              <tr>
                <th>Person</th>
                {matrix.columns.map((key) => (
                  <th key={key} className="rd-pp-col">
                    <TargetName data={ctx.data} keyText={key} />
                  </th>
                ))}
                <th className="rd-num">Use records</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map(({ person, records, cells }) => (
                <tr key={person.name}>
                  <td className="rd-pp-who">
                    <StarButton name={person.name} />
                    <a href={personHref(person.name, ctx.route.job)}>
                      {person.name}
                    </a>
                  </td>
                  {person.adviceOnly ? (
                    <td colSpan={matrix.columns.length + 1} className="rd-note">
                      Method advice only: too few use records name a model.
                    </td>
                  ) : (
                    <>
                      {matrix.columns.map((key) => {
                        const hit = cells.get(key) ?? [];
                        return (
                          <td key={key} className="rd-num">
                            {hit.length > 0 && (
                              <Shade count={hit.length} peak={peak}>
                                {open(
                                  `${person.name} · ${keyLabel(ctx.data, key)}`,
                                  hit,
                                  hit.length.toLocaleString(),
                                )}
                                <OutcomeBar tally={outcomeTally(hit)} />
                              </Shade>
                            )}
                          </td>
                        );
                      })}
                      <td className="rd-num">
                        {records.length === 0 ? (
                          <span className="rd-muted">0</span>
                        ) : (
                          open(
                            `${person.name} · use records`,
                            records,
                            records.length.toLocaleString(),
                          )
                        )}
                      </td>
                    </>
                  )}
                  <td className="rd-nowrap">
                    {person.sourceClass === 'secondary' ? (
                      <SecondaryTag person={person} />
                    ) : (
                      <span className="rd-note">first-hand</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="rd-note">
          A cell counts use records that name the target; the strip is their
          outcome. A count shows where someone has written, not how often they
          use a model, and orders nothing.
          {matrix.top &&
            ` ${matrix.top.person.name} supplies ${matrix.top.count.toLocaleString()} of ${matrix.records.length.toLocaleString()} (${percent(matrix.top.count / Math.max(1, matrix.records.length))}).`}{' '}
          Product lines and versions outside the model list are columns of their
          own, never added to a model; models follow the model filter and
          Current models only. Starred people are listed first.
        </p>
      </section>
      <TrustedPanel index={ctx.index} job={ctx.route.job} />
    </div>
  );
}

function TrustedPanel({
  index,
  job,
}: {
  index: NamedIndex;
  job: string | null;
}) {
  const { trusted, setTrusted } = useNamed();
  const others = peopleOrder(index.people, trusted).filter(
    (person) => !trusted.includes(person.name),
  );
  return (
    <section className="rd-panel rd-pp-section">
      <h2 className="rd-h">Trusted people</h2>
      <p className="rd-note">
        Their records come first in every Named band, in this order. Kept in
        this browser.
      </p>
      {trusted.length > 0 ? (
        <ol className="rd-pp-trusted">
          {trusted.map((name, at) => (
            <li key={name}>
              <StarButton name={name} />
              <a href={personHref(name, job)}>{name}</a>
              <button
                type="button"
                className="rd-button"
                disabled={at === 0}
                aria-label={`Move ${name} up`}
                onClick={() => setTrusted(moveTrusted(trusted, at, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="rd-button"
                disabled={at === trusted.length - 1}
                aria-label={`Move ${name} down`}
                onClick={() => setTrusted(moveTrusted(trusted, at, 1))}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rd-note">None starred.</p>
      )}
      <h3 className="rd-pp-sub">Others</h3>
      <ul className="rd-pp-others">
        {others.map((person) => (
          <li key={person.name}>
            <StarButton name={person.name} />
            <a href={personHref(person.name, job)}>{person.name}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

const shownCards = 4;

function RecordList({
  title,
  records,
  note,
  person,
  shown = shownCards,
}: {
  title: string;
  records: NamedRecord[];
  note: string;
  person: string;
  shown?: number;
}) {
  return (
    <section className="rd-panel rd-pp-section">
      <h2 className="rd-h">
        {title}: {records.length.toLocaleString()}
      </h2>
      {records.length === 0 ? (
        <p className="rd-note">None within the filters.</p>
      ) : (
        <div className="rd-ncards">
          {records.slice(0, shown).map((record) => (
            <NamedCard key={record.id} record={record} />
          ))}
        </div>
      )}
      {records.length > shown && (
        <p>
          <EvidenceButton
            spec={() => namedSpec(`${person} · ${title}`, records, note)}
          >
            {`All ${records.length.toLocaleString()}`}
          </EvidenceButton>
        </p>
      )}
    </section>
  );
}

function Person({ ctx, name }: { ctx: PageContext; name: string }) {
  const named = useNamed();
  const person = ctx.index.personByName.get(name);
  const adviceState = useNamedAdvice(
    named.access,
    person !== undefined && canLoadNamed(named.access),
  );
  if (!person)
    return (
      <div className="rd-page">
        <header className="rd-page-head">
          <p className="rd-note">
            <a href={routeHref({ ...ctx.route, name: null })}>People</a>
          </p>
          <h1>People</h1>
        </header>
        <p className="rd-panel rd-brief-notice" role="status">
          No person is named “{name}”.{' '}
          <a href={routeHref({ ...ctx.route, name: null })}>All people</a>
        </p>
      </div>
    );
  const jobId = ctx.job?.id ?? null;
  const summary = personSummary(
    ctx.data,
    ctx.index,
    name,
    jobId,
    ctx.filters,
    named.trusted,
  );
  const advice =
    adviceState.status === 'ready'
      ? personAdvice(ctx.data, adviceState.value, name, jobId, ctx.filters)
      : null;
  const note = namedNote(named.state);
  const open = (title: string, records: NamedRecord[], text: string) => (
    <EvidenceButton spec={() => namedSpec(`${name} · ${title}`, records, note)}>
      {text}
    </EvidenceButton>
  );
  const channels = [
    ...summary.records
      .reduce(
        (counts, record) =>
          counts.set(
            record.use.channel,
            (counts.get(record.use.channel) ?? 0) + 1,
          ),
        new Map<string, number>(),
      )
      .entries(),
  ].sort((a, b) => b[1] - a[1]);
  return (
    <div className="rd-page rd-people">
      <header className="rd-page-head">
        <p className="rd-note">
          <a href={routeHref({ ...ctx.route, name: null })}>People</a>
        </p>
        <h1 className="rd-pp-name">
          <StarButton name={name} /> {name} <SecondaryTag person={person} />
        </h1>
        <p>
          {plural(summary.records.length, 'use record')}
          {advice !== null &&
            ` and ${plural(advice.length, 'piece', 'pieces')} of method advice`}{' '}
          within the filters: {scopeText(ctx)}.
          {channels.length > 0 &&
            ` ${channels.map(([channel, count]) => `${count.toLocaleString()} from ${channel}`).join(' · ')}.`}
        </p>
        {person.sourceClass === 'secondary' && (
          <p className="rd-note">
            Secondary source: many records quote other people’s reports, system
            cards or survey answers. A record the review labelled “measured” is
            shown as a reported figure and filtered as second-hand.
          </p>
        )}
        {person.adviceOnly && (
          <p className="rd-note">
            Method advice only. {plural(person.useLeftOut, 'use record')} from
            the review are not loaded: too few name a model to stand in the
            Named band.
          </p>
        )}
        {person.dropped && (
          <p className="rd-note">
            Collection stopped on {formatDay(person.dropped.date)}; the stored
            records stay.
          </p>
        )}
      </header>
      {!person.adviceOnly && (
        <>
          <section className="rd-panel rd-pp-section">
            <h2 className="rd-h">What the records name</h2>
            <p className="rd-pp-row">
              {summary.byName.map((group) => (
                <span key={group.kind}>
                  {open(
                    `names ${nameKindLabels[group.kind]}`,
                    group.records,
                    `${group.records.length.toLocaleString()} name ${nameKindLabels[group.kind]}`,
                  )}
                </span>
              ))}
            </p>
            <h3 className="rd-pp-sub">Basis</h3>
            <p className="rd-pp-row">
              {summary.byBasis.map((group) => (
                <span key={group.basis}>
                  {open(
                    basisLabels[group.basis].toLowerCase(),
                    group.records,
                    `${basisLabels[group.basis]} ${group.records.length.toLocaleString()}`,
                  )}
                </span>
              ))}
            </p>
            <h3 className="rd-pp-sub">Job, as assigned by the review</h3>
            <p className="rd-pp-row">
              {summary.byJob.map((group) => {
                const label = group.job ? named.jobLabel(group.job) : 'No job';
                return (
                  <span key={group.job}>
                    {open(
                      `${label} (job by review)`,
                      group.records,
                      `${label} ${group.records.length.toLocaleString()}`,
                    )}
                  </span>
                );
              })}
            </p>
            <p className="rd-note">
              Jobs were assigned by the model review and only filter. Counts
              show what was written about, not how good a model is.
            </p>
          </section>
          <Timeline ctx={ctx} name={name} summary={summary} note={note} />
          <div className="rd-pp-cols">
            <RecordList
              title="Use records naming a model in the list"
              records={summary.models}
              note={note}
              person={name}
            />
            <RecordList
              title="Comparisons"
              records={summary.comparisons}
              note={note}
              person={name}
            />
          </div>
        </>
      )}
      <div className="rd-pp-cols">
        {!person.adviceOnly && (
          <RecordList
            title="Failed or abandoned"
            records={summary.failures}
            note={note}
            person={name}
          />
        )}
        {advice === null ? (
          <section className="rd-panel rd-pp-section">
            <h2 className="rd-h">Method advice</h2>
            <p className="rd-note" role="status">
              {adviceState.status === 'failed'
                ? 'Method advice could not be loaded.'
                : 'Loading method advice…'}
            </p>
          </section>
        ) : (
          <RecordList
            title="Method advice"
            records={advice}
            note="Advice that names no model. It never counts toward a model or a job."
            person={name}
            shown={person.adviceOnly ? 8 : shownCards}
          />
        )}
      </div>
      <Articles
        name={name}
        advice={adviceState.status === 'ready' ? adviceState.value : null}
        index={ctx.index}
        since={ctx.filters.since}
      />
    </div>
  );
}

function Timeline({
  ctx,
  name,
  summary,
  note,
}: {
  ctx: PageContext;
  name: string;
  summary: ReturnType<typeof personSummary>;
  note: string;
}) {
  const { months, rows } = summary.timeline;
  const peak = Math.max(
    0,
    ...rows.flatMap((row) => row.cells.map((cell) => cell.length)),
  );
  return (
    <section className="rd-panel rd-pp-section">
      <h2 className="rd-h">Timeline</h2>
      {rows.length === 0 ? (
        <p className="rd-note">
          No use record within the filters names a model, line or tool.
        </p>
      ) : (
        <div className="rd-scroll">
          <table className="rd-pp-timeline">
            <thead>
              <tr>
                <th />
                {months.map((month, at) => (
                  <th key={month} scope="col">
                    {at === 0 || month.endsWith('-01') ? month.slice(0, 4) : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    <TargetName data={ctx.data} keyText={row.key} />
                  </th>
                  {row.cells.map((cell, at) => {
                    const month = months[at] ?? '';
                    const label = `${keyLabel(ctx.data, row.key)} · ${month}`;
                    return (
                      <td key={month}>
                        {cell.length > 0 && (
                          <EvidenceButton
                            spec={() =>
                              namedSpec(`${name} · ${label}`, cell, note)
                            }
                          >
                            <span
                              className="rd-pp-tick"
                              title={`${label}: ${cell.length}`}
                              aria-label={`${label}: ${cell.length}`}
                              style={{
                                background: shade(
                                  0.2 + 0.8 * (cell.length / Math.max(1, peak)),
                                ),
                              }}
                            />
                          </EvidenceButton>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="rd-note">
        Use records per month for the targets named most, {months[0] ?? ''} to{' '}
        {months[months.length - 1] ?? ''}. Years are marked at January.
      </p>
    </section>
  );
}

type Catalog =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'sign-in' }
  | { status: 'ready'; articles: ExpertArticle[] };

const shownArticles = 15;

// The person's articles from the article catalog: a catalog link belongs to
// a person when only that person's records link to its site.
function Articles({
  name,
  advice,
  index,
  since,
}: {
  name: string;
  advice: readonly AdviceRecord[] | null;
  index: NamedIndex;
  since: string;
}) {
  const [catalog, setCatalog] = useState<Catalog>({ status: 'loading' });
  const [all, setAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    loadExpertArticles(controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setCatalog(
          result.kind === 'ready'
            ? { status: 'ready', articles: result.articles }
            : { status: 'sign-in' },
        );
      },
      () => {
        if (!controller.signal.aborted) setCatalog({ status: 'failed' });
      },
    );
    return () => controller.abort();
  }, []);
  const owners = useMemo(
    () => (advice === null ? null : siteOwners([...index.use, ...advice])),
    [index, advice],
  );
  const articles =
    catalog.status === 'ready' && owners
      ? articlesOf(catalog.articles, owners, name).filter(
          (article) => !since || article.date >= since,
        )
      : null;
  return (
    <section className="rd-panel rd-pp-section">
      <h2 className="rd-h">
        Articles{articles !== null && `: ${articles.length.toLocaleString()}`}
      </h2>
      {articles === null ? (
        <p className="rd-note" role="status">
          {catalog.status === 'failed'
            ? 'The article catalog could not be loaded.'
            : catalog.status === 'sign-in'
              ? 'The article catalog needs sign-in.'
              : 'Loading articles…'}
        </p>
      ) : articles.length === 0 ? (
        <p className="rd-note">
          No verified authored article in the catalog
          {since ? ' within the period' : ''}.
        </p>
      ) : (
        <>
          <ul className="rd-pp-articles">
            {(all ? articles : articles.slice(0, shownArticles)).map(
              (article) => (
                <li key={article.url}>
                  <time dateTime={article.date}>{article.date}</time>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title}
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </a>
                </li>
              ),
            )}
          </ul>
          {articles.length > shownArticles && (
            <button
              type="button"
              className="rd-link"
              onClick={() => setAll(!all)}
            >
              {all ? 'Show fewer' : `All ${articles.length.toLocaleString()}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
