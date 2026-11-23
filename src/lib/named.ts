import { z } from 'zod';
import { inPool, jobSet, lineKey, modelKey } from './brief.ts';
import type { BriefData, BriefFilters, Tally } from './brief.ts';
import { basisClasses } from './model-filter.ts';
import type { BasisClass } from './model-filter.ts';
import { recordSchema } from './records.ts';
import type { EvidenceRecord } from './records.ts';

// Practitioners' named records: use records, which name a model, a product
// line, a version outside the model list or a tool, and method advice, which
// names none. They reach the browser only for signed-in, granted accounts.
//
// Rules: trusted people come first, then a first-hand or measured basis before
// second-hand and vendor, then the newest. A record that names only a product
// line stays under the line, and a version outside the model list keeps its
// own key. The job was assigned by the review, so it only filters: nothing
// here orders a model or a job, and method advice never counts toward one.

const day = z.iso.date();
const count = z.number().int().nonnegative();
const change = z.strictObject({ date: day, reason: z.string().min(1) });

export const comparisons = [
  '',
  'this better',
  'other better',
  'similar',
  'mixed',
] as const;

// The review's fields on a use record (`x`). `b` is the basis it is filtered
// by: a secondary source's "measured" is second-hand there.
const useExtrasSchema = z.object({
  b: z.enum(basisClasses),
  basis: z.string(),
  sec: z.boolean(),
  named: z.string(),
  exact: z.boolean(),
  line: z.string(),
  task: z.string(),
  cmp: z.enum(comparisons),
  cmpId: z.string(),
  cmpNamed: z.string(),
  channel: z.string(),
});
export type UseExtras = z.infer<typeof useExtrasSchema>;

const useRecordSchema = recordSchema.transform((record, ctx) => {
  const use = useExtrasSchema.safeParse(record.x);
  if (record.src !== 'use' || !use.success) {
    ctx.addIssue({ code: 'custom', message: `${record.id}: not a use record` });
    return z.NEVER;
  }
  return { ...record, use: use.data };
});
const adviceRecordSchema = recordSchema.refine(
  (record) => record.src === 'advice' && record.keys.length === 0,
  'not method advice',
);

export const namedPersonSchema = z.strictObject({
  name: z.string().min(1),
  sourceClass: z.enum(['first-hand', 'secondary']),
  // Shown for method advice only: too few use records name a model.
  adviceOnly: z.boolean(),
  // On the trusted list until the viewer changes it.
  trusted: z.boolean(),
  added: change,
  dropped: change.nullable(),
  use: count,
  advice: count,
  useLeftOut: count,
});

// The people, the review's notes and the use records (`/api/named`).
export const namedPayloadSchema = z
  .strictObject({
    version: z.literal(1),
    review: z.object({
      model: z.string(),
      methodology: z.string(),
      jobAgreement: z.object({
        share: z.number().min(0).max(1),
        check: z.string().min(1),
      }),
      note: z.string(),
    }),
    people: z.array(namedPersonSchema),
    coverage: z.array(
      z.strictObject({
        job: z.union([z.literal(''), z.string()]),
        use: count,
        advice: count,
      }),
    ),
    use: z.array(useRecordSchema),
  })
  .superRefine((payload, ctx) => {
    const names = new Set(payload.people.map((person) => person.name));
    if (names.size !== payload.people.length)
      ctx.addIssue({ code: 'custom', message: 'a person is repeated' });
    if (payload.use.some((record) => !names.has(record.person)))
      ctx.addIssue({ code: 'custom', message: 'a record names no person' });
    if (new Set(payload.use.map((r) => r.id)).size !== payload.use.length)
      ctx.addIssue({ code: 'custom', message: 'a record id is repeated' });
  });

// Method advice (`/api/named/advice`).
export const namedAdviceSchema = z.strictObject({
  version: z.literal(1),
  advice: z.array(adviceRecordSchema),
});

export type NamedPayload = z.infer<typeof namedPayloadSchema>;
export type NamedPerson = NamedPayload['people'][number];
export type UseRecord = NamedPayload['use'][number];
export type AdviceRecord = EvidenceRecord;
export type NamedRecord = UseRecord | AdviceRecord;

export type NamedIndex = {
  payload: NamedPayload;
  people: NamedPerson[];
  personByName: Map<string, NamedPerson>;
  use: UseRecord[];
  // Use records by every key they carry, exactly as written: a line's
  // records are never filed under its models.
  byKey: Map<string, UseRecord[]>;
};

export function indexNamed(payload: NamedPayload): NamedIndex {
  const byKey = new Map<string, UseRecord[]>();
  for (const record of payload.use)
    for (const [key] of record.keys) {
      const list = byKey.get(key);
      if (list) list.push(record);
      else byKey.set(key, [record]);
    }
  return {
    payload,
    people: payload.people,
    personByName: new Map(
      payload.people.map((person) => [person.name, person]),
    ),
    use: payload.use,
    byKey,
  };
}

export const basisLabels: Record<BasisClass, string> = {
  first: 'First-hand',
  measured: 'Measured',
  second: 'Second-hand',
  vendor: 'Vendor',
};

// What a secondary source's record labelled "measured" is shown as.
export function basisText(record: UseRecord) {
  return record.use.sec && record.use.basis === 'measured'
    ? 'reported figure (labelled measured by the review; secondary source, not checked)'
    : record.use.basis;
}

// ---- Order -----------------------------------------------------------------------

const basisRank: Record<BasisClass, number> = {
  first: 0,
  measured: 0,
  second: 1,
  vendor: 1,
};

const isUse = (record: NamedRecord): record is UseRecord => 'use' in record;

// Trusted people first, in the listed order; then a first-hand or measured
// basis before second-hand and vendor; then newest first.
export function namedOrder<T extends NamedRecord>(
  records: readonly T[],
  trusted: readonly string[],
): T[] {
  const rank = (person: string) => {
    const at = trusted.indexOf(person);
    return at < 0 ? trusted.length : at;
  };
  const basis = (record: NamedRecord) =>
    isUse(record) ? basisRank[record.use.b] : 2;
  return [...records].sort(
    (a, b) =>
      rank(a.person) - rank(b.person) ||
      basis(a) - basis(b) ||
      b.date.localeCompare(a.date) ||
      a.id.localeCompare(b.id),
  );
}

// ---- Filters ---------------------------------------------------------------------

// The filter bar applied to one named record: the Named class, the job by
// review, the period and, for use records, the basis. Records with no job
// pass only for all jobs.
export function namedPasses(
  data: BriefData,
  record: NamedRecord,
  jobId: string | null,
  filters: BriefFilters,
) {
  if (!filters.classes.includes('named')) return false;
  if (isUse(record) && !filters.basis.includes(record.use.b)) return false;
  if (jobId !== null && !jobSet(data, jobId).has(record.job)) return false;
  return !filters.since || record.date >= filters.since;
}

// The use records that carry one key, within the filters, in band order.
export function namedFor(
  data: BriefData,
  named: NamedIndex,
  key: string,
  jobId: string | null,
  filters: BriefFilters,
  trusted: readonly string[],
) {
  return namedOrder(
    (named.byKey.get(key) ?? []).filter((record) =>
      namedPasses(data, record, jobId, filters),
    ),
    trusted,
  );
}

export type NamedBand = {
  // Records that name the target exactly.
  records: UseRecord[];
  // For a model: records that name only one of its product lines, apart.
  lines: { name: string; key: string; records: UseRecord[] }[];
};

// The Named band for a model (`model|<id>`) or a product line
// (`line|<name>`). A model's band lists the records that name only one of its
// lines apart; they are never added to the model's own.
export function namedBand(
  data: BriefData,
  named: NamedIndex,
  key: string,
  jobId: string | null,
  filters: BriefFilters,
  trusted: readonly string[],
): NamedBand {
  const records = namedFor(data, named, key, jobId, filters, trusted);
  const modelId = key.startsWith('model|') ? key.slice(6) : null;
  const lines =
    modelId === null
      ? []
      : data.core.lines
          .filter((line) => line.models.includes(modelId))
          .map((line) => ({
            name: line.name,
            key: lineKey(line.name),
            records: namedFor(
              data,
              named,
              lineKey(line.name),
              jobId,
              filters,
              trusted,
            ).filter((record) => !record.keys.some(([entry]) => entry === key)),
          }))
          .filter((line) => line.records.length > 0);
  return { records, lines };
}

// The Named column of Brief's table: each row's use records, in the rows'
// own order. The rows are ordered before this and are never reordered by it.
export function namedColumn<R extends { model: { id: string } }>(
  data: BriefData,
  named: NamedIndex,
  rows: readonly R[],
  jobId: string,
  filters: BriefFilters,
  trusted: readonly string[],
) {
  return rows.map((row) => ({
    row,
    records: namedFor(
      data,
      named,
      modelKey(row.model.id),
      jobId,
      filters,
      trusted,
    ),
  }));
}

// Records of one model that compare it with the other, in either direction.
export function namedComparisons(
  data: BriefData,
  named: NamedIndex,
  a: string,
  b: string,
  jobId: string | null,
  filters: BriefFilters,
  trusted: readonly string[],
) {
  const compares = (record: UseRecord, self: string, other: string) =>
    record.use.cmpId === other &&
    record.keys.some(([key]) => key === modelKey(self));
  return namedOrder(
    [
      ...(named.byKey.get(modelKey(a)) ?? []),
      ...(named.byKey.get(modelKey(b)) ?? []),
    ]
      .filter((record) => compares(record, a, b) || compares(record, b, a))
      .filter((record) => namedPasses(data, record, jobId, filters)),
    trusted,
  );
}

// Outcome counts in the order of a tally: worked, failed or abandoned,
// worked after rework, no outcome stated.
export const outcomeLabels = [
  'Worked',
  'Failed or abandoned',
  'Worked after rework',
  'No outcome stated',
] as const;

export function outcomeTally(records: readonly NamedRecord[]): Tally {
  const tally: Tally = [0, 0, 0, 0];
  for (const record of records)
    tally[
      record.stance === 'positive'
        ? 0
        : record.stance === 'critical'
          ? 1
          : record.stance === 'mixed'
            ? 2
            : 3
    ] += 1;
  return tally;
}

// ---- People ----------------------------------------------------------------------

// Starred people first, in the listed order; then everyone else as listed.
export function peopleOrder(
  people: readonly NamedPerson[],
  trusted: readonly string[],
) {
  const starred = trusted.flatMap(
    (name) => people.find((person) => person.name === name) ?? [],
  );
  return [...starred, ...people.filter((p) => !trusted.includes(p.name))];
}

export type KeyKind = 'model' | 'line' | 'version' | 'tool';
export const keyKind = (key: string): KeyKind => {
  const kind = key.slice(0, key.indexOf('|'));
  return kind === 'model' || kind === 'line' || kind === 'version'
    ? kind
    : 'tool';
};

export type MatrixKind = 'targets' | 'tools';

// A model column follows the model selection and Current models only; lines,
// versions and tools are not in the model list and are always columns.
function columnAllowed(
  data: BriefData,
  key: string,
  kind: MatrixKind,
  filters: BriefFilters,
) {
  const keyType = keyKind(key);
  if (kind === 'tools') return keyType === 'tool';
  if (keyType === 'tool') return false;
  if (keyType !== 'model') return true;
  const model = data.modelById.get(key.slice(6));
  return model !== undefined && inPool(model, filters);
}

export type PeopleMatrix = {
  // Use records within the filters, of every person.
  records: UseRecord[];
  // The targets named most, most records first.
  columns: string[];
  rows: {
    person: NamedPerson;
    records: UseRecord[];
    cells: Map<string, UseRecord[]>;
  }[];
  // The person who supplies the most records, and how many.
  top: { person: NamedPerson; count: number } | null;
};

// Who has reported on which model, line, version or tool. A count shows
// where someone has written, not how often they use a model, and orders
// nothing but its own columns.
export function peopleMatrix(
  data: BriefData,
  named: NamedIndex,
  jobId: string | null,
  filters: BriefFilters,
  trusted: readonly string[],
  kind: MatrixKind,
  limit = 14,
): PeopleMatrix {
  const records = named.use.filter((record) =>
    namedPasses(data, record, jobId, filters),
  );
  const counts = new Map<string, number>();
  for (const record of records)
    for (const [key] of record.keys)
      if (columnAllowed(data, key, kind, filters))
        counts.set(key, (counts.get(key) ?? 0) + 1);
  const columns = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
  const rows = peopleOrder(named.people, trusted).map((person) => {
    const own = records.filter((record) => record.person === person.name);
    const cells = new Map<string, UseRecord[]>();
    for (const key of columns)
      cells.set(
        key,
        namedOrder(
          own.filter((record) => record.keys.some(([entry]) => entry === key)),
          trusted,
        ),
      );
    return { person, records: namedOrder(own, trusted), cells };
  });
  const top = rows.reduce<PeopleMatrix['top']>(
    (best, row) =>
      row.records.length > 0 && (!best || row.records.length > best.count)
        ? { person: row.person, count: row.records.length }
        : best,
    null,
  );
  return { records, columns, rows, top };
}

export type NameKind = 'model' | 'version' | 'line' | 'none';
export const nameKindLabels: Record<NameKind, string> = {
  model: 'a model in the list',
  version: 'an exact version not in the list',
  line: 'only a product line',
  none: 'no model',
};

// What a use record names: an exact model in the list, an exact version not
// in it, only a product line, or no model (a tool alone, or nothing).
export function nameKind(record: UseRecord): NameKind {
  const kinds = record.keys.map(([key]) => keyKind(key));
  if (kinds.includes('model')) return 'model';
  if (kinds.includes('version')) return 'version';
  if (kinds.includes('line')) return 'line';
  return 'none';
}

// Months from `from` to `to` (YYYY-MM-DD), as YYYY-MM.
export function monthsBetween(from: string, to: string) {
  const months: string[] = [];
  const last = to.slice(0, 7);
  const date = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (date.toISOString().slice(0, 7) <= last) {
    months.push(date.toISOString().slice(0, 7));
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  return months;
}

export type PersonSummary = {
  records: UseRecord[];
  byName: { kind: NameKind; records: UseRecord[] }[];
  byBasis: { basis: BasisClass; records: UseRecord[] }[];
  // Jobs by review, most records first; '' for no job.
  byJob: { job: string; records: UseRecord[] }[];
  // Use records per month for the targets named most.
  timeline: { months: string[]; rows: { key: string; cells: UseRecord[][] }[] };
  models: UseRecord[];
  comparisons: UseRecord[];
  failures: UseRecord[];
};

export function personSummary(
  data: BriefData,
  named: NamedIndex,
  name: string,
  jobId: string | null,
  filters: BriefFilters,
  trusted: readonly string[],
  topKeys = 12,
): PersonSummary {
  const records = namedOrder(
    named.use.filter(
      (record) =>
        record.person === name && namedPasses(data, record, jobId, filters),
    ),
    trusted,
  );
  const group = <K extends string>(keyOf: (record: UseRecord) => K) => {
    const groups = new Map<K, UseRecord[]>();
    for (const record of records) {
      const key = keyOf(record);
      const list = groups.get(key);
      if (list) list.push(record);
      else groups.set(key, [record]);
    }
    return groups;
  };
  const names = group(nameKind);
  const bases = group((record) => record.use.b);
  const jobs = group((record) => record.job);
  const counts = new Map<string, number>();
  for (const record of records)
    for (const [key] of record.keys)
      counts.set(key, (counts.get(key) ?? 0) + 1);
  const keys = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topKeys)
    .map(([key]) => key);
  const first =
    filters.since ||
    named.use.reduce(
      (min, record) => (record.date < min ? record.date : min),
      data.end,
    );
  const months = monthsBetween(first, data.end);
  return {
    records,
    byName: (['model', 'version', 'line', 'none'] as const).flatMap((kind) =>
      names.has(kind) ? [{ kind, records: names.get(kind) ?? [] }] : [],
    ),
    byBasis: basisClasses.flatMap((basis) =>
      bases.has(basis) ? [{ basis, records: bases.get(basis) ?? [] }] : [],
    ),
    byJob: [...jobs]
      .map(([job, list]) => ({ job, records: list }))
      .sort(
        (a, b) =>
          b.records.length - a.records.length || a.job.localeCompare(b.job),
      ),
    timeline: {
      months,
      rows: keys.map((key) => ({
        key,
        cells: months.map((month) =>
          records.filter(
            (record) =>
              record.date.startsWith(month) &&
              record.keys.some(([entry]) => entry === key),
          ),
        ),
      })),
    },
    models: names.get('model') ?? [],
    comparisons: records.filter((record) => record.use.cmp !== ''),
    failures: records.filter((record) => record.stance === 'critical'),
  };
}

// A person's method advice within the job and period. It never counts toward
// a model or a job's coverage.
export function personAdvice(
  data: BriefData,
  advice: readonly AdviceRecord[],
  name: string,
  jobId: string | null,
  filters: BriefFilters,
) {
  return advice.filter(
    (record) =>
      record.person === name && namedPasses(data, record, jobId, filters),
  );
}

// Method advice for the App guide's Coding agents mode, grouped by what the
// review applied it to: each job in the job file's order, except jobs whose
// App guide task is answered in chat apps only, then advice for any job.
// Within a group, trusted people first (see namedOrder).
export function codingAdviceGroups(
  advice: readonly AdviceRecord[],
  jobs: readonly { id: string; guideTask?: string }[],
  chatOnlyTasks: ReadonlySet<string>,
  trusted: readonly string[],
) {
  const shown = jobs
    .filter((job) => !job.guideTask || !chatOnlyTasks.has(job.guideTask))
    .map((job) => job.id);
  const byJob = new Map<string, AdviceRecord[]>();
  for (const record of advice) {
    const list = byJob.get(record.job);
    if (list) list.push(record);
    else byJob.set(record.job, [record]);
  }
  return [...shown, ''].flatMap((job) => {
    const records = byJob.get(job);
    return records ? [{ job, records: namedOrder(records, trusted) }] : [];
  });
}

// ---- Trusted people --------------------------------------------------------------

export const trustedStorageKey = 'model-picker:trusted-people';
const storedTrustedSchema = z.array(z.string().min(1)).max(200);

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

// The viewer's stored list, or null when there is none or it cannot be read.
export function readStoredTrusted(storage: StorageReader | null) {
  try {
    const raw = storage?.getItem(trustedStorageKey);
    if (!raw) return null;
    const parsed = storedTrustedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeStoredTrusted(
  storage: StorageWriter | null,
  list: readonly string[],
) {
  try {
    storage?.setItem(trustedStorageKey, JSON.stringify(list));
  } catch {
    // The list still applies until the page is reloaded.
  }
}

// The trusted list: the viewer's own, without names the data no longer has,
// or, before they change it, the people flagged as the default.
export function trustedList(
  stored: readonly string[] | null,
  people: readonly NamedPerson[],
) {
  if (stored === null)
    return people.filter((person) => person.trusted).map((p) => p.name);
  const names = new Set(people.map((person) => person.name));
  return [...new Set(stored)].filter((name) => names.has(name));
}

export function toggleTrusted(list: readonly string[], name: string) {
  return list.includes(name)
    ? list.filter((entry) => entry !== name)
    : [...list, name];
}

export function moveTrusted(list: readonly string[], at: number, by: -1 | 1) {
  const to = at + by;
  if (at < 0 || to < 0 || at >= list.length || to >= list.length)
    return [...list];
  const next = [...list];
  const [moved] = next.splice(at, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

// ---- Articles --------------------------------------------------------------------

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// The person whose records link to a site, for sites only one person's
// records link to. A shared site is left unassigned.
export function siteOwners(
  records: readonly { person: string; url: string }[],
) {
  const owners = new Map<string, Set<string>>();
  for (const record of records) {
    const host = hostOf(record.url);
    if (!host) continue;
    const set = owners.get(host) ?? new Set<string>();
    set.add(record.person);
    owners.set(host, set);
  }
  const unique = new Map<string, string>();
  for (const [host, set] of owners)
    if (set.size === 1) unique.set(host, [...set][0] ?? '');
  return unique;
}

export function articlesOf<T extends { url: string }>(
  articles: readonly T[],
  owners: ReadonlyMap<string, string>,
  name: string,
) {
  return articles.filter((article) => owners.get(hostOf(article.url)) === name);
}
