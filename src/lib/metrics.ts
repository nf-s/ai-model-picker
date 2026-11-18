import type { BenchmarkResult, ModelRecord } from './schema';

export type HorizontalMetric =
  'benchmarkCost' | 'benchmarkTime' | 'input' | 'output' | 'estimate';

export function ratesForDate(model: ModelRecord, date: string) {
  const pricing = model.pricing;
  return pricing?.nextPricing && date >= pricing.nextPricing.effectiveFrom
    ? pricing.nextPricing
    : pricing;
}

export function getResult(
  results: BenchmarkResult[],
  modelId: string,
  benchmarkId: string,
  chosenId?: string,
): BenchmarkResult | undefined {
  const matching = results.filter(
    (result) =>
      result.modelId === modelId && result.benchmarkId === benchmarkId,
  );
  return matching.find((result) => result.id === chosenId) ?? matching[0];
}

export function estimateCost(
  model: ModelRecord,
  inputTokens: number,
  outputTokens: number,
  date: string,
): number | undefined {
  if (
    !model.pricing ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  )
    return undefined;
  const pricing = model.pricing;
  const contextUsage =
    pricing.contextType === 'input' ? inputTokens : inputTokens + outputTokens;
  if (pricing.contextTokens && contextUsage > pricing.contextTokens)
    return undefined;
  const base = ratesForDate(model, date);
  if (!base) return undefined;
  const long = pricing.longContext;
  const rates =
    long &&
    (long.inclusive
      ? inputTokens >= long.thresholdTokens
      : inputTokens > long.thresholdTokens)
      ? long
      : base;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

export function horizontalValue(
  model: ModelRecord,
  result: BenchmarkResult | undefined,
  metric: HorizontalMetric,
  inputTokens: number,
  outputTokens: number,
  date: string,
): number | undefined {
  if (metric === 'benchmarkCost') return result?.costUsd;
  if (metric === 'benchmarkTime') return result?.timeSeconds;
  if (metric === 'input') return ratesForDate(model, date)?.input;
  if (metric === 'output') return ratesForDate(model, date)?.output;
  return estimateCost(model, inputTokens, outputTokens, date);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(
    value,
  );
}

export function dollars(value: number | undefined): string {
  if (value === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  }).format(value);
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—';
  return seconds >= 60
    ? `${formatNumber(seconds / 60)} min`
    : `${formatNumber(seconds)} sec`;
}

export function axisBounds(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * 0.2, 1);
  return [min - spread * 0.12, max + spread * 0.15];
}
