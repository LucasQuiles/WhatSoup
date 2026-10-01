import { afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';
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
// The synthetic secret-tool reports itself absent (exit 127), which keyring
// classifies as an errored probe; an inherited REQUIRE_OS_KEYRING would then
// make unmocked backend detection throw instead of using env-only.
delete process.env['REQUIRE_OS_KEYRING'];

// OS credential stores are not HOME-scoped. Inherited test commands see a
// missing item on macOS, an empty read on Linux, and rejected writes; dedicated
// keyring tests retain their explicit process mocks. The Linux read stays empty
// because `secret-tool lookup` exits 1 for a missing item and for a failure
// alike, and keyring records such an exit as a failure. Each shim must stay
// runnable: a missing interpreter would make PATH lookup continue to the real
// binary.
const credentialBin = join(isolatedHome, 'credential-bin');
mkdirSync(credentialBin, { mode: 0o700 });
const rejection = 'synthetic credential backend rejects writes and unsupported operations';
// The two write operations take the secret on stdin, so their arm reads it to
// the end before rejecting: a shim that exits first makes the caller's write
// fail with EPIPE. `cat` does the reading because on macOS `wc -c` alone only
// stats a regular file. The message reports the discarded byte count, which
// lets a test witness the drain. A terminal stdin is left unread, so an
// interactive caller cannot block. A closed stdin is not read either: in macOS
// sh the pipe of the command substitution would take descriptor 0, and `cat`
// would wait on its own pipeline forever. The check duplicates descriptor 0
// onto another one, because macOS sh skips a duplication onto itself, and runs
// in a subshell, where a failed redirection cannot end the shim. Every other
// rejected operation leaves stdin unread.
const rejectWrite =
  `if ! ( true 3<&0 ) 2>/dev/null || [ -t 0 ]; then n=0; else n=$(( $(cat | wc -c) )); fi; printf '%s\\n' "${rejection} (discarded $n bytes of stdin)" >&2; exit 1 ;;`;
const rejectOther = `  *) printf '%s\\n' '${rejection}' >&2; exit 1 ;;`;
const syntheticCredentialBackends: Record<string, string> = {
  security: [
    '#!/bin/sh',
    'case "$1" in',
    // A missing item, as the real tool reports one: keyring treats a clean exit
    // 44 as a miss, and a shell caller that tests the status sees "not found".
    "  find-generic-password) printf '%s\\n' 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2; exit 44 ;;",
    "  --help) printf '%s\\n' 'Usage: synthetic credential backend'; exit 0 ;;",
    `  add-generic-password) ${rejectWrite}`,
    rejectOther,
    'esac',
    '',
  ].join('\n'),
  // Exit 127 on the backend probe: Linux runs select env-only, as on a host
  // without libsecret.
  'secret-tool': [
    '#!/bin/sh',
    'case "$1" in',
    "  --help) printf '%s\\n' 'secret-tool: not found (synthetic credential backend)' >&2; exit 127 ;;",
    '  lookup) exit 0 ;;',
    `  store) ${rejectWrite}`,
    rejectOther,
    'esac',
    '',
  ].join('\n'),
};
for (const [executable, body] of Object.entries(syntheticCredentialBackends)) {
  writeFileSync(join(credentialBin, executable), body, { mode: 0o700 });
}
process.env['PATH'] = `${credentialBin}${delimiter}${process.env['PATH'] ?? ''}`;

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
