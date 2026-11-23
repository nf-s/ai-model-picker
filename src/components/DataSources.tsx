import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { minimums, plural, recordBenchmark } from '../lib/brief';
import type { BriefData } from '../lib/brief';
import type { CoreUsage } from '../lib/core-schema';
import { restrictedData } from '../lib/data';
import {
  byJob,
  crowdInFilters,
  inFilters,
  measuredFrom,
  limitsOf,
  pendingLabel,
  pendingRow,
  rowEntries,
} from '../lib/data-page';
import { surfaceName } from '../lib/fields';
import { crosswalkSources, jobRules } from '../lib/job-rules';
import type { FilterBar, Scope } from '../lib/model-filter';
import { useNamedAdvice } from '../lib/named-client';
import { namedOrder } from '../lib/named';
import type { NamedIndex, NamedRecord } from '../lib/named';
import { practitionerReview } from '../lib/practitioner';
import type { EvidenceRecord } from '../lib/records';
import { modelHref, routeHref } from '../lib/route';
import { percent, useHnData } from '../lib/site-data';
import { BenchmarkName, commentSpec, measuredSpec, namedSpec } from './Bands';
import { EvidenceButton } from './EvidenceDrawer';
import type { EvidenceSpec } from './EvidenceDrawer';
import { formatDay } from './FilterBar';
import { NamedUnavailable, namedNote, useNamed } from './Named';
import { searchFilter } from './Search';

// The Data page's record sections: every source with its class and count,
// the limits, job coverage, what each benchmark measures, and how jobs are
// assigned. Every count opens its records.

const jobNote = 'Job by review: it filters and never ranks a model.';

function dateRange(dates: readonly string[]) {
  const known = dates.filter(Boolean).sort();
  const first = known[0];
  const last = known.at(-1);
  if (!first || !last) return 'No dates';
  return first === last
    ? formatDay(first)
    : `${formatDay(first)} to ${formatDay(last)}`;
}

function Count({ n, open }: { n: number; open: () => EvidenceSpec }) {
  if (n === 0) return <>0</>;
  return <EvidenceButton spec={open}>{n.toLocaleString()}</EvidenceButton>;
}

function Row({
  source,
  cls,
  count,
  dates,
  note,
}: {
  source: ReactNode;
  cls: ReactNode;
  count: ReactNode;
  dates: ReactNode;
  note?: ReactNode;
}) {
  return (
    <tr>
      <td>
        {source}
        {note && <div className="rd-note">{note}</div>}
      </td>
      <td>{cls}</td>
      <td className="rd-num">{count}</td>
      <td>{dates}</td>
    </tr>
  );
}

export function Sources({
  data,
  advice,
}: {
  data: BriefData;
  advice: NamedRecord[] | null;
}) {
  const { core } = data;
  const named = useNamed();
  const ready = named.state.status === 'ready' ? named.state.value : null;
  const snapshot = measuredFrom(data, 'snapshot');
  const epoch = measuredFrom(data, 'epoch');
  const arena = measuredFrom(data, 'arena');
  const reports = measuredFrom(data, 'report');
  const restricted = measuredFrom(data, 'restricted');
  const published = (source: string) =>
    dateRange(
      data.benchmarks
        .filter((entry) => entry.source === source)
        .map((entry) => entry.publishedAt),
    );
  const hn = core.sources.hn;
  return (
    <section className="rd-section" aria-labelledby="rd-dp-loaded-title">
      <h2 className="rd-h" id="rd-dp-loaded-title">
        Sources in the records
      </h2>
      <p className="rd-note">
        Only measured records order models. Named and Crowd records are reported
        evidence and order a job only where no benchmark has a result; usage
        orders nothing.
      </p>
      <div className="rd-panel rd-dp-table">
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Class</th>
                <th className="rd-num">Records</th>
                <th>Dates</th>
              </tr>
            </thead>
            <tbody>
              <Row
                source="Benchmark results, picker snapshot"
                cls="Measured"
                count={
                  <Count
                    n={snapshot.length}
                    open={() =>
                      measuredSpec(data, 'Benchmark results', snapshot)
                    }
                  />
                }
                dates={`Checked ${formatDay(core.sources.snapshot)}`}
                note="Each benchmark’s credit is under Licences and attribution."
              />
              <Row
                source="Epoch AI runs"
                cls="Measured"
                count={
                  <Count
                    n={epoch.length}
                    open={() =>
                      measuredSpec(
                        data,
                        'Epoch AI runs',
                        epoch,
                        'Epoch’s own runs; results Epoch copies from other sources are not loaded.',
                      )
                    }
                  />
                }
                dates={`Run ${dateRange(epoch.map((record) => record.date))}; fetched ${formatDay(core.sources.epoch.fetchedAt)}`}
                note={core.sources.epoch.attribution}
              />
              <Row
                source="LMArena leaderboard ratings"
                cls="Measured (preference votes)"
                count={
                  <Count
                    n={arena.length}
                    open={() =>
                      measuredSpec(
                        data,
                        'LMArena ratings',
                        arena,
                        'Preference votes between two answers, or agent sessions: a rating relative to one leaderboard and date, not a pass rate.',
                      )
                    }
                  />
                }
                dates={`Published ${published('lmarena')}; fetched ${formatDay(core.sources.lmarena.fetchedAt)}`}
                note={core.sources.lmarena.attribution}
              />
              <Row
                source="Published reports and controlled studies"
                cls="Measured"
                count={
                  <Count
                    n={reports.length}
                    open={() =>
                      measuredSpec(data, 'Published reports', reports)
                    }
                  />
                }
                dates={dateRange(reports.map((record) => record.date))}
                note="Summarised in this site’s words; each links to the original."
              />
              {restricted.length > 0 && (
                <Row
                  source="Restricted benchmarks, signed-in accounts only"
                  cls="Measured"
                  count={
                    <Count
                      n={restricted.length}
                      open={() =>
                        measuredSpec(data, 'Restricted results', restricted)
                      }
                    />
                  }
                  dates={
                    restrictedData.checkedAt
                      ? `Checked ${formatDay(restrictedData.checkedAt)}`
                      : 'No date'
                  }
                  note="Their terms do not allow republishing; credits are under Licences and attribution."
                />
              )}
              {ready ? (
                <>
                  <Row
                    source="Practitioner use records, people review"
                    cls="Named (job by review)"
                    count={
                      <Count
                        n={ready.use.length}
                        open={() =>
                          namedSpec(
                            'Practitioner use records',
                            namedOrder(ready.use, named.trusted),
                            namedNote(named.state),
                          )
                        }
                      />
                    }
                    dates={dateRange(ready.use.map((record) => record.date))}
                    note={`From ${plural(ready.people.filter((person) => !person.adviceOnly).length, 'person', 'people')}; ${plural(
                      ready.people.reduce(
                        (sum, person) => sum + person.useLeftOut,
                        0,
                      ),
                      'record',
                    )} from people shown for method advice only are left out.`}
                  />
                  <Row
                    source="Method advice, people review"
                    cls="Named, never counted toward a model"
                    count={
                      advice ? (
                        <Count
                          n={advice.length}
                          open={() =>
                            namedSpec(
                              'Method advice',
                              namedOrder(advice, named.trusted),
                              'Advice names no model and is never counted toward one.',
                            )
                          }
                        />
                      ) : (
                        '…'
                      )
                    }
                    dates={
                      advice
                        ? dateRange(advice.map((record) => record.date))
                        : 'Loading'
                    }
                  />
                </>
              ) : (
                <tr>
                  <td>Practitioner use records and method advice</td>
                  <td>Named</td>
                  <td colSpan={2}>
                    <NamedUnavailable what="Practitioner records" />
                  </td>
                </tr>
              )}
              <Row
                source={`Hacker News comments, ${hn.labels.toLocaleString()} labels`}
                cls="Crowd"
                count={
                  <Count
                    n={hn.comments}
                    open={() =>
                      commentSpec('Hacker News comments', null, null, '')
                    }
                  />
                }
                dates={`${formatDay(hn.startAt.slice(0, 10))} to ${formatDay(hn.endAt.slice(0, 10))}`}
                note={`Labels by the ${hn.classifier} classifier; no author names are kept.`}
              />
              <Row
                source={
                  <>
                    Hand-checked practitioner findings, in the{' '}
                    <a href={routeHref({ view: 'apps' })}>App guide</a>
                  </>
                }
                cls="Reported, shown apart"
                count={
                  <a href={routeHref({ view: 'apps' })}>
                    {practitionerReview.findings.length}
                  </a>
                }
                dates={`Checked ${formatDay(practitionerReview.checkedAt)}`}
                note="Paraphrased with their sources; they order nothing."
              />
              {core.usage && <UsageRow usage={core.usage} data={data} />}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function UsageRow({ usage, data }: { usage: CoreUsage; data: BriefData }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>
          OpenRouter usage
          <div className="rd-note">{usage.note}</div>
          <div className="rd-note">{usage.tokens.attribution}</div>
        </td>
        <td>Usage, orders nothing</td>
        <td className="rd-num">
          <button
            type="button"
            className="rd-link rd-evidence"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {plural(usage.tokens.models.length, 'model')} ·{' '}
            {plural(usage.tasks.tags.length, 'task tag')}
          </button>
        </td>
        <td>
          Tokens {formatDay(usage.tokens.period.start)} to{' '}
          {formatDay(usage.tokens.period.end)}; task tags 7 days to{' '}
          {formatDay(usage.tasks.period.end)}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <table className="rd-table rd-band-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="rd-num">Tokens</th>
                  <th className="rd-num">Share of public tokens</th>
                  <th className="rd-num">Days in the top list</th>
                </tr>
              </thead>
              <tbody>
                {usage.tokens.models.map((row) => (
                  <tr key={row.modelId}>
                    <td>
                      <a href={modelHref(row.modelId)}>
                        {data.modelById.get(row.modelId)?.name ?? row.modelId}
                      </a>
                    </td>
                    <td className="rd-num">{row.tokens.toLocaleString()}</td>
                    <td className="rd-num">{(row.share * 100).toFixed(1)}%</td>
                    <td className="rd-num">{row.days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

export function Limits({ data }: { data: BriefData }) {
  const named = useNamed();
  const ready = named.state.status === 'ready' ? named.state.value : null;
  return (
    <section className="rd-section" aria-labelledby="rd-dp-limits-title">
      <h2 className="rd-h" id="rd-dp-limits-title">
        Limits
      </h2>
      <ul className="rd-panel rd-dp-limits">
        <li>
          Thin evidence: a stated-preference share needs {minimums.preferences}{' '}
          preferences and a Hacker News positive share {minimums.clearLabels}{' '}
          clearly positive or critical labels. Below that a page says so instead
          of showing a number. A job’s own benchmark sets Brief’s order once it
          covers {minimums.models} models. Missing prices and results are not
          estimated.
        </li>
        <li>
          Arena ratings are preference votes relative to one leaderboard and
          date, not pass rates. They never share a column with percentages.
        </li>
        <li>
          OpenRouter usage orders nothing: volume follows price, free routes and
          app defaults. Models outside a top 10 show nothing, not zero.
        </li>
        {data.core.jobs.status === 'draft' && (
          <li>
            The job list is a draft (version {data.core.jobs.version}). Jobs
            from sources come from their own labels or keyword rules, listed
            below.
          </li>
        )}
        <li>
          Practitioner records need sign-in. Their jobs are assigned by the
          people review: they filter and never rank a model.
        </li>
        {ready && <UseLimits named={ready} />}
      </ul>
    </section>
  );
}

function UseLimits({ named }: { named: NamedIndex }) {
  const { state, trusted } = useNamed();
  const limits = limitsOf(named);
  const note = namedNote(state);
  const { review } = named.payload;
  const unresolved = review.passages['unresolved'] ?? 0;
  const passages = Object.values(review.passages).reduce((a, b) => a + b, 0);
  const records = (title: string, list: NamedRecord[], n = list.length) => (
    <EvidenceButton
      spec={() => namedSpec(title, namedOrder(list, trusted), note)}
    >
      {n.toLocaleString()}
    </EvidenceButton>
  );
  const kind = (key: 'version' | 'line' | 'none') =>
    limits.kinds.get(key) ?? [];
  return (
    <>
      <li>
        Jobs by review agreed with a reference set{' '}
        {percent(review.jobAgreement.share)} of the time (
        {review.jobAgreement.check}).
      </li>
      <li>
        One person supplies{' '}
        {records('Use records from the largest single source', limits.largest)}{' '}
        of {limits.total.toLocaleString()} use records (
        {percent(limits.total ? limits.largest.length / limits.total : 0)}).
        Counts show where someone has written, not how often a model is used.
      </li>
      <li>
        Not resolved to an exact model:{' '}
        {records('Use records naming only a product line', kind('line'))} name
        only a product line and stay under it;{' '}
        {records(
          'Use records naming a version outside the model list',
          kind('version'),
        )}{' '}
        name a version outside the model list;{' '}
        {records('Use records naming no model', kind('none'))} name no model.
      </li>
      <li>
        {unresolved.toLocaleString()} of {passages.toLocaleString()} passages
        failed the review’s checks after a retry and are not records, so they
        cannot be opened here:{' '}
        {Object.entries(review.unresolvedByIssue)
          .sort((a, b) => b[1] - a[1])
          .map(([issue, n]) => `${n} ${issue.replace(/-/g, ' ')}`)
          .join(', ')}
        .
      </li>
      <li>
        {plural(limits.secondaryPeople, 'person is a', 'people are')} secondary{' '}
        {limits.secondaryPeople === 1 ? 'source' : 'sources'}:{' '}
        {records(
          'Secondary sources: records labelled measured',
          limits.secondaryMeasured,
        )}{' '}
        of their records the review labelled measured are shown as reported
        figures and filtered as second-hand.
      </li>
    </>
  );
}

const sourceLabels: Record<string, string> = {
  benchmark: 'Benchmark results',
  arena: 'Arena ratings',
  report: 'Reports',
  hn: 'Hacker News comments',
};

export function Coverage({
  data,
  filter,
  scope,
}: {
  data: BriefData;
  filter: FilterBar;
  scope: Scope;
}) {
  const { core } = data;
  const named = useNamed();
  const ready = named.state.status === 'ready' ? named.state.value : null;
  const [countCrowd, setCountCrowd] = useState(false);
  const hn = useHnData(countCrowd);
  const sf = useMemo(
    () => searchFilter(data, null, filter, scope),
    [data, filter, scope],
  );
  const built = useMemo(
    () =>
      new Map(
        ['benchmark', 'arena', 'report'].map((source) => [
          source,
          byJob(core.measured.filter((record) => record.src === source)),
        ]),
      ),
    [core],
  );
  const measuredIn = useMemo(
    () => byJob(inFilters(data.measured, sf)),
    [data, sf],
  );
  const namedAll = useMemo(() => (ready ? byJob(ready.use) : null), [ready]);
  const namedIn = useMemo(
    () => (ready ? byJob(inFilters(ready.use, sf)) : null),
    [ready, sf],
  );
  const crowdIn = useMemo(
    () =>
      hn.status === 'ready' ? crowdInFilters(hn.index, core.crowd, sf) : null,
    [hn, core, sf],
  );
  const since = sf.since;
  const pendingOld = core.coverage.pending.map((row) => row.old);
  for (const row of ready?.payload.pending ?? [])
    if (!pendingOld.includes(row.old)) pendingOld.push(row.old);
  const rows = [
    ...data.jobs.map((job) => ({
      id: job.id,
      label: job.label,
      sub: job.parent !== undefined,
    })),
    { id: 'pending', label: pendingLabel, sub: false },
    ...pendingOld.map((old) => ({
      id: pendingRow(old),
      label: `from ${jobRules.replaces[old]?.label ?? old}`,
      sub: true,
    })),
    { id: '', label: 'No job', sub: false },
  ];
  const labelOf = new Map(rows.map((row) => [row.id, row.label]));
  const label = (id: string) =>
    data.jobById.get(id)?.label ?? labelOf.get(id) ?? 'No job';
  // Hacker News comments by coverage row in the whole build: those that need
  // reading are kept apart from those with no job.
  const pendingIds = new Set(Object.values(core.crowd.pending).flat());
  const crowdBuilt = new Map<string, number[]>([
    ...Object.entries(core.crowd.comments).map(
      ([job, ids]): [string, number[]] => [
        job,
        job === '' ? ids.filter((id) => !pendingIds.has(id)) : ids,
      ],
    ),
    ...Object.entries(core.crowd.pending).map(
      ([old, ids]): [string, number[]] => [pendingRow(old), ids],
    ),
  ]);
  const off = (cls: 'measured' | 'named' | 'crowd') =>
    !filter.classes.includes(cls);
  const measuredCell = (
    job: string,
    records: EvidenceRecord[],
    title: string,
  ) => (
    <Count
      n={records.length}
      open={() => measuredSpec(data, `${title} · ${label(job)}`, records)}
    />
  );
  const namedCell = (job: string, records: NamedRecord[], title: string) => (
    <Count
      n={records.length}
      open={() =>
        namedSpec(
          `${title} · ${label(job)}`,
          namedOrder(records, named.trusted),
          `${jobNote} ${namedNote(named.state)}`,
        )
      }
    />
  );
  const crowdCell = (job: string, ids: readonly number[], title: string) => (
    <Count
      n={ids.length}
      open={() =>
        commentSpec(`${title} · ${label(job)}`, new Set(ids), null, '')
      }
    />
  );
  return (
    <section className="rd-section" aria-labelledby="rd-dp-coverage-title">
      <h2 className="rd-h" id="rd-dp-coverage-title">
        Job coverage
      </h2>
      <p className="rd-note">
        Records by their own job: a parent job’s row holds only its own records,
        though Brief also takes in its sub-jobs. The first columns are the whole
        build; the last apply the filter bar’s period, models, sources, basis,
        setting, run, surface and current-models setting
        {since ? ` (from ${formatDay(since)})` : ''}. Hacker News records count
        from the first of the period’s month. {pendingLabel}: records whose job
        under the earlier job list was split or became the setting or run field;
        they have no job until the next review, and none is guessed.
      </p>
      <div className="rd-panel rd-dp-table">
        <div className="rd-scroll">
          <table className="rd-table rd-dp-jobs">
            <thead>
              <tr>
                <th>Job</th>
                <th>Benchmarks that order Brief</th>
                {core.coverage.sources.map((source) => (
                  <th key={source} className="rd-num">
                    {sourceLabels[source] ?? source}
                  </th>
                ))}
                {namedAll && <th className="rd-num">Named (job by review)</th>}
                <th className="rd-num rd-dp-split">Measured in filters</th>
                {namedIn && <th className="rd-num">Named in filters</th>}
                <th className="rd-num">Crowd in filters</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const job = data.jobById.get(row.id);
                const benchmarks = job
                  ? job.benchmarks.flatMap(
                      (id) => data.benchmarkById.get(id) ?? [],
                    )
                  : [];
                const surfaceOf = (id: string) =>
                  Object.entries(job?.bySurface ?? {}).find(([, ids]) =>
                    ids?.includes(id),
                  )?.[0];
                return (
                  <tr key={row.id || 'none'}>
                    <td>
                      {row.sub && '↳ '}
                      {job ? (
                        <a href={routeHref({ view: 'brief', job: row.id })}>
                          {row.label}
                        </a>
                      ) : (
                        row.label
                      )}
                    </td>
                    <td className="rd-note">
                      {benchmarks.length > 0
                        ? benchmarks.map((entry, i) => {
                            const surface = surfaceOf(entry.id);
                            return (
                              <Fragment key={entry.id}>
                                {i > 0 && ', '}
                                <BenchmarkName benchmark={entry} />
                                {surface &&
                                  ` (${surfaceName(surface).toLowerCase()})`}
                              </Fragment>
                            );
                          })
                        : job
                          ? 'No measure'
                          : ''}
                    </td>
                    {core.coverage.sources.map((source) => (
                      <td key={source} className="rd-num">
                        {source === 'hn'
                          ? crowdCell(
                              row.id,
                              rowEntries(crowdBuilt, row.id),
                              'Hacker News comments',
                            )
                          : measuredCell(
                              row.id,
                              rowEntries(
                                built.get(source) ?? new Map(),
                                row.id,
                              ),
                              sourceLabels[source] ?? source,
                            )}
                      </td>
                    ))}
                    {namedAll && (
                      <td className="rd-num">
                        {namedCell(
                          row.id,
                          rowEntries(namedAll, row.id),
                          'Use records',
                        )}
                      </td>
                    )}
                    <td className="rd-num rd-dp-split">
                      {off('measured')
                        ? 'Off'
                        : measuredCell(
                            row.id,
                            rowEntries(measuredIn, row.id),
                            'Measured in filters',
                          )}
                    </td>
                    {namedIn && (
                      <td className="rd-num">
                        {off('named')
                          ? 'Off'
                          : namedCell(
                              row.id,
                              rowEntries(namedIn, row.id),
                              'Use records in filters',
                            )}
                      </td>
                    )}
                    <td className="rd-num">
                      {off('crowd')
                        ? 'Off'
                        : crowdIn
                          ? crowdCell(
                              row.id,
                              rowEntries(
                                new Map(
                                  [...crowdIn].map(([key, ids]) => [
                                    key,
                                    [...ids],
                                  ]),
                                ),
                                row.id,
                              ),
                              'Hacker News comments in filters',
                            )
                          : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {!off('crowd') && !crowdIn && (
        <p className="rd-note">
          {hn.status === 'loading' ? (
            'Loading the Hacker News comment index…'
          ) : hn.status === 'failed' ? (
            'The comment index could not be loaded, so Crowd counts within the filters are not shown.'
          ) : (
            <>
              Crowd counts within the filters read the whole comment index
              (several megabytes).{' '}
              <button
                type="button"
                className="rd-link"
                onClick={() => setCountCrowd(true)}
              >
                Count Crowd comments in filters
              </button>
            </>
          )}
        </p>
      )}
      <p className="rd-note">
        The Epoch Capabilities Index is a general index: its results have no job
        and order none. Method advice is not counted here.
      </p>
    </section>
  );
}

export function Measures({ data }: { data: BriefData }) {
  const records = useMemo(() => {
    const byBenchmark = new Map<string, EvidenceRecord[]>();
    for (const record of data.measured) {
      const id = recordBenchmark(record);
      if (id) byBenchmark.set(id, [...(byBenchmark.get(id) ?? []), record]);
    }
    return byBenchmark;
  }, [data]);
  return (
    <section className="rd-section" aria-labelledby="rd-dp-measures-title">
      <h2 className="rd-h" id="rd-dp-measures-title">
        What each benchmark measures
      </h2>
      <div className="rd-panel rd-dp-table">
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Benchmark</th>
                <th>Measures</th>
                <th>Source and dates</th>
                <th className="rd-num">Results</th>
              </tr>
            </thead>
            <tbody>
              {data.benchmarks.map((benchmark) => {
                const results = records.get(benchmark.id) ?? [];
                return (
                  <tr key={benchmark.id}>
                    <td>
                      <BenchmarkName benchmark={benchmark} />
                    </td>
                    <td>{benchmark.what}</td>
                    <td className="rd-note">
                      {benchmark.publisher || sourceName[benchmark.source]}
                      {benchmark.publishedAt
                        ? `, published ${formatDay(benchmark.publishedAt)}`
                        : benchmark.dates
                          ? `, ${dateRange(benchmark.dates)}`
                          : ''}
                    </td>
                    <td className="rd-num">
                      <Count
                        n={results.length}
                        open={() =>
                          measuredSpec(
                            data,
                            benchmark.name,
                            results,
                            benchmark.what,
                          )
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

const sourceName: Record<string, string> = {
  snapshot: 'Picker snapshot',
  lmarena: 'LMArena',
  epoch: 'Epoch AI',
  restricted: 'Restricted',
};

export function JobRules({ data }: { data: BriefData }) {
  const label = (job: string | null) => {
    if (job === null) return 'none';
    const old = jobRules.replaces[job];
    if (old && old.job === null) return `needs reading (${old.label})`;
    return data.jobById.get(job)?.label ?? job;
  };
  const fieldText = (rule: { setting?: string; run?: string }) =>
    [rule.setting && `setting: ${rule.setting}`, rule.run && `run: ${rule.run}`]
      .filter(Boolean)
      .join(', ');
  const replaced = Object.entries(jobRules.replaces);
  return (
    <section className="rd-section" aria-labelledby="rd-dp-rules-title">
      <h2 className="rd-h" id="rd-dp-rules-title">
        How records get a job
      </h2>
      <p className="rd-note">
        A source’s own label maps to a job through the crosswalk, with how well
        it fits: direct (the same task), loose (an overlapping one) or none.
        Hacker News themes are used only when the comment’s task is “other”. The
        people review’s job is kept as the review gave it and read through the
        replacements below. Job list version {data.core.jobs.version},{' '}
        {data.core.jobs.status}.
      </p>
      <details className="rd-panel rd-dp-details rd-dp-rules">
        <summary>
          Crosswalk from source labels:{' '}
          {plural(Object.keys(jobRules.crosswalk).length, 'table')}
        </summary>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Source field</th>
                <th>Label → job (fit)</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(jobRules.crosswalk).map(([source, table]) => (
                <tr key={source}>
                  <td>
                    {crosswalkSources[source] ?? source}
                    <div className="rd-note">
                      <code>{source}</code> · version {table.version}
                    </div>
                  </td>
                  <td className="rd-note">
                    {table.labels
                      .map(
                        (entry) =>
                          `${entry.label} → ${label(entry.job)} (${entry.fit}${entry.note ? `: ${entry.note}` : ''})`,
                      )
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="rd-panel rd-dp-details rd-dp-rules">
        <summary>
          Jobs of the earlier list: {plural(replaced.length, 'replacement')}
        </summary>
        <p className="rd-note">
          Stored records keep the job they were reviewed with. A job that was
          merged gives its new job; one that was split or became a field gives
          no job until the next review, and sets the field where it implies one.
        </p>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Earlier job</th>
                <th>Now</th>
                <th>Sets</th>
              </tr>
            </thead>
            <tbody>
              {replaced.map(([old, entry]) => (
                <tr key={old}>
                  <td>
                    {entry.label}
                    <div className="rd-note">
                      <code>{old}</code>
                    </div>
                  </td>
                  <td className="rd-note">
                    {entry.job !== null
                      ? label(entry.job)
                      : entry.into
                        ? `Split into ${entry.into.map(label).join(' and ')}; needs reading`
                        : 'No job; needs reading'}
                  </td>
                  <td className="rd-note">{fieldText(entry) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="rd-panel rd-dp-details rd-dp-rules">
        <summary>Setting, run and surface rules</summary>
        <p className="rd-note">
          Setting is local or hosted (the default), run unattended, parallel or
          interactive (the default). Both are set by rule, never guessed; a
          record that states neither leaves them blank. Surface comes from the
          tool a record names, the first group whose word it contains.
        </p>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Sets</th>
              </tr>
            </thead>
            <tbody>
              {jobRules.fields['hn-theme'].map((rule) => (
                <tr key={`theme-${rule.label}`}>
                  <td>
                    Hacker News theme <code>{rule.label}</code>
                  </td>
                  <td className="rd-note">{fieldText(rule)}</td>
                </tr>
              ))}
              {jobRules.fields.surface.map((rule) => (
                <tr key={`surface-${rule.surface}`}>
                  <td>Surface: {surfaceName(rule.surface).toLowerCase()}</td>
                  <td className="rd-note">{fieldText(rule)}</td>
                </tr>
              ))}
              {jobRules.surface.surfaces.map((entry) => (
                <tr key={entry.surface}>
                  <td>Tool names {entry.words.join(', ')}</td>
                  <td className="rd-note">
                    surface: {surfaceName(entry.surface).toLowerCase()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details className="rd-panel rd-dp-details rd-dp-rules">
        <summary>
          Keyword rules: {plural(jobRules.keywords.rules.length, 'rule')}; tag
          rules: {plural(jobRules.tags.rules.length, 'rule')}
        </summary>
        <p className="rd-note">
          Keyword rules give a job from a record’s text and run in order. A tag
          rule marks records on the model page and never gives or changes a job.
        </p>
        <div className="rd-scroll">
          <table className="rd-table">
            <thead>
              <tr>
                <th>Gives</th>
                <th>Applies when the label’s job is</th>
                <th>Pattern</th>
              </tr>
            </thead>
            <tbody>
              {jobRules.keywords.rules.map((rule, i) => (
                <tr key={i}>
                  <td>{label(rule.job)}</td>
                  <td className="rd-note">
                    {rule.within.map(label).join(', ')}
                  </td>
                  <td className="rd-dp-pattern">
                    <code>{rule.pattern}</code>
                    {rule.caseSensitive && (
                      <span className="rd-note"> (case-sensitive)</span>
                    )}
                  </td>
                </tr>
              ))}
              {jobRules.tags.rules.map((rule) => (
                <tr key={rule.tag}>
                  <td>Tag: {rule.label}</td>
                  <td className="rd-note">
                    Any job; read from a use record’s task or a Hacker News
                    claim
                  </td>
                  <td className="rd-dp-pattern">
                    <code>{rule.pattern}</code>
                    {rule.caseSensitive && (
                      <span className="rd-note"> (case-sensitive)</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

// Method advice is requested only for a granted account, and only here and
// on the views that list it.
export function useAdvice(): NamedRecord[] | null {
  const { access, state } = useNamed();
  const advice = useNamedAdvice(access, state.status === 'ready');
  return advice.status === 'ready' ? advice.value : null;
}
