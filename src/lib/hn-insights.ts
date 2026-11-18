import type {
  HnAspect,
  HnAssessment,
  HnIndexComment,
  HnStory,
} from './hn-index.ts';

export type HnSentiment = HnAssessment['sentiment'];
export type HnConfidence = HnAssessment['confidence'];
export type Tally = Record<HnSentiment, number>;
export type TargetRef = Pick<HnAssessment, 'kind' | 'target'>;
export type IndexedAssessment = HnAssessment & { key: string };
// story is the thread a comment belongs to and parent the item it replies
// to. Both are absent until the collection has resolved them.
export type IndexedComment = {
  id: number;
  createdAt: string;
  week: number;
  assessments: IndexedAssessment[];
  story?: number;
  parent?: number;
};
export type CommentIndex = {
  rows: IndexedComment[];
  weekStarts: string[];
  stories: ReadonlyMap<number, HnStory>;
};
// Comments that assess two unrelated targets. "ahead" means this target was
// labelled positive and the other negative in the same comment.
export type PairTally = {
  total: number;
  ahead: number;
  behind: number;
  bothPositive: number;
  bothNegative: number;
};
export type TargetInsight = TargetRef & {
  key: string;
  total: number;
  tally: Tally;
  weeks: Tally[];
  aspects: Record<HnAspect, Tally>;
  pairs: Map<string, PairTally>;
  firstAt: string;
  lastAt: string;
};
export type HnInsights = {
  weekStarts: string[];
  weekTotals: number[];
  commentCount: number;
  targets: Map<string, TargetInsight>;
};
export type HnFilter = {
  target: string | null;
  alongside: string | null;
  sentiment: HnSentiment | null;
  aspect: HnAspect | null;
  confidence: HnConfidence | null;
  fromWeek: number | null;
  toWeek: number | null;
};
export type SliceSummary = {
  total: number;
  tally: Tally;
  weeks: number[];
  aspects: Record<HnAspect, number>;
  targets: Map<string, number>;
};

const weekMs = 7 * 24 * 60 * 60 * 1000;

export const emptyFilter: HnFilter = {
  target: null,
  alongside: null,
  sentiment: null,
  aspect: null,
  confidence: null,
  fromWeek: null,
  toWeek: null,
};

export function targetKey(ref: TargetRef) {
  return `${ref.kind}:${ref.target}`;
}

export function parseTargetKey(key: string): TargetRef | null {
  const separator = key.indexOf(':');
  const kind = key.slice(0, separator);
  const target = key.slice(separator + 1);
  return (kind === 'model' || kind === 'family') && target
    ? { kind, target }
    : null;
}

export function emptyTally(): Tally {
  return { positive: 0, negative: 0, mixed: 0, neutral: 0, unclear: 0 };
}

export function tallyTotal(tally: Tally) {
  return (
    tally.positive +
    tally.negative +
    tally.mixed +
    tally.neutral +
    tally.unclear
  );
}

export function addTally(into: Tally, from: Tally) {
  into.positive += from.positive;
  into.negative += from.negative;
  into.mixed += from.mixed;
  into.neutral += from.neutral;
  into.unclear += from.unclear;
  return into;
}

// Positive share of comments labelled clearly positive or negative.
// Null below `minimum` such comments, so thin samples are not shown as a rate.
export function positiveShare(tally: Tally, minimum = 1) {
  const decided = tally.positive + tally.negative;
  return decided < minimum || decided === 0 ? null : tally.positive / decided;
}

export function sumWeeks(weeks: readonly Tally[], from: number, to: number) {
  const total = emptyTally();
  for (let week = Math.max(0, from); week <= to && week < weeks.length; week++)
    addTally(total, weeks[week] ?? emptyTally());
  return total;
}

// Names share a lineage when every word of the shorter name appears in the
// longer one: "Claude" and "Claude Opus 5.5", but not "Opus 5" and "Opus 5.5".
// Words containing digits must match exactly; plain words may be prefixes
// ("Qwen" and "Qwen3.6-27B").
export function relatedNames(first: string, second: string) {
  const words = (name: string) =>
    name
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter(Boolean);
  const a = words(first);
  const b = words(second);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    short.length > 0 &&
    short.every((word) =>
      long.some((other) =>
        /\d/.test(word) ? other === word : other.startsWith(word),
      ),
    )
  );
}

function mondayBefore(time: number) {
  const date = new Date(time);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - day,
  );
}

export function indexComments(
  comments: readonly HnIndexComment[],
  storyList: readonly HnStory[] = [],
): CommentIndex {
  const stories = new Map(storyList.map((story) => [story.id, story]));
  let first = Infinity;
  let last = -Infinity;
  const times = comments.map((comment) => {
    const time = Date.parse(comment.createdAt);
    if (time < first) first = time;
    if (time > last) last = time;
    return time;
  });
  if (comments.length === 0) return { rows: [], weekStarts: [], stories };
  const origin = mondayBefore(first);
  const weekCount = Math.floor((last - origin) / weekMs) + 1;
  return {
    weekStarts: Array.from({ length: weekCount }, (_, week) =>
      new Date(origin + week * weekMs).toISOString().slice(0, 10),
    ),
    rows: comments.map((comment, position) => ({
      id: comment.id,
      createdAt: comment.createdAt,
      week: Math.floor(((times[position] ?? origin) - origin) / weekMs),
      assessments: comment.assessments.map((assessment) => ({
        ...assessment,
        key: targetKey(assessment),
      })),
      ...(comment.story === undefined ? {} : { story: comment.story }),
      ...(comment.parent === undefined ? {} : { parent: comment.parent }),
    })),
    stories,
  };
}

function emptyAspects(): Record<HnAspect, Tally> {
  return {
    coding: emptyTally(),
    reliability: emptyTally(),
    cost: emptyTally(),
    speed: emptyTally(),
    design: emptyTally(),
    agents: emptyTally(),
    writing: emptyTally(),
    research: emptyTally(),
    reasoning: emptyTally(),
  };
}

export function buildInsights(
  index: CommentIndex,
  related: (firstKey: string, secondKey: string) => boolean,
): HnInsights {
  const weekCount = index.weekStarts.length;
  const targets = new Map<string, TargetInsight>();
  const weekTotals = Array.from({ length: weekCount }, () => 0);
  const relations = new Map<string, boolean>();
  function unrelated(a: string, b: string) {
    const id = a < b ? `${a}|${b}` : `${b}|${a}`;
    let known = relations.get(id);
    if (known === undefined) {
      known = related(a, b);
      relations.set(id, known);
    }
    return !known;
  }
  for (const row of index.rows) {
    weekTotals[row.week] = (weekTotals[row.week] ?? 0) + 1;
    for (const assessment of row.assessments) {
      let insight = targets.get(assessment.key);
      if (!insight) {
        insight = {
          key: assessment.key,
          kind: assessment.kind,
          target: assessment.target,
          total: 0,
          tally: emptyTally(),
          weeks: Array.from({ length: weekCount }, emptyTally),
          aspects: emptyAspects(),
          pairs: new Map(),
          firstAt: row.createdAt,
          lastAt: row.createdAt,
        };
        targets.set(assessment.key, insight);
      }
      insight.total += 1;
      insight.tally[assessment.sentiment] += 1;
      const week = insight.weeks[row.week];
      if (week) week[assessment.sentiment] += 1;
      for (const aspect of assessment.aspects)
        insight.aspects[aspect][assessment.sentiment] += 1;
      if (row.createdAt < insight.firstAt) insight.firstAt = row.createdAt;
      if (row.createdAt > insight.lastAt) insight.lastAt = row.createdAt;
      for (const other of row.assessments) {
        if (
          other.key === assessment.key ||
          !unrelated(assessment.key, other.key)
        )
          continue;
        let pair = insight.pairs.get(other.key);
        if (!pair) {
          pair = {
            total: 0,
            ahead: 0,
            behind: 0,
            bothPositive: 0,
            bothNegative: 0,
          };
          insight.pairs.set(other.key, pair);
        }
        pair.total += 1;
        const mine = assessment.sentiment;
        const theirs = other.sentiment;
        if (mine === 'positive' && theirs === 'negative') pair.ahead += 1;
        else if (mine === 'negative' && theirs === 'positive') pair.behind += 1;
        else if (mine === 'positive' && theirs === 'positive')
          pair.bothPositive += 1;
        else if (mine === 'negative' && theirs === 'negative')
          pair.bothNegative += 1;
      }
    }
  }
  return {
    weekStarts: index.weekStarts,
    weekTotals,
    commentCount: index.rows.length,
    targets,
  };
}

// The assessments in a comment that satisfy the filter. With a target set,
// sentiment, aspect and confidence apply to that target's label only.
export function matchingAssessments(row: IndexedComment, filter: HnFilter) {
  if (filter.fromWeek !== null && row.week < filter.fromWeek) return [];
  if (filter.toWeek !== null && row.week > filter.toWeek) return [];
  if (
    filter.alongside !== null &&
    !row.assessments.some((assessment) => assessment.key === filter.alongside)
  )
    return [];
  return row.assessments.filter(
    (assessment) =>
      (filter.target === null || assessment.key === filter.target) &&
      (filter.sentiment === null ||
        assessment.sentiment === filter.sentiment) &&
      (filter.aspect === null || assessment.aspects.includes(filter.aspect)) &&
      (filter.confidence === null ||
        assessment.confidence === filter.confidence),
  );
}

export function filterComments(index: CommentIndex, filter: HnFilter) {
  return index.rows.filter(
    (row) => matchingAssessments(row, filter).length > 0,
  );
}

export function summariseSlice(
  index: CommentIndex,
  filter: HnFilter,
): SliceSummary {
  const summary: SliceSummary = {
    total: 0,
    tally: emptyTally(),
    weeks: Array.from({ length: index.weekStarts.length }, () => 0),
    aspects: {
      coding: 0,
      reliability: 0,
      cost: 0,
      speed: 0,
      design: 0,
      agents: 0,
      writing: 0,
      research: 0,
      reasoning: 0,
    },
    targets: new Map(),
  };
  for (const row of index.rows) {
    const matched = matchingAssessments(row, filter);
    if (matched.length === 0) continue;
    summary.total += 1;
    summary.weeks[row.week] = (summary.weeks[row.week] ?? 0) + 1;
    const seen = new Set<HnAspect>();
    for (const assessment of matched) {
      summary.tally[assessment.sentiment] += 1;
      for (const aspect of assessment.aspects) seen.add(aspect);
    }
    for (const aspect of seen) summary.aspects[aspect] += 1;
    for (const assessment of row.assessments)
      summary.targets.set(
        assessment.key,
        (summary.targets.get(assessment.key) ?? 0) + 1,
      );
  }
  return summary;
}

// Sentiment per target inside a slice, for ranking targets against each
// other. Applies the period, topic, confidence and alongside filters; the
// target and sentiment filters are ignored so every target keeps its split.
export function rankTargets(index: CommentIndex, filter: HnFilter) {
  const open = { ...filter, target: null, sentiment: null };
  const ranked = new Map<string, Tally>();
  for (const row of index.rows)
    for (const assessment of matchingAssessments(row, open)) {
      let tally = ranked.get(assessment.key);
      if (!tally) {
        tally = emptyTally();
        ranked.set(assessment.key, tally);
      }
      tally[assessment.sentiment] += 1;
    }
  return ranked;
}
