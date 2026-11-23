import { useState } from 'react';
import {
  ArrowUpRight,
  Download as DownloadIcon,
  RefreshCw,
} from 'lucide-react';
import { attributions } from '../lib/attribution';
import { useBriefData } from '../lib/core-client';
import type { CoreData } from '../lib/core-client';
import type { Core } from '../lib/core-schema';
import {
  checkedAt,
  downloadPublicData,
  models,
  restrictedAttributions,
  restrictedData,
  sources,
} from '../lib/data';
import { guide } from '../lib/guide';
import { formatHnRange, hnClassifierCheck, hnSources } from '../lib/hn-client';
import type { HnPipeline } from '../lib/hn-client';
import { hnPublished } from '../lib/hn-published';
import type { FilterBar, Scope } from '../lib/model-filter';
import { routeHref } from '../lib/route';
import { RecordsStatus } from './Bands';
import {
  Coverage,
  JobRules,
  Limits,
  Measures,
  Sources,
  useAdvice,
} from './DataSources';
import { formatDay } from './FilterBar';
import './data-page.css';

const publicationDate = new Intl.DateTimeFormat('en-AU', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Australia/Hobart',
});

const allSources = [
  ...new Map(
    [
      ...sources,
      ...hnSources,
      ...guide.sources.map((source) => ({
        ...source,
        kind: 'App documentation',
        coverage: 'App model names, settings, features and plan availability.',
        access: 'Public provider documentation',
        limitations:
          'Account-specific rollout and remaining usage are not verified.',
      })),
    ].map((source) => [source.url, source]),
  ).values(),
];

function Collection({ pipeline }: { pipeline: HnPipeline }) {
  const { data, error, pending, control, publishedAt, refreshSnapshot } =
    pipeline;
  const status = data?.status;
  const checkApplies = status?.classifier === hnClassifierCheck.classifierId;
  const active = data?.runner.active ?? false;
  const external = data?.runner.external ?? false;
  const hosted =
    external || (checkApplies && hnClassifierCheck.backend !== 'local');
  const totalExpected =
    status?.partitions.reduce((sum, part) => sum + part.expectedItems, 0) ?? 0;
  const scanned = status?.totals.itemsScanned ?? 0;
  const percentage = totalExpected
    ? Math.min(100, (scanned / totalExpected) * 100)
    : 0;
  const finished = status?.state === 'complete';
  const blocked = status?.state === 'blocked';
  const sectionsComplete =
    status &&
    status.totals.partitionsComplete === status.totals.partitionsTotal;
  const unresolved = status?.totals.classificationFailures ?? 0;
  const localLabel = active
    ? status?.state === 'running'
      ? 'Running locally'
      : 'Starting or finishing'
    : finished
      ? 'Run finished'
      : blocked
        ? 'Needs attention'
        : external && status?.state === 'running'
          ? 'Running from a terminal'
          : status
            ? 'Paused'
            : 'Ready to start';
  const label = hnPublished
    ? status
      ? finished
        ? 'Collection complete'
        : sectionsComplete
          ? 'Classification incomplete'
          : 'Partial collection'
      : error
        ? 'Snapshot unavailable'
        : 'Loading snapshot…'
    : localLabel;
  const currentPartitions =
    status?.partitions.filter(
      (part) =>
        part.state === 'running' ||
        part.state === 'paused' ||
        part.state === 'blocked',
    ) ?? [];
  return (
    <section className="rd-section" aria-labelledby="rd-dp-hn-title">
      <h2 className="rd-h" id="rd-dp-hn-title">
        Hacker News collection
      </h2>
      <p className="rd-note">
        Comments open from the Crowd band of each{' '}
        <a
          className="rd-dp-link"
          href={routeHref({
            view: 'model',
            target: null,
            job: null,
            comments: false,
          })}
        >
          model page
        </a>
        .
      </p>
      <div className="rd-panel rd-dp-collection">
        <div className="rd-dp-top">
          <div>
            <p>
              {status?.startAt && status.endAt
                ? formatHnRange(status.startAt, status.endAt)
                : 'Last six months'}{' '}
              ·{' '}
              {hnPublished
                ? 'Published snapshot'
                : external
                  ? 'Collected on this computer'
                  : 'Analysed on this computer'}
            </p>
            <p className="rd-dp-state">
              <span
                className={
                  active ? 'rd-dp-badge rd-dp-badge-active' : 'rd-dp-badge'
                }
              >
                {label}
              </span>
            </p>
          </div>
          {hnPublished ? (
            <button
              type="button"
              className="rd-button rd-button-primary"
              disabled={pending}
              onClick={() => void refreshSnapshot()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {pending ? 'Refreshing…' : 'Refresh snapshot'}
            </button>
          ) : (
            <button
              type="button"
              className="rd-button rd-button-primary"
              disabled={
                pending ||
                finished ||
                external ||
                (!active && !data?.runner.installed)
              }
              onClick={() => void control(active ? 'pause' : 'start')}
            >
              {pending
                ? 'Working…'
                : active
                  ? 'Pause'
                  : finished
                    ? 'Scan finished'
                    : external
                      ? 'Controlled from a terminal'
                      : blocked
                        ? 'Retry scan'
                        : status
                          ? 'Resume scan'
                          : 'Start six-month scan'}
            </button>
          )}
        </div>
        {error && (
          <p className="rd-alert rd-dp-alert" role="status">
            {error}{' '}
            {!hnPublished && (
              <>
                Start the app with <code>npm run dev</code> to enable local
                controls.
              </>
            )}
          </p>
        )}
        {!hnPublished && blocked && (
          <p className="rd-alert rd-dp-alert" role="status">
            {status.reason === 'classification-unresolved' ? (
              <>
                {unresolved.toLocaleString()} comments have no valid review.{' '}
                {external
                  ? 'Running the review again from a terminal sends them once more.'
                  : 'Retry sends them once more.'}
              </>
            ) : (
              <>
                The scan stopped before completion.{' '}
                {external
                  ? 'Running it again from a terminal resumes from its checkpoint.'
                  : 'Retry resumes from its checkpoint.'}{' '}
                {status.reason && <span>{status.reason}.</span>}
              </>
            )}
          </p>
        )}
        {data?.runner.message && (
          <p className="rd-alert rd-dp-alert" role="status">
            {data.runner.message}
          </p>
        )}
        <div className="rd-dp-progress" aria-label="Collection progress">
          <div className="rd-dp-progress-top">
            <span>
              <strong>{scanned.toLocaleString()}</strong>
              {totalExpected > 0 &&
                ` of ${totalExpected.toLocaleString()}`}{' '}
              item records scanned
            </span>
            <span className="rd-num">{percentage.toFixed(2)}%</span>
          </div>
          <progress
            className="rd-dp-bar"
            max={100}
            value={percentage}
            aria-label="Item records scanned"
          />
          <dl className="rd-dp-counts">
            <div>
              <dt>Comments read</dt>
              <dd>{status?.totals.commentsScanned.toLocaleString() ?? '—'}</dd>
            </div>
            <div>
              <dt>Model-related comments</dt>
              <dd>{status?.totals.candidates.toLocaleString() ?? '—'}</dd>
            </div>
            <div>
              <dt>Comments analysed</dt>
              <dd>{status?.totals.classified.toLocaleString() ?? '—'}</dd>
            </div>
            <div>
              <dt>Source sections complete</dt>
              <dd>
                {status
                  ? `${status.totals.partitionsComplete} / ${status.totals.partitionsTotal}`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Inference API charges</dt>
              <dd>{hosted ? 'Not tracked here' : '$0'}</dd>
            </div>
          </dl>
          <p className="rd-note">
            {finished
              ? status?.allPublicItemsScanned
                ? 'The run’s public API item range has been scanned.'
                : 'Collection finished for the selected dates. Archive and mirror records can lag edits and deletions.'
              : hnPublished
                ? status &&
                  (sectionsComplete
                    ? 'Source scanning finished for the selected dates.'
                    : 'Counts cover comments processed at publication.')
                : 'Counts below cover comments processed so far.'}{' '}
            {hnPublished && unresolved > 0 && (
              <>
                {unresolved.toLocaleString()} comments are awaiting valid
                classification.{' '}
              </>
            )}
            {publishedAt && (
              <>
                Published{' '}
                <time dateTime={publishedAt}>
                  {publicationDate.format(new Date(publishedAt))} Hobart time
                </time>
                .
              </>
            )}
            {!hnPublished && status?.updatedAt && (
              <>
                Updated{' '}
                {new Date(status.updatedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .
              </>
            )}
          </p>
        </div>
        <p className="rd-dp-line">
          <span>
            {status?.source === 'firebase'
              ? 'Official Hacker News API'
              : 'Public archive and recent HN data'}
          </span>
          <span>
            {checkApplies || !status
              ? hnClassifierCheck.modelName
              : status.classifier}{' '}
            classifier
          </span>
        </p>
        <details className="rd-dp-details">
          <summary>Coverage, processing and limitations</summary>
          {checkApplies && (
            <div className="rd-dp-block">
              <h3>Quality check · {hnClassifierCheck.checkedAt}</h3>
              <p>
                {hnClassifierCheck.agrees} of{' '}
                {hnClassifierCheck.referenceAssessments} labels matched an
                earlier AI review. {hnClassifierCheck.disagrees} differed,
                including {hnClassifierCheck.oppositePolarity} with the opposite
                sign. {hnClassifierCheck.unclear} had no clear stance and{' '}
                {hnClassifierCheck.targetMissed === 1
                  ? '1 target was'
                  : `${hnClassifierCheck.targetMissed} targets were`}{' '}
                missed.
                {hnClassifierCheck.failed > 0 && (
                  <> {hnClassifierCheck.failed} classifications failed.</>
                )}
              </p>
              <p>
                The reference has no independent human validation. Read the
                original comments before using a label to choose a model.
              </p>
            </div>
          )}
          <div className="rd-dp-grid">
            <div className="rd-dp-block">
              <h3>What is scanned</h3>
              <p>
                The run covers six calendar months. It reads recent records and
                overlapping monthly archive files. The official HN API fills
                source ID gaps. Deleted, unavailable and malformed records are
                counted separately.
              </p>
              <p>
                A text filter finds comments that name a model or app. Every
                comment in a thread whose story title names one is included. The
                classifier reads each comment with the text it replies to and
                the story title, after links, contact details, handles, quoted
                lines and code are removed. Outside those threads it misses
                comments that do not name a model. Archived records reflect a
                source snapshot.
              </p>
              <p>
                Unspecified versions are kept as family feedback. Unresolved
                classifier failures are tracked separately and retried. They do
                not become sentiment evidence.
              </p>
            </div>
            <div className="rd-dp-block">
              <h3>{hnPublished ? 'Published data' : 'On this computer'}</h3>
              {!hnPublished &&
                (hnClassifierCheck.backend === 'local' ? (
                  <p>
                    The quantized model uses local compute and electricity.
                    Initial setup downloads about{' '}
                    {hnClassifierCheck.downloadGigabytes} GB of model files.
                  </p>
                ) : (
                  <p>
                    The review ran through the Anthropic API from a terminal. It
                    is paid and sends each comment, the text it replies to and
                    the story title to Anthropic after links, contact details
                    and handles are removed.
                  </p>
                ))}
              <p>
                {hnPublished
                  ? 'The snapshot contains IDs, timestamps, classifications, story titles and one-sentence claims written by the classifier.'
                  : 'Comment bodies are processed in memory. Saved data contains IDs, timestamps, classifications, story titles, one-sentence claims written by the classifier and checkpoints.'}{' '}
                The reader loads original wording from Hacker News as you
                browse. Parent context and replies can extend beyond the scan
                dates.
              </p>
              <p>
                {!hnPublished &&
                  !external &&
                  'Pause keeps progress. Resume continues the same pinned run. '}
                The quality check uses earlier AI assessments as its reference.
              </p>
            </div>
          </div>
          {status && (
            <div className="rd-dp-block">
              <p>
                Unavailable records:{' '}
                {status.totals.unavailable.toLocaleString()} · Invalid records:{' '}
                {status.totals.invalid.toLocaleString()} · Recorded failures:{' '}
                {status.totals.failures.toLocaleString()} · Comments awaiting
                valid classification:{' '}
                {status.totals.classificationFailures.toLocaleString()}
              </p>
              <p>
                Comment dates encountered ·{' '}
                {status.firstCommentAt && status.lastCommentAt
                  ? formatHnRange(status.firstCommentAt, status.lastCommentAt)
                  : '—'}
              </p>
              {currentPartitions.slice(0, 5).map((part) => (
                <p key={part.id}>
                  {part.id} · {part.source} ·{' '}
                  {part.itemsScanned.toLocaleString()} /{' '}
                  {part.expectedItems.toLocaleString()} records
                </p>
              ))}
            </div>
          )}
          <p className="rd-dp-links">
            {hnSources.map((source) => (
              <a
                key={source.id}
                className="rd-dp-link"
                href={source.url}
                target="_blank"
                rel="noreferrer"
              >
                {source.name}
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
            ))}
          </p>
        </details>
      </div>
    </section>
  );
}

function Licences() {
  return (
    <section className="rd-section" aria-labelledby="rd-dp-licences-title">
      <h2 className="rd-h" id="rd-dp-licences-title">
        Licences and attribution
      </h2>
      <p className="rd-note">
        This site is not affiliated with or endorsed by any source. Each entry
        gives the day its licence or terms were checked.
      </p>
      <ul className="rd-panel rd-dp-sources">
        {attributions.map((entry) => (
          <li key={entry.source}>
            <a
              className="rd-dp-link rd-dp-source-name"
              href={entry.url}
              target="_blank"
              rel="noreferrer"
            >
              {entry.source}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <span className="rd-muted rd-dp-kind">
              {entry.material}
              {entry.licence && (
                <>
                  {' · '}
                  <a href={entry.licence.url} target="_blank" rel="noreferrer">
                    {entry.licence.name}
                  </a>
                </>
              )}
              {' · '}Checked {formatDay(entry.checkedAt)}
            </span>
            <p className="rd-dp-coverage">{entry.credit}</p>
            {entry.changes && (
              <p className="rd-dp-coverage rd-muted">
                Changes: {entry.changes}
              </p>
            )}
          </li>
        ))}
        {restrictedAttributions.map((entry) => (
          <li key={entry.source}>
            <a
              className="rd-dp-link rd-dp-source-name"
              href={entry.url}
              target="_blank"
              rel="noreferrer"
            >
              {entry.source}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <span className="rd-muted rd-dp-kind">
              {entry.material}
              {entry.licence && (
                <>
                  {' · '}
                  <a href={entry.licence.url} target="_blank" rel="noreferrer">
                    {entry.licence.name}
                  </a>
                </>
              )}
              {restrictedData.checkedAt &&
                ` · Checked ${formatDay(restrictedData.checkedAt)}`}
            </span>
            <p className="rd-dp-coverage">{entry.credit}</p>
            {entry.changes && (
              <p className="rd-dp-coverage rd-muted">
                Changes: {entry.changes}
              </p>
            )}
          </li>
        ))}
        <li>
          <span className="rd-dp-source-name">Software and fonts</span>
          <p className="rd-dp-coverage">
            <a href="/third-party-licenses.txt">Bundled software licences</a>{' '}
            (React, Lucide, Zod) · Instrument Sans and Newsreader under the{' '}
            <a href="/fonts/instrument-sans.txt">SIL Open Font License 1.1</a>
          </p>
        </li>
      </ul>
    </section>
  );
}

function SourceDocuments() {
  const [query, setQuery] = useState('');
  const visibleSources = allSources.filter((source) =>
    `${source.name} ${source.kind} ${source.coverage}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <section className="rd-section" aria-labelledby="rd-dp-sources-title">
      <h2 className="rd-h" id="rd-dp-sources-title">
        Source documents
      </h2>
      <p className="rd-note">
        The pages the benchmark snapshot, prices, reports and App guide were
        read from. This is a curated snapshot, not a live feed or complete
        census. Each benchmark retains its scale and configurations. Missing
        prices or results are not estimated.
      </p>
      <input
        type="search"
        className="rd-input rd-dp-search"
        aria-label="Search sources"
        name="source-search"
        placeholder="Find a source or topic"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ul className="rd-panel rd-dp-sources">
        {visibleSources.map((source) => (
          <li key={source.url}>
            <a
              className="rd-dp-link rd-dp-source-name"
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              {source.name}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
            <span className="rd-muted rd-dp-kind">{source.kind}</span>
            <p className="rd-dp-coverage">{source.coverage}</p>
            <details className="rd-dp-details">
              <summary>Access & limitations</summary>
              <p>{source.access}</p>
              <p>{source.limitations}</p>
            </details>
          </li>
        ))}
      </ul>
      {visibleSources.length === 0 && (
        <p className="rd-muted">No sources match this search.</p>
      )}
    </section>
  );
}

function Download({ core }: { core: Core | null }) {
  return (
    <section className="rd-section" aria-labelledby="rd-dp-download-title">
      <h2 className="rd-h" id="rd-dp-download-title">
        Download
      </h2>
      <p className="rd-note">
        Public records and their attribution: the benchmark snapshot (models,
        prices, results, reports, sources), every measured record with its job,
        the benchmark definitions and the job list. Practitioner records, quotes
        and restricted results are not included. OpenRouter usage is left out
        because its terms do not allow re-serving it as data; it is published at{' '}
        <a
          href="https://openrouter.ai/rankings"
          target="_blank"
          rel="noreferrer"
        >
          openrouter.ai/rankings
        </a>
        .
      </p>
      <div>
        <button
          type="button"
          className="rd-button"
          disabled={core === null}
          onClick={() => {
            if (core) downloadPublicData(core);
          }}
        >
          <DownloadIcon size={14} aria-hidden="true" />
          Download public data (JSON)
        </button>
      </div>
    </section>
  );
}

export default function DataPage({
  pipeline,
  section,
  coreData,
  filter,
  scope,
}: {
  pipeline: HnPipeline;
  section: 'papers' | null;
  coreData: CoreData;
  filter: FilterBar;
  scope: Scope;
}) {
  const data = useBriefData(coreData);
  const advice = useAdvice();
  return (
    <div className="rd-page rd-dp-page">
      <header className="rd-page-head">
        <h1>Data</h1>
        <p>
          {models.length} model identities.{' '}
          {models.filter((model) => model.pricing).length} models have verified
          API prices. Benchmarks checked {checkedAt}.
        </p>
        <p
          id="data-papers"
          className={section === 'papers' ? 'rd-dp-marked' : undefined}
        >
          arXiv papers were removed on 24 November 2026: on 23 November only 47
          of 408 paper results ranked a current exact model, each from one line
          of an abstract. A controlled study from arXiv is added as a reviewed
          report instead.
        </p>
      </header>
      {data ? (
        <>
          <Sources data={data} advice={advice} />
          <Limits data={data} />
          <Coverage data={data} filter={filter} scope={scope} />
          <Measures data={data} />
          <JobRules data={data} />
        </>
      ) : (
        <RecordsStatus coreData={coreData} />
      )}
      <Collection pipeline={pipeline} />
      <SourceDocuments />
      <Licences />
      <Download core={data ? data.core : null} />
    </div>
  );
}
