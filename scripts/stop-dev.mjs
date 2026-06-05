#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [5173, 5174, 5175];
const quiet = process.argv.includes('--quiet');

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function main() {
  const pids = new Set();
  for (const port of PORTS) {
    for (const pid of await listenersOn(port)) pids.add(pid);
  }

  const projectPids = [];
  for (const pid of pids) {
    const info = await processInfo(pid);
    if (info && isProjectProcess(info)) projectPids.push({ pid, ...info });
    else if (!quiet && info) {
      console.log(`[stop-dev] leaving pid ${pid} alone (${info.command || 'unknown command'})`);
    }
  }

  if (projectPids.length === 0) {
    if (!quiet) console.log('[stop-dev] no Market Map dev servers are running');
    return;
  }

  for (const proc of projectPids) {
    if (!quiet) console.log(`[stop-dev] stopping pid ${proc.pid} (${proc.command})`);
    try {
      process.kill(Number(proc.pid), 'SIGTERM');
    } catch {
      // Already gone.
    }
  }

  await sleep(900);

  for (const proc of projectPids) {
    if (!(await isAlive(proc.pid))) continue;
    if (!quiet) console.log(`[stop-dev] force stopping pid ${proc.pid}`);
    try {
      process.kill(Number(proc.pid), 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

async function listenersOn(port) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return stdout.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

async function processInfo(pid) {
  const [command, cwd] = await Promise.all([commandFor(pid), cwdFor(pid)]);
  if (!command && !cwd) return null;
  return { command, cwd };
}

async function commandFor(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function cwdFor(pid) {
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((entry) => entry.startsWith('n'));
    return line ? line.slice(1) : '';
  } catch {
    return '';
  }
}

function isProjectProcess(info) {
  return info.cwd === ROOT || info.cwd.startsWith(`${ROOT}/`) || info.command.includes(ROOT);
}

async function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`[stop-dev] ${error.message}`);
  process.exit(1);
});
