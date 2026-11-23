import { z } from 'zod';
import { hnAspectSchema, hnThemeSchema } from './hn-published.ts';
import { recordSchema, stances } from './records.ts';

// build/records/core.json as `npm run records:build` writes it. The app reads
// it through this schema in development and in the published build.

const text = z.string().min(1);
const day = z.iso.date();
const jobId = z.string().regex(/^[a-z][a-z0-9-]*$/);
const count = z.number().int().nonnegative();
const tally = z.tuple([count, count, count, count]);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const targetKey = z.string().regex(/^(model|line|version|tool)\|\S(?:.*\S)?$/);
const share = z.number().min(0).max(1);

const importedSource = z.strictObject({
  fetchedAt: day,
  checkedAt: day,
  attribution: text,
  records: count,
});

export const coreJobSchema = z.strictObject({
  id: jobId,
  label: text,
  parent: jobId.optional(),
  benchmarks: z.array(text),
  guideTask: text.optional(),
});

export const coreBenchmarkSchema = z.strictObject({
  id: text,
  name: text,
  category: z.string(),
  general: z.boolean(),
  unit: text,
  scale: z.enum(['percent', 'index', 'rating']),
  what: text,
  methodology: z.string(),
  costMethod: z.string(),
  url: z.httpUrl(),
  source: text,
  publishedAt: z.union([z.literal(''), day]),
  attribution: z.string(),
  // The rows the source lists, for an imported leaderboard or run; null for
  // the snapshot's benchmarks.
  rows: count.nullable(),
});

// The brief each App guide task links to: a job, or none with the reason.
export const guideLinkSchema = z.union([
  z.strictObject({ task: text, job: jobId }),
  z.strictObject({ task: text, job: z.null(), note: text }),
]);

const usageTop = z.strictObject({
  modelId: z.string(),
  route: text,
  share,
});

const usageSchema = z.strictObject({
  source: text,
  url: z.httpUrl(),
  licence: text,
  terms: text,
  fetchedAt: day,
  checkedAt: day,
  note: text,
  tokens: z.strictObject({
    asOf: text,
    period: z.strictObject({ start: day, end: day }),
    meta: z.record(z.string(), z.union([z.string(), z.number()])),
    attribution: text,
    what: text,
    models: z.array(
      z.strictObject({
        modelId: text,
        share,
        tokens: count,
        days: count,
      }),
    ),
  }),
  tasks: z.strictObject({
    asOf: text,
    period: z.strictObject({ start: day, end: day }),
    meta: z.record(z.string(), z.union([z.string(), z.number()])),
    attribution: text,
    what: text,
    tags: z.array(
      z.strictObject({
        tag: text,
        label: text,
        job: z.union([z.literal(''), jobId]),
        share,
        top: z.array(usageTop),
      }),
    ),
  }),
});

export const coreSchema = z
  .strictObject({
    sources: z.strictObject({
      snapshot: day,
      lmarena: importedSource,
      epoch: importedSource,
      hn: z.strictObject({
        from: z.enum(['checkpoint', 'export']),
        publishedAt: z.string(),
        classifier: text,
        startAt: z.iso.datetime(),
        endAt: z.iso.datetime(),
        comments: count,
        labels: count,
      }),
    }),
    jobs: z.strictObject({
      version: z.number().int().min(1),
      status: z.enum(['draft', 'approved']),
      list: z.array(coreJobSchema).min(1),
      categories: z.record(z.string(), z.union([z.literal(''), jobId])),
      guide: z.array(guideLinkSchema),
    }),
    models: z.array(
      z.strictObject({
        id: text,
        name: text,
        provider: text,
        status: z.string(),
        input: z.number().nonnegative().nullable(),
        output: z.number().nonnegative().nullable(),
        priceUrl: z.string(),
        contextTokens: z.number().int().positive().nullable(),
      }),
    ),
    lines: z.array(z.strictObject({ name: text, models: z.array(text) })),
    benchmarks: z.array(coreBenchmarkSchema),
    measured: z.array(recordSchema),
    crowd: z.strictObject({
      stances: z.tuple([
        z.literal(stances[0]),
        z.literal(stances[1]),
        z.literal(stances[2]),
        z.literal(stances[3]),
      ]),
      counts: z.record(
        targetKey,
        z.record(z.union([z.literal(''), jobId]), z.record(month, tally)),
      ),
      // The same counts for each theme of a label, toward that label's target.
      themes: z.record(
        targetKey,
        z.record(
          z.union([z.literal(''), jobId]),
          z.record(month, z.partialRecord(hnThemeSchema, tally)),
        ),
      ),
      // Each exact model's labels per Monday-UTC week from `start`, and per
      // legacy aspect of the label, for the Board.
      weeks: z.strictObject({
        start: z.union([z.literal(''), day]),
        count,
        targets: z.record(targetKey, z.array(tally)),
      }),
      aspects: z.record(targetKey, z.partialRecord(hnAspectSchema, tally)),
      comments: z.record(
        z.union([z.literal(''), jobId]),
        z.array(z.number().int().positive()),
      ),
    }),
    preferences: z.array(
      z.strictObject({
        winner: targetKey,
        loser: targetKey,
        job: z.union([z.literal(''), jobId]),
        date: day,
        id: z.string().regex(/^hn:[1-9][0-9]*$/),
      }),
    ),
    coverage: z.strictObject({
      sources: z.array(text),
      rows: z.array(
        z.strictObject({
          job: z.union([z.literal(''), jobId]),
          counts: z.record(z.string(), count),
        }),
      ),
    }),
    usage: usageSchema.nullable(),
    namedBehindSignIn: z.boolean(),
  })
  .superRefine((core, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    const jobs = new Set(core.jobs.list.map((job) => job.id));
    const benchmarks = new Set(core.benchmarks.map((entry) => entry.id));
    const models = new Set(core.models.map((model) => model.id));
    if (jobs.size !== core.jobs.list.length) issue('a job id is repeated');
    for (const link of core.jobs.guide)
      if (link.job !== null && !jobs.has(link.job))
        issue(`guide task ${link.task}: unknown job`);
    for (const [key, weeks] of Object.entries(core.crowd.weeks.targets))
      if (weeks.length !== core.crowd.weeks.count)
        issue(`${key}: weeks differ in number`);
    for (const job of core.jobs.list) {
      if (job.parent !== undefined && !jobs.has(job.parent))
        issue(`job ${job.id}: unknown parent`);
      for (const id of job.benchmarks)
        if (!benchmarks.has(id)) issue(`job ${job.id}: unknown benchmark`);
    }
    for (const record of core.measured) {
      if (record.cls !== 'measured') issue(`${record.id}: not measured`);
      for (const [key] of record.keys)
        if (key.startsWith('model|') && !models.has(key.slice(6)))
          issue(`${record.id}: unknown model`);
      const benchmark = record.x?.b;
      if (typeof benchmark === 'string' && !benchmarks.has(benchmark))
        issue(`${record.id}: unknown benchmark`);
    }
  });

export type Core = z.infer<typeof coreSchema>;
export type CoreJob = z.infer<typeof coreJobSchema>;
export type CoreBenchmark = z.infer<typeof coreBenchmarkSchema>;
export type CoreModel = Core['models'][number];
export type CoreUsage = NonNullable<Core['usage']>;
export type Preference = Core['preferences'][number];
