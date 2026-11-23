import assert from 'node:assert/strict';
import test from 'node:test';
import { arxivSnapshotSchema } from '../src/lib/arxiv-schema.ts';
import { buildInsights, indexComments } from '../src/lib/hn-insights.ts';
import type { HnIndexComment } from '../src/lib/hn-index.ts';
import {
  cleanFilter,
  createScope,
  defaultFilterBar,
  emptyModelFilter,
  familyProviders,
  filterActive,
  filterStorageKey,
  includeKey,
  providerLabel,
  providerName,
  providerOptions,
  readStoredFilter,
  scopeIndex,
  scopeLabel,
  scopePapers,
  sourceClasses,
  toggleBasis,
  toggleClass,
  toggleModel,
  toggleProvider,
  writeStoredFilter,
} from '../src/lib/model-filter.ts';
import type {
  Catalogue,
  FilterBar,
  ModelFilter,
} from '../src/lib/model-filter.ts';

const catalogue: Catalogue = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', provider: 'OpenAI' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', provider: 'OpenAI' },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', provider: 'Anthropic' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'Anthropic' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'Anthropic' },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', provider: 'Google' },
  { id: 'example-1', name: 'Example 1', provider: 'Example Labs' },
];
const openai: ModelFilter = { providers: ['OpenAI'], models: [] };
const fable: ModelFilter = { providers: [], models: ['claude-fable-5-2'] };
const mixed: ModelFilter = {
  providers: ['OpenAI'],
  models: ['claude-fable-5-2'],
};
const never = () => false;

test('providers carry the name people use beside the company', () => {
  assert.equal(providerName('OpenAI'), 'ChatGPT');
  assert.equal(providerLabel('OpenAI'), 'ChatGPT · OpenAI');
  assert.equal(providerLabel('Anthropic'), 'Claude · Anthropic');
  assert.equal(providerName('Example Labs'), 'Example Labs');
  assert.equal(providerLabel('Example Labs'), 'Example Labs');
  assert.deepEqual(
    providerOptions(catalogue).map((option) => [
      option.provider,
      option.models.length,
    ]),
    [
      ['Anthropic', 3],
      ['OpenAI', 2],
      ['Example Labs', 1],
      ['Google', 1],
    ],
  );
});

test('selections toggle, and stored values lose what the catalogue lacks', () => {
  assert.equal(filterActive(emptyModelFilter), false);
  const picked = toggleModel(
    toggleProvider(emptyModelFilter, 'OpenAI'),
    'claude-fable-5-2',
  );
  assert.deepEqual(picked, mixed);
  assert.equal(filterActive(picked), true);
  assert.deepEqual(
    toggleModel(toggleProvider(picked, 'OpenAI'), 'claude-fable-5-2'),
    emptyModelFilter,
  );
  assert.deepEqual(
    cleanFilter(
      {
        providers: ['OpenAI', 'OpenAI', 'Retired Labs'],
        models: ['claude-opus-5', 'retired-1', 'claude-opus-5'],
      },
      catalogue,
    ),
    { providers: ['OpenAI'], models: ['claude-opus-5'] },
  );
});

test('with no selection everything is in scope', () => {
  const scope = createScope(emptyModelFilter, catalogue);
  assert.equal(scope.active, false);
  assert.equal(scope.model('gemini-4-carbon'), true);
  assert.equal(scope.model('not-in-the-catalogue'), true);
  assert.equal(scope.provider('Google'), true);
  assert.equal(scope.key('family:Llama'), true);
  assert.equal(scope.key('not a key'), true);
});

test('a provider covers its models and its family labels', () => {
  const scope = createScope(openai, catalogue);
  assert.equal(scope.active, true);
  assert.equal(scope.model('gpt-6-astra'), true);
  assert.equal(scope.model('claude-opus-5-5'), false);
  assert.equal(scope.model('not-in-the-catalogue'), false);
  assert.equal(scope.provider('OpenAI'), true);
  assert.equal(scope.provider('Anthropic'), false);
  assert.equal(scope.key('model:gpt-6-sol'), true);
  // Related to a model name, to the company name, and a listed product line.
  assert.equal(scope.key('family:GPT'), true);
  assert.equal(scope.key('family:OpenAI o-series'), true);
  assert.equal(scope.key('family:Codex'), true);
  assert.equal(scope.key('family:Claude'), false);
  assert.equal(scope.key('family:Llama'), false);
  assert.equal(scope.key('model:gemini-4-carbon'), false);
  assert.equal(scope.key('not a key'), false);

  const claude = createScope({ providers: ['Anthropic'], models: [] }, [
    ...catalogue,
    { id: 'claude-next', name: 'Claude Next', provider: 'Anthropic' },
  ]);
  assert.equal(claude.model('claude-next'), true);
  assert.equal(claude.key('family:Claude'), true);
  assert.equal(claude.key('family:Claude Opus'), true);
  assert.equal(claude.key('family:GPT'), false);
});

test('an individual model covers only its own label', () => {
  const scope = createScope(fable, catalogue);
  assert.equal(scope.model('claude-fable-5-2'), true);
  assert.equal(scope.model('claude-opus-5-5'), false);
  assert.equal(scope.key('model:claude-fable-5-2'), true);
  assert.equal(scope.key('family:Claude'), false);
  assert.equal(scope.key('family:Claude Fable'), false);
  // The provider has a model in scope, without being selected whole.
  assert.equal(scope.provider('Anthropic'), true);
  assert.equal(scope.provider('OpenAI'), false);
});

test('a mixed selection is the union', () => {
  const scope = createScope(mixed, catalogue);
  assert.equal(scope.key('model:gpt-6-astra'), true);
  assert.equal(scope.key('family:GPT'), true);
  assert.equal(scope.key('model:claude-fable-5-2'), true);
  assert.equal(scope.key('family:Claude'), false);
  assert.equal(scope.key('model:claude-opus-5-5'), false);
  assert.notEqual(scope.id, createScope(openai, catalogue).id);
});

test('one target can be shown regardless of the selection', () => {
  const model = createScope(openai, catalogue, 'model:gemini-4-carbon');
  assert.equal(model.model('gemini-4-carbon'), true);
  assert.equal(model.key('model:gemini-4-carbon'), true);
  assert.equal(model.key('family:Gemini'), false);
  assert.notEqual(model.id, createScope(openai, catalogue).id);
  const family = createScope(fable, catalogue, 'family:Claude');
  assert.equal(family.key('family:Claude'), true);
  assert.equal(family.key('model:claude-opus-5-5'), false);
});

test('family labels map to providers', () => {
  assert.deepEqual(familyProviders('Claude Opus', catalogue), ['Anthropic']);
  assert.deepEqual(familyProviders('Gemma', catalogue), ['Google']);
  assert.deepEqual(familyProviders('Example', catalogue), ['Example Labs']);
  assert.deepEqual(familyProviders('Llama', catalogue), []);
  // A version label belongs to its provider through the common name.
  assert.deepEqual(familyProviders('Claude Opus 5.1', catalogue), [
    'Anthropic',
  ]);
});

test('a target can be added to the selection', () => {
  assert.deepEqual(includeKey(openai, 'model:claude-fable-5-2', catalogue), {
    providers: ['OpenAI'],
    models: ['claude-fable-5-2'],
  });
  assert.deepEqual(
    includeKey(mixed, 'model:claude-fable-5-2', catalogue),
    mixed,
  );
  assert.deepEqual(includeKey(fable, 'family:Claude', catalogue), {
    providers: ['Anthropic'],
    models: ['claude-fable-5-2'],
  });
  assert.equal(
    includeKey(openai, 'model:not-in-the-catalogue', catalogue),
    null,
  );
  assert.equal(includeKey(openai, 'family:Llama', catalogue), null);
  assert.equal(includeKey(openai, 'not a key', catalogue), null);
});

test('the label names the selection and stays short', () => {
  assert.equal(scopeLabel(emptyModelFilter, catalogue), 'All models');
  assert.equal(
    scopeLabel({ providers: ['OpenAI', 'Anthropic'], models: [] }, catalogue),
    'ChatGPT, Claude',
  );
  assert.equal(
    scopeLabel(
      { providers: [], models: ['claude-fable-5-2', 'claude-opus-5-5'] },
      catalogue,
    ),
    'Claude Fable 5.2, Claude Opus 5.5',
  );
  // A model its provider already covers is not named twice.
  assert.equal(
    scopeLabel({ providers: ['OpenAI'], models: ['gpt-6-sol'] }, catalogue),
    'ChatGPT',
  );
  assert.equal(
    scopeLabel(
      {
        providers: ['OpenAI', 'Google'],
        models: ['claude-fable-5-2', 'claude-opus-5-5'],
      },
      catalogue,
    ),
    'ChatGPT, Gemini + 2 more',
  );
});

const label = (
  kind: 'model' | 'family',
  target: string,
  sentiment: 'positive' | 'negative',
): HnIndexComment['assessments'][number] => ({
  kind,
  target,
  sentiment,
  aspects: [],
  confidence: 'high',
});
const comments: HnIndexComment[] = [
  {
    id: 3,
    createdAt: '2026-06-16T10:00:00Z',
    assessments: [
      label('model', 'gpt-6-astra', 'positive'),
      label('model', 'gemini-4-carbon', 'negative'),
      label('model', 'claude-fable-5-2', 'negative'),
    ],
  },
  {
    id: 2,
    createdAt: '2026-06-09T10:00:00Z',
    assessments: [label('family', 'Claude', 'positive')],
  },
  {
    id: 1,
    createdAt: '2026-06-02T10:00:00Z',
    assessments: [label('family', 'GPT', 'positive')],
  },
];

test('the comment index keeps only labels in scope', () => {
  const index = indexComments(comments);
  const scoped = scopeIndex(index, createScope(mixed, catalogue).key);
  assert.deepEqual(scoped.weekStarts, index.weekStarts);
  assert.deepEqual(
    scoped.rows.map((row) => [
      row.id,
      row.assessments.map((assessment) => assessment.key),
    ]),
    [
      [3, ['model:gpt-6-astra', 'model:claude-fable-5-2']],
      [1, ['family:GPT']],
    ],
  );
  // Co-mentions built from the scoped index follow the selection.
  const insights = buildInsights(scoped, never);
  assert.equal(insights.commentCount, 2);
  assert.deepEqual(
    [...(insights.targets.get('model:gpt-6-astra')?.pairs.keys() ?? [])],
    ['model:claude-fable-5-2'],
  );
  assert.equal(insights.targets.has('model:gemini-4-carbon'), false);
  assert.equal(scopeIndex(index, never).rows.length, 0);
});

test('the comment index keeps only stated preferences with both sides in scope', () => {
  const [first, ...rest] = comments;
  assert.ok(first);
  const index = indexComments([
    {
      ...first,
      task: 'coding',
      claim: 'Synthetic claim about three models.',
      prefers: [
        {
          winner: { kind: 'model', target: 'gpt-6-astra' },
          loser: { kind: 'model', target: 'claude-fable-5-2' },
        },
        {
          winner: { kind: 'model', target: 'gpt-6-astra' },
          loser: { kind: 'model', target: 'gemini-4-carbon' },
        },
      ],
    },
    ...rest,
  ]);
  const scoped = scopeIndex(index, createScope(mixed, catalogue).key);
  assert.equal(scoped.detailed, true);
  const [row, other] = scoped.rows;
  assert.ok(row && other);
  assert.equal(row.task, 'coding');
  assert.equal(row.claim, 'Synthetic claim about three models.');
  assert.deepEqual(row.preferences, [
    { winner: 'model:gpt-6-astra', loser: 'model:claude-fable-5-2' },
  ]);
  assert.equal('preferences' in other, false);
  const insights = buildInsights(scoped, never);
  assert.deepEqual(
    [...(insights.targets.get('model:gpt-6-astra')?.preferences ?? [])],
    [['model:claude-fable-5-2', { over: 1, under: 0 }]],
  );
});

const counts = {
  usage: 0,
  evaluation: 0,
  application: 0,
  behaviour: 0,
  release: 0,
  survey: 0,
  other: 0,
};
const topics = {
  prompting: 0,
  context: 0,
  reasoning: 0,
  agents: 0,
  tools: 0,
  retrieval: 0,
  'structured-output': 0,
  coding: 0,
  cost: 0,
  safety: 0,
  multimodal: 0,
  'fine-tuning': 0,
};
const snapshot = arxivSnapshotSchema.parse({
  schemaVersion: 1,
  updatedAt: '2026-11-17T11:05:57Z',
  assessor: null,
  startAt: '2026-05-16T14:00:00Z',
  coverage: {
    state: 'complete',
    firstDay: '2026-05-16',
    lastDay: '2026-11-17',
    daysComplete: 186,
    daysTotal: 186,
    recordsScanned: 200,
    recordsEligible: 150,
    papers: 3,
    assessed: 0,
    assessmentFailures: 0,
    results: 0,
    resultFailures: 0,
  },
  models: [
    {
      modelId: 'gpt-6-astra',
      papers: 2,
      months: {},
      kinds: counts,
      topics,
    },
    {
      modelId: 'gemini-4-carbon',
      papers: 2,
      months: {},
      kinds: counts,
      topics,
    },
  ],
  families: [
    { familyName: 'Claude', papers: 1, months: {}, kinds: counts, topics },
    { familyName: 'GPT', papers: 1, months: {}, kinds: counts, topics },
  ],
  papers: [
    {
      id: '2611.00003',
      title: 'Two Models Compared',
      submittedAt: '2026-11-10T09:00:00Z',
      categories: ['cs.CL'],
      targets: [
        { kind: 'model', target: 'gpt-6-astra' },
        { kind: 'model', target: 'gemini-4-carbon' },
      ],
      assessment: null,
      result: null,
    },
    {
      id: '2611.00002',
      title: 'One Model and a Family',
      submittedAt: '2026-11-09T09:00:00Z',
      categories: ['cs.CL'],
      targets: [
        { kind: 'model', target: 'gemini-4-carbon' },
        { kind: 'family', target: 'Claude' },
      ],
      assessment: null,
      result: null,
    },
    {
      id: '2611.00001',
      title: 'Two Labels for One Provider',
      submittedAt: '2026-11-08T09:00:00Z',
      categories: ['cs.CL'],
      targets: [
        { kind: 'model', target: 'gpt-6-astra' },
        { kind: 'family', target: 'GPT' },
      ],
      assessment: null,
      result: null,
    },
  ],
});

test('the paper index keeps only targets in scope', () => {
  const scoped = scopePapers(snapshot, createScope(openai, catalogue).key);
  assert.deepEqual(
    scoped.models.map((row) => row.modelId),
    ['gpt-6-astra'],
  );
  assert.deepEqual(
    scoped.families.map((row) => row.familyName),
    ['GPT'],
  );
  assert.deepEqual(
    scoped.papers.map((paper) => [
      paper.id,
      paper.targets.map((ref) => ref.target),
    ]),
    [
      ['2611.00003', ['gpt-6-astra']],
      ['2611.00001', ['gpt-6-astra', 'GPT']],
    ],
  );
  assert.equal(scoped.coverage, snapshot.coverage);
  assert.equal(scopePapers(snapshot, never).papers.length, 0);
});

function memory(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => (key === filterStorageKey ? value : null),
    setItem: (key: string, next: string) => {
      if (key === filterStorageKey) value = next;
    },
    removeItem: (key: string) => {
      if (key === filterStorageKey) value = null;
    },
    read: () => value,
  };
}
const blocked = {
  getItem: (): string => {
    throw new Error('Storage is blocked.');
  },
  setItem: () => {
    throw new Error('Storage is blocked.');
  },
  removeItem: () => {
    throw new Error('Storage is blocked.');
  },
};

test('the selection survives a reload', () => {
  const storage = memory();
  const bar: FilterBar = { ...defaultFilterBar, ...mixed };
  writeStoredFilter(storage, bar);
  assert.deepEqual(readStoredFilter(storage, catalogue), bar);
  const narrowed: FilterBar = {
    ...defaultFilterBar,
    period: 6,
    classes: ['crowd'],
    current: false,
  };
  writeStoredFilter(storage, narrowed);
  assert.deepEqual(readStoredFilter(storage, catalogue), narrowed);
  writeStoredFilter(storage, defaultFilterBar);
  assert.equal(storage.read(), null);
  assert.deepEqual(readStoredFilter(storage, catalogue), defaultFilterBar);
});

test('a selection stored before the filter bar keeps its models', () => {
  assert.deepEqual(
    readStoredFilter(
      memory('{"providers":["OpenAI"],"models":["claude-fable-5-2"]}'),
      catalogue,
    ),
    { ...defaultFilterBar, ...mixed },
  );
});

test('unusable storage reads as the default bar', () => {
  const bar: FilterBar = { ...defaultFilterBar, ...mixed };
  assert.deepEqual(readStoredFilter(null, catalogue), defaultFilterBar);
  assert.deepEqual(readStoredFilter(blocked, catalogue), defaultFilterBar);
  assert.doesNotThrow(() => writeStoredFilter(blocked, bar));
  assert.doesNotThrow(() => writeStoredFilter(blocked, defaultFilterBar));
  assert.doesNotThrow(() => writeStoredFilter(null, bar));
  for (const stored of [
    'not json',
    '[]',
    '"OpenAI"',
    '{"providers":"OpenAI","models":[]}',
    '{"providers":[1],"models":[]}',
    '{"providers":["OpenAI"]}',
    '{"providers":[],"models":[],"period":5}',
    '{"providers":[],"models":[],"classes":["usage"]}',
    '{"providers":[],"models":[],"basis":["hearsay"]}',
    '{"providers":[],"models":[],"current":"yes"}',
  ])
    assert.deepEqual(
      readStoredFilter(memory(stored), catalogue),
      defaultFilterBar,
      stored,
    );
  assert.deepEqual(
    readStoredFilter(
      memory('{"providers":["Retired Labs","OpenAI"],"models":["retired-1"]}'),
      catalogue,
    ),
    { ...defaultFilterBar, ...openai },
  );
  assert.deepEqual(
    readStoredFilter(
      memory('{"providers":[],"models":[],"classes":[]}'),
      catalogue,
    ),
    defaultFilterBar,
    'at least one source class stays on',
  );
  assert.deepEqual(
    readStoredFilter(
      memory('{"providers":[],"models":[],"basis":["second","first"]}'),
      catalogue,
    ),
    { ...defaultFilterBar, basis: ['first', 'second'] },
    'bases keep their own order',
  );
});

test('a source class or basis toggle never leaves nothing to show', () => {
  // Without sign-in only Measured and Crowd can be seen, so one of them stays on.
  const signedOut = ['measured', 'crowd'] as const;
  assert.deepEqual(
    toggleClass(['measured', 'named', 'crowd'], 'crowd', signedOut),
    ['measured', 'named'],
  );
  assert.equal(toggleClass(['measured', 'named'], 'measured', signedOut), null);
  assert.deepEqual(
    toggleClass(['measured', 'named'], 'measured', sourceClasses),
    ['named'],
  );
  assert.deepEqual(toggleBasis(['first', 'second'], 'second'), ['first']);
  assert.equal(toggleBasis(['vendor'], 'vendor'), null);
});
