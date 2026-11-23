import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  appPort,
  controlPort,
  createHnController,
  host,
} from '../scripts/hn-control.mjs';

const appOrigin = `http://${host}:${appPort}`;

function contact(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: host,
        port,
        path,
        method,
        headers: { Host: `${host}:${controlPort}`, ...headers },
      },
      (incoming) => {
        incoming.setEncoding('utf8');
        let data = '';
        incoming.on('data', (chunk) => (data += chunk));
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            resolve({
              status: incoming.statusCode,
              headers: incoming.headers,
              data: JSON.parse(data),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

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
const start = 1_780_000_000;
const end = start + 1000;

// One run with a single listed comment, so each directory is identifiable.
async function writeRun(directory, commentId, label) {
  await mkdir(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'checkpoint.sqlite3'));
  db.exec(checkpointSchema);
  db.prepare(
    `INSERT INTO run (id, source, first_item, last_item, classifier, classifier_key, state,
       updated, full_range, start_at, end_at)
     VALUES (1, 'firebase', 1, 2000, 'synthetic', 'current', 'paused', ?, 0, ?, ?)`,
  ).run(end, start, end);
  db.prepare(
    `INSERT INTO comment (item_id, classifier_key, digest, created, priority, failed_groups)
     VALUES (?, 'current', '', ?, 0, 0)`,
  ).run(commentId, start + 1);
  db.prepare(
    `INSERT INTO assessment VALUES (?, 'current', 'model', 'example-model', 'positive', '[]',
       'high', 0, '[]')`,
  ).run(commentId);
  db.close();
  await writeFile(join(directory, 'results.json'), JSON.stringify({ label }));
}

function runStatus(state, totals, classifier) {
  return JSON.stringify({ state, totals, classifier });
}

const finishedTotals = {
  partitionsTotal: 3,
  partitionsComplete: 3,
  storiesPending: 0,
  commentsQueued: 0,
  classificationFailures: 2,
};

async function startController(t, root) {
  const { server, shutdown } = createHnController(root);
  t.after(async () => {
    await shutdown();
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const { port } = address;
  return {
    overview: async () => (await contact(port, '/api/hn')).data,
    start: () =>
      contact(port, '/api/hn/start', {
        method: 'POST',
        headers: { Origin: appOrigin },
      }),
    indexIds: async () =>
      (await contact(port, '/api/hn/index')).data.comments.map(
        (comment) => comment.id,
      ),
  };
}

test('HN controller restricts actions and reads only its state files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hn-controller-'));
  const stateDir = join(root, '.local', 'hn');
  const { server, shutdown } = createHnController(root);
  t.after(async () => {
    await shutdown();
    await rm(root, { recursive: true, force: true });
  });

  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const { port } = address;

  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'status.json'), '{"phase":"paused"}');
  await writeFile(join(stateDir, 'other.json'), '{"unexpected":true}');
  await symlink('other.json', join(stateDir, 'results.json'));

  const health = await contact(port, '/api/hn/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const status = await contact(port, '/api/hn', {
    headers: { Host: `${host}:${appPort}` },
  });
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(status.data, {
    status: { phase: 'paused' },
    results: null,
    runner: {
      active: false,
      installed: false,
      runtimeReady: false,
      message: null,
      showingPrevious: false,
      external: false,
    },
  });

  const foreignHost = await contact(port, '/api/hn/health', {
    headers: { Host: 'example.test:5187' },
  });
  assert.equal(foreignHost.status, 403);

  const foreignOrigin = await contact(port, '/api/hn/start', {
    method: 'POST',
    headers: { Origin: 'https://example.test' },
  });
  assert.equal(foreignOrigin.status, 403);

  const missingOrigin = await contact(port, '/api/hn/start', {
    method: 'POST',
  });
  assert.equal(missingOrigin.status, 403);

  const requestWithInput = await contact(port, '/api/hn/start', {
    method: 'POST',
    headers: { Origin: appOrigin, 'Content-Length': '2' },
    body: '{}',
  });
  assert.equal(requestWithInput.status, 403);

  const query = await contact(port, '/api/hn/start?source=tail', {
    method: 'POST',
    headers: { Origin: appOrigin },
  });
  assert.equal(query.status, 404);

  const notInstalled = await contact(port, '/api/hn/start', {
    method: 'POST',
    headers: { Origin: appOrigin },
  });
  assert.equal(notInstalled.status, 409);

  const paused = await contact(port, '/api/hn/pause', {
    method: 'POST',
    headers: { Origin: appOrigin },
  });
  assert.equal(paused.status, 202);
  assert.deepEqual(paused.data, { active: false });
});

test('HN controller serves the previous analysis until the new run finishes review', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hn-controller-'));
  const previousDir = join(root, '.local', 'hn');
  const runDir = join(previousDir, 'threads');
  await writeRun(previousDir, 101, 'previous');
  await writeFile(
    join(previousDir, 'status.json'),
    runStatus('blocked', finishedTotals),
  );
  const { overview, indexIds } = await startController(t, root);

  let data = await overview();
  assert.equal(data.status.state, 'blocked');
  assert.deepEqual(data.results, { label: 'previous' });
  assert.equal(data.runner.showingPrevious, false);
  assert.deepEqual(await indexIds(), [101]);

  await writeRun(runDir, 202, 'new');
  for (const totals of [
    { ...finishedTotals, commentsQueued: 4 },
    { ...finishedTotals, storiesPending: 1 },
    { ...finishedTotals, partitionsComplete: 2 },
    { ...finishedTotals, partitionsTotal: 0, partitionsComplete: 0 },
    { ...finishedTotals, commentsQueued: '0' },
    { partitionsTotal: 3, partitionsComplete: 3, storiesPending: 0 },
  ]) {
    await writeFile(join(runDir, 'status.json'), runStatus('running', totals));
    data = await overview();
    assert.equal(data.status.state, 'running');
    assert.deepEqual(data.status.totals, totals);
    assert.deepEqual(data.results, { label: 'previous' });
    assert.equal(data.runner.showingPrevious, true);
    assert.deepEqual(await indexIds(), [101]);
  }

  // Unresolved failures leave the run blocked but still finished.
  await writeFile(
    join(runDir, 'status.json'),
    runStatus('blocked', finishedTotals),
  );
  data = await overview();
  assert.equal(data.status.state, 'blocked');
  assert.deepEqual(data.results, { label: 'new' });
  assert.equal(data.runner.showingPrevious, false);
  assert.deepEqual(await indexIds(), [202]);
});

test('HN controller serves the new run when there is no previous checkpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hn-controller-'));
  const runDir = join(root, '.local', 'hn', 'threads');
  const { overview, indexIds } = await startController(t, root);

  let data = await overview();
  assert.equal(data.status, null);
  assert.equal(data.results, null);
  assert.equal(data.runner.showingPrevious, false);
  assert.deepEqual(await indexIds(), []);

  await writeRun(runDir, 202, 'new');
  await writeFile(
    join(runDir, 'status.json'),
    runStatus('running', { ...finishedTotals, commentsQueued: 4 }),
  );
  data = await overview();
  assert.equal(data.status.state, 'running');
  assert.deepEqual(data.results, { label: 'new' });
  assert.equal(data.runner.showingPrevious, false);
  assert.deepEqual(await indexIds(), [202]);
});

test('HN controller leaves a run made with another classifier to the terminal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hn-controller-'));
  const runDir = join(root, '.local', 'hn', 'threads');
  const { overview, start } = await startController(t, root);
  const unfinished = { ...finishedTotals, commentsQueued: 4 };
  await writeRun(runDir, 202, 'new');

  await writeFile(
    join(runDir, 'status.json'),
    runStatus('paused', unfinished, 'qwen3.8-27b-4bit-jobs-v1'),
  );
  assert.equal((await overview()).runner.external, false);
  let started = await start();
  assert.equal(started.status, 409);
  assert.equal(started.data.error, 'Run the local model setup first.');

  await writeFile(
    join(runDir, 'status.json'),
    runStatus('running', unfinished, 'claude-haiku-5.5-jobs-v1'),
  );
  const data = await overview();
  assert.equal(data.runner.external, true);
  assert.equal(data.runner.active, false);
  assert.equal(data.status.state, 'running');
  started = await start();
  assert.equal(started.status, 409);
  assert.equal(
    started.data.error,
    'This run is started and paused from a terminal.',
  );
  assert.equal((await overview()).runner.active, false);
});
