import type { Core } from './core-schema.ts';
import type { Tally } from './hn-insights.ts';

// Hacker News figures for one exact model from core.json, so the App guide
// needs no comment part. core.json counts a label as positive,
// critical, mixed or neutral; the comment index's "unclear" is counted as
// neutral there.

type CoreTally = readonly [number, number, number, number];

export function hnTally(tally: CoreTally): Tally {
  return {
    positive: tally[0],
    negative: tally[1],
    mixed: tally[2],
    neutral: tally[3],
    unclear: 0,
  };
}

const coreTotal = (tally: CoreTally) =>
  tally[0] + tally[1] + tally[2] + tally[3];

// The labels on a target (`model|<id>`) over every job and month: the
// comments that name it.
export function labelTotal(core: Core, key: string) {
  let total = 0;
  for (const months of Object.values(core.crowd.counts[key] ?? {}))
    for (const tally of Object.values(months)) total += coreTotal(tally);
  return total;
}
