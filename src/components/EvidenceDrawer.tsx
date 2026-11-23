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
import { emptyFilter } from '../lib/hn-insights';
import { dollars } from '../lib/metrics';
import type { EvidenceRecord } from '../lib/records';
import { routeHref } from '../lib/route';
import type { HnData } from '../lib/site-data';
import { CommentStream } from './parts';
import './evidence-drawer.css';

// What a count opens: the measured records behind it, or the Hacker News
// comments behind a crowd count or a stated preference.
export type EvidenceSpec = { title: string; note?: string } & (
  | { kind: 'measured'; data: BriefData; records: EvidenceRecord[] }
  | {
      kind: 'comments';
      // Item ids the comments must be among; null for any.
      ids: ReadonlySet<number> | null;
      // A comment-index target key ("model:<id>", "family:<name>"), or null.
      target: string | null;
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
  if (hn.status === 'loading')
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
      filter={{ ...emptyFilter, target: spec.target }}
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
  const [shown, setShown] = useState(pageSize);
  return (
    <div className="rd-records">
      <p className="rd-stream-count" role="status">
        {records.length === 0
          ? 'No records.'
          : `${records.length.toLocaleString()} ${records.length === 1 ? 'record' : 'records'}`}
      </p>
      {records.slice(0, shown).map((record) => (
        <MeasuredRecord key={record.id} data={data} record={record} />
      ))}
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
          Measures: {benchmark.what} ({benchmarkKind(benchmark)})
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
              <a href={routeHref({ view: 'model', key: `model:${model.id}` })}>
                {model.name}
              </a>
            </span>
          ))}
        </p>
      )}
      <p className="rd-note">
        Job: {job ? job.label : 'none'}
        {job &&
          ` · ${record.how === 'keywords' ? `keyword rule ${record.via}` : `source label ${record.via}`}`}
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
