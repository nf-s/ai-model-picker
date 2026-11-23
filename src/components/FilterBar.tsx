import { monthStart, periodStart } from '../lib/brief';
import type { CoreJob } from '../lib/core-schema';
import {
  basisClasses,
  defaultFilterBar,
  filterBarDefault,
  periods,
  sourceClasses,
  toggleBasis,
  toggleClass,
} from '../lib/model-filter';
import type { FilterBar as Filters, SourceClass } from '../lib/model-filter';
import { basisLabels } from '../lib/named';
import ModelFilterControl from './ModelFilter';
import './filter-bar.css';

const classLabels: Record<SourceClass, string> = {
  measured: 'Measured',
  named: 'Named',
  crowd: 'Crowd',
};

const dayFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
export const formatDay = (day: string) =>
  dayFormat.format(new Date(`${day}T00:00:00Z`));

// One bar for every filter. The job is in the address; the rest is kept in
// this browser. Period, sources, basis and current models apply to Brief,
// Model, Switch, People, Search and Data; the other views use the model
// selection. Named and the basis are enabled only when the named records are
// loaded.
export default function FilterBar({
  filter,
  onChange,
  jobs,
  job,
  jobHref,
  full,
  named,
  end,
}: {
  filter: Filters;
  onChange: (next: Filters) => void;
  jobs: readonly CoreJob[] | null;
  job: string | null;
  // Where choosing a job leads: the same view for that job, or its brief.
  jobHref: (job: string | null) => string;
  full: boolean;
  // The named records are loaded: a signed-in, granted account.
  named: boolean;
  // The last day of the collected evidence; periods count back from it.
  end: string | null;
}) {
  const tops = (jobs ?? []).filter((entry) => entry.parent === undefined);
  const since = end ? periodStart(end, filter.period) : '';
  const available = sourceClasses.filter((cls) => named || cls !== 'named');
  const toggle = (cls: SourceClass) => {
    const next = toggleClass(filter.classes, cls, available);
    if (next) onChange({ ...filter, classes: next });
  };
  return (
    <div className="rd-filterbar" role="group" aria-label="Filters">
      <label className="rd-fb-group">
        <span className="rd-fb-label">Job</span>
        <select
          className="rd-select"
          value={job ?? ''}
          disabled={jobs === null}
          onChange={(event) => {
            window.location.hash = jobHref(event.target.value || null);
          }}
        >
          <option value="">All jobs</option>
          {job !== null && !jobs?.some((entry) => entry.id === job) && (
            <option value={job}>Unknown job</option>
          )}
          {tops.map((top) => [
            <option key={top.id} value={top.id}>
              {top.label}
            </option>,
            ...(jobs ?? [])
              .filter((entry) => entry.parent === top.id)
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`↳ ${entry.label}`}
                </option>
              )),
          ])}
        </select>
      </label>
      <div className="rd-fb-group">
        <span className="rd-fb-label">Models</span>
        <ModelFilterControl
          filter={filter}
          onChange={(next) => onChange({ ...filter, ...next })}
        />
      </div>
      {full && (
        <>
          <label className="rd-fb-group">
            <span className="rd-fb-label">Period</span>
            <select
              className="rd-select"
              value={filter.period}
              onChange={(event) => {
                const period = periods.find(
                  (months) => String(months) === event.target.value,
                );
                if (period !== undefined) onChange({ ...filter, period });
              }}
            >
              {periods.map((months) => (
                <option key={months} value={months}>
                  {months === 0 ? 'All dates' : `Last ${months} months`}
                </option>
              ))}
            </select>
          </label>
          <div className="rd-fb-group" role="group" aria-label="Sources">
            <span className="rd-fb-label">Sources</span>
            <span className="rd-chips">
              {sourceClasses.map((cls) =>
                available.includes(cls) ? (
                  <button
                    key={cls}
                    type="button"
                    className="rd-chip"
                    aria-pressed={filter.classes.includes(cls)}
                    onClick={() => toggle(cls)}
                  >
                    {classLabels[cls]}
                  </button>
                ) : (
                  <button
                    key={cls}
                    type="button"
                    className="rd-chip"
                    aria-pressed={false}
                    disabled
                    title="Practitioner records need sign-in"
                  >
                    {classLabels[cls]} <small>sign-in</small>
                  </button>
                ),
              )}
            </span>
          </div>
          {named && filter.classes.includes('named') && (
            <div
              className="rd-fb-group"
              role="group"
              aria-label="Basis of named records"
              title="Applies to named use records. A secondary source’s “measured” counts as second-hand."
            >
              <span className="rd-fb-label">Basis</span>
              <span className="rd-chips">
                {basisClasses.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className="rd-chip"
                    aria-pressed={filter.basis.includes(entry)}
                    onClick={() => {
                      const next = toggleBasis(filter.basis, entry);
                      if (next) onChange({ ...filter, basis: next });
                    }}
                  >
                    {basisLabels[entry]}
                  </button>
                ))}
              </span>
            </div>
          )}
          <label className="rd-fb-check">
            <input
              type="checkbox"
              checked={filter.current}
              onChange={(event) =>
                onChange({ ...filter, current: event.target.checked })
              }
            />
            Current models only
          </label>
        </>
      )}
      {!filterBarDefault(filter) && (
        <button
          type="button"
          className="rd-link rd-fb-reset"
          onClick={() => onChange(defaultFilterBar)}
        >
          Reset filters
        </button>
      )}
      {full && since && (
        <p className="rd-note rd-fb-period">
          From {formatDay(since)}. Hacker News counts are monthly and start{' '}
          {formatDay(monthStart(since))}.
        </p>
      )}
    </div>
  );
}
