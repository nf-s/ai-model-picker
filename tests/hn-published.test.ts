import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hnIndexCommentSchema,
  hnPublishedSnapshotSchema,
  hnStorySchema,
  hnRunSchema,
  hnSettingSchema,
  hnTaskSchema,
  hnThemeSchema,
  parsePublishedCollection,
  parsePublishedComments,
  publishedCommentPage,
} from '../src/lib/hn-published.ts';
import { hnClassifierCheck } from '../src/lib/hn-schema.ts';

const startAt = '2026-05-16T00:00:00Z';
const endAt = '2026-11-16T00:00:00Z';
const publishedAt = '2026-11-16T00:05:00.123456+00:00';
const metadata = {
  schemaVersion: 1,
  updatedAt: endAt,
  classifier: hnClassifierCheck.classifierId,
  startAt,
  endAt,
};
const summary = {
  schemaVersion: 1,
  publishedAt,
  commentParts: 1,
  status: {
    ...metadata,
    state: 'blocked',
    reason: null,
    source: 'archive-and-tail',
    archiveRevision: null,
    firstItem: 1,
    lastItem: 100,
    totals: {
      itemsScanned: 100,
      commentsScanned: 40,
      commentsEligible: 38,
      candidates: 30,
      classified: 29,
      classificationFailures: 1,
      unavailable: 2,
      invalid: 0,
      failures: 1,
      partitionsComplete: 1,
      partitionsTotal: 1,
    },
    firstCommentAt: startAt,
    lastCommentAt: endAt,
    partitions: [],
    allPublicItemsScanned: false,
  },
  results: { ...metadata, models: [], families: [] },
};
const target = { kind: 'model', target: 'example-model' } satisfies {
  kind: 'model' | 'family';
  target: string;
};
const rows = Array.from({ length: 30 }, (_, index) => ({
  id: 30 - index,
  createdAt: index === 0 ? endAt : startAt,
  assessments:
    index === 0
      ? []
      : [
          {
            ...target,
            sentiment: index % 2 ? 'negative' : 'positive',
            confidence: 'medium',
            aspects: ['coding'],
          },
          {
            kind: 'family',
            target: 'Example family',
            sentiment: 'positive',
            confidence: 'high',
            aspects: [],
          },
        ],
}));
const collection = { schemaVersion: 1, publishedAt, comments: rows };
const snapshot = hnPublishedSnapshotSchema.parse(summary);

test('the published reader pages through all candidates and pairs filters on each label', () => {
  const comments = parsePublishedComments(snapshot, [collection]);
  assert.equal(comments[0]?.assessments.length, 0);
  const seen: number[] = [];
  let cursor = null;
  do {
    const page = publishedCommentPage(comments, null, null, cursor, 7);
    assert.equal(page.total, 30);
    seen.push(...page.rows.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(
    seen,
    rows.map((row) => row.id),
  );
  const positive = publishedCommentPage(comments, target, 'positive', null, 20);
  assert.equal(positive.total, 14);
  assert(positive.rows.every((row) => row.id % 2 === 0));
  const negative = publishedCommentPage(comments, target, 'negative', null, 20);
  assert.equal(negative.total, 15);
  assert(negative.rows.every((row) => row.id % 2 === 1));
  assert.equal(
    publishedCommentPage(comments, null, 'positive', null, 50).total,
    29,
  );
  assert.equal(
    publishedCommentPage(comments, null, null, 1, 7).nextCursor,
    null,
  );
});

test('the published reader rejects inconsistent revisions, date ranges, and item data', () => {
  assert.throws(() =>
    hnPublishedSnapshotSchema.parse({
      ...summary,
      results: { ...summary.results, startAt: endAt },
    }),
  );
  assert.throws(() =>
    parsePublishedComments(snapshot, [{ ...collection, publishedAt: endAt }]),
  );
  assert.throws(() =>
    parsePublishedComments(snapshot, [
      {
        ...collection,
        comments: rows.map((row) => ({ ...row, createdAt: publishedAt })),
      },
    ]),
  );
  assert.throws(() =>
    parsePublishedComments(snapshot, [
      { ...collection, comments: rows.map((row) => ({ ...row, id: 1 })) },
    ]),
  );
  assert.throws(() =>
    parsePublishedComments(snapshot, [
      {
        ...collection,
        comments: rows.map((row) => ({ ...row, by: 'synthetic-account' })),
      },
    ]),
  );
});

const reviewed = {
  id: 40,
  createdAt: endAt,
  assessments: [
    {
      ...target,
      sentiment: 'positive',
      confidence: 'high',
      aspects: ['coding'],
      themes: ['code-quality', 'speed'],
    },
  ],
  story: 7,
  parent: 39,
  task: 'coding',
  claim: 'Synthetic claim about the example model.',
  prefers: [
    {
      winner: target,
      loser: { kind: 'family', target: 'Example family' },
    },
  ],
};
const story = {
  id: 7,
  title: 'Synthetic story about a model',
  createdAt: startAt,
  about: [target],
  comments: 1,
};

test('task, setting, run and theme values match the pipeline lists', () => {
  assert.deepEqual(hnTaskSchema.options, [
    'code',
    'debug',
    'review',
    'plan',
    'interface',
    'research',
    'documents',
    'extraction',
    'writing',
    'maths',
    'chat',
    'read-media',
    'make-images',
    'none',
    'coding',
    'agents',
    'design',
    'reasoning',
    'images',
    'other',
  ]);
  assert.deepEqual(hnSettingSchema.options, ['local']);
  assert.deepEqual(hnRunSchema.options, ['unattended', 'parallel']);
  assert.equal(hnThemeSchema.options.length, 20);
  assert.equal(hnThemeSchema.options[0], 'code-quality');
  assert.equal(hnThemeSchema.options.at(-1), 'release');
});

test('published comments accept the old shape and the reviewed shape with stories', () => {
  assert.deepEqual(
    parsePublishedCollection(snapshot, [collection]).stories,
    [],
  );
  const listed = rows.slice(1);
  const current = hnPublishedSnapshotSchema.parse({
    ...summary,
    status: {
      ...summary.status,
      totals: {
        ...summary.status.totals,
        commentsAboutTargets: listed.length + 1,
        commentsQueued: 0,
        stories: 1,
        storiesPending: 0,
        threadComments: 3,
      },
    },
  });
  const parsed = parsePublishedCollection(current, [
    { ...collection, comments: [reviewed, ...listed], stories: [story] },
  ]);
  assert.deepEqual(parsed.comments[0], reviewed);
  const { parent, ...unparented } = reviewed;
  assert.equal(parent, 39);
  assert.deepEqual(hnIndexCommentSchema.parse(unparented), unparented);
  assert.deepEqual(parsed.stories, [story]);
  assert.throws(() =>
    parsePublishedCollection(current, [
      { ...collection, comments: listed, stories: [story] },
    ]),
  );
  assert.equal(
    hnStorySchema.parse({ ...story, createdAt: null, about: [] }).createdAt,
    null,
  );
});

test('published comments are read from every part of one export, in order', () => {
  const split = hnPublishedSnapshotSchema.parse({
    ...summary,
    commentParts: 2,
  });
  const first = { ...collection, comments: rows.slice(0, 12), stories: [] };
  const second = { ...collection, comments: rows.slice(12) };
  const parsed = parsePublishedCollection(split, [first, second]);
  assert.deepEqual(
    parsed.comments.map((comment) => comment.id),
    rows.map((row) => row.id),
  );
  assert.deepEqual(parsed.stories, []);
  // A missing part, a part of another export and parts out of order.
  assert.throws(() => parsePublishedCollection(split, [first]));
  assert.throws(() => parsePublishedCollection(snapshot, [first, second]));
  assert.throws(() =>
    parsePublishedCollection(split, [first, { ...second, publishedAt: endAt }]),
  );
  assert.throws(() => parsePublishedCollection(split, [second, first]));
  for (const commentParts of [0, 1.5, 17, undefined])
    assert.throws(() =>
      hnPublishedSnapshotSchema.parse({ ...summary, commentParts }),
    );
});

test('published comment fields reject unknown keys and unlisted values', () => {
  const assessment = reviewed.assessments[0];
  for (const invalid of [
    { ...reviewed, by: 'synthetic-account' },
    { ...reviewed, task: 'synthetic' },
    { ...reviewed, claim: 'x'.repeat(241) },
    { ...reviewed, claim: '' },
    { ...reviewed, story: 0 },
    { ...reviewed, parent: 0 },
    { ...reviewed, parent: -39 },
    { ...reviewed, parent: 1.5 },
    { ...reviewed, parent: '39' },
    { ...reviewed, parent: null },
    { ...reviewed, assessments: [{ ...assessment, themes: ['synthetic'] }] },
    {
      ...reviewed,
      assessments: [
        {
          ...assessment,
          themes: ['code-quality', 'speed', 'pricing', 'context'],
        },
      ],
    },
    { ...reviewed, assessments: [{ ...assessment, extra: true }] },
    {
      ...reviewed,
      prefers: [{ winner: target, loser: { ...target, extra: true } }],
    },
    { ...reviewed, prefers: [{ winner: target }] },
  ])
    assert.throws(() => hnIndexCommentSchema.parse(invalid));
  for (const invalid of [
    { ...story, title: 'x'.repeat(301) },
    { ...story, about: [{ kind: 'app', target: 'example' }] },
    { ...story, extra: true },
  ])
    assert.throws(() => hnStorySchema.parse(invalid));
});
