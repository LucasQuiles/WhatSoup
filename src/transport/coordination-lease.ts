// src/transport/coordination-lease.ts
//
// T4 of the q-canary re-pair enablement lane: one fenced, host-local
// account-scope lease shared by the pairing coordinator, runtime startup, the
// fleet route, and the watchdog. Exactly one owner per scope at a time; every
// ownership change carries a monotonically increasing fencing token.
//
// Reuse audit against `src/lib/process-lock.ts` (T4.1, recorded here so the
// rejection is reviewable): the process lock provides O_EXCL discipline,
// pid+bootId payloads, and same-boot dead-holder reclaim — all reused as
// PATTERNS - but it has no fencing token (a resurrected holder could keep
// writing), no heartbeat/expiry, no process-birth token (PID reuse inside one
// boot defeats it), no mode, and it is keyed per instance state dir rather
// than per account scope. Those are load-bearing properties here, so this is
// a sibling primitive, not a replacement; the runtime's per-instance
// `bot.lock` keeps its own semantics.
//
// Takeover decision table (lock file present):
//   corrupt payload            -> refuse lease_corrupt (preserve bytes)
//   different host             -> refuse owner_unknown (fail closed)
//   different bootId           -> reclaim (boot_changed)
//   same boot, pid dead        -> reclaim (holder_dead)
//   same boot, pid alive:
//     birth token matches      -> refuse held_by_live_owner (stale heartbeat
//                                 does NOT permit takeover of a live owner)
//     birth token differs      -> reclaim (pid_reused)
//     birth token unprobeable  -> refuse owner_unknown (fail closed; the only
//                                 path forward is the owner-authorized
//                                 forceTakeoverCoordinationLease, which writes
//                                 a durable receipt)
//
// Fencing monotonicity: release writes a tombstone carrying the released
// token BEFORE removing the lease; acquisition takes
// max(tombstone, existing lease) + 1. The O_EXCL lease create is the
// single-winner arbiter between racing acquirers.

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { appendPrivateJsonLineSync, ensurePrivateDirectorySync, writeAtomicPrivateFileSync } from '../lib/private-fs.ts';
import { getCurrentBootId } from '../lib/process-lock.ts';
import { probeProcessBirthToken } from '../lib/process-identity.ts';
import { systemClock } from '../lib/clock.ts';
import {
  parseAccountScopeId,
  parseCoordinationLease,
  type AccountScopeIdV1,
  type CoordinationLeaseMode,
  type CoordinationLeaseV1,
} from './auth-custody-contracts.ts';

const TAKEOVER_LOG_FILENAME = 'coordination-lease-takeovers.ndjson';

/**
 * Resolve the configured account scope. Absent stays absent (the lease
 * machinery is inert for legacy instances); a PRESENT but malformed value
 * throws at config load — a typo must never silently disable coordination.
 */
export function resolveConfiguredAccountScope(raw: unknown): AccountScopeIdV1 | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === 'string' ? parseAccountScopeId(raw) : null;
  if (parsed === null) {
    throw new Error(
      'accountScopeId is configured but malformed: expected an opaque "scope:" identifier ' +
      '([a-z0-9-], 4-59 chars after the prefix, at least one letter; never a path, JID, or phone number)',
    );
  }
  return parsed;
}

/**
 * Probe a process's birth identity, defeating same-boot PID reuse. Linux
 * reads the kernel's per-process stat starttime; darwin asks ps for lstart.
 * null = cannot be established (callers must treat the owner as unknown,
 * fail closed).
 */
export { probeProcessBirthToken } from '../lib/process-identity.ts';

/** Production probes. EPERM means alive-but-not-ours — that is ALIVE. */
export function defaultLeaseProbes(): LeaseProbes {
  return {
    hostId: hostname(),
    bootId: getCurrentBootId(),
    pid: process.pid,
    birthToken: probeProcessBirthToken,
    pidAlive: pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    nowMs: () => systemClock.now(),
  };
}

export interface LeaseProbes {
  hostId: string;
  bootId: string;
  pid: number;
  /** Birth token for a pid, or null when it cannot be established. */
  birthToken: (pid: number) => string | null;
  pidAlive: (pid: number) => boolean;
  nowMs: () => number;
}

export type TakeoverReason = 'boot_changed' | 'holder_dead' | 'pid_reused' | 'owner_authorized_takeover';

export interface TakeoverReceipt {
  reason: TakeoverReason;
  priorFencingToken: number;
  priorPid: number | null;
  at: string;
  operationId: string;
  ownerAuthorizationId: string | null;
}

export type AcquireLeaseResult =
  | { ok: true; lease: CoordinationLeaseV1; takeover: TakeoverReceipt | null }
  | { ok: false; refusal: 'held_by_live_owner' | 'owner_unknown' | 'lease_corrupt' | 'lease_race_lost' | 'io_error' };

export interface AcquireLeaseArgs {
  stateRoot: string;
  scopeId: AccountScopeIdV1;
  operationId: string;
  mode: CoordinationLeaseMode;
  ttlMs: number;
  probes: LeaseProbes;
}

/** Parse the on-disk lease for a scope; null when absent or unparseable. */
export function readCoordinationLease(
  stateRoot: string,
  scopeId: AccountScopeIdV1,
): CoordinationLeaseV1 | null {
  const leasePath = coordinationLeasePath(stateRoot, scopeId);
  if (!existsSync(leasePath)) return null;
  try {
    return parseCoordinationLease(JSON.parse(readFileSync(leasePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function coordinationLeasePath(stateRoot: string, scopeId: AccountScopeIdV1): string {
  return join(stateRoot, `coordination-lease.${scopeFileTag(scopeId)}.json`);
}

function tombstonePath(stateRoot: string, scopeId: AccountScopeIdV1): string {
  return join(stateRoot, `coordination-lease.${scopeFileTag(scopeId)}.last-token.json`);
}

function scopeFileTag(scopeId: AccountScopeIdV1): string {
  // scope ids are [a-z0-9-] after the prefix; the prefix colon is the only
  // filesystem-hostile byte.
  return scopeId.replace(':', '_');
}

function readTombstoneToken(stateRoot: string, scopeId: AccountScopeIdV1): number {
  try {
    const raw = readFileSync(tombstonePath(stateRoot, scopeId), 'utf-8');
    const value = JSON.parse(raw) as { lastFencingToken?: unknown };
    return typeof value.lastFencingToken === 'number' && Number.isInteger(value.lastFencingToken) && value.lastFencingToken > 0
      ? value.lastFencingToken
      : 0;
  } catch {
    return 0;
  }
}

function writeTombstoneToken(stateRoot: string, scopeId: AccountScopeIdV1, token: number): void {
  writeAtomicPrivateFileSync(
    tombstonePath(stateRoot, scopeId),
    JSON.stringify({ lastFencingToken: token }),
    'coordination-lease tombstone',
  );
}

function buildLease(args: AcquireLeaseArgs, fencingToken: number): CoordinationLeaseV1 | null {
  const now = args.probes.nowMs();
  const birthToken = args.probes.birthToken(args.probes.pid);
  if (birthToken === null) return null;
  const candidate = {
    v: 1,
    scopeId: args.scopeId,
    operationId: args.operationId,
    hostId: args.probes.hostId,
    bootId: args.probes.bootId,
    processBirthToken: birthToken,
    pid: args.probes.pid,
    acquiredAt: new Date(now).toISOString(),
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(1, args.ttlMs)).toISOString(),
    fencingToken,
    mode: args.mode,
  };
  return parseCoordinationLease(candidate);
}

function writeLeaseExclusive(leasePath: string, lease: CoordinationLeaseV1): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(leasePath, 'wx', 0o600);
    writeSync(fd, JSON.stringify(lease));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function appendTakeoverReceipt(stateRoot: string, scopeId: AccountScopeIdV1, receipt: TakeoverReceipt): void {
  appendPrivateJsonLineSync(join(stateRoot, TAKEOVER_LOG_FILENAME), { scopeId, ...receipt });
}

type HolderVerdict =
  | { verdict: 'reclaimable'; reason: Exclude<TakeoverReason, 'owner_authorized_takeover'>; holder: CoordinationLeaseV1 }
  | { verdict: 'live_owner' }
  | { verdict: 'unknown' }
  | { verdict: 'corrupt' };

function assessHolder(leasePath: string, probes: LeaseProbes): HolderVerdict {
  let parsed: CoordinationLeaseV1 | null;
  try {
    parsed = parseCoordinationLease(JSON.parse(readFileSync(leasePath, 'utf-8')));
  } catch {
    return { verdict: 'corrupt' };
  }
  if (parsed === null) return { verdict: 'corrupt' };
  if (parsed.hostId !== probes.hostId) return { verdict: 'unknown' };
  if (parsed.bootId !== probes.bootId) return { verdict: 'reclaimable', reason: 'boot_changed', holder: parsed };
  if (!probes.pidAlive(parsed.pid)) return { verdict: 'reclaimable', reason: 'holder_dead', holder: parsed };
  const holderBirth = probes.birthToken(parsed.pid);
  if (holderBirth === null) return { verdict: 'unknown' };
  if (holderBirth !== parsed.processBirthToken) {
    return { verdict: 'reclaimable', reason: 'pid_reused', holder: parsed };
  }
  // Live, verified owner. A stale heartbeat does not permit takeover.
  return { verdict: 'live_owner' };
}

// The reclaim path (assess → unlink → exclusive create) is not atomic: two
// racers that both assessed a dead holder could each unlink the other's fresh
// lease and both "win" with the SAME fencing token. A guard file serializes
// the whole reclaim critical section; anything older than this is a crashed
// reclaimer's leftover and may be broken.
const RECLAIM_GUARD_STALE_MS = 30_000;

function reclaimGuardPath(stateRoot: string, scopeId: AccountScopeIdV1): string {
  return `${coordinationLeasePath(stateRoot, scopeId)}.reclaim`;
}

function acquireReclaimGuard(guardPath: string, probes: LeaseProbes): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = openSync(guardPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: probes.pid, at: probes.nowMs() }));
      return true;
    } catch {
      // intentional: the guard already exists (or the directory refused the
      // create) — fall through to the staleness check below.
    } finally {
      if (fd !== null) closeSync(fd);
    }
    try {
      const age = probes.nowMs() - statSync(guardPath).mtimeMs;
      if (age <= RECLAIM_GUARD_STALE_MS) return false;
      unlinkSync(guardPath);
    } catch {
      // intentional: a guard that vanished or cannot be assessed means the
      // race is live — refuse rather than reclaim blind.
      return false;
    }
  }
  return false;
}

export function acquireCoordinationLease(args: AcquireLeaseArgs): AcquireLeaseResult {
  ensurePrivateDirectorySync(args.stateRoot);
  const leasePath = coordinationLeasePath(args.stateRoot, args.scopeId);

  let takeover: TakeoverReceipt | null = null;
  let priorToken = 0;
  let guardPath: string | null = null;

  try {
    if (existsSync(leasePath)) {
      const assessment = assessHolder(leasePath, args.probes);
      if (assessment.verdict === 'corrupt') return { ok: false, refusal: 'lease_corrupt' };
      if (assessment.verdict === 'unknown') return { ok: false, refusal: 'owner_unknown' };
      if (assessment.verdict === 'live_owner') return { ok: false, refusal: 'held_by_live_owner' };
      guardPath = reclaimGuardPath(args.stateRoot, args.scopeId);
      if (!acquireReclaimGuard(guardPath, args.probes)) {
        guardPath = null;
        return { ok: false, refusal: 'lease_race_lost' };
      }
      // Re-assess UNDER the guard: the state may have changed while racing
      // for it (a racer may have already reclaimed and now be the owner).
      if (existsSync(leasePath)) {
        const reassessed = assessHolder(leasePath, args.probes);
        if (reassessed.verdict === 'corrupt') return { ok: false, refusal: 'lease_corrupt' };
        if (reassessed.verdict === 'unknown') return { ok: false, refusal: 'owner_unknown' };
        if (reassessed.verdict === 'live_owner') return { ok: false, refusal: 'held_by_live_owner' };
        priorToken = reassessed.holder.fencingToken;
        takeover = {
          reason: reassessed.reason,
          priorFencingToken: reassessed.holder.fencingToken,
          priorPid: reassessed.holder.pid,
          at: new Date(args.probes.nowMs()).toISOString(),
          operationId: args.operationId,
          ownerAuthorizationId: null,
        };
        try {
          unlinkSync(leasePath);
        } catch {
          return { ok: false, refusal: 'io_error' };
        }
      }
    }

    const fencingToken = Math.max(readTombstoneToken(args.stateRoot, args.scopeId), priorToken) + 1;
    const lease = buildLease(args, fencingToken);
    if (lease === null) return { ok: false, refusal: 'owner_unknown' };
    if (!writeLeaseExclusive(leasePath, lease)) {
      // Another acquirer won the O_EXCL race between our unlink/read and write.
      return { ok: false, refusal: 'lease_race_lost' };
    }
    // Verify-after-write: our write must still be the lease on disk. Belt and
    // braces under the guard; load-bearing if a guard-less writer slips in.
    const onDisk = readCoordinationLease(args.stateRoot, args.scopeId);
    if (onDisk === null || onDisk.operationId !== lease.operationId || onDisk.fencingToken !== lease.fencingToken) {
      return { ok: false, refusal: 'lease_race_lost' };
    }
    if (takeover !== null) appendTakeoverReceipt(args.stateRoot, args.scopeId, takeover);
    return { ok: true, lease, takeover };
  } finally {
    if (guardPath !== null) {
      try {
        unlinkSync(guardPath);
      } catch {
        // intentional: the stale-age fallback reaps a leaked guard file.
      }
    }
  }
}

export type RenewLeaseResult =
  | { ok: true; lease: CoordinationLeaseV1 }
  | { ok: false; refusal: 'lease_missing' | 'lease_corrupt' | 'fencing_token_mismatch' };

export function renewCoordinationLease(args: {
  stateRoot: string;
  scopeId: AccountScopeIdV1;
  lease: CoordinationLeaseV1;
  ttlMs: number;
  probes: LeaseProbes;
}): RenewLeaseResult {
  const leasePath = coordinationLeasePath(args.stateRoot, args.scopeId);
  if (!existsSync(leasePath)) return { ok: false, refusal: 'lease_missing' };
  let onDisk: CoordinationLeaseV1 | null;
  try {
    onDisk = parseCoordinationLease(JSON.parse(readFileSync(leasePath, 'utf-8')));
  } catch {
    return { ok: false, refusal: 'lease_corrupt' };
  }
  if (onDisk === null) return { ok: false, refusal: 'lease_corrupt' };
  if (onDisk.fencingToken !== args.lease.fencingToken) {
    return { ok: false, refusal: 'fencing_token_mismatch' };
  }
  const now = args.probes.nowMs();
  const renewedCandidate = {
    ...onDisk,
    renewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(1, args.ttlMs)).toISOString(),
  };
  const renewed = parseCoordinationLease(renewedCandidate);
  if (renewed === null) return { ok: false, refusal: 'lease_corrupt' };
  writeAtomicPrivateFileSync(leasePath, JSON.stringify(renewed), 'coordination lease');
  return { ok: true, lease: renewed };
}

export type ReleaseLeaseResult =
  | { ok: true }
  | { ok: false; refusal: 'lease_missing' | 'lease_corrupt' | 'fencing_token_mismatch' };

export function releaseCoordinationLease(args: {
  stateRoot: string;
  scopeId: AccountScopeIdV1;
  lease: CoordinationLeaseV1;
}): ReleaseLeaseResult {
  const leasePath = coordinationLeasePath(args.stateRoot, args.scopeId);
  if (!existsSync(leasePath)) return { ok: false, refusal: 'lease_missing' };
  let onDisk: CoordinationLeaseV1 | null;
  try {
    onDisk = parseCoordinationLease(JSON.parse(readFileSync(leasePath, 'utf-8')));
  } catch {
    return { ok: false, refusal: 'lease_corrupt' };
  }
  if (onDisk === null) return { ok: false, refusal: 'lease_corrupt' };
  if (onDisk.fencingToken !== args.lease.fencingToken) {
    return { ok: false, refusal: 'fencing_token_mismatch' };
  }
  // Tombstone BEFORE unlink so a crash between the two cannot lose
  // monotonicity: the next acquire folds in max(tombstone, lease).
  writeTombstoneToken(args.stateRoot, args.scopeId, onDisk.fencingToken);
  unlinkSync(leasePath);
  return { ok: true };
}

export type ForceTakeoverResult =
  | { ok: true; lease: CoordinationLeaseV1 }
  | { ok: false; refusal: 'authorization_required' | 'lease_missing' | 'lease_corrupt' | 'io_error' };

/**
 * The owner-authorized escape hatch for `owner_unknown` holds. Writes a
 * durable takeover receipt naming the authorization before replacing the
 * lease. This is deliberately the ONLY path past an unknown owner.
 */
export function forceTakeoverCoordinationLease(args: AcquireLeaseArgs & {
  ownerAuthorizationId: string;
}): ForceTakeoverResult {
  if (typeof args.ownerAuthorizationId !== 'string' || args.ownerAuthorizationId.length === 0) {
    return { ok: false, refusal: 'authorization_required' };
  }
  const leasePath = coordinationLeasePath(args.stateRoot, args.scopeId);
  if (!existsSync(leasePath)) return { ok: false, refusal: 'lease_missing' };
  let prior: CoordinationLeaseV1 | null;
  try {
    prior = parseCoordinationLease(JSON.parse(readFileSync(leasePath, 'utf-8')));
  } catch {
    prior = null;
  }
  const priorToken = prior?.fencingToken ?? readTombstoneToken(args.stateRoot, args.scopeId);
  const receipt: TakeoverReceipt = {
    reason: 'owner_authorized_takeover',
    priorFencingToken: priorToken,
    priorPid: prior?.pid ?? null,
    at: new Date(args.probes.nowMs()).toISOString(),
    operationId: args.operationId,
    ownerAuthorizationId: args.ownerAuthorizationId,
  };
  appendTakeoverReceipt(args.stateRoot, args.scopeId, receipt);
  try {
    unlinkSync(leasePath);
  } catch {
    return { ok: false, refusal: 'io_error' };
  }
  const fencingToken = Math.max(readTombstoneToken(args.stateRoot, args.scopeId), priorToken) + 1;
  const lease = buildLease(args, fencingToken);
  if (lease === null) return { ok: false, refusal: 'io_error' };
  if (!writeLeaseExclusive(leasePath, lease)) return { ok: false, refusal: 'io_error' };
  return { ok: true, lease };
}
