import { useCallback, useEffect, useMemo, useState } from 'react';
import Account from './components/Account';
import AppGuide from './components/AppGuide';
import Benchmark from './components/Benchmark';
import Brief from './components/Brief';
import DataPage from './components/DataPage';
import EvidenceDrawer, { EvidenceContext } from './components/EvidenceDrawer';
import type { EvidenceSpec } from './components/EvidenceDrawer';
import FilterBar from './components/FilterBar';
import Model from './components/Model';
import { OutsideFilter } from './components/ModelFilter';
import { NamedContext, useNamedView } from './components/Named';
import Papers from './components/Papers';
import People from './components/People';
import Search from './components/Search';
import Switch from './components/Switch';
import type { Access } from './lib/access';
import { useCoreData } from './lib/core-client';
import { checkedAt, models } from './lib/data';
import { formatHnRange, useHnPipeline } from './lib/hn-client';
import { hnPublished } from './lib/hn-published';
import { createScope } from './lib/model-filter';
import type { ModelFilter } from './lib/model-filter';
import { parseRoute, routeHref, useHash } from './lib/route';
import type { ModelTarget, Route } from './lib/route';
import {
  benchmarkById,
  modelById,
  useHnData,
  useModelFilter,
} from './lib/site-data';

type View = Route['view'];
// The Board left for Brief; its old address opens Brief. Discussion left for
// the thread reader under each model's Crowd band; its links open the model
// page. Expert articles moved onto person pages; their old address opens
// People.
const views: { route: Route; label: string; also?: View }[] = [
  { route: { view: 'brief', job: null }, label: 'Brief', also: 'benchmark' },
  {
    route: { view: 'model', target: null, job: null, comments: false },
    label: 'Models',
  },
  { route: { view: 'switch', a: null, b: null, job: null }, label: 'Switch' },
  { route: { view: 'people', name: null, job: null }, label: 'People' },
  { route: { view: 'search', words: '', job: null }, label: 'Search' },
  { route: { view: 'papers', key: null, area: null }, label: 'Papers' },
  { route: { view: 'apps' }, label: 'App guide' },
  { route: { view: 'data' }, label: 'Data' },
];

// The comment-index key of a model page's target, for the model filter.
function targetKey(target: ModelTarget | null) {
  if (target === null) return null;
  return target.kind === 'model'
    ? `model:${target.id}`
    : `family:${target.name}`;
}

export default function App({ access }: { access: Access }) {
  const hash = useHash();
  const route = parseRoute(hash);
  const location = routeHref(route);
  const pipeline = useHnPipeline();
  const { filter, setFilter } = useModelFilter();
  const coreData = useCoreData();
  const core = coreData.status === 'ready' ? coreData.core : null;
  // Named records are requested only with a session (or on the dev server).
  const named = useNamedView(access, core ? core.jobs.list : null);
  const [evidence, setEvidence] = useState<EvidenceSpec | null>(null);
  // The comment index is requested only when a drawer lists comments; every
  // view counts from core.json, and the model page's thread reader loads it
  // itself.
  const hn = useHnData(evidence?.kind === 'comments');
  const closeEvidence = useCallback(() => setEvidence(null), []);
  const setSelection = useCallback(
    (next: ModelFilter) => setFilter({ ...filter, ...next }),
    [filter, setFilter],
  );
  // A model or line opened by a direct link is shown even when the filter
  // leaves it out.
  const linked =
    route.view === 'model'
      ? targetKey(route.target)
      : route.view === 'papers'
        ? route.key
        : null;
  const selection = useMemo(() => createScope(filter, models), [filter]);
  const outside =
    linked &&
    !selection.key(linked) &&
    (linked.startsWith('family:') || modelById.has(linked.slice(6)))
      ? linked
      : null;
  const scope = useMemo(
    () => (outside ? createScope(filter, models, outside) : selection),
    [filter, selection, outside],
  );
  const title =
    route.view === 'benchmark'
      ? (benchmarkById.get(route.id)?.name ??
        core?.benchmarks.find((entry) => entry.id === route.id)?.name ??
        'Benchmark')
      : route.view === 'model' && route.target
        ? route.target.kind === 'model'
          ? (modelById.get(route.target.id)?.name ?? 'Model')
          : route.target.name
        : route.view === 'people' && route.name !== null
          ? route.name
          : route.view === 'account'
            ? 'Account'
            : (views.find((view) => view.route.view === route.view)?.label ??
              'Brief');
  // Model, Switch, People and Search keep the job in their own address;
  // elsewhere choosing a job opens its brief.
  const jobHref = (job: string | null) =>
    route.view === 'model' ||
    route.view === 'switch' ||
    route.view === 'people' ||
    route.view === 'search'
      ? routeHref({ ...route, job })
      : routeHref({ view: 'brief', job });
  const full =
    route.view === 'brief' ||
    route.view === 'model' ||
    route.view === 'switch' ||
    route.view === 'people' ||
    route.view === 'search';

  // A new page starts at the top; opening or closing the thread reader on the
  // same page does not move it.
  const page = routeHref(
    route.view === 'model' ? { ...route, comments: false } : route,
  );
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    document.title = `${title} · Model picker`;
  }, [title]);

  return (
    <NamedContext.Provider value={named}>
      <EvidenceContext.Provider value={setEvidence}>
        <div className="rd">
          <a
            className="skip-link"
            href={location}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById('content')?.focus();
            }}
          >
            Skip to content
          </a>
          <header className="rd-top">
            <a
              className="rd-brand"
              href={routeHref({ view: 'brief', job: null })}
            >
              Model picker
            </a>
            <nav aria-label="Main">
              {views.map((view) => (
                <a
                  key={view.label}
                  href={routeHref(view.route)}
                  aria-current={
                    view.route.view === route.view
                      ? 'page'
                      : view.also === route.view
                        ? 'true'
                        : undefined
                  }
                >
                  {view.label}
                  {view.route.view === 'data' &&
                    pipeline.data?.runner.active && <span>Running</span>}
                </a>
              ))}
            </nav>
            <p className="rd-top-meta">
              {core && (
                <span>
                  HN{' '}
                  {formatHnRange(
                    core.sources.hn.startAt,
                    core.sources.hn.endAt,
                  )}{' '}
                  · {core.sources.hn.comments.toLocaleString()} comments
                </span>
              )}
              <span>Benchmarks checked {checkedAt}</span>
            </p>
            {access.kind !== 'local' && (
              <a
                className="rd-account-link"
                href={routeHref({ view: 'account', error: null })}
                aria-current={route.view === 'account' ? 'page' : undefined}
              >
                {access.kind === 'signed-in' ? 'Account' : 'Sign in'}
              </a>
            )}
          </header>
          <FilterBar
            filter={filter}
            onChange={setFilter}
            jobs={core ? core.jobs.list : null}
            job={
              route.view === 'brief' ||
              route.view === 'model' ||
              route.view === 'switch' ||
              route.view === 'people' ||
              route.view === 'search'
                ? route.job
                : null
            }
            jobHref={jobHref}
            full={full}
            named={named.state.status === 'ready'}
            end={core ? core.sources.hn.endAt.slice(0, 10) : null}
          />
          {hn.status === 'failed' && (
            <p className="rd-alert" role="alert">
              The comment index could not be loaded.{' '}
              {!hnPublished && (
                <>
                  Start the app with <code>npm run dev</code> so the local
                  analysis service is running.{' '}
                </>
              )}
              Benchmark data is still shown.
            </p>
          )}
          {outside && (
            <OutsideFilter
              target={outside}
              filter={filter}
              onChange={setSelection}
            />
          )}
          <main id="content" className="rd-main" tabIndex={-1}>
            {route.view === 'brief' && (
              <Brief
                job={route.job}
                coreData={coreData}
                filter={filter}
                onFilterChange={setFilter}
                scope={scope}
              />
            )}
            {route.view === 'model' && (
              <Model
                route={route}
                coreData={coreData}
                filter={filter}
                scope={scope}
              />
            )}
            {route.view === 'switch' && (
              <Switch
                route={route}
                coreData={coreData}
                filter={filter}
                scope={scope}
              />
            )}
            {route.view === 'papers' && (
              <Papers
                initialTarget={route.key}
                initialArea={route.area}
                scope={scope}
              />
            )}
            {route.view === 'benchmark' && (
              <Benchmark
                key={route.id}
                id={route.id}
                scope={scope}
                coreData={coreData}
              />
            )}
            {route.view === 'apps' && (
              <AppGuide coreData={coreData} scope={scope} />
            )}
            {route.view === 'people' && (
              <People
                route={route}
                coreData={coreData}
                filter={filter}
                scope={scope}
              />
            )}
            {route.view === 'search' && (
              <Search
                route={route}
                coreData={coreData}
                filter={filter}
                scope={scope}
              />
            )}
            {route.view === 'data' && <DataPage pipeline={pipeline} />}
            {route.view === 'account' && (
              <Account access={access} error={route.error} />
            )}
          </main>
          {evidence && (
            <EvidenceDrawer spec={evidence} hn={hn} onClose={closeEvidence} />
          )}
        </div>
      </EvidenceContext.Provider>
    </NamedContext.Provider>
  );
}
