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
//   - kill grace: before signalling such a child, wait (bounded) while the
//     refresh lock is held and fresh.
//
// Only `claudeAiOauth.expiresAt` is read (through the heal module's reader,
// the one keychain/file-store reader WhatSoup has). No token value is kept or
// logged, and the child's output is never captured.

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { systemClock } from '../../../lib/clock.ts';
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

const REFRESH_LOCK_POLL_MS = 250;
const STILL_RUNNING_LOG_MS = 60_000;
const OAUTH_REFRESH_LOCK = '.oauth_refresh.lock';

type Log = { info: (o: Record<string, unknown>, m: string) => void; warn: (o: Record<string, unknown>, m: string) => void };

export type ClaudeRefreshAheadReason = 'expiry-unknown' | 'expired' | 'within-window';

export type ClaudeRefreshAheadResult =
  | { outcome: 'not-needed' }
  | { outcome: 'skipped-test-runner'; reason: ClaudeRefreshAheadReason }
  | { outcome: 'spawn-failed'; reason: ClaudeRefreshAheadReason }
  | { outcome: 'ran'; reason: ClaudeRefreshAheadReason; exitCode: number | null; signal: NodeJS.Signals | null };

export interface ClaudeRefreshAheadDeps extends ClaudeCredentialReadDeps {
  now?: () => number;
  /** Injected in tests. When absent under a test runner, nothing is read or spawned. */
  spawnImpl?: typeof spawn;
  log?: Log;
}

const inFlight = new Map<string, Promise<ClaudeRefreshAheadResult>>();

function refreshReason(expiresAt: number | null, now: number): ClaudeRefreshAheadReason | null {
  if (expiresAt === null) return 'expiry-unknown';
  if (expiresAt <= now) return 'expired';
  return expiresAt - now <= REFRESH_AHEAD_MS ? 'within-window' : null;
}

/**
 * Run one never-killed `claude auth status --json` with `env` (the env of the
 * probe child that follows) when the stored token is near, past or of unknown
 * expiry, and resolve when it exits. Callers for the same storage dir share
 * one in-flight run. Never rejects.
 */
export function refreshClaudeLoginAhead(
  binary: string,
  env: NodeJS.ProcessEnv,
  deps: ClaudeRefreshAheadDeps = {},
): Promise<ClaudeRefreshAheadResult> {
  const key = claudeSecureStorageDir(env);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = runRefreshAhead(binary, env, deps).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function runRefreshAhead(
  binary: string,
  env: NodeJS.ProcessEnv,
  deps: ClaudeRefreshAheadDeps,
): Promise<ClaudeRefreshAheadResult> {
  const now = deps.now ?? (() => systemClock.now());
  // Never read a live login or start a live CLI from a test run that did not
  // inject its own child.
  const testRunnerDefaults = !deps.spawnImpl && underTestRunner();
  let expiresAt: number | null = null;
  if (!testRunnerDefaults) {
    try {
      expiresAt = readClaudeCredentialExpiry(env, deps).expiresAt;
    } catch {
      expiresAt = null;
    }
  }
  const reason = refreshReason(expiresAt, now());
  if (reason === null) return { outcome: 'not-needed' };
  if (testRunnerDefaults) return { outcome: 'skipped-test-runner', reason };

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
      // No timeout, no AbortSignal, output discarded: this child always runs to its own exit.
      child = (deps.spawnImpl ?? spawn)(binary, [...CLAUDE_AUTH_STATUS_ARGS], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env,
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
    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean): void => {
      if (finished) return;
      finished = true;
      clearInterval(stillRunning);
      quietly(() => observers.onExited(exitOf(pid, exitCode, signal, spawnFailed)));
      resolve(spawnFailed ? { outcome: 'spawn-failed', reason } : { outcome: 'ran', reason, exitCode, signal });
    };
    // An error from a spawned child does not end it; only close does.
    child.on('error', () => { if (child.pid === undefined) finish(null, null, true); });
    child.on('close', (code, signal) => finish(code, signal, false));
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
