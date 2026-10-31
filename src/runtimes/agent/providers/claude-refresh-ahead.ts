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
//     never signals, so rotation can finish before a killable probe starts.
//     Concurrent callers for one storage dir share it.
//     A caller waits at most REFRESH_AHEAD_WAIT_MS for it; if it is still
//     running, the probe is deferred (no killable child is spawned) and the
//     child keeps running. After REFRESH_AHEAD_HARD_CAP_MS the local wait is
//     logged as hung, but its durable owner claim still defers later callers
//     until that exact child closes. After a parent restart, a boot-bound
//     child identity permits recovery once that process is proven absent or
//     replaced. Unknown ownership is alertable and is never called live.
//     The child runs in its own process group. Graceful shutdown joins its
//     close event within the shutdown deadline; a supervisor's forced stop
//     can still kill the service cgroup, including a detached child.
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
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { systemClock } from '../../../lib/clock.ts';
import { createPrivateFileIsolatedSync, writeAtomicPrivateFileIsolatedSync } from '../../../lib/private-fs-isolated.ts';
import { deletePrivateFileSync, readPrivateFileSync, type PrivateFileObservation } from '../../../lib/private-fs.ts';
import { inspectRefreshProcess, type RefreshProcessObservation } from './claude-refresh-process-identity.ts';
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

/** Shared non-interactive auth command for refresh and account probes. */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status', '--json'];

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

/** After this long a still-running child stops local waiting but keeps its durable hold without signalling. */
export const REFRESH_AHEAD_HARD_CAP_MS = 10 * 60_000;

const REFRESH_LOCK_POLL_MS = 250;
const STILL_RUNNING_LOG_MS = 60_000;
const OAUTH_REFRESH_LOCK = '.oauth_refresh.lock';
const OWNER_DIRECTORY = '.whatsoup-refresh-ahead';
const OWNER_FILENAME = 'owner.json';
const MUTATION_FILENAME = 'owner.mutation.json';
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
  /** The refresh owner cannot be read or published; defer without claiming a live child. */
  | { outcome: 'owner-unavailable' }
  /** The caller's wait ended while the child still runs: defer the probe, spawn nothing killable. */
  | { outcome: 'still-running' }
  /**
   * A verified refresh is unhealthy: it exceeded this parent's hard cap, or it
   * was adopted from a prior parent whose elapsed duration cannot be bounded.
   * Its ownership fence remains held; callers must not signal or replace it.
   */
  | { outcome: 'hung' };

/** True when a refresh-ahead result says the probe must be deferred. */
export function refreshAheadDefersProbe(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const refresh = result as { outcome?: unknown; exitCode?: unknown; signal?: unknown };
  return refresh.outcome === 'owner-unavailable' || refresh.outcome === 'still-running' || refresh.outcome === 'hung' || refresh.outcome === 'spawn-failed'
    || (refresh.outcome === 'ran' && (refresh.exitCode !== 0 || refresh.signal !== null));
}

export interface ClaudeRefreshAheadDeps extends ClaudeCredentialReadDeps {
  now?: () => number;
  /** Injected in tests. When absent under a test runner, nothing is read or spawned. */
  spawnImpl?: typeof spawn;
  hostId?: string;
  inspectProcess?: (pid: number) => RefreshProcessObservation;
  log?: Log;
}

const inFlight = new Map<string, Promise<ClaudeRefreshAheadResult>>();
/** Refresh-ahead children still alive per storage dir, including ones past the hard cap. */
const liveChildren = new Map<string, { fence: string; verified: boolean; unhealthy: boolean; closed: Promise<void> }>();
let shutdownAdmissionClosed = false;

/** A content-free deadline result, distinct from an unexpected drain failure. */
export class ClaudeRefreshShutdownDeadlineError extends Error {
  constructor() {
    super('Claude refresh shutdown deadline expired');
    this.name = 'ClaudeRefreshShutdownDeadlineError';
  }
}

/** Join tracked children after callers quiesce, without signalling or releasing their claims. */
export async function awaitActiveClaudeRefreshes(deadlineAt: number): Promise<void> {
  // Close admission before taking the snapshot, including when no child is active.
  shutdownAdmissionClosed = true;
  const children = [...liveChildren.values()];
  if (children.length === 0) return;
  const remainingMs = deadlineAt - systemClock.now();
  if (remainingMs <= 0) throw new ClaudeRefreshShutdownDeadlineError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    // Keep shutdown alive even though refresh children and their timers are unref'd.
    timer = setTimeout(() => reject(new ClaudeRefreshShutdownDeadlineError()), remainingMs);
  });
  try {
    await Promise.race([Promise.all(children.map((child) => child.closed)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type RefreshOwnerLocation = {
  store: string;
  directory: string;
  path: string;
  guardPath: string;
};

/**
 * Existing stores receive the same ownership, privacy, and ancestor checks as
 * a store initialized by refresh-ahead. A final symlink is an established
 * canonical alias, so it may resolve to the store; the alias and its physical
 * parent chain, plus the resolved store and its physical ancestors, must
 * remain private and ownership-safe.
 */
function validatePrivateStoreParent(parent: string, uid: number): boolean {
  const parentIdentity = lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
    || parentIdentity.uid !== uid || (parentIdentity.mode & 0o022) !== 0) return false;
  for (let ancestor = dirname(parent);; ancestor = dirname(ancestor)) {
    const ancestorIdentity = lstatSync(ancestor);
    if (!ancestorIdentity.isDirectory() || ancestorIdentity.isSymbolicLink()
      || (ancestorIdentity.uid !== 0 && ancestorIdentity.uid !== uid)
      || ((ancestorIdentity.mode & 0o022) !== 0 && (ancestorIdentity.mode & 0o1000) === 0)) return false;
    if (dirname(ancestor) === ancestor) break;
  }
  return true;
}

function validateExistingCredentialStore(requested: string, store: string): boolean {
  if (typeof process.getuid !== 'function') return false;
  const uid = process.getuid();
  const requestedIdentity = lstatSync(requested);
  if (!requestedIdentity.isDirectory() && !requestedIdentity.isSymbolicLink()) return false;
  if (requestedIdentity.uid !== uid) return false;
  if (!validatePrivateStoreParent(realpathSync(dirname(requested)), uid)) return false;
  const identity = lstatSync(store);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.uid !== uid || (identity.mode & 0o077) !== 0) return false;
  return validatePrivateStoreParent(dirname(store), uid);
}

/**
 * The durable owner namespace is the canonical effective store, not its
 * spelling. A failure to establish that namespace fails closed without
 * claiming a live refresh owner.
 */
function refreshOwnerLocation(env: NodeJS.ProcessEnv): RefreshOwnerLocation | null {
  try {
    const requested = claudeSecureStorageDir(env);
    let store: string;
    try {
      store = realpathSync(requested);
      if (!validateExistingCredentialStore(requested, store)) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      // Render admission permits one absent leaf, but never missing ancestors or a dangling link.
      const parent = realpathSync(dirname(requested));
      if (typeof process.getuid !== 'function') return null;
      const uid = process.getuid();
      const parentIdentity = lstatSync(parent);
      if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
        || parentIdentity.uid !== uid || (parentIdentity.mode & 0o022) !== 0) return null;
      // Sticky shared ancestors protect entries owned by this UID (for example /tmp).
      for (let ancestor = dirname(parent);; ancestor = dirname(ancestor)) {
        const identity = lstatSync(ancestor);
        if (!identity.isDirectory() || identity.isSymbolicLink()
          || (identity.uid !== 0 && identity.uid !== uid)
          || ((identity.mode & 0o022) !== 0 && (identity.mode & 0o1000) === 0)) return null;
        if (dirname(ancestor) === ancestor) break;
      }
      const leaf = join(parent, basename(requested));
      try {
        lstatSync(leaf);
        return null;
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      // Initialization assumes cooperating same-UID writers. A parent exchange can
      // leave an empty directory; the identity check below still forbids credential access.
      try { mkdirSync(leaf, { mode: 0o700 }); } catch (creation) {
        if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      }
      const identity = lstatSync(leaf);
      if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o077) !== 0
        || identity.uid !== uid) return null;
      const currentParent = lstatSync(parent);
      store = realpathSync(requested);
      if (store !== leaf || currentParent.isSymbolicLink() || currentParent.dev !== parentIdentity.dev
        || currentParent.ino !== parentIdentity.ino) return null;
    }
    const directory = join(store, OWNER_DIRECTORY);
    return { store, directory, path: join(directory, OWNER_FILENAME), guardPath: join(directory, MUTATION_FILENAME) };
  } catch {
    return null;
  }
}

type OwnerClaimState = 'absent' | 'held' | 'unavailable';
type RefreshOwner = { version: 2 | 3; fence: string; hostId: string; pid: number; processBirthToken: string };

function readOwnerFile(location: RefreshOwnerLocation, path = location.path): PrivateFileObservation | null {
  return readPrivateFileSync(path, { label: OWNER_LABEL, maxBytes: OWNER_MAX_BYTES, observation: { root: location.store } });
}

function sameObservation(left: PrivateFileObservation | null, right: PrivateFileObservation): boolean {
  return left !== null && left.rawSha256 === right.rawSha256
    && JSON.stringify(left.identity) === JSON.stringify(right.identity);
}

function removeObserved(location: RefreshOwnerLocation, path: string, observed: PrivateFileObservation): boolean {
  try {
    return sameObservation(readOwnerFile(location, path), observed) && deletePrivateFileSync(path, OWNER_LABEL);
  } catch {
    return false;
  }
}

/** Never reclaim a guard: its owner may be between its final proof and unlink. */
function acquireMutationGuard(location: RefreshOwnerLocation): PrivateFileObservation | null {
  try {
    readOwnerFile(location);
    try { mkdirSync(location.directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (readOwnerFile(location, location.guardPath) !== null) return null;
    const raw = JSON.stringify({ version: 1, fence: randomUUID() });
    createPrivateFileIsolatedSync(location.guardPath, raw, OWNER_LABEL);
    const observed = readOwnerFile(location, location.guardPath);
    return observed?.bytes.toString('utf8') === raw ? observed : null;
  } catch {
    return null;
  }
}

function isCurrentBirthToken(token: string): boolean {
  return (token.startsWith('refresh-owner-v1:') && !token.startsWith('refresh-owner-v1:darwin:'))
    || /^refresh-owner-v2:darwin:\d+\.\d{6}:[1-9]\d*$/.test(token);
}

function parseOwner(observed: PrivateFileObservation): RefreshOwner | null {
  const value = JSON.parse(observed.bytes.toString('utf8')) as Partial<RefreshOwner> | null;
  if (!value || (value.version !== 2 && value.version !== 3) || Object.keys(value).length !== 5
    || typeof value.fence !== 'string' || value.fence.length === 0
    || typeof value.hostId !== 'string' || value.hostId.length === 0
    || !Number.isSafeInteger(value.pid) || value.pid! <= 0
    || typeof value.processBirthToken !== 'string'
    || !(isCurrentBirthToken(value.processBirthToken)
      || (value.version === 2 && value.processBirthToken.startsWith('refresh-owner-v1:darwin:')))) return null;
  return value as RefreshOwner;
}

/** The caller holds the mutation guard through observation, removal and successor publication. */
function reconcileOwnerClaim(location: RefreshOwnerLocation, deps: ClaudeRefreshAheadDeps): OwnerClaimState {
  try {
    const observed = readOwnerFile(location);
    if (observed === null) return 'absent';
    const owner = parseOwner(observed);
    if (owner === null || owner.hostId !== (deps.hostId ?? hostname())) return 'unavailable';
    const process = (deps.inspectProcess ?? inspectRefreshProcess)(owner.pid);
    if (process.state === 'unknown') return 'unavailable';
    if (process.state === 'alive') {
      // A live legacy macOS claim cannot distinguish the original child from same-second PID reuse.
      if (!isCurrentBirthToken(owner.processBirthToken) || !isCurrentBirthToken(process.birthToken)
        || process.birthToken.split(':', 2).join(':') !== owner.processBirthToken.split(':', 2).join(':')) return 'unavailable';
      if (process.birthToken === owner.processBirthToken) return 'held';
    }
    return removeObserved(location, location.path, observed) ? 'absent' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function releaseOwnerClaim(location: RefreshOwnerLocation, ownedPayloads: Set<string>): boolean {
  try {
    const observed = readOwnerFile(location);
    return observed !== null && ownedPayloads.has(observed.bytes.toString('utf8'))
      && removeObserved(location, location.path, observed);
  } catch {
    return false;
  }
}

function refreshReason(expiresAt: number | null, now: number): ClaudeRefreshAheadReason | null {
  if (expiresAt === null) return 'expiry-unknown';
  if (expiresAt <= now) return 'expired';
  return expiresAt - now <= REFRESH_AHEAD_MS ? 'within-window' : null;
}

/**
 * Run one `claude auth status --json` that this provider never signals, with `env` (the env of the
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
  if (shutdownAdmissionClosed) return Promise.resolve({ outcome: 'owner-unavailable' });
  // Keep the existing test-runner boundary before any config-store or claim
  // filesystem operation: default test fixtures may deliberately not exist.
  if (!deps.spawnImpl && underTestRunner()) {
    return Promise.resolve({ outcome: 'skipped-test-runner', reason: 'expiry-unknown' });
  }

  const location = refreshOwnerLocation(env);
  if (location === null) return Promise.resolve({ outcome: 'owner-unavailable' });
  const key = location.store;
  const live = liveChildren.get(key);
  if (live && !live.verified) return Promise.resolve({ outcome: 'owner-unavailable' });
  const run = inFlight.get(key);
  if (run) return waitBounded(run);
  // A child past its hard cap no longer blocks the wait, but while it is
  // alive no second refresh child and no killable probe may start.
  if (live) return Promise.resolve({ outcome: live.unhealthy ? 'hung' : 'still-running' });
  // A previous parent may have died with its child alive. Its claim must win
  // over a newly renewed credential or any later expiry fast path. Its duration
  // is unknowable after adoption, so report an alertable hold without signalling it.
  const guard = acquireMutationGuard(location);
  if (guard === null) return Promise.resolve({ outcome: 'owner-unavailable' });
  let created: Promise<ClaudeRefreshAheadResult> | undefined;
  const release = (): void => {
    if (created && inFlight.get(key) === created) inFlight.delete(key);
  };
  let released = false;
  try {
    const priorClaim = reconcileOwnerClaim(location, deps);
    if (priorClaim === 'held') return Promise.resolve({ outcome: 'hung' });
    if (priorClaim === 'unavailable') return Promise.resolve({ outcome: 'owner-unavailable' });
    created = runRefreshAhead(binary, env, deps, release, key, location).finally(release);
  } catch {
    return Promise.resolve({ outcome: 'owner-unavailable' });
  } finally {
    released = removeObserved(location, location.guardPath, guard);
  }
  if (!released) {
    const child = liveChildren.get(key);
    if (child) child.verified = false;
    return Promise.resolve({ outcome: 'owner-unavailable' });
  }
  inFlight.set(key, created);
  return waitBounded(created);
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
  const initialPayload = JSON.stringify({ version: 1, fence });
  const ownedPayloads = new Set([initialPayload]);
  let initialObservation: PrivateFileObservation;
  try {
    createPrivateFileIsolatedSync(location.path, initialPayload, OWNER_LABEL);
    const observed = readOwnerFile(location);
    if (observed?.bytes.toString('utf8') !== initialPayload) return { outcome: 'owner-unavailable' };
    initialObservation = observed;
  } catch {
    return { outcome: 'owner-unavailable' };
  }

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
      // the provider waits for this child's own exit. Detaching protects from
      // bot process-group signals, not a supervisor's forced cgroup stop.
      child = (deps.spawnImpl ?? spawn)(binary, [...CLAUDE_AUTH_STATUS_ARGS], {
        stdio: ['ignore', 'ignore', 'ignore'],
        env,
        detached: true,
        windowsHide: true,
      });
    } catch {
      quietly(() => observers.onSpawned(undefined));
      quietly(() => observers.onExited(exitOf(undefined, null, null, true)));
      // The production Node spawn path can throw here only before a child exists or after
      // closing a failed native handle. An injected test seam may throw after side effects,
      // so it retains the fence until an observed close.
      if (!deps.spawnImpl && releaseOwnerClaim(location, ownedPayloads)) {
        resolve({ outcome: 'spawn-failed', reason });
      } else {
        resolve({ outcome: 'owner-unavailable' });
      }
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
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolveClose) => { resolveClosed = resolveClose; });
    const live = { fence, verified: false, unhealthy: false, closed };
    liveChildren.set(key, live);
    const hardCap = setTimeout(() => {
      live.unhealthy = true;
      release();
      clearInterval(stillRunning);
      quietly(() => log.error(
        { event: 'claude_refresh_ahead_hung', purpose: 'refresh-ahead', pid: pid ?? null, elapsedMs: now() - startedAt },
        'claude refresh-ahead child exceeded its hard cap; durable owner remains held and later probes defer',
      ));
    }, REFRESH_AHEAD_HARD_CAP_MS);
    hardCap.unref?.();
    let finished = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnFailed: boolean, claimReleased = false): void => {
      if (finished) return;
      finished = true;
      clearInterval(stillRunning);
      clearTimeout(hardCap);
      if (liveChildren.get(key)?.fence === fence) liveChildren.delete(key);
      resolveClosed();
      quietly(() => observers.onExited(exitOf(pid, exitCode, signal, spawnFailed)));
      if (!claimReleased) resolve({ outcome: 'owner-unavailable' });
      else if (spawnFailed) resolve({ outcome: 'spawn-failed', reason });
      else resolve({ outcome: 'ran', reason, exitCode, signal });
    };
    // Even a pidless error is not proof that the child has closed.
    let spawnFailed = false;
    let publishing = true;
    let pendingClose: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on('error', () => { if (child.pid === undefined) spawnFailed = true; });
    child.on('close', (code, signal) => {
      if (publishing) {
        pendingClose = { code, signal };
        return;
      }
      const guard = acquireMutationGuard(location);
      if (guard === null) {
        finish(code, signal, spawnFailed);
        return;
      }
      let claimReleased = false;
      try { claimReleased = releaseOwnerClaim(location, ownedPayloads); } finally {
        if (!removeObserved(location, location.guardPath, guard)) claimReleased = false;
      }
      finish(code, signal, spawnFailed, claimReleased);
    });
    try {
      if (!Number.isSafeInteger(pid) || pid! <= 0) throw new Error('refresh child identity unavailable');
      const process = (deps.inspectProcess ?? inspectRefreshProcess)(pid!);
      if (process.state !== 'alive' || !isCurrentBirthToken(process.birthToken)) {
        throw new Error('refresh child identity unavailable');
      }
      if (!sameObservation(readOwnerFile(location), initialObservation)) throw new Error('refresh owner changed');
      // Older readers reject this version instead of treating a new identity format as a reused PID.
      const owner: RefreshOwner = { version: 3, fence, hostId: deps.hostId ?? hostname(), pid: pid!, processBirthToken: process.birthToken };
      const payload = JSON.stringify(owner);
      ownedPayloads.add(payload);
      writeAtomicPrivateFileIsolatedSync(location.path, payload, OWNER_LABEL);
      if (readOwnerFile(location)?.bytes.toString('utf8') !== payload) throw new Error('refresh owner publication unavailable');
      live.verified = true;
    } catch {
      resolve({ outcome: 'owner-unavailable' });
    } finally {
      publishing = false;
      // A synchronous close during publication uses the guard already held by this call.
      if (pendingClose) finish(pendingClose.code, pendingClose.signal, spawnFailed, releaseOwnerClaim(location, ownedPayloads));
    }
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
