import { recordBenchmark } from './brief.ts';
import type { BriefData } from './brief.ts';
import type { Core } from './core-schema.ts';
import type { CommentIndex } from './hn-insights.ts';
import { noJobTag, oldJobOf, tagsOf } from './job-rules.ts';
import type { NamedIndex, UseRecord } from './named.ts';
import type { EvidenceRecord } from './records.ts';
import { passes, recordFacts } from './search.ts';
import type { SearchFilter } from './search.ts';

// What the Data page counts. Coverage is by each record's own job: a parent
// job's row holds only its own records, not its sub-jobs'.

export const pendingLabel = 'Needs reading until the next review';

// The coverage row of a record: its job, '' for none, `pending:<old job>`
// for a record that needs reading because its old job was split or became a
// field, or `tag:<tag>` for a record a tag rule gave no job.
export const pendingRow = (old: string) => `pending:${old}`;
export const tagRow = (tag: string) => `tag:${tag}`;
type Rowed = {
  job: string;
  how: string;
  via: string;
  x: { [key: string]: unknown } | null;
};
export function coverageRow(record: Rowed) {
  if (record.how === 'pending') return pendingRow(oldJobOf(record.via));
  if (record.how === 'tag') return tagRow(noJobTag(tagsOf(record)));
  return record.job;
}

export function byJob<T extends Rowed>(records: readonly T[]) {
  const jobs = new Map<string, T[]>();
  for (const record of records) {
    const row = coverageRow(record);
    const list = jobs.get(row);
    if (list) list.push(record);
    else jobs.set(row, [record]);
  }
  return jobs;
}

// The entries of a coverage table for one row; 'pending' joins every old
// job's records that need reading.
export function rowEntries<T>(
  table: ReadonlyMap<string, readonly T[]>,
  row: string,
): T[] {
  if (row !== 'pending') return [...(table.get(row) ?? [])];
  return [...table].flatMap(([key, entries]) =>
    key.startsWith('pending:') ? entries : [],
  );
}

// Measured records of one source: a benchmark's source (snapshot, epoch,
// restricted) for benchmark results, or the record's own (arena, report).
export function measuredFrom(data: BriefData, source: string) {
  return data.measured.filter((record) =>
    record.src === 'benchmark'
      ? data.benchmarkById.get(recordBenchmark(record))?.source === source
      : record.src === source,
  );
}

// The filter bar over every job, as Search applies it.
export function inFilters<T extends EvidenceRecord>(
  records: readonly T[],
  filter: SearchFilter,
) {
  return records.filter((record) => passes(recordFacts(record), filter));
}

// The comment index names a line `family:<name>`; records call it
// `line|<name>`.
const coreKey = (key: string) =>
  key.startsWith('family:') ? `line|${key.slice(7)}` : key.replace(':', '|');

// Hacker News comments within the filters, by coverage row: the comment ids,
// read from the comment index with the job, setting and run each has in
// core.json.
export function crowdInFilters(
  index: CommentIndex,
  crowd: Pick<Core['crowd'], 'comments' | 'cells' | 'pending' | 'noJob'>,
  filter: SearchFilter,
) {
  const jobOf = new Map<number, string>();
  for (const [job, ids] of Object.entries(crowd.comments))
    for (const id of ids) jobOf.set(id, job);
  for (const [old, ids] of Object.entries(crowd.pending))
    for (const id of ids) jobOf.set(id, pendingRow(old));
  for (const [tag, ids] of Object.entries(crowd.noJob))
    for (const id of ids) jobOf.set(id, tagRow(tag));
  const cellOf = new Map<number, string>();
  for (const [cell, table] of Object.entries(crowd.cells))
    for (const ids of Object.values(table.comments))
      for (const id of ids) cellOf.set(id, cell);
  const jobs = new Map<string, Set<number>>();
  for (const row of index.rows) {
    const coverage = jobOf.get(row.id) ?? '';
    const job =
      coverage.startsWith('pending:') || coverage.startsWith('tag:')
        ? ''
        : coverage;
    const [setting = '', run = ''] = (cellOf.get(row.id) ?? '|').split('|');
    const facts = {
      band: 'crowd' as const,
      job,
      benchmark: '',
      date: row.createdAt.slice(0, 10),
      keys: row.assessments.map((assessment) => coreKey(assessment.key)),
      basis: '',
      setting,
      run,
      surface: '',
    };
    if (!passes(facts, filter)) continue;
    const ids = jobs.get(coverage);
    if (ids) ids.add(row.id);
    else jobs.set(coverage, new Set([row.id]));
  }
  return jobs;
}

// What a use record names, most exact first: a model in the model list, a
// version outside it, only a product line, or no model (a tool or nothing).
export type NameKind = 'model' | 'version' | 'line' | 'none';
export function nameKindOf(record: UseRecord): NameKind {
  const kinds = new Set(record.keys.map(([key]) => key.split('|')[0]));
  if (kinds.has('model')) return 'model';
  if (kinds.has('version')) return 'version';
  if (kinds.has('line')) return 'line';
  return 'none';
}

// The limits of the use records. The largest single person's share is a
// count and the records; the page does not name the person.
export function limitsOf(named: NamedIndex) {
  const use = named.use;
  const byPerson = new Map<string, UseRecord[]>();
  for (const record of use)
    byPerson.set(record.person, [
      ...(byPerson.get(record.person) ?? []),
      record,
    ]);
  const largest = [...byPerson.values()].reduce<UseRecord[]>(
    (top, records) => (records.length > top.length ? records : top),
    [],
  );
  const kinds = new Map<NameKind, UseRecord[]>(
    (['model', 'version', 'line', 'none'] as const).map((kind) => [kind, []]),
  );
  for (const record of use) kinds.get(nameKindOf(record))?.push(record);
  const secondary = named.people.filter(
    (person) => person.sourceClass === 'secondary',
  );
  return {
    total: use.length,
    largest,
    kinds,
    secondaryPeople: secondary.length,
    // A secondary source's record the review labelled measured: shown as a
    // reported figure and filtered as second-hand.
    secondaryMeasured: use.filter(
      (record) => record.use.sec && record.use.basis === 'measured',
    ),
  };
}
