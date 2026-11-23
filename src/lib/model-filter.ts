import { z } from 'zod';
import { parseTargetKey, relatedNames } from './hn-insights.ts';
import type { CommentIndex } from './hn-insights.ts';

// The site-wide selection of models. A provider covers all of its models,
// including ones added to the data later; individual models are explicit.
export type ModelFilter = { providers: string[]; models: string[] };
export type CatalogueModel = { id: string; name: string; provider: string };
export type Catalogue = readonly CatalogueModel[];
export type ProviderOption = {
  provider: string;
  name: string;
  label: string;
  models: CatalogueModel[];
};
// What the current selection covers. `id` changes with the selection.
export type Scope = {
  id: string;
  active: boolean;
  model: (modelId: string) => boolean;
  provider: (provider: string) => boolean;
  key: (key: string) => boolean;
};
type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

export const emptyModelFilter: ModelFilter = { providers: [], models: [] };
export const filterStorageKey = 'model-picker:model-filter';

// The filter bar adds a period in months (0 for all dates), the source
// classes shown, the basis of named use records and whether only current
// models are listed. Named records are behind sign-in: without them the Named
// class and the basis have nothing to filter.
export const periods = [0, 24, 12, 6, 3] as const;
export const sourceClasses = ['measured', 'named', 'crowd'] as const;
// A use record's basis; a secondary source's "measured" counts as second-hand.
export const basisClasses = ['first', 'measured', 'second', 'vendor'] as const;
export type Period = (typeof periods)[number];
export type SourceClass = (typeof sourceClasses)[number];
export type BasisClass = (typeof basisClasses)[number];
export type FilterBar = ModelFilter & {
  period: Period;
  classes: SourceClass[];
  basis: BasisClass[];
  current: boolean;
};
export const defaultFilterBar: FilterBar = {
  ...emptyModelFilter,
  period: 0,
  classes: [...sourceClasses],
  basis: [...basisClasses],
  current: true,
};
// Selections stored before the filter bar hold providers and models only.
export const storedFilterSchema = z.object({
  providers: z.array(z.string()),
  models: z.array(z.string()),
  period: z.literal([...periods]).default(defaultFilterBar.period),
  classes: z.array(z.enum(sourceClasses)).default(defaultFilterBar.classes),
  basis: z.array(z.enum(basisClasses)).default(defaultFilterBar.basis),
  current: z.boolean().default(defaultFilterBar.current),
});

// The name people use for a provider's models where it differs from the
// company, and product lines whose family label shares no word with the
// provider or its models.
const providerNotes: Record<string, { known?: string; lines?: string[] }> = {
  OpenAI: { known: 'ChatGPT', lines: ['Codex', 'DALL-E', 'Sora'] },
  Anthropic: { known: 'Claude' },
  Google: { known: 'Gemini', lines: ['Gemma', 'Veo'] },
  xAI: { known: 'Grok' },
  Meta: { lines: ['Llama'] },
  Alibaba: { known: 'Qwen' },
  'Moonshot AI': { known: 'Kimi' },
  'Z.ai': { known: 'GLM' },
};

export function providerName(provider: string) {
  return providerNotes[provider]?.known ?? provider;
}

export function providerLabel(provider: string) {
  const known = providerNotes[provider]?.known;
  return known ? `${known} · ${provider}` : provider;
}

// Providers with the most models first.
export function providerOptions(catalogue: Catalogue): ProviderOption[] {
  const groups = new Map<string, CatalogueModel[]>();
  for (const model of catalogue) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups.entries()]
    .map(([provider, models]) => ({
      provider,
      name: providerName(provider),
      label: providerLabel(provider),
      models,
    }))
    .sort(
      (a, b) =>
        b.models.length - a.models.length ||
        a.provider.localeCompare(b.provider),
    );
}

export function filterActive(filter: ModelFilter) {
  return filter.providers.length > 0 || filter.models.length > 0;
}

// Drops duplicates and anything the catalogue does not contain.
export function cleanFilter(
  filter: ModelFilter,
  catalogue: Catalogue,
): ModelFilter {
  const providers = new Set(catalogue.map((model) => model.provider));
  const ids = new Set(catalogue.map((model) => model.id));
  return {
    providers: [...new Set(filter.providers)].filter((name) =>
      providers.has(name),
    ),
    models: [...new Set(filter.models)].filter((id) => ids.has(id)),
  };
}

function toggled(list: readonly string[], value: string) {
  return list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value];
}

export function toggleProvider(
  filter: ModelFilter,
  provider: string,
): ModelFilter {
  return { ...filter, providers: toggled(filter.providers, provider) };
}

export function toggleModel(filter: ModelFilter, modelId: string): ModelFilter {
  return { ...filter, models: toggled(filter.models, modelId) };
}

// The providers a family label belongs to: those with a model, a company name
// or a common name that shares its words, or that list it as a product line.
export function familyProviders(family: string, catalogue: Catalogue) {
  const found = new Set<string>();
  for (const model of catalogue)
    if (!found.has(model.provider) && relatedNames(family, model.name))
      found.add(model.provider);
  for (const provider of new Set(catalogue.map((model) => model.provider))) {
    const notes = providerNotes[provider];
    if (
      relatedNames(family, provider) ||
      (notes?.known !== undefined && relatedNames(family, notes.known)) ||
      notes?.lines?.includes(family)
    )
      found.add(provider);
  }
  return [...found];
}

// `alsoKey` is one target shown regardless of the selection, such as a model
// opened by a direct link.
export function createScope(
  filter: ModelFilter,
  catalogue: Catalogue,
  alsoKey: string | null = null,
): Scope {
  const active = filterActive(filter);
  const providers = new Set(filter.providers);
  const picked = new Set(filter.models);
  const byId = new Map(catalogue.map((model) => [model.id, model]));
  const also = alsoKey ? parseTargetKey(alsoKey) : null;
  const families = new Map<string, boolean>();
  function model(modelId: string) {
    if (!active || picked.has(modelId)) return true;
    if (also?.kind === 'model' && also.target === modelId) return true;
    const found = byId.get(modelId);
    return found !== undefined && providers.has(found.provider);
  }
  function family(name: string) {
    let known = families.get(name);
    if (known === undefined) {
      known =
        providers.size > 0 &&
        familyProviders(name, catalogue).some((provider) =>
          providers.has(provider),
        );
      families.set(name, known);
    }
    return known;
  }
  return {
    id: JSON.stringify([filter.providers, filter.models, alsoKey]),
    active,
    model,
    provider: (name) =>
      !active ||
      providers.has(name) ||
      filter.models.some((id) => byId.get(id)?.provider === name),
    key: (key) => {
      if (!active || key === alsoKey) return true;
      const ref = parseTargetKey(key);
      if (!ref) return false;
      return ref.kind === 'model' ? model(ref.target) : family(ref.target);
    },
  };
}

// The selection with a target added: a model by itself, a family by its
// providers. Null when a family belongs to no provider in the catalogue.
export function includeKey(
  filter: ModelFilter,
  key: string,
  catalogue: Catalogue,
): ModelFilter | null {
  const ref = parseTargetKey(key);
  if (!ref) return null;
  if (ref.kind === 'model')
    return catalogue.some((model) => model.id === ref.target)
      ? { ...filter, models: [...new Set([...filter.models, ref.target])] }
      : null;
  const owners = familyProviders(ref.target, catalogue);
  return owners.length > 0
    ? { ...filter, providers: [...new Set([...filter.providers, ...owners])] }
    : null;
}

// Selected providers by the name people use, then individually selected
// models that no selected provider already covers.
export function scopeNames(filter: ModelFilter, catalogue: Catalogue) {
  const byId = new Map(catalogue.map((model) => [model.id, model]));
  return [
    ...filter.providers.map(providerName),
    ...filter.models.flatMap((id) => {
      const model = byId.get(id);
      return model && !filter.providers.includes(model.provider)
        ? [model.name]
        : [];
    }),
  ];
}

export function scopeLabel(
  filter: ModelFilter,
  catalogue: Catalogue,
  limit = 3,
) {
  const names = scopeNames(filter, catalogue);
  if (names.length === 0) return 'All models';
  if (names.length <= limit) return names.join(', ');
  const shown = names.slice(0, limit - 1);
  return `${shown.join(', ')} + ${names.length - shown.length} more`;
}

// The comment index with only the labels the selection covers. Comments
// left without a label are dropped, so counts, rankings and co-mentions built
// from the result all follow the selection.
export function scopeIndex(
  index: CommentIndex,
  inScope: (key: string) => boolean,
): CommentIndex {
  return {
    weekStarts: index.weekStarts,
    stories: index.stories,
    detailed: index.detailed,
    rows: index.rows.flatMap((row) => {
      const assessments = row.assessments.filter((assessment) =>
        inScope(assessment.key),
      );
      if (assessments.length === 0) return [];
      const preferences = row.preferences?.filter(
        (pair) => inScope(pair.winner) && inScope(pair.loser),
      );
      return [
        {
          ...row,
          assessments,
          ...(preferences === undefined ? {} : { preferences }),
        },
      ];
    }),
  };
}

// The bar with the model selection cleaned, the classes and bases in their
// own order and at least one of each left on.
export function cleanFilterBar(
  bar: FilterBar,
  catalogue: Catalogue,
): FilterBar {
  const classes = sourceClasses.filter((cls) => bar.classes.includes(cls));
  const basis = basisClasses.filter((entry) => bar.basis.includes(entry));
  return {
    ...cleanFilter(bar, catalogue),
    period: bar.period,
    classes: classes.length > 0 ? classes : [...sourceClasses],
    basis: basis.length > 0 ? basis : [...basisClasses],
    current: bar.current,
  };
}

export function filterBarDefault(bar: FilterBar) {
  return (
    !filterActive(bar) &&
    bar.period === defaultFilterBar.period &&
    bar.current === defaultFilterBar.current &&
    sourceClasses.every((cls) => bar.classes.includes(cls)) &&
    basisClasses.every((entry) => bar.basis.includes(entry))
  );
}

// Turns one source class on or off. At least one class that the viewer can
// see stays on, so the bands never all disappear; null when the change would
// leave none.
export function toggleClass(
  classes: readonly SourceClass[],
  cls: SourceClass,
  available: readonly SourceClass[],
): SourceClass[] | null {
  const next = classes.includes(cls)
    ? classes.filter((entry) => entry !== cls)
    : [...classes, cls];
  return next.some((entry) => available.includes(entry)) ? next : null;
}

export function toggleBasis(
  basis: readonly BasisClass[],
  entry: BasisClass,
): BasisClass[] | null {
  const next = basis.includes(entry)
    ? basis.filter((value) => value !== entry)
    : [...basis, entry];
  return next.length > 0 ? next : null;
}

// Storage can be missing, blocked or hold anything, so every failure reads as
// the default bar and a failed write is ignored.
export function readStoredFilter(
  storage: StorageReader | null,
  catalogue: Catalogue,
): FilterBar {
  try {
    const raw = storage?.getItem(filterStorageKey);
    if (!raw) return defaultFilterBar;
    const parsed = storedFilterSchema.safeParse(JSON.parse(raw));
    return parsed.success
      ? cleanFilterBar(parsed.data, catalogue)
      : defaultFilterBar;
  } catch {
    return defaultFilterBar;
  }
}

export function writeStoredFilter(
  storage: StorageWriter | null,
  filter: FilterBar,
) {
  try {
    if (filterBarDefault(filter)) storage?.removeItem(filterStorageKey);
    else storage?.setItem(filterStorageKey, JSON.stringify(filter));
  } catch {
    // The selection still applies; it is only not remembered.
  }
}
