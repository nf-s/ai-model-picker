import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appPort, controlIsReady, host, projectRoot } from './hn-control.mjs';

let controller;
let vite;
let shuttingDown = false;

function stop(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of [vite, controller]) {
    if (child?.pid && child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());

async function ensureController() {
  if (await controlIsReady()) return true;
  if (shuttingDown) return false;

  controller = spawn(
    process.execPath,
    [join(projectRoot, 'scripts', 'hn-control.mjs')],
    { cwd: projectRoot, stdio: 'ignore' },
  );
  controller.once('error', () => {
    if (vite) stop(1);
  });
  controller.once('exit', () => {
    if (vite) stop(1);
  });

  const deadline = Date.now() + 5000;
  while (!shuttingDown && Date.now() < deadline) {
    if (await controlIsReady()) {
      if (controller.exitCode !== null || controller.signalCode !== null)
        controller = undefined;
      return true;
    }
    await delay(100);
  }
  return false;
}

async function main() {
  if (!(await ensureController())) {
    if (!shuttingDown) {
      console.error('The HN controller did not start on port 5187.');
      stop(1);
    }
    return;
  }

  if (shuttingDown) return;
  vite = spawn(
    process.execPath,
    [
      join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      '--host',
      host,
      '--port',
      String(appPort),
      '--strictPort',
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );
  vite.once('error', () => stop(1));
  vite.once('exit', (code) => stop(code ?? 1));
}

void main().catch(() => stop(1));
