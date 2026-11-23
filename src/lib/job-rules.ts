import { z } from 'zod';
import rawJobs from '../../research/jobs.json' with { type: 'json' };

// How the records build gives each record a job, as research/jobs.json holds
// it: a crosswalk from each source's own labels with how well each fits, then
// keyword rules tried in order; the old job ids it replaces; the rules that
// set the setting and run fields; and the tag rules. The records build checks
// the file; this reads the parts the Data page lists and old addresses need.

const jobId = z.string().regex(/^[a-z][a-z0-9-]*$/);

const fields = {
  setting: z.literal('local').optional(),
  run: z.enum(['unattended', 'parallel']).optional(),
};

const jobRulesSchema = z.object({
  jobs: z.array(z.object({ id: jobId, label: z.string().min(1) })),
  crosswalk: z.record(
    z.string().min(1),
    z.strictObject({
      version: z.number().int().min(1),
      labels: z.array(
        z.strictObject({
          label: z.string().min(1),
          job: jobId.nullable(),
          fit: z.enum(['direct', 'loose', 'none']),
          note: z.string().min(1).optional(),
        }),
      ),
    }),
  ),
  keywords: z.strictObject({
    version: z.number().int().min(1),
    rules: z.array(
      z.strictObject({
        job: jobId,
        within: z.array(jobId.nullable()).min(1),
        pattern: z.string().min(1),
        caseSensitive: z.boolean(),
      }),
    ),
  }),
  // Old job ids, from an earlier job list, that stored records and old
  // addresses still carry.
  replaces: z.record(
    jobId,
    z.strictObject({
      label: z.string().min(1),
      job: jobId.nullable(),
      into: z.array(jobId).optional(),
      ...fields,
    }),
  ),
  surface: z.strictObject({
    version: z.number().int().min(1),
    surfaces: z.array(
      z.strictObject({
        surface: z.string().min(1),
        words: z.array(z.string().min(1)).min(1),
      }),
    ),
  }),
  fields: z.strictObject({
    version: z.number().int().min(1),
    'hn-theme': z.array(z.strictObject({ label: z.string(), ...fields })),
    surface: z.array(z.strictObject({ surface: z.string(), ...fields })),
  }),
  tags: z.strictObject({
    version: z.number().int().min(1),
    rules: z.array(
      z.strictObject({
        tag: jobId,
        label: z.string().min(1),
        pattern: z.string().min(1),
        caseSensitive: z.boolean(),
      }),
    ),
  }),
});

export const jobRules = jobRulesSchema.parse(rawJobs);

// What each crosswalk table reads, in the words the Data page uses.
export const crosswalkSources: Record<string, string> = {
  'hn-task': 'Hacker News: the comment’s task',
  'hn-theme': 'Hacker News: a label’s theme, when the task is “other”',
  report: 'Published reports: the report itself, read by title',
  'report-category':
    'Published reports: category, when the report is not listed',
  benchmark: 'Benchmark (picker snapshot)',
  'arena-leaderboard': 'LMArena leaderboard',
  'epoch-run': 'Epoch AI run file',
  'openrouter-tag': 'OpenRouter task tag (usage only)',
  'review-job': 'People review: job (by review)',
  'benchmark-category': 'Benchmark category (restricted benchmarks)',
};

export type Replacement = (typeof jobRules.replaces)[string];

// A job id from an address. An old id lands on the job that replaced it; an
// old job that was split or became a field has no job, and `retired` names
// it so the page can say what became of it.
export function jobFromAddress(id: string | null): {
  job: string | null;
  retired: string | null;
} {
  if (id === null) return { job: null, retired: null };
  const replaced = jobRules.replaces[id];
  if (!replaced) return { job: id, retired: null };
  return replaced.job === null
    ? { job: null, retired: id }
    : { job: replaced.job, retired: null };
}

const jobLabel = (id: string) =>
  jobRules.jobs.find((job) => job.id === id)?.label ?? id;

// One line on what became of an old job that is no longer one.
export function retiredNotice(id: string) {
  const replaced = jobRules.replaces[id];
  if (!replaced) return '';
  const field = replaced.setting
    ? `the Setting filter (${replaced.setting})`
    : replaced.run
      ? `the Run filter (${replaced.run})`
      : '';
  const into = (replaced.into ?? []).map(jobLabel).join(' and ');
  const became = field
    ? `is now ${field}, not a job`
    : `was split into ${into}`;
  return `“${replaced.label}” ${became}. Its records have no job until the next review.`;
}

// The tag rules by tag, for the label a page shows.
export const tagLabel = (tag: string) =>
  jobRules.tags.rules.find((rule) => rule.tag === tag)?.label ?? tag;

// The crosswalk table a record's `via` prefix names.
const viaTables: Record<string, string> = {
  task: 'hn-task',
  theme: 'hn-theme',
  review: 'review-job',
  category: 'report-category',
  report: 'report',
};

// The old job a record that needs reading was given: the label in its `via`
// read through the crosswalk; '' when the label does not name one.
export function oldJobOf(via: string) {
  const mark = via.indexOf(':');
  const table = jobRules.crosswalk[viaTables[via.slice(0, mark)] ?? ''];
  const label = via.slice(mark + 1);
  const job = table?.labels.find((entry) => entry.label === label)?.job;
  return job && jobRules.replaces[job] ? job : '';
}
