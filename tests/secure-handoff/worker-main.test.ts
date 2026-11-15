import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigration68 } from '../../src/core/database-migration-68.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../../src/core/database-schema-version.ts';
import { readConsumerConfig, consumerConfigPath } from '../../src/secure-handoff/worker-main.ts';
import { TEST_DELIVERY_HOST, TEST_LINK_HOST } from '../helpers/protected-delivery-pins.ts';

const directories: string[] = [];
const children = new Set<WorkerChild>();
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');
const PINNED_NODE = process.execPath;
const WORKER_MAIN = join(REPO_ROOT, 'src/secure-handoff/worker-main.ts');
const PINS_MODULE_URL = pathToFileURL(join(REPO_ROOT, 'src/core/protected-delivery-pins.ts')).href;
const CHILD_TIMEOUT_MS = 4_000;
const DUMMY_TRANSPORT_TOKEN = 'transport-token-for-cli-test';
const DUMMY_CONSUMER_TOKEN = 'consumer-token-for-cli-test';

type ChildExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
type WorkerChild = {
  child: ChildProcess;
  closed: Promise<ChildExit>;
  isClosed: () => boolean;
  stdout: () => string;
  stderr: () => string;
};

afterEach(async () => {
  await Promise.all([...children].map(stopOwnedChild));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function configFile(contents = '{"databasePath":"/private/metadata.db"}', mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-cli-'));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const path = join(directory, 'config.json');
  writeFileSync(path, contents, { mode });
  return path;
}

function privateWorkerFiles(schema: 'current' | 'empty' | 'missing_migration'): {
  configPath: string;
  networkMarker: string;
  networkBlocker: string;
  testPinsHook: string;
} {
  const directory = mkdtempSync(join(tmpdir(), 'consumer-cli-process-'));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const databasePath = join(directory, 'worker.db');
  const database = new DatabaseSync(databasePath);
  if (schema === 'current') {
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION);
    runMigration68(database);
  } else if (schema === 'missing_migration') {
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    database.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(CURRENT_SCHEMA_MIGRATION - 1);
  }
  database.close();
  chmodSync(databasePath, 0o600);

  const configPath = join(directory, 'worker.json');
  writeFileSync(configPath, JSON.stringify({
    databasePath,
    linksBaseUrl: `https://${TEST_LINK_HOST}/s/api/v1`,
    pollIntervalMs: 60_000,
    adapters: [{
      kind: 'password', resourceId: 'fixed-password-resource', principal: 'fixed-principal', action: 'sign_in',
      endpoint: 'https://fixed-target.invalid/login', username: 'fixed-user',
    }],
  }), { mode: 0o600 });

  const networkMarker = join(directory, 'network-attempt');
  const networkBlocker = join(directory, 'network-blocker.cjs');
  writeFileSync(networkBlocker, [
    "const { writeFileSync } = require('node:fs');",
    "const marker = process.env.CONSUMER_CLI_NETWORK_MARKER;",
    "globalThis.fetch = async () => { writeFileSync(marker, 'attempt'); throw new Error('network disabled by CLI test'); };",
  ].join('\n'), { mode: 0o600 });

  // The child runs the real entrypoint, so vi.mock cannot reach it. A module
  // resolve hook swaps the production pins module for one that keeps every
  // real export but pins the neutral test hosts instead.
  const testPins = join(directory, 'test-pins.mjs');
  writeFileSync(testPins, [
    "import { createHash } from 'node:crypto';",
    `export * from ${JSON.stringify(PINS_MODULE_URL)};`,
    "const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');",
    'export const PROTECTED_DELIVERY_PINS = Object.freeze({',
    `  deliveryHostSha256: new Set([digest(${JSON.stringify(TEST_DELIVERY_HOST)})]),`,
    `  linkHostSha256: new Set([digest(${JSON.stringify(TEST_LINK_HOST)}), digest(${JSON.stringify(TEST_DELIVERY_HOST)})]),`,
    `  canonicalLinkHostSha256: new Set([digest(${JSON.stringify(TEST_LINK_HOST)})]),`,
    '});',
  ].join('\n'), { mode: 0o600 });
  const testPinsLoader = join(directory, 'test-pins-loader.mjs');
  writeFileSync(testPinsLoader, [
    `const target = ${JSON.stringify(PINS_MODULE_URL)};`,
    `const replacement = ${JSON.stringify(pathToFileURL(testPins).href)};`,
    'export async function resolve(specifier, context, nextResolve) {',
    '  const resolved = await nextResolve(specifier, context);',
    '  return resolved.url === target && context.parentURL !== replacement ? { url: replacement, shortCircuit: true } : resolved;',
    '}',
  ].join('\n'), { mode: 0o600 });
  const testPinsHook = join(directory, 'test-pins-hook.mjs');
  writeFileSync(testPinsHook, [
    "import { register } from 'node:module';",
    `register(${JSON.stringify(pathToFileURL(testPinsLoader).href)});`,
  ].join('\n'), { mode: 0o600 });
  return { configPath, networkMarker, networkBlocker, testPinsHook };
}

function launchWorker(files: ReturnType<typeof privateWorkerFiles>, pins: 'test' | 'production' = 'test'): WorkerChild {
  let stdout = '';
  let stderr = '';
  let closed = false;
  let error: Error | null = null;
  const child = spawn(PINNED_NODE, [
    '--require', files.networkBlocker,
    ...(pins === 'test' ? ['--import', pathToFileURL(files.testPinsHook).href] : []),
    '--disable-warning=ExperimentalWarning', '--experimental-strip-types',
    WORKER_MAIN, '--config', files.configPath,
  ], {
    cwd: REPO_ROOT,
    env: {
      HOME: dirname(files.configPath),
      LOG_LEVEL: 'silent',
      PATH: dirname(PINNED_NODE),
      TMPDIR: dirname(files.configPath),
      LINKS_MANAGED_TRANSPORT_TOKEN: DUMMY_TRANSPORT_TOKEN,
      LINKS_MANAGED_CONSUMER_TOKEN: DUMMY_CONSUMER_TOKEN,
      CONSUMER_CLI_NETWORK_MARKER: files.networkMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const result = new Promise<ChildExit>((resolveExit) => {
    child.once('error', (childError) => { error = childError; });
    child.once('close', (code, signal) => {
      closed = true;
      resolveExit({ code, signal, error });
    });
  });
  const run: WorkerChild = {
    child,
    closed: result,
    isClosed: () => closed,
    stdout: () => stdout,
    stderr: () => stderr,
  };
  children.add(run);
  void result.then(() => { children.delete(run); });
  return run;
}

async function awaitOwnedChild(run: WorkerChild, label: string): Promise<ChildExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), CHILD_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (!run.isClosed()) run.child.kill('SIGKILL');
    await Promise.race([
      run.closed,
      new Promise<void>((resolve) => { setTimeout(resolve, CHILD_TIMEOUT_MS); }),
    ]);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function awaitLifecycle(run: WorkerChild, event: string, label: string): Promise<void> {
  if (run.stderr().includes(event)) return;
  let listener: (() => void) | undefined;
  let closeListener: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveLifecycle, reject) => {
      const finish = (callback: () => void) => {
        if (listener) run.child.stderr?.off('data', listener);
        if (closeListener) run.child.off('close', closeListener);
        if (timer !== undefined) clearTimeout(timer);
        callback();
      };
      listener = () => {
        if (run.stderr().includes(event)) finish(resolveLifecycle);
      };
      closeListener = () => finish(() => reject(new Error(`${label} exited before ${event}`)));
      timer = setTimeout(() => finish(() => reject(new Error(`${label} timed out waiting for ${event}`))), CHILD_TIMEOUT_MS);
      run.child.stderr?.on('data', listener);
      run.child.once('close', closeListener);
    });
  } catch (error) {
    if (!run.isClosed()) run.child.kill('SIGKILL');
    try {
      await awaitOwnedChild(run, `${label} cleanup`);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${label} failed and its owned child did not settle`);
    }
    throw error;
  }
}

async function stopOwnedChild(run: WorkerChild): Promise<void> {
  if (!run.isClosed()) run.child.kill('SIGKILL');
  await awaitOwnedChild(run, 'owned child cleanup');
}

function expectSafeFailure(result: ChildExit, run: WorkerChild, files: ReturnType<typeof privateWorkerFiles>): void {
  expect(result).toEqual({ code: 1, signal: null, error: null });
  expect(run.stdout()).toBe('');
  expect(run.stderr()).toBe('{"event":"consumer_start_failed"}\n');
  expect(`${run.stdout()}${run.stderr()}`).not.toContain('consumer_started');
  expect(`${run.stdout()}${run.stderr()}`).not.toContain(files.configPath);
  expect(`${run.stdout()}${run.stderr()}`).not.toContain(DUMMY_TRANSPORT_TOKEN);
  expect(`${run.stdout()}${run.stderr()}`).not.toContain(DUMMY_CONSUMER_TOKEN);
  expect(existsSync(files.networkMarker)).toBe(false);
}

describe('fixed consumer service launch configuration', () => {
  it('accepts one absolute config path and no credential or destination arguments', () => {
    const path = resolve('/private/config.json');
    expect(consumerConfigPath(['--config', path])).toBe(path);
    for (const args of [[], ['--config'], ['--config', 'relative.json'], ['--config', path, '--token', 'dummy'], ['--endpoint', path]]) {
      expect(() => consumerConfigPath(args)).toThrow('consumer service requires --config with one absolute path');
    }
  });

  it('reads only a bounded owner-private regular JSON file', () => {
    const path = configFile();
    expect(readConsumerConfig(path)).toEqual({ databasePath: '/private/metadata.db' });
    chmodSync(path, 0o644);
    expect(() => readConsumerConfig(path)).toThrow('consumer service configuration is unavailable');
  });

  it('refuses symlinks, missing files, oversized input, and malformed input without reflecting values', () => {
    const path = configFile();
    const link = join(directories[0], 'link.json');
    symlinkSync(path, link);
    const oversized = configFile('x'.repeat(16_385));
    const malformed = configFile('DUMMY-private-value-that-must-not-be-reflected');
    for (const value of [link, join(directories[0], 'missing.json'), oversized, malformed]) {
      expect(() => readConsumerConfig(value)).toThrow('consumer service configuration is unavailable');
    }
  });

  it('starts against an empty schema-68 database and exits cleanly after SIGTERM without a network request', async () => {
    const files = privateWorkerFiles('current');
    const run = launchWorker(files);
    try {
      await awaitLifecycle(run, '{"event":"consumer_started"}\n', 'consumer startup');
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toBe('{"event":"consumer_started"}\n');
      expect(existsSync(files.networkMarker)).toBe(false);

      expect(run.child.kill('SIGTERM')).toBe(true);
      const result = await awaitOwnedChild(run, 'consumer SIGTERM shutdown');

      expect(result).toEqual({ code: 0, signal: null, error: null });
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toBe('{"event":"consumer_started"}\n{"event":"consumer_stopped"}\n');
      expect(existsSync(files.networkMarker)).toBe(false);
    } finally {
      await stopOwnedChild(run);
    }
  });

  it('fails closed under the production pins when the links API host is not pinned', async () => {
    const files = privateWorkerFiles('current');
    const run = launchWorker(files, 'production');
    try {
      const result = await awaitOwnedChild(run, 'consumer unpinned links host rejection');
      expectSafeFailure(result, run, files);
    } finally {
      await stopOwnedChild(run);
    }
  });

  it('fails closed for invalid and migration-missing databases without lifecycle or configuration output', async () => {
    for (const schema of ['empty', 'missing_migration'] as const) {
      const files = privateWorkerFiles(schema);
      const run = launchWorker(files);
      try {
        const result = await awaitOwnedChild(run, `consumer ${schema} schema rejection`);
        expectSafeFailure(result, run, files);
      } finally {
        await stopOwnedChild(run);
      }
    }
  });
});
