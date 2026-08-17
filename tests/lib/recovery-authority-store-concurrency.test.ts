import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';

const STORE = fileURLToPath(new URL('../../src/lib/recovery-authority-store.ts', import.meta.url));
const MARKER_FILE = 'recovery-authority.json';
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_KILL_GRACE_MS = 1_000;
const LOCAL_OPERATION_ENVELOPE_MS = 588;

interface ChildReceipt {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  operationElapsedMs: number | null;
  stdout: string;
  stderr: string;
}

interface RunningChild {
  ready: Promise<void>;
  send: (message: string) => void;
  events: string[];
  settled: () => boolean;
  result: Promise<ChildReceipt>;
}

interface ChildWatchdogOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  stateDirOverride?: string;
}

let stateDir = '';
const activeChildren = new Set<ChildProcess>();

beforeEach(() => {
  stateDir = fs.mkdtempSync(join(os.tmpdir(), 'recovery-authority-conc-'));
});

afterEach(async () => {
  for (const child of activeChildren) terminateChildTree(child, 'SIGKILL');
  if (activeChildren.size > 0) {
    await waitUntil(() => activeChildren.size === 0, CHILD_KILL_GRACE_MS, 'child cleanup');
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    await delay(5);
  }
}

function terminateChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already have exited; fall through to the direct child.
    }
  }
  child.kill(signal);
}

function spawnBoundedChild(file: string, options: ChildWatchdogOptions = {}): RunningChild {
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? CHILD_KILL_GRACE_MS;
  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    file,
  ], {
    detached: process.platform !== 'win32',
    env: { ...process.env, BOT_ERRORS_STATE_DIR: options.stateDirOverride ?? stateDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';
  let didSettle = false;
  let operationElapsedMs: number | null = null;
  const events: string[] = [];
  let readyResolve!: () => void;
  const readySignal = new Promise<void>((resolve) => { readyResolve = resolve; });

  child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  child.on('message', (message) => {
    if (message === 'ready') readyResolve();
    if (typeof message === 'string') events.push(message);
    if (
      typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === 'operation-complete'
      && 'elapsedMs' in message
      && typeof message.elapsedMs === 'number'
      && Number.isFinite(message.elapsedMs)
      && message.elapsedMs >= 0
    ) {
      operationElapsedMs = message.elapsedMs;
    }
  });

  const result = new Promise<ChildReceipt>((resolve) => {
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    let finished = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, 'SIGTERM');
      forceKill = setTimeout(() => terminateChildTree(child, 'SIGKILL'), killGraceMs);
    }, timeoutMs);
    const finish = (receipt: ChildReceipt): void => {
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      if (forceKill) clearTimeout(forceKill);
      didSettle = true;
      activeChildren.delete(child);
      resolve(receipt);
    };
    child.on('close', (code, signal) => {
      finish({ code, signal, timedOut, operationElapsedMs, stdout, stderr });
    });
    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        operationElapsedMs,
        stdout,
        stderr: `${stderr}${String(error)}`,
      });
    });
  });

  const ready = withTimeout(
    Promise.race([
      readySignal,
      result.then((receipt) => {
        throw new Error(`child exited before readiness: ${JSON.stringify(receipt)}`);
      }),
    ]),
    timeoutMs,
    'child readiness',
  );

  return {
    ready,
    send: (message) => {
      if (!child.connected || !child.send) throw new Error('child IPC channel unavailable');
      child.send(message);
    },
    events,
    settled: () => didSettle,
    result,
  };
}

function expectSuccessfulReceipt(receipt: ChildReceipt): void {
  expect(receipt).toMatchObject({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
  });
  expect(receipt.operationElapsedMs).not.toBeNull();
  expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(0);
  expect(receipt.operationElapsedMs).toBeLessThanOrEqual(LOCAL_OPERATION_ENVELOPE_MS);
}

function parseJsonLogs(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function markerPath(): string {
  return join(stateDir, MARKER_FILE);
}

function readMarkersFromDisk(): Record<string, unknown> {
  if (!fs.existsSync(markerPath())) return {};
  const raw: unknown = JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function orphanStoreArtifacts(): string[] {
  return fs.readdirSync(stateDir).filter((name) =>
    name === `${MARKER_FILE}.tmp`
    || name === `${MARKER_FILE}.lock`
    || (name.startsWith(`.${MARKER_FILE}.`) && name.endsWith('.tmp')),
  );
}

function writeChildScript(name: string, body: string): string {
  const file = join(stateDir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function setChildScript(name: string, key: string, observeContention = false): string {
  const contentionProbe = observeContention ? `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalLink = fs.linkSync;
fs.linkSync = ((existingPath, newPath) => {
  try {
    return originalLink(existingPath, newPath);
  } catch (error) {
    if (String(newPath) === ${JSON.stringify(`${markerPath()}.lock`)} && error?.code === 'EEXIST') {
      process.send?.('lock-contended');
    }
    throw error;
  }
}) as typeof fs.linkSync;
syncBuiltinESMExports();
` : '';
  return writeChildScript(name, `${contentionProbe}
const { setRecoveryMarker } = await import(${JSON.stringify(STORE)});
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
setRecoveryMarker(${JSON.stringify(key)});
const elapsedMs = performance.now() - startedAtMs;
await new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel unavailable'));
  process.send({ type: 'operation-complete', elapsedMs }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
`);
}

describe('recovery-authority store real multi-process contention', () => {
  // @skip-env Windows has no detached POSIX process group or SIGKILL classification.
  it.runIf(process.platform !== 'win32')('watchdog classifies and reaps a child that ignores SIGTERM', async () => {
    const file = writeChildScript('hung-child.ts', `
process.on('SIGTERM', () => undefined);
process.send?.('ready');
setInterval(() => undefined, 1_000);
await new Promise(() => undefined);
`);
    const child = spawnBoundedChild(file, { timeoutMs: 100, killGraceMs: 50 });

    await child.ready;
    const receipt = await child.result;

    expect(receipt).toMatchObject({
      code: null,
      signal: 'SIGKILL',
      timedOut: true,
      operationElapsedMs: null,
    });
    expect(activeChildren.size).toBe(0);
  });

  it('preserves every concurrently written marker', async () => {
    const count = 16;
    const expectedKeys = Array.from({ length: count }, (_, index) => `source-${index}:inst-${index}`);
    const children = expectedKeys.map((key, index) =>
      spawnBoundedChild(setChildScript(`set-${index}.ts`, key)),
    );

    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.send('go');
    const receipts = await Promise.all(children.map((child) => child.result));

    for (const receipt of receipts) expectSuccessfulReceipt(receipt);
    expect(Object.keys(readMarkersFromDisk()).sort()).toEqual(expectedKeys.sort());
    expect(orphanStoreArtifacts()).toEqual([]);
  });

  it('does not let a clear erase a concurrently added marker', async () => {
    fs.writeFileSync(markerPath(), JSON.stringify({ 'source-a:inst-a': true }), 'utf8');
    const clearReadReleasePath = join(stateDir, 'release-clear-read');
    const clearScript = writeChildScript('clear.ts', `
import fs from 'node:fs';
const markerPath = ${JSON.stringify(markerPath())};
const releasePath = ${JSON.stringify(clearReadReleasePath)};
const originalRead = fs.readFileSync.bind(fs);
let intercepted = false;
fs.readFileSync = ((path, ...args) => {
  const value = originalRead(path, ...args);
  if (!intercepted && String(path) === markerPath) {
    intercepted = true;
    process.send?.('ready');
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 5);
  }
  return value;
}) as typeof fs.readFileSync;
const { clearRecoveryMarker } = await import(${JSON.stringify(STORE)});
const startedAtMs = performance.now();
clearRecoveryMarker('source-a:inst-a');
const elapsedMs = performance.now() - startedAtMs;
await new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel unavailable'));
  process.send({ type: 'operation-complete', elapsedMs }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
`);
    const clearing = spawnBoundedChild(clearScript);
    await clearing.ready;

    const adding = spawnBoundedChild(setChildScript('set.ts', 'source-b:inst-b', true));
    await adding.ready;
    adding.send('go');
    await waitUntil(
      () => adding.settled() || adding.events.includes('lock-contended'),
      CHILD_TIMEOUT_MS,
      'setter neither completed nor encountered the transaction lock',
    );
    fs.writeFileSync(clearReadReleasePath, 'release', { flag: 'wx' });

    const [clearReceipt, setReceipt] = await Promise.all([clearing.result, adding.result]);
    expectSuccessfulReceipt(clearReceipt);
    expectSuccessfulReceipt(setReceipt);
    expect(readMarkersFromDisk()).toEqual({ 'source-b:inst-b': true });
    expect(adding.events).toContain('lock-contended');
    expect(orphanStoreArtifacts()).toEqual([]);
  });

  it('records a bounded lock-timeout classification without marker identity', async () => {
    const lockPath = `${markerPath()}.lock`;
    const held = acquireProcessLock(lockPath);
    const source = 'private-timeout-source:private-instance';
    const file = writeChildScript('lock-timeout.ts', `
const { setRecoveryMarker } = await import(${JSON.stringify(STORE)});
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
try {
  setRecoveryMarker(${JSON.stringify(source)});
} catch {
  const elapsedMs = performance.now() - startedAtMs;
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC channel unavailable'));
    process.send({ type: 'operation-complete', elapsedMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
`);
    const child = spawnBoundedChild(file);
    await child.ready;
    child.send('go');
    const receipt = await child.result;
    expect(releaseProcessLock(held)).toBe(true);

    expect(receipt).toMatchObject({ code: 0, signal: null, timedOut: false, stderr: '' });
    expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(500);
    expect(receipt.operationElapsedMs).toBeLessThanOrEqual(LOCAL_OPERATION_ENVELOPE_MS);
    const record = parseJsonLogs(receipt.stdout).find((entry) => entry['reason'] === 'lock_timeout');
    expect(record).toMatchObject({
      component: 'recovery-authority-store',
      operation: 'set',
      reason: 'lock_timeout',
      msg: 'recovery authority mutation not accepted',
    });
    expect(record?.['elapsedMs']).toEqual(expect.any(Number));
    expect(receipt.stdout).not.toContain(source);
    expect(receipt.stdout).not.toContain(stateDir);
  });

  it('records release ownership loss without deleting the replacement lock', async () => {
    const lockPath = `${markerPath()}.lock`;
    const source = 'private-release-source:private-instance';
    const file = writeChildScript('release-ownership-loss.ts', `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const lockPath = ${JSON.stringify(lockPath)};
const originalRead = fs.readFileSync.bind(fs);
let replaced = false;
fs.readFileSync = ((path, ...args) => {
  const value = originalRead(path, ...args);
  if (!replaced && String(path) === lockPath) {
    replaced = true;
    const payload = JSON.parse(String(value));
    fs.writeFileSync(lockPath, JSON.stringify({ ...payload, token: 'replacement-owner' }));
  }
  return value;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
const { setRecoveryMarker } = await import(${JSON.stringify(STORE)});
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
setRecoveryMarker(${JSON.stringify(source)});
const elapsedMs = performance.now() - startedAtMs;
await new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel unavailable'));
  process.send({ type: 'operation-complete', elapsedMs }, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
`);
    const child = spawnBoundedChild(file);
    await child.ready;
    child.send('go');
    const receipt = await child.result;

    expect(receipt).toMatchObject({ code: 0, signal: null, timedOut: false, stderr: '' });
    expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(receipt.operationElapsedMs).toBeLessThanOrEqual(LOCAL_OPERATION_ENVELOPE_MS);
    const record = parseJsonLogs(receipt.stdout).find((entry) => entry['reason'] === 'lock_release_lost_ownership');
    expect(record).toMatchObject({
      component: 'recovery-authority-store',
      operation: 'set',
      reason: 'lock_release_lost_ownership',
      msg: 'recovery authority lock release lost ownership',
    });
    expect(record?.['elapsedMs']).toEqual(expect.any(Number));
    expect(receipt.stdout).not.toContain(source);
    expect(receipt.stdout).not.toContain(stateDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
  });

  it('records a lock-release failure while preserving the authoritative lock', async () => {
    const lockPath = `${markerPath()}.lock`;
    const source = 'private-release-error-source:private-instance';
    const file = writeChildScript('release-error.ts', `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const lockPath = ${JSON.stringify(lockPath)};
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = ((path) => {
  if (String(path) === lockPath) {
    const error = new Error('forced release refusal');
    Object.assign(error, { code: 'EACCES' });
    throw error;
  }
  return originalUnlink(path);
}) as typeof fs.unlinkSync;
syncBuiltinESMExports();
const { setRecoveryMarker } = await import(${JSON.stringify(STORE)});
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
try {
  setRecoveryMarker(${JSON.stringify(source)});
} catch {
  const elapsedMs = performance.now() - startedAtMs;
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC channel unavailable'));
    process.send({ type: 'operation-complete', elapsedMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
`);
    const child = spawnBoundedChild(file);
    await child.ready;
    child.send('go');
    const receipt = await child.result;

    expect(receipt).toMatchObject({ code: 0, signal: null, timedOut: false, stderr: '' });
    expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(receipt.operationElapsedMs).toBeLessThanOrEqual(LOCAL_OPERATION_ENVELOPE_MS);
    const record = parseJsonLogs(receipt.stdout).find((entry) => entry['reason'] === 'lock_release_failed');
    expect(record).toMatchObject({
      component: 'recovery-authority-store',
      operation: 'set',
      reason: 'lock_release_failed',
      code: 'EACCES',
      msg: 'recovery authority lock release failed',
    });
    expect(record?.['elapsedMs']).toEqual(expect.any(Number));
    expect(receipt.stdout).not.toContain(source);
    expect(receipt.stdout).not.toContain(stateDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
  });

  it('records a directory failure before the caller boundary can swallow it', async () => {
    const blockedStatePath = join(stateDir, 'state-root-is-a-file');
    fs.writeFileSync(blockedStatePath, 'not a directory', 'utf8');
    const source = 'private-directory-source:private-instance';
    const file = writeChildScript('directory-failure.ts', `
const { setRecoveryMarker } = await import(${JSON.stringify(STORE)});
process.send?.('ready');
await new Promise<void>((resolve) => process.once('message', (message) => {
  if (message === 'go') resolve();
}));
const startedAtMs = performance.now();
try {
  setRecoveryMarker(${JSON.stringify(source)});
} catch {
  const elapsedMs = performance.now() - startedAtMs;
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('IPC channel unavailable'));
    process.send({ type: 'operation-complete', elapsedMs }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
`);
    const child = spawnBoundedChild(file, { stateDirOverride: blockedStatePath });
    await child.ready;
    child.send('go');
    const receipt = await child.result;

    expect(receipt).toMatchObject({ code: 0, signal: null, timedOut: false, stderr: '' });
    expect(receipt.operationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(receipt.operationElapsedMs).toBeLessThanOrEqual(LOCAL_OPERATION_ENVELOPE_MS);
    const record = parseJsonLogs(receipt.stdout).find((entry) => entry['reason'] === 'mutation_failed');
    expect(record).toMatchObject({
      component: 'recovery-authority-store',
      operation: 'set',
      reason: 'mutation_failed',
      msg: 'recovery authority mutation failed',
    });
    expect(record?.['code']).toEqual(expect.any(String));
    expect(record?.['elapsedMs']).toEqual(expect.any(Number));
    expect(receipt.stdout).not.toContain(source);
    expect(receipt.stdout).not.toContain(blockedStatePath);
  });
});
