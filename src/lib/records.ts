import { z } from 'zod';

// The shared evidence record and the people file. scripts/records_schema.py
// holds the same rules for the records build; tests/records.test.ts checks that
// both accept and reject the same fixtures.

export const recordClasses = ['measured', 'named', 'crowd'] as const;
export const recordSources = {
  benchmark: 'measured',
  arena: 'measured',
  report: 'measured',
  use: 'named',
  advice: 'named',
  hn: 'crowd',
} as const;
const idSources: Record<string, readonly RecordSource[]> = {
  hn: ['hn'],
  bm: ['benchmark'],
  ep: ['benchmark'],
  rp: ['report'],
  la: ['arena'],
  ur: ['use'],
  ma: ['advice'],
};
export const stances = ['positive', 'critical', 'mixed', 'neutral'] as const;

const idPattern = /^(hn|bm|ep|rp|la|ur|ma):(\S+)$/;
const keyPattern = /^(model|line|version|tool)\|\S(?:.*\S)?$/;
const jobPattern = /^[a-z][a-z0-9-]*$/;
const urlPattern = /^https?:\/\/[^\s/?#]+\S*$/;

const stance = z.enum(stances);
const source = z.enum(['benchmark', 'arena', 'report', 'use', 'advice', 'hn']);
const date = z.iso.date();
const url = z.string().regex(urlPattern);
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RecordSource = z.infer<typeof source>;

export const recordSchema = z
  .strictObject({
    id: z.string().regex(idPattern),
    cls: z.enum(recordClasses),
    src: source,
    keys: z.array(z.tuple([z.string().regex(keyPattern), stance])),
    job: z.union([z.literal(''), z.string().regex(jobPattern)]),
    // pending: no job until the next review, because the old job the label
    // gave was split or became a field; `via` keeps the label. tag: no job,
    // because a tag rule that gives none (the drawing test) matched; `via`
    // keeps the label the record came with.
    how: z.enum(['', 'label', 'keywords', 'review', 'pending', 'tag']),
    via: z.string(),
    stance,
    text: z.string(),
    quote: z.string(),
    cond: z.string(),
    tool: z.string(),
    effort: z.string(),
    setting: z.enum(['', 'local', 'hosted']),
    run: z.enum(['', 'interactive', 'unattended', 'parallel']),
    surface: z.enum(['', 'coding-agent', 'chat-app', 'api', 'local-runner']),
    date: z.union([z.literal(''), date]),
    person: z.string(),
    url,
    title: z.string(),
    kind: z.string(),
    x: z.record(z.string(), jsonValue).nullable(),
    checked: z.union([z.literal(''), date]),
  })
  .superRefine((record, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const prefix = idPattern.exec(record.id)?.[1] ?? '';
    if (prefix === 'hn' && !/^hn:[1-9][0-9]*$/.test(record.id))
      issue('hn id is not an item number');
    if (!(idSources[prefix] ?? []).includes(record.src))
      issue('id prefix does not match src');
    if (record.cls !== recordSources[record.src])
      issue('cls does not match src');
    if (new Set(record.keys.map(([key]) => key)).size !== record.keys.length)
      issue('a key is repeated');
    if (record.how === 'pending') {
      if (record.job !== '' || record.via === '')
        issue('a record that needs reading has no job and keeps its label');
    } else if (record.how === 'tag') {
      if (record.job !== '' || record.via === '')
        issue('a record a tag rule gave no job has no job and keeps its label');
    } else {
      const empty = [record.job, record.how, record.via].map((v) => v === '');
      if (empty.some((value) => value !== empty[0]))
        issue('job, how and via must be all set or all empty');
    }
    if (record.how === 'review' && record.cls !== 'named')
      issue('only named records have jobs by review');
    if (record.quote !== '' && record.cls !== 'named')
      issue('only named records keep quotes');
    if ((record.person !== '') !== (record.cls === 'named'))
      issue('a person is named on named records only');
  });

const change = z.strictObject({
  date,
  reason: z.string().refine((value) => value.trim() !== ''),
});

export const peopleSchema = z
  .strictObject({
    version: z.number().int().min(1),
    people: z.array(
      z
        .strictObject({
          name: z
            .string()
            .min(1)
            .refine((value) => value.trim() === value),
          feeds: z
            .array(url)
            .min(1)
            .refine((feeds) => new Set(feeds).size === feeds.length),
          sourceClass: z.enum(['first-hand', 'secondary']),
          adviceOnly: z.boolean(),
          trusted: z.boolean(),
          added: change,
          dropped: change.nullable(),
        })
        .refine(
          (person) =>
            person.dropped === null || person.dropped.date >= person.added.date,
          'dropped before added',
        ),
    ),
  })
  .refine(
    (data) =>
      new Set(data.people.map((person) => person.name)).size ===
      data.people.length,
    'a name is repeated',
  );

export type EvidenceRecord = z.infer<typeof recordSchema>;
export type People = z.infer<typeof peopleSchema>;
