import { z } from 'zod';
import rawSample from '../../research/hn-themes-sample.json' with { type: 'json' };

const text = z.string().trim().min(1);
const stance = z.enum(['positive', 'negative', 'mixed', 'neutral']);
const sampleSchema = z
  .object({
    checkedAt: z.iso.date(),
    method: z.object({
      label: text,
      selection: text,
      reviewer: text,
      limitations: text,
    }),
    themes: z.array(z.object({ id: text, label: text, description: text })),
    models: z.array(
      z.object({
        modelId: text,
        collectedCommentCount: z.number().int().nonnegative(),
        reviewedCommentCount: z.number().int().positive(),
        offTopicCount: z.number().int().nonnegative(),
      }),
    ),
    entries: z.array(
      z.object({
        id: z.number().int().positive(),
        createdAt: z.iso.datetime({ offset: true }),
        modelId: text,
        stance,
        summary: text.max(160),
        themes: z.array(text).min(1).max(3),
        task: text,
        tool: text.nullable(),
        comparedWith: z.array(
          z.object({
            name: text,
            verdict: z.enum(['better', 'worse', 'similar', 'unclear']),
          }),
        ),
      }),
    ),
  })
  .refine((sample) => {
    const themes = new Set(sample.themes.map((theme) => theme.id));
    const models = new Set(sample.models.map((model) => model.modelId));
    return sample.entries.every(
      (entry) =>
        models.has(entry.modelId) &&
        entry.themes.every((theme) => themes.has(theme)),
    );
  }, 'Unknown theme or model in the reviewed sample');

export const themeSample = sampleSchema.parse(rawSample);
export type ThemeEntry = (typeof themeSample)['entries'][number];
export type ThemeStance = z.infer<typeof stance>;
export type ThemeGroup = {
  id: string;
  label: string;
  entries: ThemeEntry[];
  stances: Record<ThemeStance, number>;
};

// Reviewed claims for one model, grouped by theme, largest group first.
export function themesFor(modelId: string) {
  const coverage = themeSample.models.find(
    (model) => model.modelId === modelId,
  );
  if (!coverage) return null;
  const entries = themeSample.entries.filter(
    (entry) => entry.modelId === modelId,
  );
  const groups: ThemeGroup[] = themeSample.themes
    .map((theme) => {
      const matching = entries.filter((entry) =>
        entry.themes.includes(theme.id),
      );
      const stances = { positive: 0, negative: 0, mixed: 0, neutral: 0 };
      for (const entry of matching) stances[entry.stance] += 1;
      return { id: theme.id, label: theme.label, entries: matching, stances };
    })
    .filter((group) => group.entries.length > 0)
    .sort((a, b) => b.entries.length - a.entries.length);
  const compared = new Map<
    string,
    { better: number; worse: number; similar: number; unclear: number }
  >();
  for (const entry of entries)
    for (const other of entry.comparedWith) {
      const found = compared.get(other.name) ?? {
        better: 0,
        worse: 0,
        similar: 0,
        unclear: 0,
      };
      found[other.verdict] += 1;
      compared.set(other.name, found);
    }
  return { coverage, entries, groups, compared };
}
