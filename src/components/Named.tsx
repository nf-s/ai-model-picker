import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Access } from '../lib/access';
import type { Tally } from '../lib/brief';
import type { CoreJob } from '../lib/core-schema';
import { fieldsText } from '../lib/fields';
import { noJobTag, tagLabel, tagsOf } from '../lib/job-rules';
import { useNamedData } from '../lib/named-client';
import type { NamedState } from '../lib/named-client';
import {
  basisText,
  outcomeLabels,
  readStoredTrusted,
  toggleTrusted,
  trustedList,
  writeStoredTrusted,
} from '../lib/named';
import type { NamedPerson, NamedRecord, UseRecord } from '../lib/named';
import { lineHref, modelHref, personHref, routeHref } from '../lib/route';
import { browserStorage, percent } from '../lib/site-data';
import './named.css';

// What every Named position reads: the records (for a signed-in, granted
// account or the local dev server), the viewer's trusted people and the job
// names.

export type NamedView = {
  access: Access;
  state: NamedState;
  trusted: string[];
  setTrusted: (next: string[]) => void;
  jobLabel: (id: string) => string;
};

export const NamedContext = createContext<NamedView>({
  access: { kind: 'anonymous' },
  state: { status: 'none' },
  trusted: [],
  setTrusted: () => undefined,
  jobLabel: (id) => id,
});

export function useNamed() {
  return useContext(NamedContext);
}

// Loads the records once for the app and keeps the trusted list in this
// browser. The list starts with the people the data flags as the default.
export function useNamedView(
  access: Access,
  jobs: readonly CoreJob[] | null,
): NamedView {
  const state = useNamedData(access);
  const [stored, setStored] = useState(() =>
    readStoredTrusted(browserStorage()),
  );
  const people = state.status === 'ready' ? state.value.people : null;
  const trusted = useMemo(
    () => (people ? trustedList(stored, people) : []),
    [stored, people],
  );
  const setTrusted = useCallback((next: string[]) => {
    setStored(next);
    writeStoredTrusted(browserStorage(), next);
  }, []);
  const jobLabel = useCallback(
    (id: string) => jobs?.find((job) => job.id === id)?.label ?? id,
    [jobs],
  );
  return useMemo(
    () => ({ access, state, trusted, setTrusted, jobLabel }),
    [access, state, trusted, setTrusted, jobLabel],
  );
}

// How the records were written, for every list of them.
export function namedNote(state: NamedState) {
  const agreement =
    state.status === 'ready' ? state.value.payload.review.jobAgreement : null;
  return `Trusted people first, then first-hand and measured before second-hand and vendor, then newest. Summaries, outcome, basis and job were written by a model review; the quote is the source’s own words.${agreement ? ` The review’s jobs agreed with a reference set ${percent(agreement.share)} of the time (${agreement.check}).` : ''}`;
}

// The line shown wherever named records would be, without them.
export function NamedUnavailable({ what }: { what: string }) {
  const { access, state } = useNamed();
  if (state.status === 'loading')
    return <span className="rd-note">Loading practitioner records…</span>;
  if (state.status === 'failed')
    return (
      <span className="rd-note" role="alert">
        Practitioner records could not be loaded.
        {import.meta.env.DEV && (
          <>
            {' '}
            Run <code>npm run records:build</code> and reload.
          </>
        )}
      </span>
    );
  return (
    <span className="rd-note">
      {what} need sign-in.
      {(access.kind === 'anonymous' || state.status === 'sign-in') && (
        <>
          {' '}
          <a href={routeHref({ view: 'account', error: null })}>Sign in</a>
        </>
      )}
      {access.kind === 'unavailable' &&
        ' The account service could not be reached.'}
    </span>
  );
}

export function StarButton({ name }: { name: string }) {
  const { trusted, setTrusted } = useNamed();
  const on = trusted.includes(name);
  return (
    <button
      type="button"
      className="rd-star"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from trusted people` : `Trust ${name}`}
      title={on ? 'Remove from trusted people' : 'Add to trusted people'}
      onClick={() => setTrusted(toggleTrusted(trusted, name))}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

export function SecondaryTag({ person }: { person: NamedPerson | undefined }) {
  if (person?.sourceClass !== 'secondary') return null;
  return (
    <span
      className="rd-tag"
      title="Secondary source: much of it quotes other people, system cards or survey answers. Its “measured” records are shown as reported figures."
    >
      secondary
    </span>
  );
}

const outcomeClasses = ['positive', 'negative', 'mixed', 'neutral'] as const;
const stanceClass = {
  positive: 'positive',
  critical: 'negative',
  mixed: 'mixed',
  neutral: 'neutral',
} as const;

// The outcomes of a set of use records as one strip.
export function OutcomeBar({ tally }: { tally: Tally }) {
  const total = tally[0] + tally[1] + tally[2] + tally[3];
  if (total === 0) return <span className="rd-bar rd-bar-empty" />;
  const title = outcomeLabels
    .map((label, i) => `${label} ${tally[i] ?? 0}`)
    .join(' · ');
  return (
    <span className="rd-bar" role="img" aria-label={title} title={title}>
      {outcomeClasses.map(
        (cls, i) =>
          (tally[i] ?? 0) > 0 && (
            <i
              key={cls}
              className={`rd-s-${cls}`}
              style={{ flexGrow: tally[i] }}
            />
          ),
      )}
    </span>
  );
}

const comparisonText: Record<string, string> = {
  'this better': 'this one better',
  'other better': 'the other better',
  similar: 'similar',
  mixed: 'mixed',
};

function Names({ record }: { record: UseRecord }) {
  const model = record.keys.find(([key]) => key.startsWith('model|'));
  const written = record.use.named;
  if (model)
    return (
      <>
        Model:{' '}
        <a href={modelHref(model[0].slice(6))}>
          {written || model[0].slice(6)}
        </a>{' '}
        · exact, in the model list
      </>
    );
  if (record.use.exact && written)
    return <>Model: {written} · exact version, not in the model list</>;
  if (record.use.line)
    return (
      <>
        Line only: <a href={lineHref(record.use.line)}>{record.use.line}</a>
        {written && ` (written “${written}”)`} · not attached to an exact model
      </>
    );
  return <>Names no model{written && ` (written “${written}”)`}</>;
}

function Who({ record, extra }: { record: NamedRecord; extra: ReactNode }) {
  const { state } = useNamed();
  const person =
    state.status === 'ready'
      ? state.value.personByName.get(record.person)
      : undefined;
  return (
    <header>
      <StarButton name={record.person} />
      <a href={personHref(record.person)}>
        <strong>{record.person}</strong>
      </a>
      <SecondaryTag person={person} />
      {extra}
      <time>{record.date || 'No date'}</time>
    </header>
  );
}

function Source({ record }: { record: NamedRecord }) {
  return (
    <a href={record.url} target="_blank" rel="noopener noreferrer">
      {record.title || 'Source'}
    </a>
  );
}

export function NamedCard({ record }: { record: NamedRecord }) {
  const { jobLabel } = useNamed();
  if (!('use' in record)) return <AdviceCard record={record} />;
  const setting = [
    record.tool && `Tool: ${record.tool}`,
    record.effort && `Effort: ${record.effort}`,
    record.cond && `Conditions: ${record.cond}`,
  ].filter(Boolean);
  return (
    <article className="rd-record rd-ncard">
      <Who
        record={record}
        extra={
          <span className="rd-ncard-outcome">
            <i className={`rd-s-${stanceClass[record.stance]}`} />
            {record.kind}
          </span>
        }
      />
      <p className="rd-note">
        <Names record={record} />
      </p>
      <p>
        <span className="rd-note">Summary by the review:</span> {record.text}
      </p>
      <blockquote>{record.quote}</blockquote>
      {record.use.task && <p className="rd-note">Task: {record.use.task}</p>}
      {setting.length > 0 && <p className="rd-note">{setting.join(' · ')}</p>}
      {record.use.cmp !== '' && (
        <p className="rd-note">
          Compared with{' '}
          {record.use.cmpId ? (
            <a href={modelHref(record.use.cmpId)}>
              {record.use.cmpNamed || record.use.cmpId}
            </a>
          ) : (
            record.use.cmpNamed || 'another model'
          )}
          : {comparisonText[record.use.cmp] ?? record.use.cmp}
        </p>
      )}
      <p className="rd-note">
        Basis: {basisText(record)} · Job:{' '}
        {record.job
          ? `${jobLabel(record.job)}, by review`
          : record.how === 'pending'
            ? 'none until the next review'
            : record.how === 'tag'
              ? `none: ${tagLabel(noJobTag(tagsOf(record)))} (review gave ${jobLabel(record.via.slice(record.via.indexOf(':') + 1))})`
              : 'none, by review'}
        {fieldsText(record)}
        {(record.use.tags ?? []).map((tag) => ` · ${tagLabel(tag)}`)} ·{' '}
        <Source record={record} />
      </p>
    </article>
  );
}

export function AdviceCard({ record }: { record: NamedRecord }) {
  const { jobLabel } = useNamed();
  return (
    <article className="rd-record rd-ncard">
      <Who
        record={record}
        extra={<span className="rd-note">method advice</span>}
      />
      <p>
        <span className="rd-note">Summary by the review:</span> {record.text}
      </p>
      {record.quote && <blockquote>{record.quote}</blockquote>}
      <p className="rd-note">
        {record.tool && `Tool: ${record.tool} · `}Applies to:{' '}
        {record.job ? `${jobLabel(record.job)}, by review` : 'any job'} ·{' '}
        <Source record={record} />
      </p>
    </article>
  );
}
