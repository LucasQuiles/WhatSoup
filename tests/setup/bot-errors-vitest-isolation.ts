import { afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

const LIVE_ROUTING_ENV_KEYS = [
  'BOT_ERRORS_ALLOW_LIVE_IN_TESTS',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'BOT_ERRORS_JID',
  'BOT_ERRORS_EXPECTED_JID',
  'BOT_ERRORS_SOCKET',
  'BOT_ERRORS_SOCKET_PATH',
  'BOT_ERRORS_DB',
] as const;

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'main';
}

for (const key of LIVE_ROUTING_ENV_KEYS) {
  delete process.env[key];
}

const workerId = safeSegment(process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? 'main');

const tempRoot = realpathSync('/tmp');
const isolatedHome = mkdtempSync(join(tempRoot, 'ws-vh-'));
const ownershipToken = randomUUID();
const ownershipMarker = join(isolatedHome, '.whatsoup-vitest-home');
const isolatedTmpdir = join(isolatedHome, 'tmp');
chmodSync(isolatedHome, 0o700);
mkdirSync(isolatedTmpdir, { mode: 0o700 });
writeFileSync(ownershipMarker, ownershipToken, { mode: 0o600 });

let isolatedHomeRemoved = false;

function removeIsolatedHome(): void {
  if (isolatedHomeRemoved) {
    return;
  }
  const stat = lstatSync(isolatedHome);
  const resolved = realpathSync(isolatedHome);
  const fromTempRoot = relative(tempRoot, resolved);
  const escapedTempRoot = fromTempRoot === '..'
    || fromTempRoot.startsWith(`..${sep}`)
    || isAbsolute(fromTempRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || escapedTempRoot) {
    throw new Error('refusing to remove an unowned Vitest HOME');
  }
  if (readFileSync(ownershipMarker, 'utf8') !== ownershipToken) {
    throw new Error('refusing to remove Vitest HOME without its ownership marker');
  }
  rmSync(isolatedHome, { recursive: true, force: true });
  isolatedHomeRemoved = true;
}

afterAll(() => {
  removeIsolatedHome();
});

// afterAll only runs after a completed test-file run; collection-only passes
// (`vitest list`) and bailed/crashed workers exit without it and leak the dir.
process.once('exit', () => {
  try {
    removeIsolatedHome();
  } catch {
    // Never throw during process exit; an unowned dir is left in place.
  }
});

process.env['WHATSOUP_VITEST_HOME'] = isolatedHome;
process.env['WHATSOUP_VITEST_TEMP_ROOT'] = tempRoot;
process.env['HOME'] = isolatedHome;
process.env['TMPDIR'] = isolatedTmpdir;
process.env['XDG_CONFIG_HOME'] = join(isolatedHome, '.config');
process.env['XDG_DATA_HOME'] = join(isolatedHome, '.local', 'share');
process.env['XDG_STATE_HOME'] = join(isolatedHome, '.local', 'state');
process.env['XDG_CACHE_HOME'] = join(isolatedHome, '.cache');
delete process.env['CLAUDE_CONFIG_DIR'];

process.env['BOT_ERRORS_TEST_ISOLATED'] = '1';
process.env['BOT_ERRORS_STATE_DIR'] = join(
  tmpdir(),
  'whatsoup-vitest-bot-errors',
  workerId,
  String(process.pid),
  'state',
);

// Per-TEST marker-store isolation — OPT-IN, not global.
//
// The recovery-authority store persists alert markers under
// BOT_ERRORS_STATE_DIR, and consumers restore alert ownership from them at
// construction (connection.ts:738, scheduler.ts:144, health-poller.ts:809).
// A worker-wide directory therefore lets an early test's marker suppress a
// later test's expected alert — an order-dependent false green that only
// surfaced once the store learned to create its own directory.
//
// Scoped, not global: a suite-wide beforeEach override changes the semantics of
// EVERY test file — it broke the isolation guard's env contract
// (bot-errors-test-isolation expects the worker-level whatsoup-vitest-bot-errors
// path) and the tests that legitimately depend on intra-file marker persistence
// (model-advisor T1–T4 cold-start reconcile, dispatcher provenance stamping).
// Only the files whose order-dependent leaks this repairs opt in.
//
// Named, not created: the store materialises the directory on first write, so
// tests that never touch markers cost nothing and this adds no per-test mkdtemp
// or cleanup obligation. The path sits under the owned isolatedHome, so the
// existing ownership-token-guarded teardown — including the process-exit
// fallback for bailed workers — removes every one of them. afterAll restores the
// worker-level default so the last per-test path cannot bleed into the next file
// in the same worker.
const perTestMarkerRoot = join(isolatedHome, '.local', 'state', 'whatsoup-test-markers');
let perTestMarkerSeq = 0;

export function usePerTestBotErrorsMarkerIsolation(): void {
  const workerDefault = process.env['BOT_ERRORS_STATE_DIR'];
  beforeEach(() => {
    perTestMarkerSeq += 1;
    process.env['BOT_ERRORS_STATE_DIR'] = join(perTestMarkerRoot, String(perTestMarkerSeq), 'state');
  });
  afterAll(() => {
    if (workerDefault === undefined) {
      delete process.env['BOT_ERRORS_STATE_DIR'];
    } else {
      process.env['BOT_ERRORS_STATE_DIR'] = workerDefault;
    }
  });
}
