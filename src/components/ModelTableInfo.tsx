import { checkedAt } from '../lib/data';
import { ratesForDate } from '../lib/metrics';
import { modelById } from '../lib/site-data';
import './model-table-info.css';

// Token rates can be fractions of a cent even on a per-million basis.
const { format: tokenRate } = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 8,
});

function rates(input: number, output: number) {
  return `${tokenRate(input)} in · ${tokenRate(output)} out`;
}

/** Only exact API model IDs have model facts. A line or product label may
 * cover several models with different prices. */
export function ModelTableInfo({
  id,
  ratesShown = false,
}: {
  id: string;
  ratesShown?: boolean;
}) {
  const model = modelById.get(id);
  if (!model) return null;
  const pricing = model.pricing;
  const base = ratesForDate(model, checkedAt);
  const standard = base
    ? rates(base.input, base.output)
    : 'No verified API price';
  const long = pricing?.longContext;
  const offPeak = pricing?.offPeak;
  const next = pricing?.nextPricing;
  return (
    <details className="rd-model-table-info">
      <summary>
        {ratesShown
          ? 'Model details'
          : base
            ? `${standard} / 1M tokens`
            : standard}
      </summary>
      <dl>
        <dt>Provider</dt>
        <dd>{model.provider}</dd>
        {model.description && (
          <>
            <dt>Model</dt>
            <dd>{model.description}</dd>
          </>
        )}
        {model.apiId && (
          <>
            <dt>API ID</dt>
            <dd>{model.apiId}</dd>
          </>
        )}
        {model.version && (
          <>
            <dt>Version</dt>
            <dd>{model.version}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{model.status || 'Unlisted'}</dd>
        <dt>Context window</dt>
        <dd>
          {pricing?.contextTokens
            ? `${pricing.contextTokens.toLocaleString('en-US')} ${pricing.contextType === 'input' ? 'input tokens' : 'tokens total'}`
            : 'Unlisted'}
        </dd>
        {pricing && base && (
          <>
            <dt>USD / 1M tokens</dt>
            <dd>{standard}</dd>
            {base.cachedInput !== undefined && (
              <>
                <dt>Cached input</dt>
                <dd>{tokenRate(base.cachedInput)} / 1M tokens</dd>
              </>
            )}
            {long && (
              <>
                <dt>Long context</dt>
                <dd>
                  {rates(long.input, long.output)} / 1M tokens when input{' '}
                  {long.inclusive ? 'reaches' : 'exceeds'}{' '}
                  {long.thresholdTokens.toLocaleString('en-US')} tokens
                  {long.cachedInput !== undefined &&
                    ` · ${tokenRate(long.cachedInput)} cached input`}
                </dd>
              </>
            )}
            {offPeak && (
              <>
                <dt>Off-peak</dt>
                <dd>
                  {rates(offPeak.input, offPeak.output)} / 1M tokens
                  {offPeak.cachedInput !== undefined &&
                    ` · ${tokenRate(offPeak.cachedInput)} cached input`}
                </dd>
              </>
            )}
            {next && next.effectiveFrom > checkedAt && (
              <>
                <dt>From {next.effectiveFrom}</dt>
                <dd>
                  {rates(next.input, next.output)} / 1M tokens
                  {next.cachedInput !== undefined &&
                    ` · ${tokenRate(next.cachedInput)} cached input`}
                </dd>
              </>
            )}
            <dt>Terms</dt>
            <dd>{pricing.notes}</dd>
            <dt>Source</dt>
            <dd>
              <a href={pricing.url} target="_blank" rel="noreferrer">
                Provider pricing
              </a>{' '}
              · checked {checkedAt}
              {pricing.modelUrl !== pricing.url && (
                <>
                  {' '}
                  ·{' '}
                  <a href={pricing.modelUrl} target="_blank" rel="noreferrer">
                    Model documentation
                  </a>
                </>
              )}
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}
