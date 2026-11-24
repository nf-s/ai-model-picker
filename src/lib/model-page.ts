import {
  crowdTally,
  inPool,
  lineKey,
  measuredBand,
  modelKey,
  positiveShare,
  tallyTotal,
} from './brief.ts';
import type { BriefData, BriefFilters, Tally } from './brief.ts';
import type {
  CoreJob,
  CoreModel,
  CoreUsage,
  Preference,
} from './core-schema.ts';
import { namedFor } from './named.ts';
import type { NamedIndex, UseRecord } from './named.ts';
import type { EvidenceRecord } from './records.ts';
import type { ModelTarget } from './route.ts';

// What the Model page shows for one exact model or one product line. A line
// page holds only the records that name the line without a version; they are
// never added to a model's counts.

export type Line = { name: string; models: string[] };
export type PageTarget =
  | { kind: 'model'; key: string; name: string; model: CoreModel }
  | { kind: 'line'; key: string; name: string; line: Line };

// The page's target, or null when the data has no such model or line. An
// unknown id is reported, never swapped for another model.
export function findTarget(
  data: BriefData,
  target: ModelTarget,
): PageTarget | null {
  if (target.kind === 'model') {
    const model = data.modelById.get(target.id);
    return model
      ? { kind: 'model', key: modelKey(model.id), name: model.name, model }
      : null;
  }
  const line = data.core.lines.find((entry) => entry.name === target.name);
  return line
    ? { kind: 'line', key: lineKey(line.name), name: line.name, line }
    : null;
}

// The product lines whose name a model's name contains.
export function linesOf(data: BriefData, modelId: string) {
  return data.core.lines.filter((line) => line.models.includes(modelId));
}

export function lineModels(data: BriefData, line: Line) {
  return line.models.flatMap((id) => data.modelById.get(id) ?? []);
}

export type JobEvidence = {
  // null for all jobs; a job with id '' for records with no job.
  job: CoreJob | null;
  measured: EvidenceRecord[];
  // Use records that name the target exactly, by the job the review gave
  // them; empty without sign-in.
  named: UseRecord[];
  tally: Tally;
  share: number | null;
};

export const noJob: CoreJob = {
  id: '',
  label: 'No job assigned',
  benchmarks: [],
};

// Measured records, named use records and Hacker News labels for every job,
// with the same rules as the bands, so a row's counts equal the bands for
// that job. A parent job includes its sub-jobs. Jobs with nothing are left
// out; all jobs is always listed first.
export function evidenceByJob(
  data: BriefData,
  target: PageTarget,
  filters: BriefFilters,
  named: { index: NamedIndex; trusted: readonly string[] } | null = null,
): JobEvidence[] {
  const row = (job: CoreJob | null): JobEvidence => {
    const id = job === null ? null : job.id;
    const band =
      target.kind === 'model' && filters.classes.includes('measured')
        ? measuredBand(data, target.model.id, id, filters)
        : { results: [], reports: [] };
    const tally: Tally = filters.classes.includes('crowd')
      ? crowdTally(data, target.key, id, filters)
      : [0, 0, 0, 0];
    return {
      job,
      measured: [...band.results, ...band.reports],
      named: named
        ? namedFor(data, named.index, target.key, id, filters, named.trusted)
        : [],
      tally,
      share: positiveShare(tally),
    };
  };
  return [null, ...data.jobs, noJob]
    .map(row)
    .filter(
      (entry) =>
        entry.job === null ||
        entry.measured.length > 0 ||
        entry.named.length > 0 ||
        tallyTotal(entry.tally) > 0,
    );
}

export type PreferencePair = {
  other: string;
  // Comments that prefer the page's target over the other, and the reverse.
  wins: Preference[];
  losses: Preference[];
};

// Stated preferences of a target, by the other side, most comments first.
export function preferencePairs(
  preferences: readonly Preference[],
  key: string,
): PreferencePair[] {
  const pairs = new Map<string, PreferencePair>();
  for (const preference of preferences) {
    const won = preference.winner === key;
    const other = won ? preference.loser : preference.winner;
    if (!won && preference.loser !== key) continue;
    const pair = pairs.get(other) ?? { other, wins: [], losses: [] };
    (won ? pair.wins : pair.losses).push(preference);
    pairs.set(other, pair);
  }
  return [...pairs.values()].sort(
    (a, b) =>
      b.wins.length + b.losses.length - (a.wins.length + a.losses.length) ||
      a.other.localeCompare(b.other),
  );
}

// A name for any target key in the data.
export function keyLabel(data: BriefData, key: string) {
  if (key.startsWith('model|'))
    return data.modelById.get(key.slice(6))?.name ?? key.slice(6);
  return key.slice(key.indexOf('|') + 1);
}

// What a record is about: the models and product lines its keys name, not
// the story a comment sits under.
export function recordSubject(
  data: BriefData,
  record: Pick<EvidenceRecord, 'keys'>,
) {
  return record.keys.map(([key]) => keyLabel(data, key)).join(', ');
}

export type UsageLine = {
  tokens: CoreUsage['tokens']['models'][number] | null;
  tags: { tag: string; label: string; job: string; share: number }[];
};

// The model's OpenRouter usage: its 30-day token share and the task tags
// where it is in the published top 10. Null when it is in neither list:
// outside a top list shows nothing, not zero.
export function usageLine(usage: CoreUsage, modelId: string): UsageLine | null {
  const tokens =
    usage.tokens.models.find((entry) => entry.modelId === modelId) ?? null;
  const tags = usage.tasks.tags.flatMap((tag) => {
    const top = tag.top.find((entry) => entry.modelId === modelId);
    return top
      ? [{ tag: tag.tag, label: tag.label, job: tag.job, share: top.share }]
      : [];
  });
  return tokens === null && tags.length === 0 ? null : { tokens, tags };
}

// Models to compare with: those in the filters, without the page's own.
export function compareOptions(
  data: BriefData,
  filters: BriefFilters,
  modelId: string,
) {
  return data.models
    .filter((model) => model.id !== modelId && inPool(model, filters))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The model list: models in the filters by provider, then name.
export function modelList(data: BriefData, filters: BriefFilters) {
  return data.models
    .filter((model) => inPool(model, filters))
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
    );
}
