import { z } from 'zod';
import rawJobs from '../../research/jobs.json' with { type: 'json' };

// How the records build gives each record a job, as research/jobs.json holds
// it: a crosswalk from each source's own labels, then keyword rules tried in
// order. The records build checks the file; this reads the two parts the
// Data page lists.

const jobId = z.string().regex(/^[a-z][a-z0-9-]*$/);

const jobRulesSchema = z.object({
  crosswalk: z.record(
    z.string().min(1),
    z.strictObject({
      version: z.number().int().min(1),
      labels: z.array(
        z.strictObject({ label: z.string().min(1), job: jobId.nullable() }),
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
});

export const jobRules = jobRulesSchema.parse(rawJobs);

// What each crosswalk table reads, in the words the Data page uses.
export const crosswalkSources: Record<string, string> = {
  'hn-task': 'Hacker News: the comment’s task',
  'hn-theme': 'Hacker News: a label’s theme, when the task is “other”',
  'report-category': 'Published reports: category',
  benchmark: 'Benchmark (picker snapshot)',
  'arena-leaderboard': 'LMArena leaderboard',
  'epoch-run': 'Epoch AI run file',
  'openrouter-tag': 'OpenRouter task tag (usage only)',
  'review-job': 'People review: job (by review)',
  'benchmark-category': 'Benchmark category (restricted benchmarks)',
};
