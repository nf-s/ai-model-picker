import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  createCommentReader,
  readReaderRequest,
  ReaderError,
} from './hn-comments.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const host = '127.0.0.1';
export const appPort = 5186;
export const controlPort = 5187;
const modelPort = 8788;
const appOrigin = `http://${host}:${appPort}`;
const controlOrigin = `http://${host}:${controlPort}`;
const modelOrigin = `http://${host}:${modelPort}`;
const allowedHosts = new Set([`${host}:${appPort}`, `${host}:${controlPort}`]);
const allowedOrigins = new Set([appOrigin, controlOrigin]);
const service = 'ai-help-hn';
const localClassifier = 'qwen3.8-27b-4bit-thread-v1';

function reply(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readStateFile(path) {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) return null;
    const data = JSON.parse(await file.readFile('utf8'));
    return isObject(data) ? data : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

async function checkpointPresent(stateDir) {
  try {
    await lstat(join(stateDir, 'checkpoint.sqlite3'));
    return true;
  } catch {
    return false;
  }
}

// A run is ready to serve once every partition is scanned and nothing waits for
// review. Unresolved failures do not hold it back.
function reviewFinished(status) {
  const totals = status?.totals;
  if (!isObject(totals)) return false;
  const counts = [
    totals.partitionsTotal,
    totals.partitionsComplete,
    totals.storiesPending,
    totals.commentsQueued,
  ];
  if (!counts.every((count) => typeof count === 'number')) return false;
  const [partitionsTotal, partitionsComplete, storiesPending, commentsQueued] =
    counts;
  return (
    partitionsTotal > 0 &&
    partitionsComplete === partitionsTotal &&
    storiesPending === 0 &&
    commentsQueued === 0
  );
}

// The controller starts and pauses only runs made with its own local classifier.
// A run made with another one, such as a review through the Anthropic API, is
// driven from a terminal.
function drivenElsewhere(status) {
  return (
    typeof status?.classifier === 'string' &&
    status.classifier !== localClassifier
  );
}

async function filesPresent(paths) {
  try {
    await Promise.all(paths.map(([path, mode]) => access(path, mode)));
    return true;
  } catch {
    return false;
  }
}

function childExited(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('exit', (code) => resolve(code));
  });
}

async function stopChild(child, graceMs) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;

  const closed = childExited(child);
  const timeout = setTimeout(() => child.kill('SIGKILL'), graceMs);
  child.kill('SIGTERM');
  try {
    await closed;
  } finally {
    clearTimeout(timeout);
  }
}

async function matchingRuntime(modelDir, signal) {
  try {
    const timeout = AbortSignal.timeout(1200);
    const response = await fetch(`${modelOrigin}/v1/models`, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return false;
    const data = await response.json();
    return (
      Array.isArray(data?.data) &&
      data.data.some((model) => model?.id === modelDir)
    );
  } catch {
    return false;
  }
}

function modelPortInUse() {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: modelPort, timeout: 1200 });
    function finish(inUse) {
      socket.destroy();
      resolve(inUse);
    }
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export async function controlIsReady() {
  try {
    const response = await fetch(`${controlOrigin}/api/hn/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true && data.service === service;
  } catch {
    return false;
  }
}

export function createHnController(root = projectRoot) {
  const stateDir = join(root, '.local', 'hn');
  const runDir = join(stateDir, 'threads');
  const readPrevious = createCommentReader(stateDir);
  const readRun = createCommentReader(runDir);
  const modelDir = join(stateDir, 'models', 'qwen3.8-27b-4bit');
  const python = join(stateDir, 'venv', 'bin', 'python');
  const modelServer = join(stateDir, 'venv', 'bin', 'mlx_lm.server');
  const pipeline = join(root, 'scripts', 'hn_pipeline.py');
  const childOptions = {
    cwd: root,
    stdio: 'ignore',
    env: {
      LANG: 'en_US.UTF-8',
      PYTHONNOUSERSITE: '1',
      HF_HOME: join(stateDir, 'model-cache'),
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_OFFLINE: '1',
    },
  };
  const requiredFiles = [
    [python, constants.X_OK],
    [modelServer, constants.X_OK],
    [pipeline, constants.R_OK],
    [join(modelDir, 'config.json'), constants.R_OK],
    [join(modelDir, 'tokenizer.json'), constants.R_OK],
    ...[1, 2, 3].map((part) => [
      join(modelDir, `model-0000${part}-of-00003.safetensors`),
      constants.R_OK,
    ]),
  ];
  let activeRun = null;
  let runtimeChild = null;
  let message = null;
  let closing = false;

  function spawnRuntime() {
    const child = spawn(
      modelServer,
      [
        '--model',
        modelDir,
        '--host',
        host,
        '--port',
        String(modelPort),
        '--log-level',
        'CRITICAL',
        '--allowed-origins',
        appOrigin,
        '--prompt-cache-size',
        '2',
        '--max-tokens',
        '384',
        '--decode-concurrency',
        '8',
        '--prompt-concurrency',
        '8',
        '--chat-template-args',
        '{"enable_thinking":false}',
      ],
      childOptions,
    );
    runtimeChild = child;
    void childExited(child).then(() => {
      if (runtimeChild === child) runtimeChild = null;
    });
  }

  async function startRuntime(signal) {
    if (await matchingRuntime(modelDir, signal)) return true;
    if (signal.aborted) return false;
    if (!runtimeChild && !(await modelPortInUse()) && !signal.aborted)
      spawnRuntime();

    const deadline = Date.now() + 180_000;
    while (!signal.aborted && Date.now() < deadline) {
      if (await matchingRuntime(modelDir, signal)) return true;
      if (!runtimeChild && !(await modelPortInUse())) return false;
      await delay(500, undefined, { signal });
    }
    return false;
  }

  async function runPipeline(run) {
    try {
      const { signal } = run.abort;
      message = 'Starting local model…';
      if (!(await startRuntime(signal))) {
        if (!signal.aborted)
          message = 'The local model did not become ready on port 8788.';
        return;
      }
      if (signal.aborted) return;
      message = null;
      run.child = spawn(
        python,
        [
          '-B',
          pipeline,
          'run',
          '--state-dir',
          runDir,
          '--source',
          'archive-and-tail',
          '--endpoint',
          `${modelOrigin}/v1/chat/completions`,
          '--model',
          'default_model',
          '--classifier-id',
          localClassifier,
          '--classifier-workers',
          '8',
        ],
        childOptions,
      );
      const code = await childExited(run.child);
      if (!signal.aborted && code !== 0)
        message =
          'The local pipeline stopped. Check its saved status before resuming.';
    } catch {
      if (!run.abort.signal.aborted)
        message = 'The local pipeline could not start.';
    } finally {
      if (run.abort.signal.aborted) message = null;
      activeRun = null;
    }
  }

  // Keep serving the previous analysis until the new run has reviewed everything.
  async function servedSource() {
    const [runStatus, previousExists] = await Promise.all([
      readStateFile(join(runDir, 'status.json')),
      checkpointPresent(stateDir),
    ]);
    const useRun = reviewFinished(runStatus) || !previousExists;
    return { runStatus, useRun, directory: useRun ? runDir : stateDir };
  }

  function pauseRun() {
    if (!activeRun || activeRun.abort.signal.aborted) return;
    message = 'Pausing the local pipeline…';
    activeRun.abort.abort();
    activeRun.child?.kill('SIGTERM');
  }

  async function handle(request, response) {
    const origin = request.headers.origin;
    if (
      !allowedHosts.has(request.headers.host) ||
      (origin !== undefined && !allowedOrigins.has(origin))
    ) {
      reply(response, 403, { error: 'Loopback requests only.' });
      return;
    }

    if (request.method === 'GET' && request.url === '/api/hn/health') {
      reply(response, 200, { ok: true, service });
      return;
    }

    if (request.method === 'GET') {
      try {
        const selection = readReaderRequest(
          new URL(request.url, controlOrigin),
        );
        if (selection) {
          const { useRun } = await servedSource();
          const readComments = useRun ? readRun : readPrevious;
          reply(response, 200, await readComments(selection));
          return;
        }
      } catch (error) {
        if (error instanceof ReaderError) {
          reply(response, error.status, { error: error.message });
          return;
        }
        throw error;
      }
    }

    if (request.method === 'GET' && request.url === '/api/hn') {
      const { runStatus, useRun, directory } = await servedSource();
      const [previousStatus, results, runtimeReady, installed] =
        await Promise.all([
          runStatus ? null : readStateFile(join(stateDir, 'status.json')),
          readStateFile(join(directory, 'results.json')),
          matchingRuntime(modelDir),
          filesPresent(requiredFiles),
        ]);
      reply(response, 200, {
        status: runStatus ?? previousStatus,
        results,
        runner: {
          active: activeRun !== null,
          runtimeReady,
          installed,
          message,
          showingPrevious: runStatus !== null && !useRun,
          external: drivenElsewhere(runStatus),
        },
      });
      return;
    }

    if (
      request.method !== 'POST' ||
      !['/api/hn/start', '/api/hn/pause'].includes(request.url)
    ) {
      reply(response, 404, { error: 'Unknown local pipeline request.' });
      return;
    }

    if (
      !allowedOrigins.has(origin) ||
      request.headers['transfer-encoding'] !== undefined ||
      ![undefined, '0'].includes(request.headers['content-length'])
    ) {
      reply(response, 403, {
        error: 'Expected an empty local action request.',
      });
      return;
    }

    if (request.url === '/api/hn/pause') {
      pauseRun();
      reply(response, 202, { active: activeRun !== null });
      return;
    }

    if (drivenElsewhere((await servedSource()).runStatus)) {
      reply(response, 409, {
        error: 'This run is started and paused from a terminal.',
      });
      return;
    }

    if (!(await filesPresent(requiredFiles))) {
      reply(response, 409, { error: 'Run the local model setup first.' });
      return;
    }

    if (closing) {
      reply(response, 503, { error: 'The local controller is shutting down.' });
      return;
    }

    if (!activeRun) {
      const run = { abort: new AbortController(), child: null, done: null };
      activeRun = run;
      run.done = runPipeline(run);
    }
    reply(response, 202, { active: true });
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reply(response, 500, { error: 'The local request failed.' });
    });
  });

  async function shutdown() {
    if (closing) return;
    closing = true;
    const closed = new Promise((resolve) => server.close(resolve));
    const run = activeRun;
    pauseRun();
    await stopChild(run?.child, 45_000);
    await run?.done;
    await stopChild(runtimeChild, 5000);
    await closed;
  }

  return { server, shutdown };
}

if (import.meta.main) {
  const { server, shutdown } = createHnController();
  server.once('error', () => {
    console.error('Could not bind the local HN controller on port 5187.');
    process.exitCode = 1;
  });
  server.listen(controlPort, host);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown().catch(() => {
        process.exitCode = 1;
      });
    });
  }
}
