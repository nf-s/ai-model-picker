import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import {
  benchmarkKind,
  costUnit,
  recordBenchmark,
  recordConfig,
  recordCost,
  recordInterval,
  recordRank,
  recordTrials,
} from '../lib/brief';
import type { BriefData } from '../lib/brief';
import { fieldsText } from '../lib/fields';
import type { HnTheme } from '../lib/hn-index';
import { emptyFilter } from '../lib/hn-insights';
import { dollars } from '../lib/metrics';
import type { NamedRecord } from '../lib/named';
import type { EvidenceRecord } from '../lib/records';
import { lineHref, modelHref, routeHref } from '../lib/route';
import type { HnData } from '../lib/site-data';
import { NamedCard } from './Named';
import { CommentStream } from './parts';
import './evidence-drawer.css';

// What a count opens: the measured records behind it, the named records
// (in the order the band shows them), Hacker News records as the search
// index holds them, or the Hacker News comments behind a crowd count or a
// stated preference.
export type EvidenceSpec = { title: string; note?: string } & (
  | { kind: 'measured'; data: BriefData; records: EvidenceRecord[] }
  | { kind: 'crowd'; data: BriefData; records: EvidenceRecord[] }
  | { kind: 'named'; records: NamedRecord[] }
  | {
      kind: 'comments';
      // Item ids the comments must be among; null for any.
      ids: ReadonlySet<number> | null;
      // A comment-index target key ("model:<id>", "family:<name>"), or null.
      target: string | null;
      // A theme the target's label must carry, or null.
      theme: HnTheme | null;
      // First day of the period, or '' for all dates.
      from: string;
    }
);

export const EvidenceContext = createContext<(spec: EvidenceSpec) => void>(
  () => undefined,
);

export function useEvidence() {
  return useContext(EvidenceContext);
}

// A count that opens its records.
export function EvidenceButton({
  spec,
  children,
}: {
  spec: () => EvidenceSpec;
  children: ReactNode;
}) {
  const open = useEvidence();
  return (
    <button
      type="button"
      className="rd-link rd-evidence"
      onClick={() => open(spec())}
    >
      {children}
    </button>
  );
}

const pageSize = 40;

export default function EvidenceDrawer({
  spec,
  hn,
  onClose,
}: {
  spec: EvidenceSpec;
  hn: HnData;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', onClose);
    return () => {
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', onClose);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <>
      <div className="rd-drawer-backdrop" onClick={onClose} />
      <aside
        className="rd-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="rd-drawer-head">
          <h2 id={titleId}>{spec.title}</h2>
          <button
            type="button"
            className="rd-button"
            ref={close}
            onClick={onClose}
          >
            <X size={13} aria-hidden="true" />
            Close
          </button>
        </header>
        <div className="rd-drawer-body">
          {spec.note && <p className="rd-note">{spec.note}</p>}
          {spec.kind === 'measured' ? (
            <MeasuredList data={spec.data} records={spec.records} />
          ) : spec.kind === 'crowd' ? (
            <RecordPages
              records={spec.records}
              render={(record) => (
                <CrowdRecord key={record.id} data={spec.data} record={record} />
              )}
            />
          ) : spec.kind === 'named' ? (
            <RecordPages
              records={spec.records}
              render={(record) => <NamedCard key={record.id} record={record} />}
            />
          ) : (
            <CommentList spec={spec} hn={hn} />
          )}
        </div>
      </aside>
    </>
  );
}

function CommentList({
  spec,
  hn,
}: {
  spec: Extract<EvidenceSpec, { kind: 'comments' }>;
  hn: HnData;
}) {
  if (hn.status === 'loading' || hn.status === 'idle')
    return <p className="rd-note">Loading Hacker News comments…</p>;
  if (hn.status === 'failed')
    return (
      <p className="rd-note">
        The comment index could not be loaded, so the comments cannot be listed.
      </p>
    );
  const index = {
    ...hn.index,
    rows: hn.index.rows.filter(
      (row) =>
        (spec.ids === null || spec.ids.has(row.id)) &&
        (spec.from === '' || row.createdAt >= spec.from),
    ),
  };
  return (
    <CommentStream
      index={index}
      filter={{ ...emptyFilter, target: spec.target, theme: spec.theme }}
      focusKey={spec.target}
    />
  );
}

function MeasuredList({
  data,
  records,
}: {
  data: BriefData;
  records: EvidenceRecord[];
}) {
  return (
    <RecordPages
      records={records}
      render={(record) => (
        <MeasuredRecord key={record.id} data={data} record={record} />
      )}
    />
  );
}

function RecordPages<T extends { id: string }>({
  records,
  render,
}: {
  records: T[];
  render: (record: T) => ReactNode;
}) {
  const [shown, setShown] = useState(pageSize);
  return (
    <div className="rd-records">
      <p className="rd-stream-count" role="status">
        {records.length === 0
          ? 'No records.'
          : `${records.length.toLocaleString()} ${records.length === 1 ? 'record' : 'records'}`}
      </p>
      {records.slice(0, shown).map(render)}
      {records.length > shown && (
        <button
          type="button"
          className="rd-more"
          onClick={() => setShown(shown + pageSize)}
        >
          Show {Math.min(pageSize, records.length - shown)} more
        </button>
      )}
    </div>
  );
}

const sourceLabels: Record<string, string> = {
  benchmark: 'Benchmark result',
  arena: 'Arena rating',
  report: 'Published report',
};

function MeasuredRecord({
  data,
  record,
}: {
  data: BriefData;
  record: EvidenceRecord;
}) {
  const benchmark = data.benchmarkById.get(recordBenchmark(record));
  const cost = recordCost(record);
  const trials = recordTrials(record);
  const rank = recordRank(record);
  const details = benchmark
    ? [
        recordConfig(record),
        recordInterval(record),
        trials === null
          ? ''
          : `${trials.toLocaleString()} ${benchmark.scale === 'rating' ? 'votes' : 'trials'}`,
        rank === null ? '' : `rank ${rank} on this leaderboard`,
        cost === null ? '' : `${dollars(cost)} ${costUnit(benchmark.id)}`,
      ].filter(Boolean)
    : [];
  const models = record.keys.flatMap(([key]) => {
    const model = key.startsWith('model|')
      ? data.modelById.get(key.slice(6))
      : undefined;
    return model ? [model] : [];
  });
  const job = data.jobById.get(record.job);
  return (
    <article className="rd-record">
      <header>
        <span className="rd-band-chip">Measured</span>
        <span>{sourceLabels[record.src] ?? record.src}</span>
        <time>{record.date || 'No date'}</time>
      </header>
      <p>{record.text}</p>
      {benchmark && (
        <p className="rd-note">
          <a href={routeHref({ view: 'benchmark', id: benchmark.id })}>
            {benchmark.name}
          </a>{' '}
          measures: {benchmark.what} ({benchmarkKind(benchmark)})
        </p>
      )}
      {details.length > 0 && <p className="rd-note">{details.join(' · ')}</p>}
      {record.cond && <p className="rd-note">Conditions: {record.cond}</p>}
      {models.length > 0 && (
        <p className="rd-note">
          Names:{' '}
          {models.map((model, i) => (
            <span key={model.id}>
              {i > 0 && ', '}
              <a href={modelHref(model.id)}>{model.name}</a>
            </span>
          ))}
        </p>
      )}
      <p className="rd-note">
        Job:{' '}
        {job
          ? job.label
          : record.how === 'pending'
            ? `none until the next review (source label ${record.via})`
            : 'none'}
        {job &&
          ` · ${record.how === 'keywords' ? `keyword rule ${record.via}` : `source label ${record.via}`}`}
        {fieldsText(record)}
        {record.checked && ` · checked ${record.checked}`}
      </p>
      <p className="rd-note">
        <a href={record.url} target="_blank" rel="noopener noreferrer">
          {record.title || 'Source'}
        </a>
        {benchmark?.attribution && ` · ${benchmark.attribution}`}
      </p>
    </article>
  );
}

// One Hacker News comment's labels, without its text: the classifier's
// one-sentence claim, the targets it labelled and the story it is under.
function CrowdRecord({
  data,
  record,
}: {
  data: BriefData;
  record: EvidenceRecord;
}) {
  const job = data.jobById.get(record.job);
  return (
    <article className="rd-record">
      <header>
        <span className="rd-band-chip rd-band-crowd">Crowd</span>
        <span>Hacker News comment</span>
        <time>{record.date || 'No date'}</time>
      </header>
      <p>{record.text || 'No claim recorded.'}</p>
      <p className="rd-note">Claim written by the classifier.</p>
      <p className="rd-note">
        Labels:{' '}
        {record.keys.map(([key, stance], i) => {
          const at = key.indexOf('|');
          const kind = key.slice(0, at);
          const value = key.slice(at + 1);
          const model = kind === 'model' ? data.modelById.get(value) : null;
          return (
            <span key={key}>
              {i > 0 && ', '}
              <a href={model ? modelHref(model.id) : lineHref(value)}>
                {model ? model.name : value}
              </a>{' '}
              ({kind === 'line' ? `product line, ${stance}` : stance})
            </span>
          );
        })}
      </p>
      <p className="rd-note">
        Job:{' '}
        {job
          ? job.label
          : record.how === 'pending'
            ? `none until the next review (source label ${record.via})`
            : 'none'}
        {job && ` · source label ${record.via}`}
        {fieldsText(record)}
      </p>
      <p className="rd-note">
        <a href={record.url} target="_blank" rel="noopener noreferrer">
          {record.title || 'Open on Hacker News'}
        </a>
      </p>
    </article>
  );
}
