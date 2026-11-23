import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  commentText,
  createCommentReader,
  publicItem,
  readReaderRequest,
} from '../scripts/hn-comments.mjs';

const start = 1_778_853_600;
const end = start + 100_000;
const select = (path) =>
  readReaderRequest(new URL(path, 'http://127.0.0.1:5187'));

test('public comments preserve paragraph and quote wording as text without account fields', () => {
  const item = publicItem(
    {
      id: 10,
      type: 'comment',
      time: start,
      parent: 1,
      kids: [11, 11, 12],
      by: 'synthetic-account',
      text: '<p>Example &amp; &#x27;quote&#39;.<blockquote>Quoted words</blockquote><pre>const example = &lt;value&gt;;</pre><script>bad()</script>',
    },
    10,
  );
  assert.equal(
    item.text,
    "Example & 'quote'.\n\n> Quoted words\n\nconst example = <value>;",
  );
  assert.deepEqual(item.replyIds, [11, 12]);
  assert.equal('by' in item, false);
  assert.equal('textHtml' in item, false);
  assert.equal(
    commentText('&lt;img src=x onerror=bad()&gt;'),
    '<img src=x onerror=bad()>',
  );
  assert.equal(
    publicItem(
      { id: 10, deleted: true, text: 'Hidden content', kids: [11] },
      10,
    ).text,
    '',
  );
  assert.equal(publicItem(null, 10).unavailable, true);
  assert.throws(() => publicItem({ id: 11, type: 'comment' }, 10));
  assert.throws(() => publicItem({ id: 10, kids: ['11'] }, 10));
});

test('reader routes validate identifiers, paired filters and bounded pagination', () => {
  assert.equal(select('/api/hn/start'), null);
  assert.equal(select('/api/hn/index/1'), null);
  assert.equal(select('/api/hn/index').route, 'index');
  assert.equal(select('/api/hn/comments').limit, 20);
  for (const path of [
    '/api/hn/comments?limit=0',
    '/api/hn/comments?limit=51',
    '/api/hn/comments?before=-1',
    '/api/hn/comments?before=0',
    '/api/hn/comments?kind=model',
    '/api/hn/comments?target=test',
    '/api/hn/comments?kind=other&target=test',
    '/api/hn/comments?sentiment=bad',
    '/api/hn/comments?limit=10&limit=20',
    '/api/hn/comments?path=/tmp/data',
    '/api/hn/thread/0',
    '/api/hn/thread/4294967296',
    '/api/hn/thread/5?limit=10',
    '/api/hn/replies/5?after=4294967296',
    '/api/hn/index?limit=10',
  ])
    assert.throws(() => select(path), undefined, path);
});

// Same columns as the checkpoint tables in scripts/hn_local/state.py.
const checkpointSchema = `
  CREATE TABLE run (
    id INTEGER PRIMARY KEY CHECK (id = 1), source TEXT NOT NULL, archive_revision TEXT,
    first_item INTEGER NOT NULL, last_item INTEGER NOT NULL, classifier TEXT NOT NULL,
    classifier_key TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL, reason TEXT,
    full_range INTEGER NOT NULL, retry_failures INTEGER NOT NULL DEFAULT 0,
    start_at INTEGER, end_at INTEGER);
  CREATE TABLE comment (
    item_id INTEGER NOT NULL, classifier_key TEXT NOT NULL, digest TEXT NOT NULL,
    created INTEGER NOT NULL, priority INTEGER NOT NULL, failed_groups INTEGER,
    parent INTEGER, root INTEGER, mention INTEGER NOT NULL DEFAULT 1, task TEXT, claim TEXT,
    PRIMARY KEY (item_id, classifier_key));
  CREATE TABLE assessment (
    item_id INTEGER NOT NULL, classifier_key TEXT NOT NULL, kind TEXT NOT NULL,
    target TEXT NOT NULL, sentiment TEXT NOT NULL, aspects TEXT NOT NULL,
    confidence TEXT NOT NULL, failed INTEGER NOT NULL DEFAULT 0,
    themes TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (item_id, classifier_key, kind, target));
  CREATE TABLE preference (
    item_id INTEGER NOT NULL, classifier_key TEXT NOT NULL, winner_kind TEXT NOT NULL,
    winner TEXT NOT NULL, loser_kind TEXT NOT NULL, loser TEXT NOT NULL,
    PRIMARY KEY (item_id, classifier_key, winner_kind, winner, loser_kind, loser));
  CREATE TABLE story (
    item_id INTEGER PRIMARY KEY, created INTEGER, title TEXT NOT NULL,
    targets TEXT NOT NULL DEFAULT '[]', certain INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending', comments INTEGER NOT NULL DEFAULT 0);
`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hn-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'checkpoint.sqlite3'));
  db.exec(checkpointSchema);
  db.prepare(
    `INSERT INTO run (id, source, first_item, last_item, classifier, classifier_key, state,
       updated, full_range, start_at, end_at)
     VALUES (1, 'firebase', 1, 2000, 'synthetic', ?, 'paused', ?, 0, ?, ?)`,
  ).run('current', end, start, end);
  const comment = db.prepare(
    `INSERT INTO comment (item_id, classifier_key, digest, created, priority, failed_groups,
       root, task, claim) VALUES (?, ?, '', ?, 0, ?, ?, ?, ?)`,
  );
  const label = db.prepare(
    'INSERT INTO assessment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (let id = 1001; id <= 1030; id += 1) {
    comment.run(id, 'current', start + id, 0, null, null, null);
    label.run(
      id,
      'current',
      'model',
      'example-model',
      id % 2 ? 'positive' : 'negative',
      '["coding"]',
      'high',
      0,
      '[]',
    );
  }
  for (const [id, key, date] of [
    [1040, 'old', start],
    [1041, 'current', start - 1],
    [1042, 'current', end + 1],
  ]) {
    comment.run(id, key, date, 0, null, null, null);
    label.run(
      id,
      key,
      'model',
      'example-model',
      'positive',
      '[]',
      'high',
      0,
      '[]',
    );
  }
  label.run(
    1030,
    'current',
    'family',
    'Example family',
    'positive',
    '[]',
    'medium',
    0,
    '[]',
  );
  // Queued, failed and off-topic comments are never listed.
  comment.run(1031, 'current', start + 1031, null, 503, null, null);
  comment.run(1032, 'current', start + 1032, 1, 503, null, null);
  label.run(
    1032,
    'current',
    'model',
    'example-model',
    'unclear',
    '[]',
    'low',
    1,
    '[]',
  );
  comment.run(1033, 'current', start + 1033, 0, 503, 'chat', null);
  // Newer reviews carry thread, task, claim, themes and preferences.
  db.prepare(
    'UPDATE comment SET root = ?, task = ?, claim = ? WHERE item_id = ?',
  ).run(500, 'coding', 'Synthetic claim about the example model.', 1029);
  db.prepare('UPDATE comment SET root = ? WHERE item_id IN (?, ?)').run(
    500,
    1028,
    1022,
  );
  db.prepare('UPDATE comment SET root = ? WHERE item_id = ?').run(501, 1027);
  db.prepare('UPDATE comment SET parent = ? WHERE item_id = ?').run(900, 1029);
  db.prepare('UPDATE comment SET root = ? WHERE item_id = ?').run(502, 1026);
  db.prepare('UPDATE assessment SET themes = ? WHERE item_id = ?').run(
    '["code-quality","speed"]',
    1029,
  );
  db.prepare('INSERT INTO preference VALUES (?, ?, ?, ?, ?, ?)').run(
    1029,
    'current',
    'model',
    'example-model',
    'family',
    'Example family',
  );
  const story = db.prepare(
    'INSERT INTO story (item_id, created, title, targets, state) VALUES (?, ?, ?, ?, ?)',
  );
  story.run(
    500,
    start + 5,
    'Synthetic story about a model',
    '[["model","example-model"]]',
    'expanded',
  );
  story.run(501, null, 'Synthetic context story', '[]', 'context');
  story.run(
    503,
    start + 6,
    'Synthetic story with only unlisted comments',
    '[["model","example-model"]]',
    'expanded',
  );
  db.close();
  return directory;
}

function update(directory, sql, ...values) {
  const db = new DatabaseSync(join(directory, 'checkpoint.sqlite3'));
  db.prepare(sql).run(...values);
  db.close();
}

const syntheticItems = async (url) => {
  const id = Number(
    new URL(url).pathname.split('/').at(-1).replace('.json', ''),
  );
  return Response.json({
    id,
    type: 'comment',
    time: start + id,
    text: 'Synthetic example.',
    parent: 1,
  });
};

test('all collected comments paginate beyond preview limits and stay inside current run dates', async (t) => {
  const directory = await fixture(t);
  const read = createCommentReader(directory, async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const id = Number(
      new URL(url).pathname.split('/').at(-1).replace('.json', ''),
    );
    return Response.json({
      id,
      type: 'comment',
      time: start + id,
      text: 'Synthetic example.',
      parent: 1,
    });
  });
  const seen = [];
  let cursor = null;
  do {
    const page = await read(
      select(`/api/hn/comments?limit=7${cursor ? `&before=${cursor}` : ''}`),
    );
    assert.equal(page.total, 30);
    seen.push(...page.comments.map((entry) => entry.item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30);
  assert.equal(seen[0], 1030);
  assert.equal(seen.at(-1), 1001);
  const positive = await read(
    select(
      '/api/hn/comments?kind=model&target=example-model&sentiment=positive',
    ),
  );
  assert.equal(positive.total, 15);
  assert(positive.comments.every((entry) => entry.item.id % 2 === 1));
  const family = await read(
    select('/api/hn/comments?kind=family&target=Example%20family'),
  );
  assert.equal(family.total, 1);
  assert.equal(family.comments[0].assessments.length, 2);
  const injection = await read(
    select('/api/hn/comments?kind=model&target=%27%20OR%201%3D1%20--'),
  );
  assert.equal(injection.total, 0);
});

test('the comment index lists every label in the current run without fetching text', async (t) => {
  const directory = await fixture(t);
  const read = createCommentReader(directory, async () => {
    throw new Error('The index must not request comment text.');
  });
  const index = await read(select('/api/hn/index'));
  assert.equal(index.startAt, new Date(start * 1000).toISOString());
  assert.equal(index.endAt, new Date(end * 1000).toISOString());
  assert.equal(index.comments.length, 30);
  assert.equal(index.comments[0].id, 1030);
  assert.equal(index.comments.at(-1).id, 1001);
  assert.deepEqual(index.comments[0].assessments, [
    {
      kind: 'family',
      target: 'Example family',
      sentiment: 'positive',
      aspects: [],
      confidence: 'medium',
    },
    {
      kind: 'model',
      target: 'example-model',
      sentiment: 'negative',
      aspects: ['coding'],
      confidence: 'high',
    },
  ]);
  assert.equal('text' in index.comments[0], false);
  const empty = await mkdtemp(join(tmpdir(), 'hn-reader-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.deepEqual(await createCommentReader(empty)(select('/api/hn/index')), {
    startAt: null,
    endAt: null,
    comments: [],
    stories: [],
  });
});

test('queued, failed and off-topic comments are left out of the index, pages and totals', async (t) => {
  const directory = await fixture(t);
  const read = createCommentReader(directory, syntheticItems);
  const index = await read(select('/api/hn/index'));
  const ids = index.comments.map((comment) => comment.id);
  for (const id of [1031, 1032, 1033]) assert(!ids.includes(id), String(id));
  const page = await read(select('/api/hn/comments?limit=50'));
  assert.equal(page.total, 30);
  assert.equal(page.comments[0].item.id, 1030);
  const failed = await read(
    select(
      '/api/hn/comments?kind=model&target=example-model&sentiment=unclear',
    ),
  );
  assert.equal(failed.total, 0);
});

test('review details, stories and preferences appear only for newer reviews', async (t) => {
  const directory = await fixture(t);
  const read = createCommentReader(directory, syntheticItems);
  const index = await read(select('/api/hn/index'));
  const byId = new Map(index.comments.map((comment) => [comment.id, comment]));
  assert.deepEqual(byId.get(1029), {
    id: 1029,
    createdAt: new Date((start + 1029) * 1000).toISOString(),
    assessments: [
      {
        kind: 'model',
        target: 'example-model',
        sentiment: 'positive',
        aspects: ['coding'],
        confidence: 'high',
        themes: ['code-quality', 'speed'],
      },
    ],
    story: 500,
    parent: 900,
    task: 'coding',
    claim: 'Synthetic claim about the example model.',
    prefers: [
      {
        winner: { kind: 'model', target: 'example-model' },
        loser: { kind: 'family', target: 'Example family' },
      },
    ],
  });
  assert.deepEqual(Object.keys(byId.get(1028)), [
    'id',
    'createdAt',
    'assessments',
    'story',
  ]);
  assert.deepEqual(Object.keys(byId.get(1001)), [
    'id',
    'createdAt',
    'assessments',
  ]);
  assert.equal(byId.get(1026).story, 502);
  assert.deepEqual(index.stories, [
    {
      id: 501,
      title: 'Synthetic context story',
      createdAt: null,
      about: [],
      comments: 1,
    },
    {
      id: 500,
      title: 'Synthetic story about a model',
      createdAt: new Date((start + 5) * 1000).toISOString(),
      about: [{ kind: 'model', target: 'example-model' }],
      comments: 3,
    },
  ]);
  const page = await read(select('/api/hn/comments?limit=3'));
  assert.deepEqual(
    page.comments.map((entry) => Object.keys(entry)),
    [
      ['item', 'assessments'],
      ['item', 'assessments', 'story', 'parent', 'task', 'claim', 'prefers'],
      ['item', 'assessments', 'story'],
    ],
  );
  assert.equal(
    page.comments[1].claim,
    'Synthetic claim about the example model.',
  );
  assert.deepEqual(page.comments[1].assessments[0].themes, [
    'code-quality',
    'speed',
  ]);
  assert.equal(page.comments[1].prefers.length, 1);
});

test('jobs, setting and run appear when the checkpoint stores them', async (t) => {
  const directory = await fixture(t);
  update(directory, 'ALTER TABLE comment ADD COLUMN setting TEXT');
  update(directory, 'ALTER TABLE comment ADD COLUMN run TEXT');
  update(
    directory,
    'UPDATE comment SET task = ?, setting = ?, run = ? WHERE item_id = 1029',
    'read-media',
    'local',
    '',
  );
  const read = createCommentReader(directory, syntheticItems);
  const index = await read(select('/api/hn/index'));
  const comment = index.comments.find((row) => row.id === 1029);
  assert.equal(comment.task, 'read-media');
  assert.equal(comment.setting, 'local');
  assert.equal('run' in comment, false);
  update(
    directory,
    'UPDATE comment SET run = ? WHERE item_id = 1029',
    'interactive',
  );
  await assert.rejects(
    read(select('/api/hn/index')),
    (error) => error.status === 503,
  );
});

test('unknown stored values and missing columns are refused as unavailable storage', async (t) => {
  for (const [sql, value] of [
    ['UPDATE assessment SET themes = ? WHERE item_id = 1029', '["synthetic"]'],
    ['UPDATE assessment SET themes = ? WHERE item_id = 1029', 'not json'],
    ['UPDATE comment SET task = ? WHERE item_id = 1029', 'synthetic'],
    ['UPDATE comment SET claim = ? WHERE item_id = 1029', 'x'.repeat(241)],
    ['UPDATE comment SET parent = ? WHERE item_id = 1029', 0],
    ['UPDATE comment SET parent = ? WHERE item_id = 1029', -900],
    ['UPDATE comment SET parent = ? WHERE item_id = 1029', 'synthetic'],
    ['UPDATE story SET title = ? WHERE item_id = 500', 'x'.repeat(301)],
    ['UPDATE preference SET winner_kind = ? WHERE item_id = 1029', 'app'],
  ]) {
    const directory = await fixture(t);
    update(directory, sql, value);
    const read = createCommentReader(directory, syntheticItems);
    await assert.rejects(
      read(select('/api/hn/index')),
      (error) =>
        error.status === 503 &&
        error.message === 'Comment storage is unavailable.',
      sql,
    );
    if (!sql.includes('story'))
      await assert.rejects(read(select('/api/hn/comments')), sql);
  }
  const directory = await mkdtemp(join(tmpdir(), 'hn-reader-old-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'checkpoint.sqlite3'));
  db.exec(`
    CREATE TABLE run (id INTEGER, classifier_key TEXT, start_at INTEGER, end_at INTEGER);
    CREATE TABLE comment (item_id INTEGER, classifier_key TEXT, created INTEGER);
    CREATE TABLE assessment (item_id INTEGER, classifier_key TEXT, kind TEXT, target TEXT,
      sentiment TEXT, aspects TEXT, confidence TEXT, failed INTEGER);
  `);
  db.prepare('INSERT INTO run VALUES (1, ?, ?, ?)').run('current', start, end);
  db.close();
  const read = createCommentReader(directory, syntheticItems);
  for (const path of ['/api/hn/index', '/api/hn/comments'])
    await assert.rejects(read(select(path)), (error) => error.status === 503);
});

test('thread ancestry and nested replies preserve discussion context and page order', async (t) => {
  const directory = await fixture(t);
  const records = new Map([
    [1, { id: 1, type: 'story', title: 'Synthetic discussion', kids: [2] }],
    [2, { id: 2, type: 'comment', parent: 1, text: 'Parent', kids: [10] }],
    [
      10,
      {
        id: 10,
        type: 'comment',
        parent: 2,
        text: 'Selected',
        kids: [11, 12, 13],
      },
    ],
    [11, { id: 11, type: 'comment', parent: 10, text: 'Reply', kids: [14] }],
    [12, { id: 12, deleted: true, parent: 10, text: 'Do not show' }],
    [13, { id: 13, type: 'comment', parent: 10, text: 'Later reply' }],
    [14, { id: 14, type: 'comment', parent: 11, text: 'Nested reply' }],
  ]);
  const calls = [];
  const read = createCommentReader(directory, async (url) => {
    const id = Number(
      new URL(url).pathname.split('/').at(-1).replace('.json', ''),
    );
    calls.push(id);
    return Response.json(records.get(id) ?? null);
  });
  const thread = await read(select('/api/hn/thread/10'));
  assert.deepEqual(
    thread.ancestors.map((item) => item.id),
    [1, 2],
  );
  assert.equal(thread.item.id, 10);
  assert.equal(thread.contextTruncated, false);
  const first = await read(select('/api/hn/replies/10?limit=2'));
  assert.deepEqual(
    first.replies.map((item) => item.id),
    [11, 12],
  );
  assert.equal(first.replies[1].deleted, true);
  assert.equal(first.replies[1].text, '');
  assert.equal(first.nextCursor, 12);
  const last = await read(select('/api/hn/replies/10?limit=2&after=12'));
  assert.deepEqual(
    last.replies.map((item) => item.id),
    [13],
  );
  assert.equal(last.nextCursor, null);
  const nested = await read(select('/api/hn/replies/11'));
  assert.equal(nested.replies[0].parentId, 11);
  assert.equal(calls.filter((id) => id === 10).length, 1);
  assert.equal(calls.filter((id) => id === 11).length, 1);
});

test('missing storage is empty, symlink storage is rejected and upstream failures are text-free', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hn-reader-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const read = createCommentReader(directory, async () => {
    throw new Error('synthetic-private-detail');
  });
  assert.deepEqual(await read(select('/api/hn/comments')), {
    total: 0,
    nextCursor: null,
    comments: [],
  });
  await assert.rejects(
    read(select('/api/hn/thread/10')),
    (error) => !error.message.includes('synthetic-private-detail'),
  );
  const elsewhere = join(directory, 'elsewhere');
  await mkdir(elsewhere);
  const db = new DatabaseSync(join(elsewhere, 'data.sqlite3'));
  db.close();
  await symlink(
    join(elsewhere, 'data.sqlite3'),
    join(directory, 'checkpoint.sqlite3'),
  );
  await assert.rejects(read(select('/api/hn/comments')));
});

test('one failed source item remains retryable without blocking later comment pages', async (t) => {
  const directory = await fixture(t);
  let fail = true;
  const read = createCommentReader(directory, async (url) => {
    const id = Number(
      new URL(url).pathname.split('/').at(-1).replace('.json', ''),
    );
    if (id === 1030 && fail) {
      fail = false;
      throw new Error('synthetic failure');
    }
    return Response.json(
      id === 1
        ? { id, type: 'story', title: 'Synthetic discussion' }
        : {
            id,
            type: 'comment',
            time: start,
            parent: 1,
            text: 'Synthetic comment',
          },
    );
  });
  const first = await read(select('/api/hn/comments?limit=2'));
  assert.equal(first.comments[0].item.loadError, true);
  assert.equal(first.comments[1].item.loadError, false);
  assert.equal(first.nextCursor, 1029);
  const next = await read(select('/api/hn/comments?limit=2&before=1029'));
  assert.equal(next.comments[0].item.id, 1028);
  const retry = await read(select('/api/hn/thread/1030'));
  assert.equal(retry.item.loadError, false);
  assert.equal(retry.item.text, 'Synthetic comment');
});

test('reply cursors survive source reordering, insertions and deletions after cache expiry', async (t) => {
  const directory = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let children = [11, 12, 13];
  const read = createCommentReader(directory, async (url) => {
    const id = Number(
      new URL(url).pathname.split('/').at(-1).replace('.json', ''),
    );
    return Response.json(
      id === 10
        ? { id, type: 'comment', parent: 1, kids: children }
        : { id, type: 'comment', parent: 10, text: 'Synthetic reply' },
    );
  });
  const first = await read(select('/api/hn/replies/10?limit=2'));
  assert.deepEqual(
    first.replies.map((item) => item.id),
    [11, 12],
  );
  children = [14, 11, 13];
  now += 6 * 60_000;
  const next = await read(select('/api/hn/replies/10?limit=2&after=12'));
  assert.deepEqual(
    next.replies.map((item) => item.id),
    [13, 14],
  );
  assert.equal(next.nextCursor, null);
});

test('an unavailable ancestor leaves context explicitly incomplete', async (t) => {
  const directory = await fixture(t);
  const read = createCommentReader(directory, async (url) => {
    const id = Number(
      new URL(url).pathname.split('/').at(-1).replace('.json', ''),
    );
    return Response.json(
      id === 10
        ? { id, type: 'comment', parent: 1, text: 'Synthetic comment' }
        : null,
    );
  });
  const thread = await read(select('/api/hn/thread/10'));
  assert.equal(thread.ancestors[0].unavailable, true);
  assert.equal(thread.contextTruncated, true);
});
