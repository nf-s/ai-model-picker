// A stand-in restricted payload for tests; the real one is kept outside Git.
export const restrictedFixture = {
  checkedAt: '2026-11-18',
  benchmarks: [
    {
      id: 'restricted-bench',
      name: 'Restricted benchmark',
      source: 'Example source',
      category: 'general',
      unit: 'points',
      description: 'A test benchmark.',
      methodology: 'Test methodology.',
      url: 'https://example.com/benchmark',
    },
  ],
  results: [
    {
      id: 'restricted-bench:1',
      modelId: 'claude-opus-5-5',
      benchmarkId: 'restricted-bench',
      score: 1,
      configuration: 'Test configuration',
      details: '',
      sourceUrl: 'https://example.com/benchmark',
    },
  ],
  sources: [],
  evidence: [],
  attributions: [],
};
