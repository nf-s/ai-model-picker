import { useMemo, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { useArxivData } from '../lib/arxiv-client';
import {
  areaLabels,
  countLabels,
  emptyPaperFilter,
  filterPapers,
  paperAreas,
  paperDayFormat,
  paperKinds,
  paperPage,
  paperStanding,
  paperTopics,
  standingLabels,
  summariseTargets,
} from '../lib/arxiv-papers';
import type { PaperFilter, PaperKind } from '../lib/arxiv-papers';
import type {
  ArxivArea,
  ArxivPaper,
  ArxivSnapshot,
  ArxivTopic,
} from '../lib/arxiv-schema';
import { formatHnDate } from '../lib/hn-client';
import { parseTargetKey, targetKey } from '../lib/hn-insights';
import { hnPublished } from '../lib/hn-published';
import { scopePapers } from '../lib/model-filter';
import type { Scope } from '../lib/model-filter';
import { modelHref } from '../lib/route';
import { keyName, modelById } from '../lib/site-data';
import './papers.css';

type TargetOption = { key: string; name: string; papers: number };

const kindLabels: Record<PaperKind, string> = {
  usage: 'Usage finding',
  evaluation: 'Evaluation',
  application: 'Application',
  behaviour: 'Behaviour',
  release: 'Model release',
  survey: 'Survey',
  other: 'Other',
  unlabelled: 'Unlabelled',
};
const kindFilters: PaperKind[] = [...paperKinds, 'unlabelled'];
const kindDefinitions: { kind: PaperKind; text: string }[] = [
  {
    kind: 'usage',
    text: 'tests how a choice by the person using a model changes results, such as prompting, context or tool access',
  },
  { kind: 'evaluation', text: 'benchmarks or compares models on a task' },
  { kind: 'application', text: 'uses a model as a component or assistant' },
  {
    kind: 'behaviour',
    text: 'studies model behaviour, safety, security, bias or failures',
  },
  { kind: 'release', text: 'written by a model’s developers to introduce it' },
  {
    kind: 'survey',
    text: 'a review, survey, position paper or roadmap without new experiments',
  },
  { kind: 'other', text: 'none of these' },
];
const topicLabels: Record<ArxivTopic, string> = {
  prompting: 'Prompting',
  context: 'Context',
  reasoning: 'Reasoning',
  agents: 'Agents',
  tools: 'Tools',
  retrieval: 'Retrieval',
  'structured-output': 'Structured output',
  coding: 'Coding',
  cost: 'Cost',
  safety: 'Safety',
  multimodal: 'Multimodal',
  'fine-tuning': 'Fine-tuning',
};
const summaryRows = 15;
const scopeText =
  'arXiv papers whose title or abstract names a tracked model or family.';

function dayRange(first: string, last: string) {
  return paperDayFormat.formatRange(
    new Date(`${first}T00:00:00Z`),
    new Date(`${last}T00:00:00Z`),
  );
}

function byName(a: TargetOption, b: TargetOption) {
  return a.name.localeCompare(b.name);
}

function Coverage({
  snapshot,
  labelled,
}: {
  snapshot: ArxivSnapshot;
  labelled: number;
}) {
  const { coverage, papers, assessor, publishedAt, updatedAt } = snapshot;
  return (
    <p>
      Submitted {dayRange(coverage.firstDay, coverage.lastDay)} ·{' '}
      {papers.length.toLocaleString()} papers ·{' '}
      {assessor
        ? `${labelled.toLocaleString()} abstracts labelled by ${assessor}`
        : 'abstracts not labelled yet'}
      {coverage.assessmentFailures > 0 &&
        ` · ${coverage.assessmentFailures.toLocaleString()} could not be labelled`}
      {coverage.results > 0 &&
        ` · ${coverage.results.toLocaleString()} evaluation ${coverage.results === 1 ? 'result' : 'results'}`}
      {coverage.resultFailures > 0 &&
        ` · ${coverage.resultFailures.toLocaleString()} ${coverage.resultFailures === 1 ? 'result' : 'results'} could not be extracted`}{' '}
      ·{' '}
      {publishedAt
        ? `snapshot ${formatHnDate(publishedAt)}`
        : `updated ${formatHnDate(updatedAt)}`}
      {coverage.state !== 'complete' &&
        `. Collection incomplete: ${coverage.daysComplete.toLocaleString()} of ${coverage.daysTotal.toLocaleString()} days.`}
    </p>
  );
}

function PaperItem({
  paper,
  target,
  onPickTarget,
}: {
  paper: ArxivPaper;
  target: string | null;
  onPickTarget: (key: string) => void;
}) {
  const { assessment, result } = paper;
  // A result's finding replaces the takeaway.
  const note = result?.finding ?? assessment?.takeaway;
  return (
    <li className="rd-panel rd-pp-paper">
      <h3>
        <a
          href={`https://arxiv.org/abs/${paper.id}`}
          target="_blank"
          rel="noreferrer"
        >
          {paper.title}
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      </h3>
      <p className="rd-pp-meta">
        <time dateTime={paper.submittedAt}>
          {paperDayFormat.format(new Date(paper.submittedAt))}
        </time>
        <span>{paper.categories[0]}</span>
        <span>arXiv {paper.id}</span>
        {assessment && (
          <span className="rd-pp-kind">{kindLabels[assessment.kind]}</span>
        )}
        {assessment && assessment.topics.length > 0 && (
          <span>
            {assessment.topics.map((topic) => topicLabels[topic]).join(', ')}
          </span>
        )}
      </p>
      {result && (
        <p className="rd-pp-result">
          <span className="rd-pp-area">{areaLabels[result.area]}</span>
          {result.task}
        </p>
      )}
      <ul className="rd-pp-targets" aria-label="Matched models and families">
        {paper.targets.map((ref) => {
          const key = targetKey(ref);
          const standing = paperStanding(paper, key);
          return (
            <li key={key}>
              <button
                type="button"
                className="rd-chip"
                aria-pressed={key === target}
                onClick={() => onPickTarget(key)}
              >
                {keyName(key)}
                {(standing === 'best' || standing === 'weak') && (
                  <span className={`rd-pp-standing rd-pp-${standing}`}>
                    {standingLabels[standing]}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {note && (
        <p className="rd-pp-takeaway">
          <span className="rd-pp-ai">AI-generated from the abstract</span>
          {note}
        </p>
      )}
    </li>
  );
}

function Explorer({
  snapshot,
  initialTarget,
  initialArea,
}: {
  snapshot: ArxivSnapshot;
  initialTarget: string | null;
  initialArea: ArxivArea | null;
}) {
  const { papers } = snapshot;
  const options = useMemo(
    () => ({
      models: snapshot.models
        .map((row) => {
          const key = targetKey({ kind: 'model', target: row.modelId });
          return { key, name: keyName(key), papers: row.papers };
        })
        .sort(byName),
      families: snapshot.families
        .map((row) => ({
          key: targetKey({ kind: 'family', target: row.familyName }),
          name: row.familyName,
          papers: row.papers,
        }))
        .sort(byName),
    }),
    [snapshot],
  );
  const known = (key: string) =>
    options.models.some((option) => option.key === key) ||
    options.families.some((option) => option.key === key);
  const hasResults = useMemo(
    () => papers.some((paper) => paper.result !== null),
    [papers],
  );
  // A linked area opens the evaluations in it.
  const area = hasResults ? initialArea : null;
  const [filter, setFilter] = useState<PaperFilter>({
    ...emptyPaperFilter,
    target: initialTarget && known(initialTarget) ? initialTarget : null,
    kind: area ? 'evaluation' : null,
    area,
  });
  const [paging, setPaging] = useState({ filter, page: 0 });
  const [scope, setScope] = useState(
    (initialTarget && parseTargetKey(initialTarget)?.kind) || 'model',
  );
  const [allRows, setAllRows] = useState(false);
  const listHeading = useRef<HTMLHeadingElement>(null);

  const labelled = useMemo(
    () => papers.filter((paper) => paper.assessment !== null).length,
    [papers],
  );
  const matches = useMemo(() => filterPapers(papers, filter), [papers, filter]);
  // Each filter is counted with its own selection lifted, so the
  // alternatives stay visible.
  const kindCounts = useMemo(
    () => countLabels(filterPapers(papers, { ...filter, kind: null })).kinds,
    [papers, filter],
  );
  const topicCounts = useMemo(
    () => countLabels(filterPapers(papers, { ...filter, topic: null })).topics,
    [papers, filter],
  );
  const areaCounts = useMemo(
    () => countLabels(filterPapers(papers, { ...filter, area: null })).areas,
    [papers, filter],
  );
  const summary = useMemo(
    () =>
      summariseTargets(
        filterPapers(papers, { ...filter, target: null }),
      ).filter((row) => row.kind === scope),
    [papers, filter, scope],
  );
  const view = paperPage(matches, paging.filter === filter ? paging.page : 0);

  const update = (patch: Partial<PaperFilter>) =>
    setFilter((current) => ({ ...current, ...patch }));
  const pickTarget = (key: string) => {
    update({ target: key === filter.target ? null : key });
    const kind = parseTargetKey(key)?.kind;
    if (kind) setScope(kind);
  };
  const goTo = (page: number) => {
    setPaging({ filter, page });
    listHeading.current?.focus();
  };
  const active =
    filter.target !== null ||
    filter.kind !== null ||
    filter.topic !== null ||
    filter.area !== null ||
    filter.query.trim() !== '';
  const targetRef = filter.target ? parseTargetKey(filter.target) : null;
  const fileModel =
    targetRef?.kind === 'model' ? modelById.get(targetRef.target) : undefined;
  const shownRows = allRows ? summary : summary.slice(0, summaryRows);
  const head = (
    <header className="rd-page-head">
      <h1>Papers</h1>
      <p>{scopeText}</p>
      <Coverage snapshot={snapshot} labelled={labelled} />
    </header>
  );

  if (papers.length === 0)
    return (
      <>
        {head}
        <p className="rd-note">
          No papers collected yet.
          {!hnPublished && (
            <>
              {' '}
              Run <code>npm run arxiv:run</code> to collect them.
            </>
          )}
        </p>
      </>
    );
  return (
    <>
      {head}

      <section
        className={
          hasResults && labelled > 0
            ? 'rd-panel rd-pp-filters rd-pp-filters-wide'
            : 'rd-panel rd-pp-filters'
        }
        aria-label="Filters"
      >
        <div className="rd-pp-field">
          <label className="rd-h" htmlFor="rd-pp-target">
            Model or family
          </label>
          <select
            id="rd-pp-target"
            className="rd-select"
            value={filter.target ?? ''}
            onChange={(event) => {
              const key = event.target.value;
              if (key) pickTarget(key);
              else update({ target: null });
            }}
          >
            <option value="">All models and families</option>
            <optgroup label="Models">
              {options.models.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name} ({option.papers.toLocaleString()})
                </option>
              ))}
            </optgroup>
            <optgroup label="Families">
              {options.families.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.name} ({option.papers.toLocaleString()})
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="rd-pp-field">
          <label className="rd-h" htmlFor="rd-pp-search">
            Title
          </label>
          <input
            id="rd-pp-search"
            className="rd-input"
            type="search"
            placeholder="Words in the title"
            value={filter.query}
            onChange={(event) => update({ query: event.target.value })}
          />
        </div>
        {labelled > 0 && (
          <div className="rd-pp-field">
            <label className="rd-h" htmlFor="rd-pp-topic">
              Topic
            </label>
            <select
              id="rd-pp-topic"
              className="rd-select"
              value={filter.topic ?? ''}
              onChange={(event) => {
                const topic = paperTopics.find(
                  (value) => value === event.target.value,
                );
                update({ topic: topic ?? null });
              }}
            >
              <option value="">All topics</option>
              {paperTopics.map((topic) => (
                <option key={topic} value={topic}>
                  {topicLabels[topic]} ({topicCounts[topic].toLocaleString()})
                </option>
              ))}
            </select>
          </div>
        )}
        {hasResults && (
          <div className="rd-pp-field">
            <label className="rd-h" htmlFor="rd-pp-area">
              Area
            </label>
            <select
              id="rd-pp-area"
              className="rd-select"
              value={filter.area ?? ''}
              onChange={(event) => {
                const area = paperAreas.find(
                  (value) => value === event.target.value,
                );
                update({ area: area ?? null });
              }}
            >
              <option value="">All areas</option>
              {paperAreas.map((area) => (
                <option key={area} value={area}>
                  {areaLabels[area]} ({areaCounts[area].toLocaleString()})
                </option>
              ))}
            </select>
          </div>
        )}
        {labelled > 0 && (
          <fieldset className="rd-pp-kinds">
            <legend className="rd-h">Kind</legend>
            <div className="rd-chips">
              {kindFilters.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="rd-chip"
                  aria-pressed={filter.kind === kind}
                  onClick={() =>
                    update({ kind: filter.kind === kind ? null : kind })
                  }
                >
                  {kindLabels[kind]}
                  <small>{kindCounts[kind].toLocaleString()}</small>
                </button>
              ))}
            </div>
            <details className="rd-pp-defs">
              <summary>Kind definitions</summary>
              <ul>
                {kindDefinitions.map(({ kind, text }) => (
                  <li key={kind}>
                    <strong>{kindLabels[kind]}</strong>: {text}.
                  </li>
                ))}
              </ul>
            </details>
          </fieldset>
        )}
        <p className="rd-note rd-pp-limit">
          {labelled > 0
            ? `Kind, topics and takeaways are labelled by a local model${snapshot.assessor ? ` (${snapshot.assessor})` : ''} from the abstract only.${hasResults ? ' Evaluation results (area, task, and the models reported best or behind the best) are extracted by the same model, also from the abstract only.' : ''} Names are matched in the title and abstract, so some papers only mention a model in passing.`
            : 'Abstracts are not labelled yet, so kind and topic filters are hidden. Names are matched in the title and abstract, so some papers only mention a model in passing.'}
        </p>
      </section>

      <div className="rd-chips" role="group" aria-label="Active filters">
        {filter.target ? (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => update({ target: null })}
          >
            {keyName(filter.target)} <X size={12} />
          </button>
        ) : (
          <span className="rd-chip">All models and families</span>
        )}
        {filter.kind && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => update({ kind: null })}
          >
            {kindLabels[filter.kind]} <X size={12} />
          </button>
        )}
        {filter.topic && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => update({ topic: null })}
          >
            Topic: {topicLabels[filter.topic]} <X size={12} />
          </button>
        )}
        {filter.area && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => update({ area: null })}
          >
            Area: {areaLabels[filter.area]} <X size={12} />
          </button>
        )}
        {filter.query.trim() && (
          <button
            type="button"
            className="rd-chip rd-chip-active"
            onClick={() => update({ query: '' })}
          >
            Title: {filter.query.trim()} <X size={12} />
          </button>
        )}
        {active && (
          <button
            type="button"
            className="rd-link"
            onClick={() => setFilter(emptyPaperFilter)}
          >
            Clear all
          </button>
        )}
        {fileModel && (
          <a href={modelHref(fileModel.id)}>Open {fileModel.name} file</a>
        )}
      </div>

      <div className="rd-pp-body">
        <section
          className="rd-section rd-pp-counts"
          aria-labelledby="rd-pp-summary"
        >
          <div className="rd-pp-head">
            <h2 className="rd-h" id="rd-pp-summary">
              Papers per {scope === 'model' ? 'model' : 'family'}
            </h2>
            <div className="rd-seg" role="group" aria-label="Rows">
              <button
                type="button"
                aria-pressed={scope === 'model'}
                onClick={() => setScope('model')}
              >
                Models
              </button>
              <button
                type="button"
                aria-pressed={scope === 'family'}
                onClick={() => setScope('family')}
              >
                Families
              </button>
            </div>
          </div>
          <div className="rd-panel">
            <table className="rd-table rd-pp-table">
              <thead>
                <tr>
                  <th scope="col">{scope === 'model' ? 'Model' : 'Family'}</th>
                  <th scope="col" className="rd-num">
                    Papers
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row) => (
                  <tr
                    key={row.key}
                    className={
                      row.key === filter.target ? 'rd-pp-current' : undefined
                    }
                  >
                    <th scope="row">
                      <button
                        type="button"
                        className="rd-link"
                        aria-pressed={row.key === filter.target}
                        onClick={() => pickTarget(row.key)}
                      >
                        {keyName(row.key)}
                      </button>
                    </th>
                    <td className="rd-num">{row.papers.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.length === 0 && (
              <p className="rd-note">No papers match these filters.</p>
            )}
          </div>
          {summary.length > summaryRows && (
            <button
              type="button"
              className="rd-more"
              onClick={() => setAllRows(!allRows)}
            >
              {allRows
                ? `Show top ${summaryRows}`
                : `Show all ${summary.length.toLocaleString()}`}
            </button>
          )}
          <p className="rd-note">
            Counts use the other filters. A paper naming several models or
            families is counted for each.
          </p>
        </section>

        <section className="rd-section" aria-labelledby="rd-pp-list">
          <div className="rd-pp-head">
            <h2
              className="rd-h rd-pp-list-title"
              id="rd-pp-list"
              ref={listHeading}
              tabIndex={-1}
            >
              Papers
            </h2>
            <p className="rd-note" role="status">
              {matches.length === 0
                ? 'No papers match these filters.'
                : `${(view.start + 1).toLocaleString()}–${(view.start + view.rows.length).toLocaleString()} of ${matches.length.toLocaleString()}, newest first`}
            </p>
          </div>
          {view.rows.length > 0 && (
            <ol className="rd-pp-list">
              {view.rows.map((paper) => (
                <PaperItem
                  key={paper.id}
                  paper={paper}
                  target={filter.target}
                  onPickTarget={pickTarget}
                />
              ))}
            </ol>
          )}
          {view.pages > 1 && (
            <nav className="rd-pp-pager" aria-label="Pages">
              <button
                type="button"
                className="rd-button"
                disabled={view.page === 0}
                onClick={() => goTo(view.page - 1)}
              >
                Previous
              </button>
              <span>
                Page {(view.page + 1).toLocaleString()} of{' '}
                {view.pages.toLocaleString()}
              </span>
              <button
                type="button"
                className="rd-button"
                disabled={view.page === view.pages - 1}
                onClick={() => goTo(view.page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </section>
      </div>
    </>
  );
}

function ArxivCredit() {
  return (
    <p className="rd-note">
      Thank you to arXiv for use of its open access interoperability. This site
      was not reviewed or approved by, nor does it necessarily express or
      reflect the policies or opinions of, arXiv.
    </p>
  );
}

export default function Papers({
  initialTarget,
  initialArea,
  scope,
}: {
  initialTarget: string | null;
  initialArea: ArxivArea | null;
  scope: Scope;
}) {
  const arxiv = useArxivData();
  // With a model filter, only papers and names it covers reach the explorer,
  // which starts over when the filter changes.
  const snapshot = useMemo(
    () =>
      arxiv.status !== 'ready'
        ? null
        : scope.active
          ? scopePapers(arxiv.snapshot, scope.key)
          : arxiv.snapshot,
    [arxiv, scope],
  );
  if (
    arxiv.status === 'ready' &&
    snapshot &&
    (snapshot.papers.length > 0 || arxiv.snapshot.papers.length === 0)
  )
    return (
      <div className="rd-page rd-pp">
        <Explorer
          key={`${initialTarget ?? 'all'}|${initialArea ?? 'all'}|${scope.id}`}
          snapshot={snapshot}
          initialTarget={initialTarget}
          initialArea={initialArea}
        />
        <ArxivCredit />
      </div>
    );
  return (
    <div className="rd-page rd-pp">
      <header className="rd-page-head">
        <h1>Papers</h1>
        <p>{scopeText}</p>
      </header>
      {arxiv.status === 'loading' ? (
        <p className="rd-note">Loading papers…</p>
      ) : arxiv.status === 'ready' ? (
        <p className="rd-note">
          No collected papers name a model in the filter.
        </p>
      ) : (
        <p className="rd-alert rd-pp-alert" role="alert">
          The paper index could not be loaded.
          {!hnPublished && (
            <>
              {' '}
              Run <code>npm run arxiv:run</code> to collect papers, then reload
              this page.
            </>
          )}
        </p>
      )}
    </div>
  );
}
