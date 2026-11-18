import { useEffect, useId, useRef, useState } from 'react';
import { ListFilter, X } from 'lucide-react';
import { models } from '../lib/data';
import {
  emptyModelFilter,
  filterActive,
  includeKey,
  providerName,
  providerOptions,
  scopeLabel,
  scopeNames,
  toggleModel,
  toggleProvider,
} from '../lib/model-filter';
import type { ModelFilter } from '../lib/model-filter';
import { keyName } from '../lib/site-data';
import './model-filter.css';

const options = providerOptions(models);

// The site-wide model filter: a header button that names the current
// selection, a one-click clear, and a panel to choose providers and models.
export default function ModelFilterControl({
  filter,
  onChange,
}: {
  filter: ModelFilter;
  onChange: (next: ModelFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const active = filterActive(filter);
  const label = scopeLabel(filter, models);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('hashchange', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', close);
    };
  }, [open]);

  const wanted = query.trim().toLowerCase();
  const groups = options
    .map((option) => ({
      ...option,
      models: option.models.filter((model) =>
        `${model.name} ${option.label}`.toLowerCase().includes(wanted),
      ),
    }))
    .filter((option) => option.models.length > 0);

  return (
    <div className={active ? 'rd-fl rd-fl-active' : 'rd-fl'} ref={root}>
      <button
        type="button"
        className="rd-fl-toggle"
        ref={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Model filter: ${label}`}
        title={active ? scopeNames(filter, models).join(', ') : undefined}
        onClick={() => setOpen(!open)}
      >
        <ListFilter size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
      {active && (
        <button
          type="button"
          className="rd-fl-clear"
          aria-label="Clear model filter"
          title="Clear model filter"
          onClick={() => onChange(emptyModelFilter)}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
      {open && (
        <div
          className="rd-fl-panel"
          id={panelId}
          role="dialog"
          aria-label="Model filter"
        >
          <div className="rd-fl-head">
            <p>
              {active
                ? `Showing ${scopeNames(filter, models).length === 1 ? 'only ' : ''}${label}`
                : 'Showing all models'}
            </p>
            <button
              type="button"
              className="rd-link"
              disabled={!active}
              onClick={() => onChange(emptyModelFilter)}
            >
              Clear
            </button>
          </div>
          <fieldset>
            <legend className="rd-h">Providers</legend>
            <div className="rd-chips">
              {options.map((option) => (
                <button
                  key={option.provider}
                  type="button"
                  className="rd-chip"
                  aria-pressed={filter.providers.includes(option.provider)}
                  onClick={() =>
                    onChange(toggleProvider(filter, option.provider))
                  }
                >
                  {option.label}
                  <small>{option.models.length}</small>
                </button>
              ))}
            </div>
            <p className="rd-note">
              A provider includes all of its models, also ones added later.
            </p>
          </fieldset>
          <fieldset>
            <legend className="rd-h">Models</legend>
            <input
              className="rd-input"
              type="search"
              placeholder="Find a model"
              aria-label="Find a model"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="rd-fl-list">
              {groups.map((option) => {
                const whole = filter.providers.includes(option.provider);
                return (
                  <div
                    key={option.provider}
                    role="group"
                    aria-label={option.label}
                  >
                    <p className="rd-fl-group">{option.label}</p>
                    {option.models.map((model) => (
                      <label
                        key={model.id}
                        title={whole ? 'Included by its provider' : undefined}
                      >
                        <input
                          type="checkbox"
                          checked={whole || filter.models.includes(model.id)}
                          disabled={whole}
                          onChange={() =>
                            onChange(toggleModel(filter, model.id))
                          }
                        />
                        {model.name}
                      </label>
                    ))}
                  </div>
                );
              })}
              {groups.length === 0 && (
                <p className="rd-note">No model has this name.</p>
              )}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}

// Shown when a direct link opens a model or family the filter leaves out.
export function OutsideFilter({
  target,
  filter,
  onChange,
}: {
  target: string;
  filter: ModelFilter;
  onChange: (next: ModelFilter) => void;
}) {
  const added = includeKey(filter, target, models);
  const providers = added
    ? added.providers.filter((name) => !filter.providers.includes(name))
    : [];
  return (
    <p className="rd-fl-notice" role="status">
      <span>{keyName(target)} is outside the current model filter.</span>
      {added && (
        <button
          type="button"
          className="rd-button"
          onClick={() => onChange(added)}
        >
          {providers.length > 0
            ? `Add ${providers.map(providerName).join(', ')} to the filter`
            : 'Add to the filter'}
        </button>
      )}
      <button
        type="button"
        className="rd-button"
        onClick={() => onChange(emptyModelFilter)}
      >
        Clear the filter
      </button>
    </p>
  );
}

// For ranked tables while a filter hides part of the field.
export function RankNote() {
  return (
    <p className="rd-note">
      Ranks are among all models, not only those in the filter.
    </p>
  );
}
