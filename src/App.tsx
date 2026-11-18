import { useEffect, useMemo } from 'react';
import Account from './components/Account';
import AppGuide from './components/AppGuide';
import Benchmark from './components/Benchmark';
import Board from './components/Board';
import DataPage from './components/DataPage';
import Discussion from './components/Discussion';
import ModelFile from './components/ModelFile';
import ModelFilterControl, { OutsideFilter } from './components/ModelFilter';
import Papers from './components/Papers';
import type { Access } from './lib/access';
import { checkedAt, models } from './lib/data';
import { formatHnRange, useHnPipeline } from './lib/hn-client';
import { parseTargetKey } from './lib/hn-insights';
import { hnPublished } from './lib/hn-published';
import { createScope } from './lib/model-filter';
import { parseRoute, routeHref, useHash } from './lib/route';
import type { Route } from './lib/route';
import {
  benchmarkById,
  keyName,
  modelById,
  scopeHnData,
  useHnData,
  useModelFilter,
} from './lib/site-data';

type View = Route['view'];
const views: { route: Route; label: string; also?: View }[] = [
  { route: { view: 'board' }, label: 'Board', also: 'benchmark' },
  { route: { view: 'model', key: null }, label: 'Models' },
  { route: { view: 'discussion', key: null }, label: 'Discussion' },
  { route: { view: 'papers', key: null, area: null }, label: 'Papers' },
  { route: { view: 'apps' }, label: 'App guide' },
  { route: { view: 'data' }, label: 'Data' },
];

export default function App({ access }: { access: Access }) {
  const hash = useHash();
  const route = parseRoute(hash);
  const location = routeHref(route);
  const hn = useHnData();
  const pipeline = useHnPipeline();
  const { filter, setFilter } = useModelFilter();
  // A model or family opened by a direct link is shown even when the filter
  // leaves it out.
  const linked =
    route.view === 'model' ||
    route.view === 'discussion' ||
    route.view === 'papers'
      ? route.key
      : null;
  const selection = useMemo(() => createScope(filter, models), [filter]);
  const linkedRef = linked ? parseTargetKey(linked) : null;
  const outside =
    linked &&
    linkedRef &&
    !selection.key(linked) &&
    (linkedRef.kind === 'family' || modelById.has(linkedRef.target))
      ? linked
      : null;
  const scope = useMemo(
    () => (outside ? createScope(filter, models, outside) : selection),
    [filter, selection, outside],
  );
  // Only the Models and Discussion views read the comments, so the others do
  // not pay for narrowing them.
  const readsComments = route.view === 'model' || route.view === 'discussion';
  const scopedHn = useMemo(
    () => (readsComments ? scopeHnData(hn, scope) : hn),
    [hn, scope, readsComments],
  );
  const title =
    route.view === 'benchmark'
      ? (benchmarkById.get(route.id)?.name ?? 'Benchmark')
      : route.view === 'model' && route.key
        ? keyName(route.key)
        : route.view === 'account'
          ? 'Account'
          : (views.find((view) => view.route.view === route.view)?.label ??
            'Board');

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  useEffect(() => {
    document.title = `${title} · Model picker`;
  }, [title]);

  return (
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
        <a className="rd-brand" href={routeHref({ view: 'board' })}>
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
              {view.route.view === 'data' && pipeline.data?.runner.active && (
                <span>Running</span>
              )}
            </a>
          ))}
        </nav>
        <ModelFilterControl filter={filter} onChange={setFilter} />
        <p className="rd-top-meta">
          {hn.status === 'ready' && hn.startAt && hn.endAt && (
            <span>
              HN {formatHnRange(hn.startAt, hn.endAt)} ·{' '}
              {hn.insights.commentCount.toLocaleString()} comments
            </span>
          )}
          {hn.status === 'loading' && <span>Loading HN comments…</span>}
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
      {hn.status === 'failed' && (
        <p className="rd-alert" role="alert">
          The comment index could not be loaded.{' '}
          {!hnPublished && (
            <>
              Start the app with <code>npm run dev</code> so the local analysis
              service is running.{' '}
            </>
          )}
          Benchmark data is still shown.
        </p>
      )}
      {outside && (
        <OutsideFilter target={outside} filter={filter} onChange={setFilter} />
      )}
      <main id="content" className="rd-main" tabIndex={-1}>
        {route.view === 'board' && <Board hn={hn} scope={scope} />}
        {route.view === 'model' && (
          <ModelFile hn={scopedHn} selected={route.key} scope={scope} />
        )}
        {route.view === 'discussion' && (
          <Discussion hn={scopedHn} initialTarget={route.key} scope={scope} />
        )}
        {route.view === 'papers' && (
          <Papers
            initialTarget={route.key}
            initialArea={route.area}
            scope={scope}
          />
        )}
        {route.view === 'benchmark' && (
          <Benchmark key={route.id} id={route.id} scope={scope} />
        )}
        {route.view === 'apps' && <AppGuide hn={hn} scope={scope} />}
        {route.view === 'data' && <DataPage pipeline={pipeline} />}
        {route.view === 'account' && (
          <Account access={access} error={route.error} />
        )}
      </main>
    </div>
  );
}
