import { z } from 'zod';
import rawGuide from '../../research/app-model-choices.json' with { type: 'json' };
import rawSnapshot from './snapshot.json' with { type: 'json' };
const { models, reports, results } = rawSnapshot;

const text = z.string().trim().min(1);
const recommendation = z.object({ choiceId: text, why: text });
export const guideSchema = z
  .object({
    checkedAt: z.iso.date(),
    plans: z.array(
      z.object({
        id: z.enum(['chatgpt', 'claude']),
        name: text,
        usage: text,
        sourceIds: z.array(text).min(1),
      }),
    ),
    choices: z.array(
      z.object({
        id: text,
        planId: z.enum(['chatgpt', 'claude']),
        name: text,
        surface: z.enum([
          'ChatGPT',
          'ChatGPT Work',
          'ChatGPT Work / Codex',
          'Codex',
          'Claude',
          'Claude Code',
        ]),
        setting: text,
        modelId: text.optional(),
        summary: text,
        sourceIds: z.array(text).min(1),
      }),
    ),
    tasks: z.array(
      z.object({
        id: text,
        label: text,
        default: recommendation,
        codingDefault: recommendation.optional(),
        alternatives: z.array(
          z.object({ choiceId: text, when: text, tradeoff: text }),
        ),
        evidence: z.array(
          z.object({
            kind: z.enum(['result', 'report']),
            id: text,
            note: text,
          }),
        ),
      }),
    ),
    sources: z.array(z.object({ id: text, name: text, url: z.httpUrl() })),
  })
  .superRefine((guide, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: 'custom', message });
    for (const entries of [
      guide.plans,
      guide.choices,
      guide.tasks,
      guide.sources,
    ])
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        issue('Duplicate guide identifier');
    const choiceIds = new Set(guide.choices.map((choice) => choice.id));
    const sourceIds = new Set(guide.sources.map((source) => source.id));
    for (const entry of [...guide.plans, ...guide.choices])
      for (const id of entry.sourceIds)
        if (!sourceIds.has(id)) issue('Unknown guide source');
    for (const choice of guide.choices)
      if (
        choice.modelId &&
        !models.some((model) => model.id === choice.modelId)
      )
        issue('Unknown model reference');
    for (const task of guide.tasks) {
      for (const item of [
        task.default,
        ...task.alternatives,
        ...(task.codingDefault ? [task.codingDefault] : []),
      ])
        if (!choiceIds.has(item.choiceId))
          issue('Unknown recommendation choice');
      for (const evidence of task.evidence)
        if (
          !(evidence.kind === 'result' ? results : reports).some(
            (item) => item.id === evidence.id,
          )
        )
          issue('Unknown supporting evidence');
    }
  });
export const guide = guideSchema.parse(rawGuide);
export type AppChoice = z.infer<typeof guideSchema>['choices'][number];
export type GuideTask = z.infer<typeof guideSchema>['tasks'][number];
export type ChoiceMode = 'chat' | 'coding';
export type AppFilter = 'both' | 'chatgpt' | 'claude';
export function taskOptions(task: GuideTask, mode: ChoiceMode) {
  const primary = mode === 'coding' ? task.codingDefault : task.default;
  if (!primary) return [];
  const recommendations = [
    {
      choiceId: primary.choiceId,
      when: primary.why,
      tradeoff: '',
      preferred: true,
    },
    ...task.alternatives.map((option) => ({ ...option, preferred: false })),
  ];
  return recommendations.flatMap((option) => {
    const choice = guide.choices.find((entry) => entry.id === option.choiceId);
    if (!choice) return [];
    const chat = choice.surface === 'ChatGPT' || choice.surface === 'Claude';
    return chat === (mode === 'chat') ? [{ ...option, choice }] : [];
  });
}
