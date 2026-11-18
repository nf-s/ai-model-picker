import {
  arxivAreaSchema,
  arxivKindSchema,
  arxivTopicSchema,
} from './arxiv-schema.ts';
import type {
  ArxivArea,
  ArxivKind,
  ArxivPaper,
  ArxivResult,
  ArxivTopic,
} from './arxiv-schema.ts';
import { targetKey } from './hn-insights.ts';
import type { TargetRef } from './hn-insights.ts';

export type PaperKind = ArxivKind | 'unlabelled';
export type PaperFilter = {
  // A target key such as `model:<id>` or `family:<name>`.
  target: string | null;
  kind: PaperKind | null;
  topic: ArxivTopic | null;
  // Only papers whose evaluation result is in this area.
  area: ArxivArea | null;
  query: string;
};
export type LabelCounts = {
  kinds: Record<PaperKind, number>;
  topics: Record<ArxivTopic, number>;
  // Papers with an evaluation result, per area.
  areas: Record<ArxivArea, number>;
};
export type TargetSummary = TargetRef & { key: string; papers: number };
// How one paper's result reports a target it names.
export type Standing = 'best' | 'weak' | 'unranked';
// `papers` counts every paper with a result that names the target, including
// those reporting it as best or weak.
export type ResultTally = { papers: number; best: number; weak: number };
export type AreaTallies = Record<ArxivArea | 'all', ResultTally>;
export type TargetResult = {
  paper: ArxivPaper;
  result: ArxivResult;
  standing: Standing;
};

export const paperKinds = arxivKindSchema.options;
export const paperTopics = arxivTopicSchema.options;
export const paperAreas = arxivAreaSchema.options;
export const areaLabels: Record<ArxivArea, string> = {
  coding: 'Coding',
  agents: 'Agents',
  reasoning: 'Reasoning',
  research: 'Research',
  writing: 'Writing',
  design: 'Design',
  vision: 'Vision',
  domain: 'Specialist domains',
  safety: 'Safety',
  other: 'Other',
};
// An unranked target carries no tag. A `weak` target is one the abstract
// places behind the paper's best model, which is often the runner-up.
export const standingLabels: Record<Exclude<Standing, 'unranked'>, string> = {
  best: 'Best',
  weak: 'Behind',
};
export const paperPageSize = 50;
export const emptyPaperFilter: PaperFilter = {
  target: null,
  kind: null,
  topic: null,
  area: null,
  query: '',
};
// arXiv dates are UTC.
export const paperDayFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const standingOrder: Standing[] = ['best', 'weak', 'unranked'];

function emptyKinds(): Record<ArxivKind, number> {
  return {
    usage: 0,
    evaluation: 0,
    application: 0,
    behaviour: 0,
    release: 0,
    survey: 0,
    other: 0,
  };
}

// Newest-first order is kept. Every search term must appear in the title.
export function filterPapers(
  papers: readonly ArxivPaper[],
  filter: PaperFilter,
) {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return papers.filter((paper) => {
    const { assessment } = paper;
    if (
      filter.target &&
      !paper.targets.some((ref) => targetKey(ref) === filter.target)
    )
      return false;
    if (filter.kind === 'unlabelled' && assessment !== null) return false;
    if (
      filter.kind &&
      filter.kind !== 'unlabelled' &&
      assessment?.kind !== filter.kind
    )
      return false;
    if (filter.topic && !assessment?.topics.includes(filter.topic))
      return false;
    if (filter.area && paper.result?.area !== filter.area) return false;
    const title = paper.title.toLowerCase();
    return terms.every((term) => title.includes(term));
  });
}

function emptyTopics(): Record<ArxivTopic, number> {
  return {
    prompting: 0,
    context: 0,
    reasoning: 0,
    agents: 0,
    tools: 0,
    retrieval: 0,
    'structured-output': 0,
    coding: 0,
    cost: 0,
    safety: 0,
    multimodal: 0,
    'fine-tuning': 0,
  };
}

function emptyAreas(): Record<ArxivArea, number> {
  return {
    coding: 0,
    agents: 0,
    reasoning: 0,
    research: 0,
    writing: 0,
    design: 0,
    vision: 0,
    domain: 0,
    safety: 0,
    other: 0,
  };
}

export function countLabels(papers: readonly ArxivPaper[]): LabelCounts {
  const kinds: Record<PaperKind, number> = { ...emptyKinds(), unlabelled: 0 };
  const topics = emptyTopics();
  const areas = emptyAreas();
  for (const { assessment, result } of papers) {
    kinds[assessment ? assessment.kind : 'unlabelled'] += 1;
    for (const topic of assessment?.topics ?? []) topics[topic] += 1;
    if (result) areas[result.area] += 1;
  }
  return { kinds, topics, areas };
}

// Null when the paper has no result or does not name the target.
export function paperStanding(paper: ArxivPaper, key: string): Standing | null {
  const names = (refs: readonly TargetRef[]) =>
    refs.some((ref) => targetKey(ref) === key);
  const { result } = paper;
  if (!result || !names(paper.targets)) return null;
  if (names(result.best)) return 'best';
  if (names(result.weak)) return 'weak';
  return 'unranked';
}

function emptyTally(): ResultTally {
  return { papers: 0, best: 0, weak: 0 };
}

function emptyAreaTallies(): AreaTallies {
  return {
    all: emptyTally(),
    coding: emptyTally(),
    agents: emptyTally(),
    reasoning: emptyTally(),
    research: emptyTally(),
    writing: emptyTally(),
    design: emptyTally(),
    vision: emptyTally(),
    domain: emptyTally(),
    safety: emptyTally(),
    other: emptyTally(),
  };
}

// Result counts per target key, per area and over all areas.
export function tallyResults(papers: readonly ArxivPaper[]) {
  const tallies = new Map<string, AreaTallies>();
  for (const paper of papers) {
    if (!paper.result) continue;
    const { area } = paper.result;
    for (const ref of paper.targets) {
      const key = targetKey(ref);
      const standing = paperStanding(paper, key);
      if (!standing) continue;
      let row = tallies.get(key);
      if (!row) {
        row = emptyAreaTallies();
        tallies.set(key, row);
      }
      for (const tally of [row[area], row.all]) {
        tally.papers += 1;
        if (standing !== 'unranked') tally[standing] += 1;
      }
    }
  }
  return tallies;
}

// Papers with a result that name the target: best, then weak, then unranked,
// newest first within each.
export function targetResults(
  papers: readonly ArxivPaper[],
  key: string,
): TargetResult[] {
  return papers
    .flatMap((paper) => {
      const { result } = paper;
      const standing = paperStanding(paper, key);
      return result && standing ? [{ paper, result, standing }] : [];
    })
    .sort(
      (a, b) =>
        standingOrder.indexOf(a.standing) - standingOrder.indexOf(b.standing) ||
        Date.parse(b.paper.submittedAt) - Date.parse(a.paper.submittedAt),
    );
}

// One row per model or family named in `papers`, most papers first.
export function summariseTargets(papers: readonly ArxivPaper[]) {
  const rows = new Map<string, TargetSummary>();
  for (const paper of papers)
    for (const ref of paper.targets) {
      const key = targetKey(ref);
      let row = rows.get(key);
      if (!row) {
        row = { ...ref, key, papers: 0 };
        rows.set(key, row);
      }
      row.papers += 1;
    }
  return [...rows.values()].sort(
    (a, b) => b.papers - a.papers || a.target.localeCompare(b.target),
  );
}

export function pageCount(total: number, size = paperPageSize) {
  return Math.max(1, Math.ceil(total / size));
}

// The requested page clamped to the available range, counting from 0.
export function paperPage<T>(
  items: readonly T[],
  page: number,
  size = paperPageSize,
) {
  const pages = pageCount(items.length, size);
  const current = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  const start = current * size;
  return {
    page: current,
    pages,
    start,
    rows: items.slice(start, start + size),
  };
}
