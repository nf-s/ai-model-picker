import { useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { benchmarkKind, costUnit } from '../lib/brief';
import { importedBenchmarkPage, importedIndex } from '../lib/benchmark-page';
import type { ImportedBenchmarkPage } from '../lib/benchmark-page';
import type { CoreData } from '../lib/core-client';
import type { Core } from '../lib/core-schema';
import { benchmarks, reports, results } from '../lib/data';
import type {
  Benchmark as SnapshotBenchmark,
  BenchmarkResult,
} from '../lib/data';
import type { Scope } from '../lib/model-filter';
import { dollars, duration } from '../lib/metrics';
import { modelHref, routeHref } from '../lib/route';
import {
  benchmarkById,
  benchmarkLabel,
  formatScore,
  modelById,
  standing,
} from '../lib/site-data';
import { RankNote } from './ModelFilter';
import Reports from './Reports';
import './benchmark.css';

type Row = { result: BenchmarkResult; rank: number; best: boolean };

const benchmarkHref = (id: string) => routeHref({ view: 'benchmark', id });

// Every benchmark with a page, by source: the published results (with the
// restricted payload's for an approved account), then each imported source.
function BenchmarkNav({
  current,
  core,
}: {
  current: string | null;
  core: Core | null;
}) {
  return (
    <nav className="rd-bm-nav" aria-label="Benchmarks">
      <div className="rd-bm-group">
        <span>Published results</span>
        <div className="rd-bm-chips">
          {benchmarks.map((benchmark) => (
            <a
              key={benchmark.id}
              className="rd-chip"
              href={benchmarkHref(benchmark.id)}
              aria-current={benchmark.id === current ? 'page' : undefined}
            >
              {benchmarkLabel(benchmark)}
              <small>{benchmark.category}</small>
            </a>
          ))}
        </div>
      </div>
      {core &&
        importedIndex(core).map((group) => (
          <details
            key={group.source}
            className="rd-bm-group"
            open={group.benchmarks.some((entry) => entry.id === current)}
          >
            <summary>
              {group.name} ({group.benchmarks.length})
            </summary>
            <div className="rd-bm-chips">
              {group.benchmarks.map((benchmark) => (
                <a
                  key={benchmark.id}
                  className="rd-chip"
                  href={benchmarkHref(benchmark.id)}
                  aria-current={benchmark.id === current ? 'page' : undefined}
                >
                  {benchmark.name}
                </a>
              ))}
            </div>
          </details>
        ))}
    </nav>
  );
}

// Source notes keep their links as plain URLs; make them clickable.
function Linked({ text }: { text: string }) {
  return text.split(/(https?:\/\/\S+)/).map((part, position) =>
    position % 2 === 1 ? (
      <a key={position} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

// Best first; equal scores share a rank.
function rank(entries: readonly BenchmarkResult[], benchmarkId: string) {
  const ordered = [...entries].sort((a, b) => b.score - a.score);
  return ordered.map((result): Row => ({
    result,
    rank: ordered.findIndex((other) => other.score === result.score) + 1,
    best: standing(result.modelId, benchmarkId)?.result.id === result.id,
  }));
}

export default function Benchmark({
  id,
  scope,
  coreData,
}: {
  id: string;
  scope: Scope;
  coreData: CoreData;
}) {
  const core = coreData.status === 'ready' ? coreData.core : null;
  const published = benchmarkById.get(id);
  if (published)
    return (
      <PublishedBenchmark benchmark={published} scope={scope} core={core} />
    );
  const page = core ? importedBenchmarkPage(core, id) : null;
  if (core && page)
    return <ImportedBenchmark page={page} scope={scope} core={core} />;
  return (
    <div className="rd-page">
      <BenchmarkNav current={null} core={core} />
      {coreData.status === 'loading' ? (
        <p className="rd-note">Loading records…</p>
      ) : (
        <p className="rd-note">
          No benchmark has the id “{id}”.
          {coreData.status === 'failed' &&
            ' The imported leaderboards could not be loaded.'}
        </p>
      )}
    </div>
  );
}

function PublishedBenchmark({
  benchmark,
  scope,
  core,
}: {
  benchmark: SnapshotBenchmark;
  scope: Scope;
  core: Core | null;
}) {
  const id = benchmark.id;
  const [shown, setShown] = useState<'all' | 'best'>('all');
  const [query, setQuery] = useState('');
  const all = useMemo(
    () => results.filter((result) => result.benchmarkId === id),
    [id],
  );
  const best = useMemo(
    () =>
      all.filter(
        (result) => standing(result.modelId, id)?.result.id === result.id,
      ),
    [all, id],
  );
  const rows = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return rank(shown === 'all' ? all : best, id).filter(({ result }) => {
      if (!scope.model(result.modelId)) return false;
      const model = modelById.get(result.modelId);
      return `${model?.name ?? result.modelId} ${model?.provider ?? ''} ${result.configuration}`
        .toLowerCase()
        .includes(wanted);
    });
  }, [all, best, id, query, shown, scope]);

  const scores = all.map((result) => result.score);
  const top = Math.max(...scores);
  const bottom = Math.min(...scores);
  const has = (pick: (result: BenchmarkResult) => unknown) =>
    all.some((result) => pick(result) !== undefined);
  const columns = {
    interval: has((result) => result.interval),
    cost: has((result) => result.costUsd),
    time: has((result) => result.timeSeconds),
    trials: has((result) => result.trials),
    runDate: has((result) => result.runDate),
  };
  const method = (
    benchmark.methodology.startsWith(benchmark.description)
      ? benchmark.methodology.slice(benchmark.description.length)
      : benchmark.methodology
  )
    .trim()
    .replace(/^Methodology:\s*/, '');
  const related = reports.filter(
    (report) =>
      report.category === benchmark.category &&
      (!scope.active || report.modelIds.some(scope.model)),
  );
  const filteredOut =
    scope.active && !all.some((result) => scope.model(result.modelId));

  return (
    <div className="rd-page rd-bm">
      <BenchmarkNav current={benchmark.id} core={core} />
      <header className="rd-page-head">
        <h1>{benchmark.name}</h1>
        <p>
          {benchmark.source !== benchmark.name && `${benchmark.source} · `}
          {benchmark.category} · {benchmark.unit} · {all.length} results for{' '}
          {best.length} models
          {benchmark.updatedAt &&
            ` · source updated ${benchmark.updatedAt.slice(0, 10)}`}
        </p>
      </header>

      <section className="rd-panel rd-bm-about" aria-label="About">
        <p>{benchmark.description}</p>
        <dl>
          {method && (
            <div>
              <dt>Method</dt>
              <dd>
                <Linked text={method} />
              </dd>
            </div>
          )}
          {benchmark.costMethod && (
            <div>
              <dt>Cost column</dt>
              <dd>{benchmark.costMethod}</dd>
            </div>
          )}
          {benchmark.timeMethod && (
            <div>
              <dt>Time column</dt>
              <dd>{benchmark.timeMethod}</dd>
            </div>
          )}
        </dl>
        <a href={benchmark.url} target="_blank" rel="noreferrer">
          {benchmark.source} source
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </section>

      <section className="rd-section" aria-labelledby="rd-bm-results">
        <div className="rd-bm-controls">
          <h2 className="rd-h" id="rd-bm-results">
            Results
          </h2>
          {all.length > best.length && (
            <div className="rd-seg" role="group" aria-label="Rows">
              <button
                type="button"
                aria-pressed={shown === 'all'}
                onClick={() => setShown('all')}
              >
                All configurations
              </button>
              <button
                type="button"
                aria-pressed={shown === 'best'}
                onClick={() => setShown('best')}
              >
                Best per model
              </button>
            </div>
          )}
          <input
            className="rd-input"
            type="search"
            placeholder="Find a model or configuration"
            aria-label="Find a model or configuration"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          className="rd-panel rd-bm-wrap"
          role="region"
          aria-label={`${benchmark.name} results`}
          tabIndex={0}
        >
          <table className="rd-table rd-bm-table">
            <thead>
              <tr>
                <th scope="col" className="rd-num">
                  Rank
                </th>
                <th scope="col">Model</th>
                <th scope="col">Configuration</th>
                <th scope="col" className="rd-num">
                  {benchmark.unit}
                </th>
                {columns.interval && <th scope="col">Uncertainty</th>}
                {columns.cost && (
                  <th scope="col" className="rd-num">
                    Cost
                  </th>
                )}
                {columns.time && (
                  <th scope="col" className="rd-num">
                    Time
                  </th>
                )}
                {columns.trials && (
                  <th scope="col" className="rd-num">
                    Trials
                  </th>
                )}
                {columns.runDate && <th scope="col">Run date</th>}
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ result, rank: place, best: leading }) => {
                const model = modelById.get(result.modelId);
                const position =
                  top > bottom ? (result.score - bottom) / (top - bottom) : 1;
                return (
                  <tr
                    key={result.id}
                    className={leading ? undefined : 'rd-bm-secondary'}
                  >
                    <td className="rd-num">{place}</td>
                    <th scope="row">
                      <a href={modelHref(result.modelId)}>
                        {model?.name ?? result.modelId}
                      </a>
                      {model && <small>{model.provider}</small>}
                    </th>
                    <td className="rd-bm-config">
                      {result.configuration}
                      {result.details && <small>{result.details}</small>}
                    </td>
                    <td className="rd-num rd-bm-score">
                      <strong>{formatScore(result.score, benchmark)}</strong>
                      <span className="rd-bm-bar" aria-hidden="true">
                        <i style={{ width: `${4 + position * 96}%` }} />
                      </span>
                    </td>
                    {columns.interval && (
                      <td className="rd-bm-interval">
                        {result.interval ?? '—'}
                      </td>
                    )}
                    {columns.cost && (
                      <td className="rd-num">{dollars(result.costUsd)}</td>
                    )}
                    {columns.time && (
                      <td className="rd-num">{duration(result.timeSeconds)}</td>
                    )}
                    {columns.trials && (
                      <td className="rd-num">
                        {result.trials?.toLocaleString() ?? '—'}
                      </td>
                    )}
                    {columns.runDate && <td>{result.runDate ?? '—'}</td>}
                    <td>
                      <a
                        href={result.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Source for ${model?.name ?? result.modelId}, ${result.configuration}`}
                      >
                        Open
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="rd-note">
              {filteredOut
                ? 'No models in the filter have a result on this benchmark.'
                : 'No results match.'}
            </p>
          )}
        </div>
        {shown === 'all' && all.length > best.length && (
          <p className="rd-note">
            Rank is across all configurations. Rows that are not a model&apos;s
            best result are dimmed.
          </p>
        )}
        {scope.active && <RankNote />}
      </section>

      {related.length > 0 && (
        <section className="rd-section" aria-labelledby="rd-bm-reports">
          <h2 className="rd-h" id="rd-bm-reports">
            Reports on {benchmark.category}
          </h2>
          <Reports reports={related} />
        </section>
      )}
    </div>
  );
}

// An imported LMArena leaderboard or Epoch run. Rows are records for models
// in the model list; a rating is never drawn against a percentage scale.
function ImportedBenchmark({
  page,
  scope,
  core,
}: {
  page: ImportedBenchmarkPage;
  scope: Scope;
  core: Core;
}) {
  const { benchmark, attribution } = page;
  const [shown, setShown] = useState<'all' | 'best'>('all');
  const [query, setQuery] = useState('');
  const best = page.rows.filter((row) => row.best);
  const several = best.length < page.rows.length;
  const rows = (shown === 'all' ? page.rows : best).filter((row) => {
    if (!scope.model(row.modelId)) return false;
    const model = modelById.get(row.modelId);
    return `${model?.name ?? row.modelId} ${model?.provider ?? ''} ${row.config}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  });
  const percent = benchmark.scale === 'percent';
  const scores = page.rows.map((row) => row.score);
  const top = Math.max(...scores);
  const bottom = Math.min(...scores);
  const columns = {
    interval: page.rows.some((row) => row.interval),
    count: page.countLabel !== null,
    sessions: page.rows.some((row) => row.sessions !== null),
    cost: page.rows.some((row) => row.cost !== null),
    date: page.source === 'epoch',
  };
  const kind = benchmarkKind(benchmark);
  const filteredOut =
    scope.active && !page.rows.some((row) => scope.model(row.modelId));
  return (
    <div className="rd-page rd-bm">
      <BenchmarkNav current={benchmark.id} core={core} />
      <header className="rd-page-head">
        <h1>{benchmark.name}</h1>
        <p>
          {page.source === 'lmarena' ? 'LMArena' : 'Epoch AI'} ·{' '}
          {benchmark.unit} · {kind} ·{' '}
          {page.source === 'lmarena'
            ? `published ${benchmark.publishedAt || 'undated'}`
            : page.dates
              ? `runs ${page.dates[0]} to ${page.dates[1]}`
              : 'undated runs'}{' '}
          · {page.rows.length} results for {best.length} models
        </p>
      </header>

      <section className="rd-panel rd-bm-about" aria-label="About">
        <p>{benchmark.what}</p>
        <p className="rd-bm-scale">{page.scaleNote}</p>
        <dl>
          <div>
            <dt>Coverage</dt>
            <dd>{page.coverage}</dd>
          </div>
          {benchmark.methodology && (
            <div>
              <dt>Method</dt>
              <dd>{benchmark.methodology}</dd>
            </div>
          )}
          {benchmark.costMethod && (
            <div>
              <dt>Cost column</dt>
              <dd>{benchmark.costMethod}</dd>
            </div>
          )}
          {attribution && (
            <div>
              <dt>Attribution</dt>
              <dd>
                {benchmark.attribution}
                {attribution.changes && (
                  <span className="rd-note">
                    {' '}
                    Changes: {attribution.changes}
                  </span>
                )}
              </dd>
            </div>
          )}
          {attribution?.licence && (
            <div>
              <dt>Licence</dt>
              <dd>
                <a
                  href={attribution.licence.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {attribution.licence.name}
                </a>
              </dd>
            </div>
          )}
        </dl>
        <a href={benchmark.url} target="_blank" rel="noreferrer">
          {page.source === 'lmarena'
            ? 'Leaderboard in the dataset'
            : 'Epoch AI benchmark page'}
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </section>

      <section className="rd-section" aria-labelledby="rd-bm-results">
        <div className="rd-bm-controls">
          <h2 className="rd-h" id="rd-bm-results">
            Results
          </h2>
          {several && (
            <div className="rd-seg" role="group" aria-label="Rows">
              <button
                type="button"
                aria-pressed={shown === 'all'}
                onClick={() => setShown('all')}
              >
                All configurations
              </button>
              <button
                type="button"
                aria-pressed={shown === 'best'}
                onClick={() => setShown('best')}
              >
                Best per model
              </button>
            </div>
          )}
          <input
            className="rd-input"
            type="search"
            placeholder="Find a model or configuration"
            aria-label="Find a model or configuration"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          className="rd-panel rd-bm-wrap"
          role="region"
          aria-label={`${benchmark.name} results`}
          tabIndex={0}
        >
          <table className="rd-table rd-bm-table">
            <thead>
              <tr>
                <th scope="col" className="rd-num">
                  Rank
                </th>
                <th scope="col">Model</th>
                <th scope="col">Configuration</th>
                <th scope="col" className="rd-num">
                  {benchmark.unit}
                </th>
                {columns.interval && <th scope="col">Uncertainty</th>}
                {columns.count && (
                  <th scope="col" className="rd-num">
                    {page.countLabel}
                  </th>
                )}
                {columns.sessions && (
                  <th scope="col" className="rd-num">
                    Sessions
                  </th>
                )}
                {columns.cost && (
                  <th scope="col" className="rd-num">
                    Cost {costUnit(benchmark.id)}
                  </th>
                )}
                {columns.date && <th scope="col">Run date</th>}
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const model = modelById.get(row.modelId);
                const position =
                  top > bottom ? (row.score - bottom) / (top - bottom) : 1;
                return (
                  <tr
                    key={row.id}
                    className={row.best ? undefined : 'rd-bm-secondary'}
                  >
                    <td className="rd-num">{row.rank}</td>
                    <th scope="row">
                      <a href={modelHref(row.modelId)}>
                        {model?.name ?? row.modelId}
                      </a>
                      {model && <small>{model.provider}</small>}
                    </th>
                    <td className="rd-bm-config">{row.config}</td>
                    <td className="rd-num rd-bm-score">
                      <strong>{row.value}</strong>
                      {percent && (
                        <span className="rd-bm-bar" aria-hidden="true">
                          <i style={{ width: `${4 + position * 96}%` }} />
                        </span>
                      )}
                    </td>
                    {columns.interval && (
                      <td className="rd-bm-interval">{row.interval || '—'}</td>
                    )}
                    {columns.count && (
                      <td className="rd-num">
                        {row.count?.toLocaleString() ?? '—'}
                      </td>
                    )}
                    {columns.sessions && (
                      <td className="rd-num">
                        {row.sessions?.toLocaleString() ?? '—'}
                      </td>
                    )}
                    {columns.cost && (
                      <td className="rd-num">
                        {row.cost === null ? '—' : dollars(row.cost)}
                      </td>
                    )}
                    {columns.date && <td>{row.date || '—'}</td>}
                    <td>
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Source for ${model?.name ?? row.modelId}, ${row.config}`}
                      >
                        Open
                        <ArrowUpRight size={12} aria-hidden="true" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="rd-note">
              {filteredOut
                ? 'No models in the filter have a result on this benchmark.'
                : 'No results match.'}
            </p>
          )}
        </div>
        <p className="rd-note">
          {page.rankNote}
          {shown === 'all' &&
            several &&
            " Rows that are not a model's best result are dimmed."}
        </p>
        {scope.active && <RankNote />}
      </section>
    </div>
  );
}
