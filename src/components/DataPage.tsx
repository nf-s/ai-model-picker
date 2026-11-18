import { useState } from 'react';
import { ArrowUpRight, Download, RefreshCw } from 'lucide-react';
import {
  benchmarks,
  checkedAt,
  downloadSnapshot,
  models,
  reports,
  results,
  restrictedAttributions,
  sources,
} from '../lib/data';
import { attributionCheckedAt, attributions } from '../lib/attribution';
import { guide } from '../lib/guide';
import { formatHnRange, hnClassifierCheck, hnSources } from '../lib/hn-client';
import type { HnPipeline } from '../lib/hn-client';
import { hnPublished } from '../lib/hn-published';
import { routeHref } from '../lib/route';
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
        <a
          className="rd-dp-link"
          href={routeHref({ view: 'discussion', key: null })}
        >
          Browse comments
        </a>
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
            The scan stopped before completion.{' '}
            {external
              ? 'Running it again from a terminal resumes from its checkpoint.'
              : 'Retry resumes from its checkpoint.'}{' '}
            {status.reason && <span>{status.reason}.</span>}
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
              <dd>{external ? 'Not tracked here' : '$0'}</dd>
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
                including {hnClassifierCheck.oppositePolarity} opposite
                positive/negative labels. {hnClassifierCheck.unclear} were
                unclear and {hnClassifierCheck.targetMissed} targets were
                missed.
                {hnClassifierCheck.failed > 0 && (
                  <> {hnClassifierCheck.failed} classifications failed.</>
                )}
              </p>
              <p>
                The reference uses fuller context and has no independent human
                validation. Read the original comments before using a label to
                choose a model.
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
                A text filter identifies model and app mentions. The classifier
                reads short, privacy-masked windows around each mention. It can
                miss comments without recognizable names and replies that depend
                on discussion context. Archived records reflect a source
                snapshot.
              </p>
              <p>
                Unspecified versions are kept as family feedback. Unresolved
                classifier failures are tracked separately and retried. They do
                not become sentiment evidence.
              </p>
            </div>
            <div className="rd-dp-block">
              <h3>{hnPublished ? 'Published data' : 'On this computer'}</h3>
              {!hnPublished && (
                <p>
                  The quantized model uses local compute and electricity.
                  Initial setup downloads about{' '}
                  {hnClassifierCheck.downloadGigabytes} GB of model files.
                </p>
              )}
              <p>
                {hnPublished
                  ? 'The snapshot contains IDs, timestamps and classifications.'
                  : 'Comment bodies are processed in memory. Saved data contains IDs, timestamps, classifications and checkpoints.'}{' '}
                The reader loads original wording from Hacker News as you
                browse. Parent context and replies can extend beyond the scan
                dates.
              </p>
              <p>
                {!hnPublished &&
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
        Checked {attributionCheckedAt}. This site is not affiliated with or
        endorsed by any source.
      </p>
      <ul className="rd-panel rd-dp-sources">
        {[...attributions, ...restrictedAttributions].map((entry) => (
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

export default function DataPage({ pipeline }: { pipeline: HnPipeline }) {
  const [query, setQuery] = useState('');
  const visibleSources = allSources.filter((source) =>
    `${source.name} ${source.kind} ${source.coverage}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="rd-page">
      <header className="rd-page-head">
        <h1>Data</h1>
        <p>
          {models.length} model identities · {benchmarks.length} benchmarks ·{' '}
          {results.length} published results · {reports.length} reports.{' '}
          {models.filter((model) => model.pricing).length} models have verified
          API prices. Benchmarks checked {checkedAt}
        </p>
      </header>
      <Collection pipeline={pipeline} />
      <section className="rd-section" aria-labelledby="rd-dp-sources-title">
        <h2 className="rd-h" id="rd-dp-sources-title">
          Sources and coverage
        </h2>
        <p className="rd-note">
          This is a curated snapshot, not a live feed or complete census. Each
          benchmark retains its scale and configurations. Missing prices or
          results are not estimated.
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
      <Licences />
      <section className="rd-section" aria-labelledby="rd-dp-download-title">
        <h2 className="rd-h" id="rd-dp-download-title">
          Download
        </h2>
        <div>
          <button
            type="button"
            className="rd-button"
            onClick={downloadSnapshot}
          >
            <Download size={14} aria-hidden="true" />
            Download sourced data (JSON)
          </button>
        </div>
      </section>
    </div>
  );
}
