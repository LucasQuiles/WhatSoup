// src/runtimes/agent/providers/claude-refresh-ahead.ts
//
// Keep a killed `claude` probe from losing a rotated OAuth token.
//
// The claude CLI (2.1.30x) refreshes its OAuth login inside any run that
// loads auth (`-p`, `auth status`, `mcp list`, `plugin list`; not
// `--version`) once the stored access token is within 5 minutes of expiry
// (`now + 300000 >= expiresAt`). It serializes refresh per storage dir with a
// lock at `<dir>/.oauth_refresh.lock` (stale after 60 s, mtime touched every
// 5 s while held), re-reads the store under the lock and saves with
// compare-and-swap. A child killed after the server rotated the refresh token
// but before the save loses the rotation: the next refresh posts the old
// token, gets invalid_grant, and the CLI wipes the stored login. On SIGTERM
// it waits only 2 s for an in-flight refresh. The periodic primary-model
// probe performed most observed rotations, under a 15 s kill budget.
//
// Two mitigations, both for WhatSoup's own killable non-turn children:
//   - refresh-ahead: before such a child, when the stored token is near, past
//     or of unknown expiry, run one `claude auth status --json` that WhatSoup
//     never times out and never signals, so the refresh happens in a child
//     that always finishes. Concurrent callers for one storage dir share it.
//     A caller waits at most REFRESH_AHEAD_WAIT_MS for it; if it is still
//     running, the probe is deferred (no killable child is spawned) and the
//     child keeps running. After REFRESH_AHEAD_HARD_CAP_MS the local wait is
//     logged as hung, but its durable owner claim still defers later callers
//     until that exact child closes; it is never killed.
//     The child runs detached (its own process group), so a signal to the
//     bot's group at shutdown or restart cannot reach it mid-refresh.
//   - kill grace: before signalling such a child, wait (bounded) while the
//     refresh lock is held and fresh. The check and the signal are not
//     atomic: a refresh that takes the lock in the few milliseconds between
//     the last check and the signal is not protected.
//
// For a bot with neither CLAUDE_CONFIG_DIR nor CLAUDE_SECURESTORAGE_CONFIG_DIR
// set, the expiry is read from the bare default keychain item: for that bot
// it is its own login, the one its `claude` children use.
//
// Only `claudeAiOauth.expiresAt` is read (through the heal module's reader,
// the one keychain/file-store reader WhatSoup has). No token value is kept or
// logged, and the child's output is never captured.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { systemClock } from '../../../lib/clock.ts';
import { createPrivateFileIsolatedSync } from '../../../lib/private-fs-isolated.ts';
import { deletePrivateFileSync, readPrivateFileSync } from '../../../lib/private-fs.ts';
import { CLAUDE_AUTH_STATUS_ARGS } from './account-auth-status.ts';
import {
  claudeCredentialServiceLabel,
  claudeSecureStorageDir,
  readClaudeCredentialExpiry,
  underTestRunner,
  type ClaudeCredentialReadDeps,
} from './claude-filestore-heal.ts';
import { CLAUDE_PROBE_EVENTS, probeLifecycleObservers } from './probe-lifecycle-log.ts';

/**
 * Refresh ahead when the token expires within this window. Equal to the CLI's
 * own refresh threshold (5 min), and deliberately not wider: a refresh-ahead
 * child started inside this window is certain to refresh (the window only
 * shrinks with time), while one started outside it would refresh nothing and
 * leave the refresh to the killable probe. Not narrower either: every token
 * the probe's CLI would refresh at its start is refreshed here first.
 */
export const REFRESH_AHEAD_MS = 300_000;

/** The CLI treats its refresh lock as stale after 60 s (proper-lockfile `stale`). */
export const REFRESH_LOCK_STALE_MS = 60_000;

/**
 * Longest WhatSoup delays a kill while the refresh lock is held. A refresh
 * normally holds the lock for well under 5 s (one token POST plus a store
 * write). 25 s also covers the CLI's own lock-contention budget (5 retries of
 * 1–2 s plus a 7.5 s settle wait, about 17.5 s), and stays bounded so a
 * wedged holder cannot keep a probe alive for the 60 s stale window.
 */
export const REFRESH_LOCK_GRACE_MS = 25_000;

/**
 * Longest a probe waits for a refresh-ahead child before it is deferred.
 * A healthy `auth status` with a refresh finishes in seconds; 60 s also
 * covers a refresh that waits out another process's lock (stale at 60 s).
 */
export const REFRESH_AHEAD_WAIT_MS = 60_000;

/** After this long a still-running child stops local waiting but keeps its durable hold (never killed). */
export const REFRESH_AHEAD_HARD_CAP_MS = 10 * 60_000;

const REFRESH_LOCK_POLL_MS = 250;
const STILL_RUNNING_LOG_MS = 60_000;
const OAUTH_REFRESH_LOCK = '.oauth_refresh.lock';
const OWNER_DIRECTORY = '.whatsoup-refresh-ahead';
const OWNER_FILENAME = 'owner.json';
const OWNER_MAX_BYTES = 4 * 1024;
const OWNER_LABEL = 'claude refresh-ahead owner claim';

type Log = {
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
  error: (o: Record<string, unknown>, m: string) => void;
};

export type ClaudeRefreshAheadReason = 'expiry-unknown' | 'expired' | 'within-window';

export type ClaudeRefreshAheadResult =
  | { outcome: 'not-needed' }
  | { outcome: 'skipped-test-runner'; reason: ClaudeRefreshAheadReason }
  | { outcome: 'spawn-failed'; reason: ClaudeRefreshAheadReason }
  | { outcome: 'ran'; reason: ClaudeRefreshAheadReason; exitCode: number | null; signal: NodeJS.Signals | null }
  /** The caller's wait ended while the child still runs: defer the probe, spawn nothing killable. */
  | { outcome: 'still-running' };

/** True when a refresh-ahead result says the probe must be deferred. */
export function refreshAheadStillRunning(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { outcome?: unknown }).outcome === 'still-running';
}

export interface ClaudeRefreshAheadDeps extends ClaudeCredentialReadDeps {
  now?: () => number;
  /** Injected in tests. When absent under a test runner, nothing is read or spawned. */
  spawnImpl?: typeof spawn;
  log?: Log;
}

const inFlight = new Map<string, Promise<ClaudeRefreshAheadResult>>();
/** Refresh-ahead children still alive per storage dir, including ones past the hard cap. */
const liveChildren = new Map<string, number>();

function trackLive(key: string, delta: 1 | -1): void {
  const next = (liveChildren.get(key) ?? 0) + delta;
  if (next > 0) liveChildren.set(key, next);
  else liveChildren.delete(key);
}

type RefreshOwnerLocation = {
  store: string;
  directory: string;
  path: string;
};

/**
 * The durable owner namespace is the canonical effective store, not its
 * spelling. A failure to establish that namespace is held conservatively.
 */
function refreshOwnerLocation(env: NodeJS.ProcessEnv): RefreshOwnerLocation | null {
  try {
    const store = realpathSync(claudeSecureStorageDir(env));
    const directory = join(store, OWNER_DIRECTORY);
    return { store, directory, path: join(directory, OWNER_FILENAME) };
  } catch {
    return null;
  }
}

/** Any observed or unsafe claim holds the refresh; its contents are irrelevant to acquisition. */
function ownerClaimHeld(location: RefreshOwnerLocation): boolean {
  try {
    return readPrivateFileSync(location.path, {
      label: OWNER_LABEL,
      maxBytes: OWNER_MAX_BYTES,
      observation: { root: location.store },
    }) !== null;
  } catch {
    return true;
  }
}

/**
 * Create only our private state child, then observe it again before the
 * isolated writer could force its mode. Existing or uncertain state holds.
 */
function acquireOwnerClaim(location: RefreshOwnerLocation, fence: string): boolean {
  try {
    mkdirSync(location.directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  if (ownerClaimHeld(location)) return false;
  try {
    createPrivateFileIsolatedSync(
      location.path,
      JSON.stringify({ version: 1, fence }),
      OWNER_LABEL,
    );
    return true;
  } catch {
    // EEXIST and every uncertain publication state both mean a hold.
    return false;
  }
}

/**
 * The close observer removes only the fence it created. This is cooperative
 * same-user protection, not isolation against a malicious same-UID replacer.
 */
function releaseOwnerClaim(location: RefreshOwnerLocation, fence: string): void {
  try {
    const observed = readPrivateFileSync(location.path, {
      label: OWNER_LABEL,
      maxBytes: OWNER_MAX_BYTES,
      observation: { root: location.store },
    });
    if (observed === null) return;
    const parsed = JSON.parse(observed.bytes.toString('utf8')) as { fence?: unknown };
    if (parsed.fence !== fence) return;
    deletePrivateFileSync(location.path, OWNER_LABEL);
  } catch {
    // Unknown, malformed, and unsafe ownership state remains held.
  }
}

function refreshReason(expiresAt: number | null, now: number): ClaudeRefreshAheadReason | null {
  if (expiresAt === null) return 'expiry-unknown';
  if (expiresAt <= now) return 'expired';
  return expiresAt - now <= REFRESH_AHEAD_MS ? 'within-window' : null;
}

/**
 * Run one never-killed `claude auth status --json` with `env` (the env of the
 * probe child that follows) when the stored token is near, past or of unknown
 * expiry, and resolve when it exits, or with 'still-running' once the caller
 * has waited REFRESH_AHEAD_WAIT_MS. Callers for the same storage dir share
 * one in-flight run. Never rejects.
 */
export function refreshClaudeLoginAhead(
  binary: string,
  env: NodeJS.ProcessEnv,
  deps: ClaudeRefreshAheadDeps = {},
): Promise<ClaudeRefreshAheadResult> {
  // Keep the existing test-runner boundary before any config-store or claim
  // filesystem operation: default test fixtures may deliberately not exist.
  if (!deps.spawnImpl && underTestRunner()) {
    return Promise.resolve({ outcome: 'skipped-test-runner', reason: 'expiry-unknown' });
  }

  const location = refreshOwnerLocation(env);
  if (location === null) return Promise.resolve({ outcome: 'still-running' });
  const key = location.store;
  let run = inFlight.get(key);
  if (run) return waitBounded(run);
  // A child past its hard cap no longer blocks the wait, but while it is
  // alive no second refresh child and no killable probe may start.
  if (!run && liveChildren.has(key)) return Promise.resolve({ outcome: 'still-running' });
  // A previous parent may have died with its child alive. Its claim must win
  // over a newly renewed credential or any later expiry fast path.
  if (ownerClaimHeld(location)) return Promise.resolve({ outcome: 'still-running' });
  const release = (): void => {
    if (inFlight.get(key) === created) inFlight.delete(key);
  };
  const created: Promise<ClaudeRefreshAheadResult> = runRefreshAhead(
    binary, env, deps, release, key, location,
  ).finally(release);
  run = created;
  inFlight.set(key, created);
  return waitBounded(run);
}

function waitBounded(run: Promise<ClaudeRefreshAheadResult>): Promise<ClaudeRefreshAheadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<ClaudeRefreshAheadResult>((resolveWait) => {
    timer = setTimeout(() => resolveWait({ outcome: 'still-running' }), REFRESH_AHEAD_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([run, waited]).finally(() => clearTimeout(timer));
}

async function runRefreshAhead(
  binary: string,
  env: NodeJS.ProcessEnv,
  deps: ClaudeRefreshAheadDeps,
  release: () => void,
  key: string,
  location: RefreshOwnerLocation,
): Promise<ClaudeRefreshAheadResult> {
  const now = deps.now ?? (() => systemClock.now());
  let expiresAt: number | null = null;
  try {
    expiresAt = readClaudeCredentialExpiry(env, deps).expiresAt;
  } catch {
    expiresAt = null;
  }
  const reason = refreshReason(expiresAt, now());
  if (reason === null) return { outcome: 'not-needed' };

  const fence = randomUUID();
  if (!acquireOwnerClaim(location, fence)) return { outcome: 'still-running' };

  const log = deps.log ?? createChildLogger('claude-refresh-ahead');
  const base = { purpose: 'refresh-ahead', reason, credentialService: claudeCredentialServiceLabel(env) };
  const observers = probeLifecycleObservers(log, CLAUDE_PROBE_EVENTS, base);
  const exitOf = (pid: number | undefined, exitCode: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean) => ({
    pid, exitCode, signal, killedByTimeout: false, killedByAbort: false, spawnFailed,
  });
  const quietly = (fn: () => void): void => {
    try { fn(); } catch { /* deliberately: a lifecycle observer (a log line) must never change the outcome */ }
  };

  return new Promise<ClaudeRefreshAheadResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // No timeout, no AbortSignal, output discarded (no pipes hold the parent):
      // this child always runs to its own exit. Detached: its own process
      // group, out of reach of a signal sent to the bot's group.
      child = (deps.spawnImpl ?? spawn)(binary, [...CLAUDE_AUTH_STATUS_ARGS], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env,
        detached: true,
        windowsHide: true,
      });
    } catch {
      quietly(() => observers.onSpawned(undefined));
      quietly(() => observers.onExited(exitOf(undefined, null, null, true)));
      resolve({ outcome: 'spawn-failed', reason });
      return;
    }
    const pid = child.pid;
    const startedAt = now();
    quietly(() => observers.onSpawned(pid));
    // Visibility only: a slow refresh is logged, never cut short.
    const stillRunning = setInterval(() => {
      quietly(() => log.info(
        { event: 'claude_probe_still_running', purpose: 'refresh-ahead', pid: pid ?? null, elapsedMs: now() - startedAt },
        'claude refresh-ahead child still running (not killed)',
      ));
    }, STILL_RUNNING_LOG_MS);
    stillRunning.unref?.();
    // A child that never exits keeps its durable hold. This only stops later
    // callers from awaiting this local promise; it never permits another probe.
    child.unref?.();
    trackLive(key, 1);
    const hardCap = setTimeout(() => {
      release();
      clearInterval(stillRunning);
      quietly(() => log.error(
        { event: 'claude_refresh_ahead_hung', purpose: 'refresh-ahead', pid: pid ?? null, elapsedMs: now() - startedAt },
        'claude refresh-ahead child exceeded its hard cap; durable owner remains held and later probes defer',
      ));
    }, REFRESH_AHEAD_HARD_CAP_MS);
    hardCap.unref?.();
    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): void => {
      if (finished) return;
      finished = true;
      clearInterval(stillRunning);
      clearTimeout(hardCap);
      trackLive(key, -1);
      quietly(() => observers.onExited(exitOf(pid, exitCode, signal, spawnFailed)));
      resolve(spawnFailed ? { outcome: 'spawn-failed', reason } : { outcome: 'ran', reason, exitCode, signal });
    };
    // An error from a spawned child does not end it; only close does.
    child.on('error', () => { if (child.pid === undefined) finish(null, null, true); });
    child.on('close', (code, signal) => {
      releaseOwnerClaim(location, fence);
      finish(code, signal, false);
    });
  });
}

export type ClaudeRefreshLockGraceResult = {
  outcome: 'lock-released' | 'grace-exhausted';
  waitedMs: number;
};

export interface ClaudeRefreshLockGraceDeps {
  now?: () => number;
  /** mtime (ms epoch) of `path`, or null when absent. Injected in tests. */
  statMtimeMs?: (path: string) => number | null;
  realpath?: (path: string) => string;
  log?: Log;
}

function defaultStatMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The CLI's refresh lock for `env`'s storage dir, and the legacy lock it also
 * holds beside the directory (`<realpath(dir)>.lock`).
 */
function refreshLockPaths(env: NodeJS.ProcessEnv, realpath: (path: string) => string): string[] {
  const dir = claudeSecureStorageDir(env);
  return [join(dir, OAUTH_REFRESH_LOCK), `${realpath(dir)}.lock`];
}

/**
 * Called right before WhatSoup signals a `claude` child it started with `env`.
 * Returns null (signal now) when no refresh lock is held or every held lock is
 * stale; otherwise a promise that resolves once the lock is gone or stale, or
 * after {@link REFRESH_LOCK_GRACE_MS}, whichever is first. The first check is
 * synchronous so the common no-lock case adds no delay. Never rejects.
 */
export function claudeRefreshLockGrace(
  env: NodeJS.ProcessEnv,
  purpose: string,
  deps: ClaudeRefreshLockGraceDeps = {},
): Promise<ClaudeRefreshLockGraceResult> | null {
  // A test run must not wait on a real host's lock.
  if (!deps.statMtimeMs && underTestRunner()) return null;
  const now = deps.now ?? (() => systemClock.now());
  const statMtimeMs = deps.statMtimeMs ?? defaultStatMtimeMs;
  let paths: string[];
  try {
    paths = refreshLockPaths(env, deps.realpath ?? defaultRealpath);
  } catch {
    return null;
  }
  const held = (): boolean => paths.some((path) => {
    const mtime = statMtimeMs(path);
    return mtime !== null && now() - mtime < REFRESH_LOCK_STALE_MS;
  });
  if (!held()) return null;

  const log = deps.log ?? createChildLogger('claude-refresh-ahead');
  const credentialService = claudeCredentialServiceLabel(env);
  const startedAt = now();
  return new Promise<ClaudeRefreshLockGraceResult>((resolve) => {
    const poll = (): void => {
      const waitedMs = now() - startedAt;
      let outcome: ClaudeRefreshLockGraceResult['outcome'] | null = null;
      try {
        if (!held()) outcome = 'lock-released';
      } catch {
        outcome = 'lock-released';
      }
      if (outcome === null && waitedMs >= REFRESH_LOCK_GRACE_MS) outcome = 'grace-exhausted';
      if (outcome === null) {
        setTimeout(poll, REFRESH_LOCK_POLL_MS);
        return;
      }
      const fields = { event: 'claude_refresh_lock_grace', purpose, credentialService, outcome, waitedMs };
      try {
        if (outcome === 'lock-released') {
          log.info(fields, 'delayed a claude child kill until its OAuth refresh lock was released');
        } else {
          log.warn(fields, 'claude OAuth refresh lock still held after the kill grace; signalling anyway');
        }
      } catch { /* deliberately: the log line must never block the kill */ }
      resolve({ outcome, waitedMs });
    };
    setTimeout(poll, REFRESH_LOCK_POLL_MS);
  });
}
