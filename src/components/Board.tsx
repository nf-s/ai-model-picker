import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useArxivData } from '../lib/arxiv-client';
import type { ArxivData } from '../lib/arxiv-client';
import { areaLabels, tallyResults } from '../lib/arxiv-papers';
import type { AreaTallies } from '../lib/arxiv-papers';
import type { ArxivArea } from '../lib/arxiv-schema';
import { benchmarks, models } from '../lib/data';
import type { Benchmark, Category, Model } from '../lib/data';
import { positiveShare, sumWeeks, tallyTotal } from '../lib/hn-insights';
import type { HnAspect } from '../lib/hn-index';
import type { TargetInsight } from '../lib/hn-insights';
import { SentimentBar, ShareText, Sparkline } from './parts';
import {
  benchmarkLabel,
  formatPrice,
  formatScore,
  insightFor,
  modelKey,
  momentum,
  percent,
  standing,
  standings,
} from '../lib/site-data';
import type { HnData, Standing } from '../lib/site-data';
import type { Scope } from '../lib/model-filter';
import { RankNote } from './ModelFilter';
import { keyHref, modelHref, routeHref } from '../lib/route';
import './board.css';

type Task = 'all' | Category;
type Direction = 'asc' | 'desc';
type Momentum = ReturnType<typeof momentum>;

const categoryOrder: Category[] = [
  'general',
  'coding',
  'design',
  'writing',
  'reasoning',
  'research',
  'agents',
];
const categoryLabels: Record<Category, string> = {
  general: 'General',
  coding: 'Coding',
  design: 'Design',
  writing: 'Writing',
  reasoning: 'Reasoning',
  research: 'Research',
  agents: 'Agents',
};
const topics: Partial<Record<Category, HnAspect>> = {
  coding: 'coding',
  design: 'design',
  writing: 'writing',
  reasoning: 'reasoning',
};
// Paper results counted for each task; General counts every area.
const resultAreas: Record<Category, ArxivArea | 'all'> = {
  general: 'all',
  coding: 'coding',
  design: 'design',
  writing: 'writing',
  reasoning: 'reasoning',
  research: 'research',
  agents: 'agents',
};
const taskOptions: Task[] = [
  'all',
  ...categoryOrder.filter((category) =>
    benchmarks.some((benchmark) => benchmark.category === category),
  ),
];

const shareMinimum = 20;
const topicMinimum = 10;
const leaderShareMinimum = 50;
const discussionMinimum = 20;
const recentWeeks = 4;

function taskBenchmarks(task: Task) {
  return task === 'all'
    ? benchmarks
    : benchmarks.filter((benchmark) => benchmark.category === task);
}

function topicOf(task: Task) {
  return task === 'all' ? null : (topics[task] ?? null);
}

type Fact = {
  model: Model;
  key: string;
  insight: TargetInsight | null;
  weekly: number[];
  recent: number;
  change: Momentum;
  results: AreaTallies | null;
};

function buildFacts(
  hn: HnData,
  results: ReadonlyMap<string, AreaTallies> | null,
): Fact[] {
  return models.map((model) => {
    const key = modelKey(model.id);
    const insight = insightFor(hn, key);
    const last = (insight?.weeks.length ?? 0) - 1;
    return {
      model,
      key,
      insight,
      results: results?.get(key) ?? null,
      weekly: insight ? insight.weeks.map(tallyTotal) : [],
      recent: insight
        ? tallyTotal(sumWeeks(insight.weeks, last - recentWeeks + 1, last))
        : 0,
      change: insight ? momentum(insight) : null,
    };
  });
}

type Base = { id: string; label: string; unit?: string };
type Column =
  | (Base & { kind: 'model' | 'comments' | 'sentiment' | 'change' })
  | (Base & { kind: 'benchmark'; benchmark: Benchmark })
  | (Base & { kind: 'topic'; aspect: HnAspect })
  | (Base & { kind: 'papers'; area: ArxivArea | 'all' });

function topicColumns(topic: HnAspect | null): Column[] {
  return topic
    ? [
        {
          kind: 'topic',
          id: 'topic',
          label: `On ${topic}`,
          unit: 'positive share',
          aspect: topic,
        },
      ]
    : [];
}

// All already carries every benchmark, so it leaves the paper results to the
// task tables.
function paperColumns(task: Task): Column[] {
  return task === 'all'
    ? []
    : [
        {
          kind: 'papers',
          id: 'papers',
          label: 'Paper results',
          unit: 'best · behind of papers',
          area: resultAreas[task],
        },
      ];
}

function buildColumns(task: Task): Column[] {
  const topic = topicOf(task);
  return [
    { kind: 'model', id: 'model', label: 'Model' },
    ...taskBenchmarks(task).map((benchmark): Column => ({
      kind: 'benchmark',
      id: `benchmark:${benchmark.id}`,
      label: benchmarkLabel(benchmark),
      unit: benchmark.unit,
      benchmark,
    })),
    ...paperColumns(task),
    { kind: 'comments', id: 'comments', label: 'HN comments', unit: 'weekly' },
    {
      kind: 'sentiment',
      id: 'sentiment',
      label: 'HN sentiment',
      unit: 'positive share',
    },
    { kind: 'change', id: 'change', label: '4-week change', unit: 'pts' },
    ...topicColumns(topic),
  ];
}

type SortValue = number | string | null;

function sortValue(fact: Fact, column: Column): SortValue {
  switch (column.kind) {
    case 'model':
      return fact.model.name;
    case 'benchmark':
      return standing(fact.model.id, column.benchmark.id)?.result.score ?? null;
    case 'papers': {
      const tally = fact.results?.[column.area];
      return tally && tally.papers > 0 ? tally.best : null;
    }
    case 'comments':
      return fact.insight ? fact.insight.total : null;
    case 'sentiment':
      return fact.insight
        ? positiveShare(fact.insight.tally, shareMinimum)
        : null;
    case 'change':
      return fact.change ? fact.change.change : null;
    case 'topic':
      return fact.insight
        ? positiveShare(fact.insight.aspects[column.aspect], topicMinimum)
        : null;
  }
}

function compareValues(a: SortValue, b: SortValue, direction: Direction) {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  const order =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b));
  return direction === 'asc' ? order : -order;
}

function defaultSort(task: Task): { id: string; direction: Direction } {
  const first = taskBenchmarks(task)[0];
  return {
    id: task === 'all' || !first ? 'comments' : `benchmark:${first.id}`,
    direction: 'desc',
  };
}

function hasResult(model: Model, task: Task) {
  return taskBenchmarks(task).some(
    (benchmark) => standing(model.id, benchmark.id) !== undefined,
  );
}

function formatChange(change: number) {
  const points = Math.round(change * 100);
  if (points === 0) return '0 pts';
  return `${points > 0 ? '+' : '−'}${Math.abs(points)} pts`;
}

function ModelLink({ model }: { model: Model }) {
  return <a href={modelHref(model.id)}>{model.name}</a>;
}

type Leader = { model: Model; value: string; rank: number };

function LeaderPanel({
  title,
  href,
  note,
  leaders,
}: {
  title: string;
  href?: string;
  note: string;
  leaders: Leader[];
}) {
  return (
    <section className="rd-panel rd-board-leader" aria-label={title}>
      <h2>{href ? <a href={href}>{title}</a> : title}</h2>
      <p className="rd-muted">{note}</p>
      {leaders.length === 0 ? (
        <p className="rd-muted">No models qualify.</p>
      ) : (
        <ol>
          {leaders.map((leader) => (
            <li key={leader.model.id}>
              <span className="rd-muted">{leader.rank}</span>
              <ModelLink model={leader.model} />
              <span>{leader.value}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function benchmarkLeaders(benchmark: Benchmark, scope: Scope): Leader[] {
  const field = standings.get(benchmark.id);
  if (!field) return [];
  return [...field.entries()]
    .filter(([modelId]) => scope.model(modelId))
    .slice(0, 3)
    .flatMap(([modelId, entry]) => {
      const model = models.find((candidate) => candidate.id === modelId);
      return model
        ? [
            {
              model,
              value: formatScore(entry.result.score, benchmark),
              rank: entry.rank,
            },
          ]
        : [];
    });
}

// Ranks come from the full ordering so they stay overall under the filter.
function topInScope(leaders: Omit<Leader, 'rank'>[], scope: Scope): Leader[] {
  return leaders
    .map((leader, index) => ({ ...leader, rank: index + 1 }))
    .filter((leader) => scope.model(leader.model.id))
    .slice(0, 3);
}

function Leaders({
  task,
  facts,
  hn,
  scope,
}: {
  task: Task;
  facts: Fact[];
  hn: HnData;
  scope: Scope;
}) {
  const shown = taskBenchmarks(task);
  const discussed = useMemo(
    () =>
      topInScope(
        facts
          .filter((fact) => fact.recent > 0)
          .sort((a, b) => b.recent - a.recent)
          .map((fact) => ({
            model: fact.model,
            value: fact.recent.toLocaleString(),
          })),
        scope,
      ),
    [facts, scope],
  );
  const positive = useMemo(
    () =>
      topInScope(
        facts
          .flatMap((fact) => {
            const share = fact.insight
              ? positiveShare(fact.insight.tally, leaderShareMinimum)
              : null;
            return share === null ? [] : [{ fact, share }];
          })
          .sort((a, b) => b.share - a.share)
          .map(({ fact, share }) => ({
            model: fact.model,
            value: percent(share),
          })),
        scope,
      ),
    [facts, scope],
  );
  const categories = new Set(shown.map((benchmark) => benchmark.category));
  return (
    <div
      className="rd-board-leaders"
      role="group"
      aria-label="Leaders"
      tabIndex={0}
    >
      {task === 'all' ? (
        <p className="rd-panel rd-board-count rd-muted">
          {shown.length} benchmarks in {categories.size} categories. Select a
          task for per-benchmark leaders.
        </p>
      ) : (
        shown.map((benchmark) => (
          <LeaderPanel
            key={benchmark.id}
            title={benchmarkLabel(benchmark)}
            href={routeHref({ view: 'benchmark', id: benchmark.id })}
            note={benchmark.unit}
            leaders={benchmarkLeaders(benchmark, scope)}
          />
        ))
      )}
      {hn.status === 'ready' && (
        <>
          <LeaderPanel
            title="Most discussed, last 4 weeks"
            note="HN comments"
            leaders={discussed}
          />
          <LeaderPanel
            title="Highest positive share"
            note={`At least ${leaderShareMinimum} positive or critical comments`}
            leaders={positive}
          />
        </>
      )}
    </div>
  );
}

function SortHeader({
  column,
  active,
  direction,
  onSort,
}: {
  column: Column;
  active: boolean;
  direction: Direction;
  onSort: (column: Column) => void;
}) {
  const Arrow = direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      className={
        column.kind === 'model'
          ? 'rd-board-th rd-board-th-model'
          : 'rd-board-th rd-board-th-num'
      }
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      <button
        type="button"
        className="rd-board-sort"
        onClick={() => onSort(column)}
        title={column.unit ? `${column.label} · ${column.unit}` : undefined}
      >
        <span className="rd-board-sort-label">
          {column.label}
          <span className="rd-board-arrow">
            {active && <Arrow size={12} aria-hidden="true" />}
          </span>
        </span>
        {column.unit && <small>{column.unit}</small>}
      </button>
      {column.kind === 'benchmark' && (
        <a
          className="rd-board-detail"
          href={routeHref({ view: 'benchmark', id: column.benchmark.id })}
          aria-label={`${column.benchmark.name}: all results and method`}
        >
          Details
        </a>
      )}
    </th>
  );
}

function BenchmarkCell({
  benchmark,
  entry,
}: {
  benchmark: Benchmark;
  entry: Standing | undefined;
}) {
  if (!entry)
    return (
      <td className="rd-board-num rd-board-bench rd-muted">
        <span aria-label="No result">·</span>
      </td>
    );
  const title = `${entry.result.configuration}${
    entry.configurations > 1
      ? ` · best of ${entry.configurations} configurations`
      : ''
  }`;
  return (
    <td className="rd-board-num rd-board-bench" title={title}>
      <span className="rd-board-score">
        {formatScore(entry.result.score, benchmark)}
      </span>
      <span className="rd-board-track">
        <i style={{ width: `${Math.max(2, entry.position * 100)}%` }} />
      </span>
      <span className="rd-board-rank rd-muted">
        #{entry.rank} of {entry.fieldSize}
      </span>
    </td>
  );
}

function HnCell({
  hn,
  className,
  children,
}: {
  hn: HnData;
  className: string;
  children: ReactNode;
}) {
  if (hn.status !== 'ready')
    return (
      <td className={`rd-board-num rd-muted ${className}`}>
        {hn.status === 'loading' ? '…' : '—'}
      </td>
    );
  return <td className={`rd-board-num ${className}`}>{children}</td>;
}

function Dash({ title }: { title?: string }) {
  return (
    <span className="rd-muted" title={title}>
      —
    </span>
  );
}

function PaperCell({
  arxiv,
  fact,
  area,
}: {
  arxiv: ArxivData;
  fact: Fact;
  area: ArxivArea | 'all';
}) {
  if (arxiv.status !== 'ready')
    return (
      <td className="rd-board-num rd-muted rd-board-papers">
        {arxiv.status === 'loading' ? '…' : '—'}
      </td>
    );
  const tally = fact.results?.[area];
  return (
    <td className="rd-board-num rd-board-papers">
      {!tally || tally.papers === 0 ? (
        <Dash />
      ) : (
        <span className="rd-board-pair">
          <a
            href={routeHref({
              view: 'papers',
              key: fact.key,
              area: area === 'all' ? null : area,
            })}
            title={`Reported best in ${tally.best.toLocaleString()} and behind the best model in ${tally.weak.toLocaleString()} of ${tally.papers.toLocaleString()} evaluation ${tally.papers === 1 ? 'paper' : 'papers'}${area === 'all' ? '' : ` on ${areaLabels[area].toLowerCase()}`} that ${tally.papers === 1 ? 'names' : 'name'} ${fact.model.name}`}
          >
            {tally.best.toLocaleString()} · {tally.weak.toLocaleString()}
          </a>
          <span className="rd-muted">of {tally.papers.toLocaleString()}</span>
        </span>
      )}
    </td>
  );
}

function TopicCell({
  hn,
  insight,
  aspect,
}: {
  hn: HnData;
  insight: TargetInsight | null;
  aspect: HnAspect;
}) {
  const tally = insight?.aspects[aspect];
  const count = tally ? tallyTotal(tally) : 0;
  const share = tally ? positiveShare(tally, topicMinimum) : null;
  return (
    <HnCell hn={hn} className="rd-board-topic">
      {count === 0 || !tally ? (
        <Dash />
      ) : (
        <span
          className="rd-board-pair"
          title={`${tally.positive.toLocaleString()} positive of ${(tally.positive + tally.negative).toLocaleString()} clearly positive or critical, among ${count.toLocaleString()} comments tagged ${aspect}`}
        >
          {share === null ? (
            <Dash title={`Fewer than ${topicMinimum} clear opinions`} />
          ) : (
            <span>{percent(share)}</span>
          )}
          <span className="rd-muted">{count.toLocaleString()}</span>
        </span>
      )}
    </HnCell>
  );
}

function BoardRow({
  fact,
  columns,
  hn,
  arxiv,
}: {
  fact: Fact;
  columns: Column[];
  hn: HnData;
  arxiv: ArxivData;
}) {
  const { model, insight } = fact;
  const price = formatPrice(model);
  const tag =
    model.status === 'previous' || model.status === 'preview'
      ? model.status
      : null;
  return (
    <tr>
      {columns.map((column) => {
        switch (column.kind) {
          case 'model':
            return (
              <th key={column.id} scope="row" className="rd-board-model">
                <span className="rd-board-name">
                  <ModelLink model={model} />
                  {tag && <span className="rd-board-tag">{tag}</span>}
                </span>
                <span className="rd-board-meta rd-muted">
                  {model.provider}
                  {price && ` · ${price} per 1M`}
                </span>
              </th>
            );
          case 'benchmark':
            return (
              <BenchmarkCell
                key={column.id}
                benchmark={column.benchmark}
                entry={standing(model.id, column.benchmark.id)}
              />
            );
          case 'papers':
            return (
              <PaperCell
                key={column.id}
                arxiv={arxiv}
                fact={fact}
                area={column.area}
              />
            );
          case 'comments':
            return (
              <HnCell key={column.id} hn={hn} className="rd-board-comments">
                {insight ? (
                  <span className="rd-board-pair">
                    <Sparkline values={fact.weekly} width={64} height={18} />
                    <a
                      href={keyHref(fact.key, true)}
                      title={`Open discussion of ${model.name}`}
                    >
                      {insight.total.toLocaleString()}
                    </a>
                  </span>
                ) : (
                  <Dash />
                )}
              </HnCell>
            );
          case 'sentiment':
            return (
              <HnCell key={column.id} hn={hn} className="rd-board-sentiment">
                {insight ? (
                  <span className="rd-board-pair">
                    <span className="rd-board-sentbar">
                      <SentimentBar tally={insight.tally} />
                    </span>
                    <ShareText tally={insight.tally} minimum={shareMinimum} />
                  </span>
                ) : (
                  <Dash />
                )}
              </HnCell>
            );
          case 'change': {
            const points = fact.change
              ? Math.round(fact.change.change * 100)
              : 0;
            return (
              <HnCell key={column.id} hn={hn} className="rd-board-change">
                {fact.change ? (
                  <span
                    className={
                      points > 0
                        ? 'rd-board-up'
                        : points < 0
                          ? 'rd-board-down'
                          : undefined
                    }
                    title={`Positive share ${percent(fact.change.earlier)} to ${percent(fact.change.recent)}, latest 4 weeks against the 4 before`}
                  >
                    {formatChange(fact.change.change)}
                  </span>
                ) : (
                  <Dash title="Too few clear opinions in one of the two periods" />
                )}
              </HnCell>
            );
          }
          case 'topic':
            return (
              <TopicCell
                key={column.id}
                hn={hn}
                insight={insight}
                aspect={column.aspect}
              />
            );
        }
      })}
    </tr>
  );
}

export default function Board({ hn, scope }: { hn: HnData; scope: Scope }) {
  const [task, setTask] = useState<Task>('coding');
  const [query, setQuery] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [provider, setProvider] = useState('');
  const [sort, setSort] = useState<{
    task: Task;
    id: string;
    direction: Direction;
  } | null>(null);

  const arxiv = useArxivData();
  const results = useMemo(
    () =>
      arxiv.status === 'ready' ? tallyResults(arxiv.snapshot.papers) : null,
    [arxiv],
  );
  const facts = useMemo(() => buildFacts(hn, results), [hn, results]);
  const columns = useMemo(() => buildColumns(task), [task]);
  const eligible = useMemo(
    () =>
      facts.filter(
        (fact) =>
          scope.model(fact.model.id) &&
          (hasResult(fact.model, task) ||
            (task === 'all' &&
              (fact.insight?.total ?? 0) >= discussionMinimum)),
      ),
    [facts, task, scope],
  );
  const providers = useMemo(
    () => [...new Set(eligible.map((fact) => fact.model.provider))].sort(),
    [eligible],
  );
  const activeProvider = providers.includes(provider) ? provider : '';

  const active =
    sort && sort.task === task ? sort : { task, ...defaultSort(task) };
  const sortColumn =
    columns.find((column) => column.id === active.id) ?? columns[0];

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = eligible.filter(
      (fact) =>
        (!needle || fact.model.name.toLowerCase().includes(needle)) &&
        (!currentOnly || fact.model.status === 'current') &&
        (!activeProvider || fact.model.provider === activeProvider),
    );
    if (!sortColumn) return visible;
    return visible.sort(
      (a, b) =>
        compareValues(
          sortValue(a, sortColumn),
          sortValue(b, sortColumn),
          active.direction,
        ) || a.model.name.localeCompare(b.model.name),
    );
  }, [
    eligible,
    query,
    currentOnly,
    activeProvider,
    sortColumn,
    active.direction,
  ]);

  function changeSort(column: Column) {
    setSort({
      task,
      id: column.id,
      direction:
        active.id === column.id
          ? active.direction === 'asc'
            ? 'desc'
            : 'asc'
          : column.kind === 'model'
            ? 'asc'
            : 'desc',
    });
  }

  return (
    <div className="rd-board">
      <div className="rd-board-controls">
        <div className="rd-board-tasks">
          <div className="rd-seg" role="group" aria-label="Task">
            {taskOptions.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={task === option}
                onClick={() => setTask(option)}
              >
                {option === 'all' ? 'All' : categoryLabels[option]}
              </button>
            ))}
          </div>
        </div>
        <input
          type="search"
          className="rd-input rd-board-search"
          placeholder="Search models"
          aria-label="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="rd-chip"
          aria-pressed={currentOnly}
          onClick={() => setCurrentOnly(!currentOnly)}
        >
          Current models only
        </button>
        <select
          className="rd-select"
          aria-label="Provider"
          value={activeProvider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="">All providers</option>
          {providers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p className="rd-board-total rd-muted" role="status">
          {rows.length} {rows.length === 1 ? 'model' : 'models'}
        </p>
      </div>

      <Leaders task={task} facts={facts} hn={hn} scope={scope} />

      {scope.active && <RankNote />}

      <div
        className="rd-board-wrap"
        role="region"
        aria-label="Model ranking"
        tabIndex={0}
      >
        <table
          className={
            task === 'all'
              ? 'rd-board-table rd-board-compact'
              : 'rd-board-table'
          }
        >
          <thead>
            <tr>
              {columns.map((column) => (
                <SortHeader
                  key={column.id}
                  column={column}
                  active={column.id === sortColumn?.id}
                  direction={active.direction}
                  onSort={changeSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="rd-muted">
                  {scope.active && eligible.length === 0
                    ? 'No models in the filter have results for this task.'
                    : 'No models match.'}
                </td>
              </tr>
            ) : (
              rows.map((fact) => (
                <BoardRow
                  key={fact.model.id}
                  fact={fact}
                  columns={columns}
                  hn={hn}
                  arxiv={arxiv}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="rd-note rd-board-foot">
        Scores are each model&apos;s best published configuration. Rank is
        within this snapshot&apos;s field. Positive share is positive ÷
        (positive + critical) and is hidden below {shareMinimum} such comments (
        {topicMinimum} for topic share and each period of the 4-week change). HN
        labels are automatic and can be wrong. Paper results count the
        evaluation papers whose abstract reports the model as best, or as behind
        the paper's best model, out of those that name it; they are extracted
        automatically from abstracts and can be wrong.
      </p>
    </div>
  );
}
