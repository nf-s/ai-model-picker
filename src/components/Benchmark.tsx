import { useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { benchmarks, reports, restrictedHidden, results } from '../lib/data';
import type { BenchmarkResult } from '../lib/data';
import type { Scope } from '../lib/model-filter';
import { dollars, duration } from '../lib/metrics';
import { routeHref } from '../lib/route';
import {
  benchmarkById,
  benchmarkLabel,
  formatScore,
  modelById,
  modelKey,
  standing,
} from '../lib/site-data';
import { RankNote } from './ModelFilter';
import { RestrictedNote } from './parts';
import Reports from './Reports';
import './benchmark.css';

type Row = { result: BenchmarkResult; rank: number; best: boolean };

function BenchmarkNav({ current }: { current: string | null }) {
  return (
    <nav className="rd-bm-nav" aria-label="Benchmarks">
      {benchmarks.map((benchmark) => (
        <a
          key={benchmark.id}
          className="rd-chip"
          href={routeHref({ view: 'benchmark', id: benchmark.id })}
          aria-current={benchmark.id === current ? 'page' : undefined}
        >
          {benchmarkLabel(benchmark)}
          <small>{benchmark.category}</small>
        </a>
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

export default function Benchmark({ id, scope }: { id: string; scope: Scope }) {
  const benchmark = benchmarkById.get(id);
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

  if (!benchmark)
    return (
      <div className="rd-page">
        <BenchmarkNav current={null} />
        <p className="rd-note">No benchmark has this identifier.</p>
      </div>
    );

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
      <BenchmarkNav current={benchmark.id} />
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

      {restrictedHidden(benchmark.id) && <RestrictedNote />}
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
                      <a
                        href={routeHref({
                          view: 'model',
                          key: modelKey(result.modelId),
                        })}
                      >
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
