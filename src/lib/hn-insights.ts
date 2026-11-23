import type {
  HnAspect,
  HnAssessment,
  HnIndexComment,
  HnStory,
  HnTask,
  HnTheme,
} from './hn-index.ts';

export type HnSentiment = HnAssessment['sentiment'];
export type HnConfidence = HnAssessment['confidence'];
export type Tally = Record<HnSentiment, number>;
export type TargetRef = Pick<HnAssessment, 'kind' | 'target'>;
export type IndexedAssessment = HnAssessment & { key: string };
// A comment saying that one target is better than another, as target keys.
export type StatedPreference = { winner: string; loser: string };
// story is the thread a comment belongs to and parent the item it replies
// to. Both are absent until the collection has resolved them. task, claim and
// preferences are written by the classifier of the thread pipeline and absent
// in an analysis made before it.
export type IndexedComment = {
  id: number;
  createdAt: string;
  week: number;
  assessments: IndexedAssessment[];
  story?: number;
  parent?: number;
  task?: HnTask;
  claim?: string;
  preferences?: StatedPreference[];
};
// detailed says whether the comments carry tasks, themes and claims.
export type CommentIndex = {
  rows: IndexedComment[];
  weekStarts: string[];
  stories: ReadonlyMap<number, HnStory>;
  detailed: boolean;
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
// Comments that state a preference between this target and another: `over`
// counts those preferring this target, `under` those preferring the other.
export type PreferenceTally = { over: number; under: number };
export type TargetInsight = TargetRef & {
  key: string;
  total: number;
  tally: Tally;
  weeks: Tally[];
  aspects: Record<HnAspect, Tally>;
  themes: Map<HnTheme, Tally>;
  tasks: Map<HnTask, Tally>;
  pairs: Map<string, PairTally>;
  preferences: Map<string, PreferenceTally>;
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
  theme: HnTheme | null;
  task: HnTask | null;
  confidence: HnConfidence | null;
  fromWeek: number | null;
  toWeek: number | null;
};

const weekMs = 7 * 24 * 60 * 60 * 1000;

export const emptyFilter: HnFilter = {
  target: null,
  alongside: null,
  sentiment: null,
  aspect: null,
  theme: null,
  task: null,
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

// Theme identifiers are hyphenated words.
export function themeLabel(theme: HnTheme) {
  return theme.replaceAll('-', ' ');
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

// Positive share of comments labelled clearly positive or negative.
// Null below `minimum` such comments, so thin samples are not shown as a rate.
export function positiveShare(tally: Tally, minimum = 1) {
  const decided = tally.positive + tally.negative;
  return decided < minimum || decided === 0 ? null : tally.positive / decided;
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
  if (comments.length === 0)
    return { rows: [], weekStarts: [], stories, detailed: false };
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
      ...(comment.task === undefined ? {} : { task: comment.task }),
      ...(comment.claim === undefined ? {} : { claim: comment.claim }),
      ...(comment.prefers === undefined || comment.prefers.length === 0
        ? {}
        : {
            preferences: comment.prefers.map((pair) => ({
              winner: targetKey(pair.winner),
              loser: targetKey(pair.loser),
            })),
          }),
    })),
    stories,
    detailed: comments.some((comment) => comment.task !== undefined),
  };
}

function tallyIn<Key>(tallies: Map<Key, Tally>, key: Key) {
  let tally = tallies.get(key);
  if (!tally) {
    tally = emptyTally();
    tallies.set(key, tally);
  }
  return tally;
}

function preferenceIn(insight: TargetInsight, other: string) {
  let tally = insight.preferences.get(other);
  if (!tally) {
    tally = { over: 0, under: 0 };
    insight.preferences.set(other, tally);
  }
  return tally;
}

export function emptyAspects(): Record<HnAspect, Tally> {
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
          themes: new Map(),
          tasks: new Map(),
          pairs: new Map(),
          preferences: new Map(),
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
      for (const theme of assessment.themes ?? [])
        tallyIn(insight.themes, theme)[assessment.sentiment] += 1;
      if (row.task) tallyIn(insight.tasks, row.task)[assessment.sentiment] += 1;
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
  // Counted once every target has its insight. A preference between a name
  // and its own family or version line says nothing and is left out.
  for (const row of index.rows)
    for (const { winner, loser } of row.preferences ?? []) {
      if (winner === loser || !unrelated(winner, loser)) continue;
      const ahead = targets.get(winner);
      const behind = targets.get(loser);
      if (ahead) preferenceIn(ahead, loser).over += 1;
      if (behind) preferenceIn(behind, winner).under += 1;
    }
  return {
    weekStarts: index.weekStarts,
    weekTotals,
    commentCount: index.rows.length,
    targets,
  };
}

// The assessments in a comment that satisfy the filter. With a target set,
// sentiment, aspect, theme and confidence apply to that target's label only.
// The task belongs to the comment.
export function matchingAssessments(row: IndexedComment, filter: HnFilter) {
  if (filter.fromWeek !== null && row.week < filter.fromWeek) return [];
  if (filter.toWeek !== null && row.week > filter.toWeek) return [];
  if (filter.task !== null && row.task !== filter.task) return [];
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
      (filter.theme === null ||
        (assessment.themes?.includes(filter.theme) ?? false)) &&
      (filter.confidence === null ||
        assessment.confidence === filter.confidence),
  );
}

export function filterComments(index: CommentIndex, filter: HnFilter) {
  return index.rows.filter(
    (row) => matchingAssessments(row, filter).length > 0,
  );
}
