import type { Core } from './core-schema.ts';
import { hnAspects } from './hn-index.ts';
import type { HnAspect } from './hn-index.ts';
import { emptyAspects } from './hn-insights.ts';
import type { Tally } from './hn-insights.ts';

// Hacker News figures for one exact model from core.json, so the Board and
// the App guide need no comment part. core.json counts a label as positive,
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

export type CrowdSummary = {
  total: number;
  tally: Tally;
  // Monday-UTC weeks from core.crowd.weeks.start, as the comment index has them.
  weeks: Tally[];
  aspects: Record<HnAspect, Tally>;
};

// One summary per exact model with labels, by comment-index key
// (`model:<id>`).
export function crowdSummaries(core: Core) {
  const summaries = new Map<string, CrowdSummary>();
  for (const [key, weeks] of Object.entries(core.crowd.weeks.targets)) {
    const tally: Tally = hnTally([0, 0, 0, 0]);
    const tallies = weeks.map(hnTally);
    for (const week of tallies) {
      tally.positive += week.positive;
      tally.negative += week.negative;
      tally.mixed += week.mixed;
      tally.neutral += week.neutral;
    }
    const aspects = emptyAspects();
    const own = core.crowd.aspects[key] ?? {};
    for (const aspect of hnAspects) {
      const counted = own[aspect];
      if (counted) aspects[aspect] = hnTally(counted);
    }
    summaries.set(key.replace('|', ':'), {
      total: weeks.reduce((sum, week) => sum + coreTotal(week), 0),
      tally,
      weeks: tallies,
      aspects,
    });
  }
  return summaries;
}
