import { useEffect, useMemo, useState } from 'react';
import { periodStart, recordBenchmark } from '../lib/brief';
import type { BriefData } from '../lib/brief';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { FilterBar, Scope } from '../lib/model-filter';
import { canLoadNamed, useNamedAdvice } from '../lib/named-client';
import type { NamedRecord } from '../lib/named';
import type { EvidenceRecord } from '../lib/records';
import { lineHref, modelHref, personHref, routeHref } from '../lib/route';
import type { Route } from '../lib/route';
import {
  foundIn,
  groupByJob,
  jobFilter,
  matchingRule,
  memoryCorpus,
  queryWords,
  rankRecords,
  searchLimits,
  wordsNeeded,
} from '../lib/search';
import type { Hit, MemoryCorpus, Ranked, SearchFilter } from '../lib/search';
import { staticSource } from '../lib/search-static';
import { indexKey } from './Bands';
import { useEvidence } from './EvidenceDrawer';
import { NamedUnavailable, useNamed } from './Named';
import './search.css';

// The public records are read from the static index under /search/; the
// named records, for a granted account, are searched where they already are.
const publicSource = staticSource();

type Outcome =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'missing' }
  | {
      status: 'ready';
      found: string[];
      notFound: string[];
      dropped: string[];
      measured: Ranked;
      crowd: Ranked;
      use: Ranked | null;
      advice: Ranked | null;
    };

// The filter bar as the search reads it.
function searchFilter(
  data: BriefData,
  job: string | null,
  bar: FilterBar,
  scope: Scope,
): SearchFilter {
  return {
    ...jobFilter(data, job),
    classes: bar.classes,
    since: periodStart(data.end, bar.period),
    key: scope.active ? (key) => scope.key(indexKey(key)) : null,
    current: bar.current
      ? (id) => data.modelById.get(id)?.status === 'current'
      : null,
    basis: new Set(bar.basis),
  };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function Search({
  route,
  coreData,
  filter,
  scope,
}: {
  route: Extract<Route, { view: 'search' }>;
  coreData: CoreData;
  filter: FilterBar;
  scope: Scope;
}) {
  const data = useBriefData(coreData);
  const { access, state } = useNamed();
  const advice = useNamedAdvice(
    access,
    canLoadNamed(access) && route.words !== '',
  );
  const [draft, setDraft] = useState(route.words);
  useEffect(() => setDraft(route.words), [route.words]);

  const modelName = useMemo(
    () => (id: string) => data?.modelById.get(id)?.name ?? id,
    [data],
  );
  const jobName = useMemo(
    () => (id: string) => data?.jobById.get(id)?.label ?? id,
    [data],
  );
  const useRecords = state.status === 'ready' ? state.value.use : null;
  const adviceRecords = advice.status === 'ready' ? advice.value : null;
  const useIndex = useMemo(
    () => (useRecords ? memoryCorpus(useRecords, modelName, jobName) : null),
    [useRecords, modelName, jobName],
  );
  const adviceIndex = useMemo(
    () =>
      adviceRecords ? memoryCorpus(adviceRecords, modelName, jobName) : null,
    [adviceRecords, modelName, jobName],
  );
  const searchBy = useMemo(
    () => (data ? searchFilter(data, route.job, filter, scope) : null),
    [data, route.job, filter, scope],
  );

  const [outcome, setOutcome] = useState<Outcome>({ status: 'empty' });
  useEffect(() => {
    if (!searchBy) return;
    const { words, dropped } = queryWords(route.words);
    if (words.length === 0) {
      setOutcome({ status: 'empty' });
      return;
    }
    let current = true;
    setOutcome({ status: 'loading' });
    const rankHeld = (
      records: readonly NamedRecord[] | null,
      index: MemoryCorpus | null,
      found: string[],
      need: number,
    ) =>
      records && index
        ? rankRecords(records, index, found, need, searchBy)
        : null;
    (async (): Promise<Outcome> => {
      const found = foundIn(words, [
        await publicSource.found(words),
        ...[useIndex, adviceIndex].flatMap((index) =>
          index ? [index.postings] : [],
        ),
      ]);
      const need = wordsNeeded(found.length);
      const { measured, crowd } = await publicSource.search(
        found,
        need,
        searchBy,
      );
      return {
        status: 'ready',
        found,
        notFound: words.filter((word) => !found.includes(word)),
        dropped,
        measured,
        crowd,
        use: rankHeld(useRecords, useIndex, found, need),
        advice: rankHeld(adviceRecords, adviceIndex, found, need),
      };
    })().then(
      (next) => {
        if (current) setOutcome(next);
      },
      () => {
        if (current) setOutcome({ status: 'missing' });
      },
    );
    return () => {
      current = false;
    };
  }, [route.words, searchBy, useRecords, useIndex, adviceRecords, adviceIndex]);

  const submit = () => {
    window.location.hash = routeHref({
      view: 'search',
      words: draft.trim(),
      job: route.job,
    });
  };
  const classes = filter.classes;
  // Until core.json is read there is nothing to filter by.
  const shown: Outcome = searchBy
    ? outcome
    : coreData.status === 'failed'
      ? { status: 'missing' }
      : route.words
        ? { status: 'loading' }
        : { status: 'empty' };

  return (
    <div className="rd-page rd-search">
      <header className="rd-page-head">
        <h1>Search</h1>
      </header>
      <form
        className="rd-search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          className="rd-input"
          type="search"
          value={draft}
          maxLength={200}
          aria-label="Words to search for"
          placeholder="Words, e.g. opus refactor"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="rd-button">
          Search
        </button>
      </form>
      {shown.status === 'empty' && (
        <p className="rd-note">
          {route.words
            ? 'None of these words is searched: they are too short or too common.'
            : 'Searches benchmark results, arena ratings, reports and Hacker News labels, and practitioner records for granted accounts. Results follow the filters above.'}
        </p>
      )}
      {shown.status === 'loading' && (
        <p className="rd-note" role="status">
          Searching…
        </p>
      )}
      {shown.status === 'missing' && (
        <p className="rd-note" role="alert">
          Search is unavailable: the records could not be read. If the site was
          just updated, reload the page.
        </p>
      )}
      {shown.status === 'ready' && data && (
        <>
          <p className="rd-note" role="status">
            {shown.found.length > 0
              ? `Words searched: ${shown.found.join(', ')}. ${matchingRule}`
              : 'None of these words is in the records.'}
            {shown.notFound.length > 0 &&
              ` Not in the records: ${shown.notFound.join(', ')}.`}
            {shown.dropped.length > 0 &&
              ` Only the first ${searchLimits.words} words are searched; left out: ${shown.dropped.join(', ')}.`}
          </p>
          <div className="rd-bands">
            {classes.includes('measured') && (
              <PublicBand
                band="measured"
                ranked={shown.measured}
                data={data}
                words={route.words}
              />
            )}
            {classes.includes('named') &&
              (shown.use === null ? (
                <section className="rd-band">
                  <p className="rd-band-head">
                    <span className="rd-band-chip rd-band-named">Named</span>
                  </p>
                  <NamedUnavailable what="Practitioner records" />
                </section>
              ) : (
                <>
                  <NamedBand
                    title="Use records"
                    ranked={shown.use}
                    records={useRecords ?? []}
                    data={data}
                    words={route.words}
                  />
                  {shown.advice === null ? (
                    <section className="rd-band">
                      <p className="rd-band-head">
                        <span className="rd-band-chip rd-band-named">
                          Named
                        </span>
                        <span className="rd-note">Method advice</span>
                      </p>
                      <p className="rd-note" role="status">
                        {advice.status === 'failed'
                          ? 'Method advice could not be loaded.'
                          : 'Loading method advice…'}
                      </p>
                    </section>
                  ) : (
                    <NamedBand
                      title="Method advice"
                      note="Advice names no model and is never counted toward one."
                      ranked={shown.advice}
                      records={adviceRecords ?? []}
                      data={data}
                      words={route.words}
                    />
                  )}
                </>
              ))}
            {classes.includes('crowd') && (
              <PublicBand
                band="crowd"
                ranked={shown.crowd}
                data={data}
                words={route.words}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// How many records a band shows, growing a page at a time.
function useShown(ranked: Ranked) {
  const [shown, setShown] = useState<number>(searchLimits.page);
  useEffect(() => setShown(searchLimits.page), [ranked]);
  const hits = useMemo(() => ranked.hits.slice(0, shown), [ranked, shown]);
  const next = Math.min(searchLimits.page, ranked.hits.length - shown);
  return {
    hits,
    more: next > 0 ? { count: next, show: () => setShown(shown + next) } : null,
  };
}

function BandFoot({
  ranked,
  more,
}: {
  ranked: Ranked;
  more: { count: number; show: () => void } | null;
}) {
  if (more)
    return (
      <button type="button" className="rd-more" onClick={more.show}>
        Show {more.count} more
      </button>
    );
  if (ranked.total > ranked.hits.length)
    return (
      <p className="rd-note">
        Only the best {ranked.hits.length.toLocaleString()} are listed. Narrow
        the words or the filters to see the rest.
      </p>
    );
  return null;
}

function JobHeading({
  data,
  job,
  count,
  byReview,
}: {
  data: BriefData;
  job: string;
  count: number;
  byReview: boolean;
}) {
  return (
    <h3 className="rd-search-job">
      {data.jobById.get(job)?.label ?? 'No job'}
      {byReview && job !== '' && ' (job by review)'}
      <span className="rd-note"> · {plural(count, 'record')}</span>
    </h3>
  );
}

function PublicBand({
  band,
  ranked,
  data,
  words,
}: {
  band: 'measured' | 'crowd';
  ranked: Ranked;
  data: BriefData;
  words: string;
}) {
  const { hits, more } = useShown(ranked);
  const [records, setRecords] = useState<Map<number, EvidenceRecord>>(
    () => new Map(),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const docs = hits.map((hit) => hit.doc);
    if (docs.length === 0) return;
    let current = true;
    publicSource.records(docs).then(
      (loaded) => {
        if (current) setRecords(loaded);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [hits]);
  const label = band === 'measured' ? 'Measured' : 'Crowd';
  return (
    <section className="rd-band">
      <p className="rd-band-head">
        <span
          className={`rd-band-chip${band === 'crowd' ? ' rd-band-crowd' : ''}`}
        >
          {label}
        </span>
        <span className="rd-note">
          {band === 'measured'
            ? 'benchmark results, arena ratings and reports'
            : 'Hacker News labels'}{' '}
          · {plural(ranked.total, 'record')}
        </span>
      </p>
      {ranked.total === 0 && <p className="rd-note">No record matches.</p>}
      {failed && (
        <p className="rd-note" role="alert">
          These records could not be read from the search index.
        </p>
      )}
      {groupByJob(hits, (hit) => hit.job).map((group) => (
        <div key={group.job} className="rd-search-group">
          <JobHeading
            data={data}
            job={group.job}
            count={ranked.byJob.get(group.job) ?? 0}
            byReview={false}
          />
          <ul className="rd-band-list">
            {group.items.map((hit) => (
              <PublicItem
                key={hit.doc}
                hit={hit}
                record={records.get(hit.doc)}
                data={data}
                words={words}
              />
            ))}
          </ul>
        </div>
      ))}
      <BandFoot ranked={ranked} more={more} />
    </section>
  );
}

function Targets({
  data,
  record,
}: {
  data: BriefData;
  record: EvidenceRecord;
}) {
  return (
    <>
      {record.keys.map(([key], i) => {
        const at = key.indexOf('|');
        const value = key.slice(at + 1);
        const model =
          key.slice(0, at) === 'model' ? data.modelById.get(value) : undefined;
        return (
          <span key={key}>
            {i > 0 && ', '}
            <a href={model ? modelHref(model.id) : lineHref(value)}>
              {model ? model.name : value}
            </a>
          </span>
        );
      })}
    </>
  );
}

function PublicItem({
  hit,
  record,
  data,
  words,
}: {
  hit: Hit;
  record: EvidenceRecord | undefined;
  data: BriefData;
  words: string;
}) {
  const open = useEvidence();
  if (!record)
    return (
      <li>
        <span className="rd-note">Loading record {hit.doc + 1}…</span>
      </li>
    );
  const measured = record.cls === 'measured';
  const benchmark = measured
    ? data.benchmarkById.get(recordBenchmark(record))
    : undefined;
  return (
    <li>
      <button
        type="button"
        className="rd-link rd-evidence"
        onClick={() =>
          open({
            kind: measured ? 'measured' : 'crowd',
            title: `“${words}” · ${record.title || 'record'}`,
            data,
            records: [record],
          })
        }
      >
        {record.text || record.title || 'Record'}
      </button>
      <span className="rd-note">
        {benchmark ? (
          <a href={routeHref({ view: 'benchmark', id: benchmark.id })}>
            {benchmark.name}
          </a>
        ) : (
          <Targets data={data} record={record} />
        )}
        {' · '}
        {record.date || 'undated'}
        {' · '}
        <a href={record.url} target="_blank" rel="noopener noreferrer">
          {measured ? 'Source' : 'Hacker News'}
        </a>
      </span>
    </li>
  );
}

function NamedBand({
  title,
  note,
  ranked,
  records,
  data,
  words,
}: {
  title: string;
  note?: string;
  ranked: Ranked;
  records: readonly NamedRecord[];
  data: BriefData;
  words: string;
}) {
  const open = useEvidence();
  const { hits, more } = useShown(ranked);
  return (
    <section className="rd-band">
      <p className="rd-band-head">
        <span className="rd-band-chip rd-band-named">Named</span>
        <span className="rd-note">
          {title} · {plural(ranked.total, 'record')}
        </span>
      </p>
      {note && <p className="rd-note">{note}</p>}
      {ranked.total === 0 && <p className="rd-note">No record matches.</p>}
      {groupByJob(hits, (hit) => hit.job).map((group) => (
        <div key={group.job} className="rd-search-group">
          <JobHeading
            data={data}
            job={group.job}
            count={ranked.byJob.get(group.job) ?? 0}
            byReview
          />
          <ul className="rd-band-list">
            {group.items.map((hit) => {
              const record = records[hit.doc];
              if (!record) return null;
              return (
                <li key={record.id}>
                  <button
                    type="button"
                    className="rd-link rd-evidence"
                    onClick={() =>
                      open({
                        kind: 'named',
                        title: `“${words}” · ${record.person}`,
                        records: [record],
                      })
                    }
                  >
                    {record.text}
                  </button>
                  <span className="rd-note">
                    <a href={personHref(record.person)}>{record.person}</a>
                    {' · '}
                    {record.date || 'undated'}
                    {' · '}
                    <a
                      href={record.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Source
                    </a>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <BandFoot ranked={ranked} more={more} />
    </section>
  );
}
