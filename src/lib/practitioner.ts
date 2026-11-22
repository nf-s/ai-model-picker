import { z } from 'zod';
import reviewed from '../../research/practitioner-findings.json' with { type: 'json' };
import { guide } from './guide.ts';
import type { TargetRef } from './hn-insights.ts';
import snapshot from './snapshot.json' with { type: 'json' };

const modelIds = new Set(snapshot.models.map((model) => model.id));
const codingTaskIds = new Set(
  guide.tasks.filter((task) => task.codingDefault).map((task) => task.id),
);
const text = z.string().trim().min(1);
const hnLink = z
  .httpUrl()
  .regex(/^https:\/\/news\.ycombinator\.com\/item\?id=[1-9]\d*$/);
const target = z.strictObject({
  kind: z.enum(['model', 'family', 'tool']),
  id: text,
});
const sharedFields = {
  attribution: z.enum([
    'author observation',
    'author advice',
    'reported by source',
    'project documentation',
    'attributed speaker',
  ]),
  date: z.iso.date(),
  title: text,
  summary: text,
  conditions: text,
  targets: z.array(target),
  sourceUrl: hnLink,
  contextUrl: hnLink,
};
const finding = z.discriminatedUnion('kind', [
  z.strictObject({
    ...sharedFields,
    kind: z.enum([
      'observed outcome',
      'concrete failure',
      'comparison',
      'limitation',
    ]),
  }),
  z.strictObject({
    ...sharedFields,
    kind: z.literal('workflow advice'),
    taskId: text,
  }),
]);

export const practitionerSchema = z
  .strictObject({
    checkedAt: z.iso.date(),
    collectionStart: z.iso.date(),
    collectionEnd: z.iso.date(),
    findings: z.array(finding),
  })
  .superRefine((review, context) => {
    const issue = (message: string, path: (string | number)[] = []) =>
      context.addIssue({ code: 'custom', message, path });
    if (
      review.collectionStart > review.collectionEnd ||
      review.collectionEnd > review.checkedAt
    )
      issue('Invalid practitioner collection window');

    const sources = new Set<string>();
    for (const [index, entry] of review.findings.entries()) {
      const path = ['findings', index];
      if (sources.has(entry.sourceUrl)) issue('Duplicate source', path);
      sources.add(entry.sourceUrl);
      if (entry.sourceUrl === entry.contextUrl)
        issue('Expected a separate context link', path);
      if (
        entry.date < review.collectionStart ||
        entry.date > review.collectionEnd
      )
        issue('Finding falls outside the collection window', path);
      if (
        entry.targets.some(
          (item) => item.kind === 'model' && !modelIds.has(item.id),
        )
      )
        issue('Unknown exact model', path);
      if (entry.kind === 'workflow advice') {
        if (!codingTaskIds.has(entry.taskId))
          issue('Unknown coding task', path);
      } else if (!entry.targets.some((item) => item.kind !== 'tool')) {
        issue('Finding requires an exact model or family', path);
      }
    }
  });

export const practitionerReview = practitionerSchema.parse(reviewed);
export type PractitionerReview = z.infer<typeof practitionerSchema>;
export type PractitionerFinding = z.infer<typeof finding>;

export const practitionerFamilies = [
  ...new Set(
    practitionerReview.findings.flatMap((entry) =>
      entry.kind === 'workflow advice'
        ? []
        : entry.targets.flatMap((item) =>
            item.kind === 'family' ? [item.id] : [],
          ),
    ),
  ),
];

export function findingsForTarget(ref: TargetRef | null) {
  if (!ref) return [];
  return practitionerReview.findings.filter(
    (entry) =>
      entry.kind !== 'workflow advice' &&
      entry.targets.some(
        (item) => item.kind === ref.kind && item.id === ref.target,
      ),
  );
}

export function adviceForTask(taskId: string) {
  return practitionerReview.findings.filter(
    (entry) => entry.kind === 'workflow advice' && entry.taskId === taskId,
  );
}
