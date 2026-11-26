import type { ReactNode } from 'react';
import {
  agrees,
  belowMinimum,
  benchmarkKind,
  costUnit,
  crowdBand,
  crowdCommentIds,
  lineOnlyText,
  measuredBand,
  monthStart,
  plural,
  positiveShare,
  preferredText,
  recordBenchmark,
  recordConfig,
  recordCost,
  recordInterval,
  recordScore,
  scoreText,
  tallyTotal,
  themeTallies,
} from '../lib/brief';
import type { Benchmark, BriefData, BriefFilters, Tally } from '../lib/brief';
import type { CoreData } from '../lib/core-client';
import { hnTally } from '../lib/crowd-totals';
import type { HnTheme } from '../lib/hn-index';
import { themeLabel } from '../lib/hn-insights';
import { dollars } from '../lib/metrics';
import { keyLabel, preferencePairs } from '../lib/model-page';
import { namedBand, outcomeTally } from '../lib/named';
import type { NamedRecord } from '../lib/named';
import type { EvidenceRecord } from '../lib/records';
import { routeHref } from '../lib/route';
import { percent } from '../lib/site-data';
import { EvidenceButton } from './EvidenceDrawer';
import type { EvidenceSpec } from './EvidenceDrawer';
import { ModelTableInfo } from './ModelTableInfo';
import {
  NamedCard,
  namedNote,
  NamedUnavailable,
  OutcomeBar,
  useNamed,
} from './Named';
import { SentimentBar } from './parts';
import './bands.css';

// The evidence bands every view shows for a model in a job: Measured, Named
// and Crowd. A job of null means all jobs.

export type BandContext = {
  data: BriefData;
  filters: BriefFilters;
};
export type BandJob = { id: string | null; label: string };
// A model (`model|<id>`) or a product line (`line|<name>`).
export type BandTarget = { key: string; name: string };

export const allJobs: BandJob = { id: null, label: 'All jobs' };

// Core keys name a line `line|<name>`; the comment index calls it a family.
export const indexKey = (key: string) =>
  key.startsWith('line|') ? `family:${key.slice(5)}` : key.replace('|', ':');

export { hnTally };

export function tallyNote(tally: Tally) {
  const [positive, critical, mixed, neutral] = tally;
  return `${positive} positive, ${critical} critical, ${mixed} mixed, ${neutral} neutral labels. Labels are automatic.`;
}

export function measuredSpec(
  data: BriefData,
  title: string,
  records: EvidenceRecord[],
  note?: string,
): EvidenceSpec {
  return { kind: 'measured', title, note, data, records };
}

export function commentSpec(
  title: string,
  ids: ReadonlySet<number> | null,
  target: string | null,
  since: string,
  note?: string,
  theme: HnTheme | null = null,
): EvidenceSpec {
  return {
    kind: 'comments',
    title,
    note,
    ids,
    target,
    theme,
    from: monthStart(since),
  };
}

// The item ids of stated preferences, which are their comments.
export const preferenceIds = (preferences: readonly { id: string }[]) =>
  new Set(preferences.map((preference) => Number(preference.id.slice(3))));

// Every benchmark in the records, and every restricted one shown to an
// approved account, has a Benchmark page.
export function BenchmarkName({ benchmark }: { benchmark: Benchmark }) {
  return (
    <a href={routeHref({ view: 'benchmark', id: benchmark.id })}>
      {benchmark.name}
    </a>
  );
}

// What a view shows until the records are loaded, or when they cannot be.
export function RecordsStatus({ coreData }: { coreData: CoreData }) {
  return (
    <div className="rd-page">
      {coreData.status === 'failed' ? (
        <p className="rd-alert" role="alert">
          The records could not be loaded.
          {import.meta.env.DEV && (
            <>
              {' '}
              Run <code>npm run records:build</code> and reload.
            </>
          )}
        </p>
      ) : (
        <p className="rd-note">Loading records…</p>
      )}
    </div>
  );
}

export function namedSpec(
  title: string,
  records: NamedRecord[],
  note: string,
): EvidenceSpec {
  return { kind: 'named', title, note, records };
}

// Use records that name the model or line exactly, as cards in the order the
// rules give; records that name only one of a model's lines are counted
// apart. The counts order nothing. Without sign-in, one line says so.
export function NamedBand({
  ctx,
  job,
  target,
  compact = false,
}: {
  ctx: BandContext;
  job: BandJob;
  target: BandTarget;
  // Brief's cards show two records, other views four.
  compact?: boolean;
}) {
  const named = useNamed();
  const { state } = named;
  if (state.status !== 'ready')
    return (
      <div className="rd-band">
        <span>
          <span className="rd-band-chip rd-band-named">Named</span>{' '}
          <NamedUnavailable what="Practitioner records" />
        </span>
      </div>
    );
  if (!ctx.filters.classes.includes('named')) return null;
  const band = namedBand(
    ctx.data,
    state.value,
    target.key,
    job.id,
    ctx.filters,
    named.trusted,
  );
  const line = target.key.startsWith('line|');
  const note = namedNote(state);
  return (
    <div className="rd-band">
      <p className="rd-band-head">
        <span className="rd-band-chip rd-band-named">Named</span>
        <span className="rd-note">
          practitioners’ use records, job by review
        </span>
      </p>
      {band.records.length > 0 ? (
        <>
          <p className="rd-crowd-row">
            <EvidenceButton
              spec={() =>
                namedSpec(
                  `${target.name} · use records · ${job.label}`,
                  band.records,
                  note,
                )
              }
            >
              {`${plural(band.records.length, 'use record')} ${agrees(band.records.length, 'names', 'name')} ${line ? 'only this line' : 'this model'}`}
            </EvidenceButton>
            <OutcomeBar tally={outcomeTally(band.records)} />
          </p>
          <div className="rd-ncards">
            {band.records.slice(0, compact ? 2 : 4).map((record) => (
              <NamedCard key={record.id} record={record} />
            ))}
          </div>
        </>
      ) : (
        <p className="rd-note">
          No use record names {line ? 'only this line' : 'this exact model'}
          {job.id === null ? '' : ' in this job'}.
        </p>
      )}
      {band.lines.map((entry) => (
        <p key={entry.key} className="rd-crowd-row rd-note">
          <EvidenceButton
            spec={() =>
              namedSpec(
                `${entry.name} (any version) · use records · ${job.label}`,
                entry.records,
                `Records that name the product line without a version. They may be about an older model. ${note}`,
              )
            }
          >
            {lineOnlyText(entry.records.length, 'use record', entry.name)}
          </EvidenceButton>
          <OutcomeBar tally={outcomeTally(entry.records)} />
        </p>
      ))}
    </div>
  );
}

export default function Bands({
  ctx,
  job,
  model,
  detail = false,
  compact = false,
  onOpenAll,
}: {
  ctx: BandContext;
  job: BandJob;
  model: { id: string; name: string };
  // The Model page adds themes and preferences by model to the Crowd band.
  detail?: boolean;
  compact?: boolean;
  onOpenAll?: () => void;
}) {
  return (
    <div className="rd-bands">
      {ctx.filters.classes.includes('measured') && (
        <MeasuredBand ctx={ctx} job={job} model={model} />
      )}
      <NamedBand
        ctx={ctx}
        job={job}
        target={{ key: `model|${model.id}`, name: model.name }}
        compact={compact}
      />
      {ctx.filters.classes.includes('crowd') && (
        <CrowdBand
          ctx={ctx}
          job={job}
          target={{ key: `model|${model.id}`, name: model.name }}
          detail={detail}
          onOpenAll={onOpenAll}
        />
      )}
    </div>
  );
}

const shownResults = 4;

export function MeasuredBand({
  ctx,
  job,
  model,
}: {
  ctx: BandContext;
  job: BandJob;
  model: { id: string; name: string };
}) {
  const { results, reports } = measuredBand(
    ctx.data,
    model.id,
    job.id,
    ctx.filters,
  );
  return (
    <div className="rd-band">
      <p className="rd-band-head">
        <span className="rd-band-chip">Measured</span>
        <span className="rd-note">benchmarks, arena ratings and reports</span>
      </p>
      {results.length === 0 ? (
        <p className="rd-note">
          No benchmark result in {job.id === null ? 'the data' : 'this job'}.
        </p>
      ) : (
        <ul className="rd-band-list">
          {results.slice(0, shownResults).map((record) => {
            const benchmark = ctx.data.benchmarkById.get(
              recordBenchmark(record),
            );
            const score = recordScore(record);
            const cost = recordCost(record);
            if (!benchmark || score === null) return null;
            return (
              <li key={record.id}>
                <span className="rd-band-line">
                  <BenchmarkName benchmark={benchmark} />
                  <EvidenceButton
                    spec={() =>
                      measuredSpec(
                        ctx.data,
                        `${model.name} · ${benchmark.name}`,
                        [record],
                      )
                    }
                  >
                    <strong>{scoreText(score, benchmark)}</strong>
                  </EvidenceButton>
                </span>
                <span className="rd-note">
                  {[
                    benchmarkKind(benchmark),
                    recordConfig(record),
                    recordInterval(record).split(' · ')[0],
                    record.date || 'undated',
                    cost === null
                      ? ''
                      : `${dollars(cost)} ${costUnit(benchmark.id)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(results.length > shownResults || reports.length > 0) && (
        <p className="rd-note">
          {results.length > shownResults && (
            <EvidenceButton
              spec={() =>
                measuredSpec(
                  ctx.data,
                  `${model.name} · ${job.label} · results`,
                  results,
                )
              }
            >
              {`All ${results.length} results`}
            </EvidenceButton>
          )}
          {results.length > shownResults && reports.length > 0 && ' · '}
          {reports.length > 0 && (
            <EvidenceButton
              spec={() =>
                measuredSpec(
                  ctx.data,
                  `${model.name} · ${job.label} · reports`,
                  reports,
                )
              }
            >
              {plural(reports.length, 'published report')}
            </EvidenceButton>
          )}
        </p>
      )}
    </div>
  );
}

export function CrowdBand({
  ctx,
  job,
  target,
  detail = false,
  onOpenAll,
}: {
  ctx: BandContext;
  job: BandJob;
  target: BandTarget;
  detail?: boolean;
  onOpenAll?: () => void;
}) {
  const { data, filters } = ctx;
  const since = filters.since;
  const band = crowdBand(data, target.key, job.id, filters);
  const total = tallyTotal(band.tally);
  const share = positiveShare(band.tally);
  const ids = crowdCommentIds(data, job.id, filters.fields);
  const commentKey = indexKey(target.key);
  const scope = job.id === null ? 'in any job' : 'in this job';
  return (
    <div className="rd-band">
      <p className="rd-band-head">
        <span className="rd-band-chip rd-band-crowd">Crowd</span>
        <span className="rd-note">Hacker News, automatic labels</span>
      </p>
      {total > 0 ? (
        <p className="rd-crowd-row">
          <EvidenceButton
            spec={() =>
              commentSpec(
                `${target.name} · Hacker News · ${job.label}`,
                ids,
                commentKey,
                since,
                tallyNote(band.tally),
              )
            }
          >
            {plural(total, 'label')}
          </EvidenceButton>
          <SentimentBar tally={hnTally(band.tally)} />
          <span className="rd-note">
            {share === null
              ? `${belowMinimum('clearLabels')} clear labels`
              : `${percent(share)} positive of clear`}
          </span>
          {onOpenAll && (
            <button type="button" className="rd-link" onClick={onOpenAll}>
              Open all in the thread reader
            </button>
          )}
        </p>
      ) : (
        <p className="rd-note">
          {target.key.startsWith('line|')
            ? `No comment names only this line ${scope}.`
            : `No comment names this exact model ${scope}.`}
        </p>
      )}
      {band.preferences.length > 0 && (
        <p>
          <EvidenceButton
            spec={() =>
              commentSpec(
                `${target.name} · stated preferences · ${job.label}`,
                preferenceIds(band.preferences),
                null,
                since,
                `Comments that say one named model is better than another, where ${target.name} is one of the two. ${band.wins.length} ${agrees(band.wins.length, 'prefers', 'prefer')} it.`,
              )
            }
          >
            {preferredText(band.wins.length, band.preferences.length)}
          </EvidenceButton>
        </p>
      )}
      {detail && band.preferences.length > 0 && (
        <PreferenceTable
          ctx={ctx}
          job={job}
          target={target}
          preferences={band.preferences}
        />
      )}
      {detail && <Themes ctx={ctx} job={job} target={target} ids={ids} />}
      {band.lines.map((line) => (
        <p key={line.key} className="rd-crowd-row rd-note">
          <EvidenceButton
            spec={() =>
              commentSpec(
                `${line.name} (any version) · Hacker News · ${job.label}`,
                ids,
                indexKey(line.key),
                since,
                'Comments that name the product line without a version. They may be about an older model.',
              )
            }
          >
            {lineOnlyText(tallyTotal(line.tally), 'label', line.name)}
          </EvidenceButton>
          <SentimentBar tally={hnTally(line.tally)} />
        </p>
      ))}
    </div>
  );
}

const shownPairs = 8;

function PreferenceTable({
  ctx,
  job,
  target,
  preferences,
}: {
  ctx: BandContext;
  job: BandJob;
  target: BandTarget;
  preferences: Parameters<typeof preferencePairs>[0];
}) {
  const pairs = preferencePairs(preferences, target.key).slice(0, shownPairs);
  const open = (
    title: string,
    rows: readonly { id: string }[],
    count: number,
  ): ReactNode =>
    count === 0 ? (
      <span className="rd-muted">0</span>
    ) : (
      <EvidenceButton
        spec={() =>
          commentSpec(
            `${title} · ${job.label}`,
            preferenceIds(rows),
            null,
            ctx.filters.since,
            'Comments that say one named model is better than the other. Labels are automatic.',
          )
        }
      >
        {count.toLocaleString()}
      </EvidenceButton>
    );
  return (
    <div className="rd-scroll">
      <table className="rd-table rd-band-table">
        <thead>
          <tr>
            <th>Stated preference against</th>
            <th className="rd-num">
              For {target.name}
              {target.key.startsWith('model|') && (
                <ModelTableInfo id={target.key.slice(6)} />
              )}
            </th>
            <th className="rd-num">For the other</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) => {
            const other = keyLabel(ctx.data, pair.other);
            return (
              <tr key={pair.other}>
                <td>
                  {other}
                  {pair.other.startsWith('line|') && (
                    <span className="rd-note"> (line, any version)</span>
                  )}
                  {pair.other.startsWith('model|') && (
                    <ModelTableInfo id={pair.other.slice(6)} />
                  )}
                </td>
                <td className="rd-num">
                  {open(
                    `${target.name} preferred to ${other}`,
                    pair.wins,
                    pair.wins.length,
                  )}
                </td>
                <td className="rd-num">
                  {open(
                    `${other} preferred to ${target.name}`,
                    pair.losses,
                    pair.losses.length,
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const shownThemes = 8;

function Themes({
  ctx,
  job,
  target,
  ids,
}: {
  ctx: BandContext;
  job: BandJob;
  target: BandTarget;
  ids: ReadonlySet<number> | null;
}) {
  const themes = themeTallies(ctx.data, target.key, job.id, ctx.filters).slice(
    0,
    shownThemes,
  );
  if (themes.length === 0) return null;
  return (
    <div className="rd-scroll">
      <table className="rd-table rd-band-table">
        <thead>
          <tr>
            <th>Theme</th>
            <th className="rd-num">Labels</th>
            <th>Sentiment</th>
          </tr>
        </thead>
        <tbody>
          {themes.map(({ theme, tally }) => (
            <tr key={theme}>
              <td>{themeLabel(theme)}</td>
              <td className="rd-num">
                <EvidenceButton
                  spec={() =>
                    commentSpec(
                      `${target.name} · ${themeLabel(theme)} · ${job.label}`,
                      ids,
                      indexKey(target.key),
                      ctx.filters.since,
                      `${tallyNote(tally)} Themes and claims are written by the classifier.`,
                      theme,
                    )
                  }
                >
                  {tallyTotal(tally).toLocaleString()}
                </EvidenceButton>
              </td>
              <td>
                <SentimentBar tally={hnTally(tally)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
