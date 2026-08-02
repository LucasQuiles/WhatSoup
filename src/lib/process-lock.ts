import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export type ProcessLockErrorReason = 'active' | 'stale' | 'corrupt';

export interface ProcessLockPayload {
  pid: number;
  token: string;
  startedAt: string;
  /**
   * OS boot identity at the time the lock was written. A lock whose bootId
   * differs from the current boot was written before the machine last
   * restarted, so its holder is provably gone — safe to reclaim without any
   * split-brain risk. Optional for backward-read compatibility with locks
   * written before this field existed (those are never reclaimed).
   */
  bootId?: string;
}

export interface ProcessLockHandle {
  path: string;
  pid: number;
  token: string;
  /**
   * True when acquisition reclaimed a lock left behind by a previous boot
   * (dead holder PID + differing bootId). Lets the caller log the reboot
   * self-heal so fleet rollout can prove a host migrated to a bootId-bearing
   * lock. False for a clean first acquisition. Always set by acquireProcessLock;
   * optional so callers can build a handle (e.g. for releaseProcessLock) without it.
   */
  reclaimedPreviousBoot?: boolean;
}

export interface AcquireProcessLockOptions {
  pid?: number;
  token?: string;
  now?: Date;
  bootId?: string;
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Allow reclaiming a dead holder from the current, known boot. Keep false for
   * split-brain-sensitive singleton services. Use only for short, retry-safe
   * coordination lanes whose crashed owner cannot retain external ownership.
   */
  reclaimDeadSameBoot?: boolean;
  /**
   * Test seam: invoked once immediately before the identity-checked unlink in
   * the reclaim path, to deterministically simulate a concurrent replacement of
   * the lock file between the read and the unlink. Production callers leave this
   * unset.
   */
  beforeReclaimUnlink?: () => void;
}

export class ProcessLockError extends Error {
  readonly reason: ProcessLockErrorReason;
  readonly lockPath: string;
  readonly existingPid?: number;

  constructor(reason: ProcessLockErrorReason, lockPath: string, existingPid?: number) {
    super(`process lock ${reason}: ${lockPath}`);
    this.name = 'ProcessLockError';
    this.reason = reason;
    this.lockPath = lockPath;
    this.existingPid = existingPid;
  }
}

export function isProcessLockError(err: unknown): err is ProcessLockError {
  return err instanceof ProcessLockError;
}

const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
let cachedBootId: string | null = null;

export interface BootIdProbes {
  /** Linux: kernel-provided `/proc/sys/kernel/random/boot_id` UUID. */
  readLinuxBootId?: () => string;
  /** macOS: `sysctl -n kern.boottime` (changes on every restart). */
  readMacBootTime?: () => string;
}

function defaultReadLinuxBootId(): string {
  if (!existsSync(LINUX_BOOT_ID_PATH)) return '';
  return readFileSync(LINUX_BOOT_ID_PATH, 'utf8');
}

// `sysctl` lives in /usr/sbin, which is NOT on the PATH of a launchd GUI agent
// (the WhatSoup instance plists set PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin).
// Calling bare `sysctl` there ENOENTs, so resolveBootId returned '' and the lock
// was written with an empty bootId — silently disabling reboot-reclaim on the
// whole macOS fleet. Try the absolute path first, then fall back to PATH lookup.
const MAC_SYSCTL_BINS = ['/usr/sbin/sysctl', '/sbin/sysctl', 'sysctl'];
function defaultReadMacBootTime(): string {
  let lastErr: unknown;
  for (const bin of MAC_SYSCTL_BINS) {
    try {
      const out = execFileSync(bin, ['-n', 'kern.boottime'], { timeout: 5_000, encoding: 'utf8' });
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('sysctl produced no kern.boottime output');
}

/**
 * Best-effort, stable-per-boot OS boot identity. Tries the Linux boot_id UUID,
 * then the macOS boot time. Returns '' when neither is available — an empty id
 * never matches and never enables reclaim, so an unknown boot id degrades safely
 * to the conservative fail-closed behavior. Probes are injectable for testing.
 */
export function resolveBootId(probes: BootIdProbes = {}): string {
  const readLinux = probes.readLinuxBootId ?? defaultReadLinuxBootId;
  const readMac = probes.readMacBootTime ?? defaultReadMacBootTime;
  try {
    const id = readLinux().trim();
    if (id) return id;
  } catch {
    // fall through to the macOS probe
  }
  try {
    const out = readMac().trim();
    if (out) return out;
  } catch {
    // fall through to the empty sentinel
  }
  return '';
}

/** Memoized current-boot identity (stable for the lifetime of the process). */
export function getCurrentBootId(): string {
  if (cachedBootId !== null) return cachedBootId;
  cachedBootId = resolveBootId();
  return cachedBootId;
}

function createProcessLockPayload(options: AcquireProcessLockOptions = {}): ProcessLockPayload {
  return {
    pid: options.pid ?? process.pid,
    token: options.token ?? randomUUID(),
    startedAt: (options.now ?? new Date()).toISOString(),
    bootId: options.bootId ?? getCurrentBootId(),
  };
}

// Shape schema for the three fields whose validation can reject the whole
// payload. `bootId` is deliberately excluded: the previous ladder never
// rejected the payload over a wrong-typed bootId, it just silently dropped
// it, so that permissive behavior stays as a manual conditional spread below
// rather than becoming part of the schema (a schema field would fail the
// whole `safeParse` on a wrong-typed value instead of merely omitting it).
//
// `pid` uses `.int().safe().positive()` rather than plain `.int()`: plain
// `.int()` accepts values like 2**60 (Number.isInteger true but
// Number.isSafeInteger false), which the previous `Number.isSafeInteger`
// check rejected. A real OS pid is a positive, in-range integer — reject
// 0/negative (process.kill would target a process GROUP), fractional, and
// unsafe integers as corrupt rather than feeding them to process.kill(pid, 0).
const ProcessLockShapeSchema = z.object({
  pid: z.number().int().safe().positive(),
  token: z.string(),
  startedAt: z.string(),
}) satisfies z.ZodType<Omit<ProcessLockPayload, 'bootId'>>;

export function readProcessLockPayload(lockPath: string): ProcessLockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ProcessLockPayload>;
    const result = ProcessLockShapeSchema.safeParse(parsed);
    if (!result.success) return null;
    return {
      ...result.data,
      ...(typeof parsed.bootId === 'string' ? { bootId: parsed.bootId } : {}),
    };
  } catch {
    return null;
  }
}

/** Full-identity equality of two lock payloads across every recorded field. */
function samePayloadIdentity(a: ProcessLockPayload, b: ProcessLockPayload): boolean {
  return a.pid === b.pid
    && a.token === b.token
    && a.startedAt === b.startedAt
    && a.bootId === b.bootId;
}

export function acquireProcessLock(lockPath: string, options: AcquireProcessLockOptions = {}): ProcessLockHandle {
  const payload = createProcessLockPayload(options);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const tempPath = `${lockPath}.${payload.pid}.${payload.token}.tmp`;

  writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
  try {
    // linkSync is atomic. The loop performs at most one reclaim: if the existing
    // lock is provably from a previous boot, remove it and retry the link once.
    // Any lock seen after that is necessarily from the current boot (every
    // concurrent acquirer stamps the current bootId), so the `reclaimed` guard
    // bounds the loop and a racing same-instance starter fails closed
    // (active/stale) rather than stealing a freshly-acquired lock.
    let reclaimed = false;
    let reclaimedPreviousBoot = false;
    for (;;) {
      try {
        linkSync(tempPath, lockPath);
        return { path: lockPath, pid: payload.pid, token: payload.token, reclaimedPreviousBoot };
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') throw err;

        const existing = readProcessLockPayload(lockPath);
        if (!existing) throw new ProcessLockError('corrupt', lockPath);

        // Liveness beats boot id, deliberately. A live holder is NEVER evicted,
        // even when the lock's bootId differs from ours. This preserves the
        // absolute no-split-brain invariant (two bots on one WhatsApp account)
        // under a FALSE boot-id mismatch: on macOS `kern.boottime` (our boot-id
        // source) is recomputed on clock steps (e.g. a post-boot NTP
        // correction), so a live holder and a second starter can legitimately
        // observe different boot ids with NO reboot. The cost is that a
        // prior-boot lock whose PID was recycled by an unrelated live process
        // stays fail-closed — a rare, alerting, operator-recoverable brick (see
        // docs/runbook.md §5.6). Do not reorder this below the bootId check.
        if (isProcessAlive(existing.pid)) throw new ProcessLockError('active', lockPath, existing.pid);

        // The holder pid is dead. Singleton-service callers reclaim ONLY when
        // both boot ids are known and differ. Short, retry-safe coordination
        // lanes may explicitly opt into same-boot recovery; unknown boot
        // identity remains fail-closed in both modes.
        const fromPreviousBoot = Boolean(existing.bootId)
          && Boolean(payload.bootId)
          && existing.bootId !== payload.bootId;
        const fromSameBoot = Boolean(existing.bootId)
          && Boolean(payload.bootId)
          && existing.bootId === payload.bootId;
        const reclaimable = fromPreviousBoot
          || (options.reclaimDeadSameBoot === true && fromSameBoot);
        if (reclaimed || !reclaimable) {
          throw new ProcessLockError('stale', lockPath, existing.pid);
        }

        reclaimed = true;
        options.beforeReclaimUnlink?.();
        // Identity-checked unlink: re-read immediately before removing so a lock
        // that was replaced between our first read and here is not blindly
        // deleted. This is what stops two concurrent post-reboot starters from
        // each reclaiming and one unlinking the other's freshly-linked lock
        // (which would be split-brain). If the lock changed, loop and
        // re-evaluate the replacement (it will block as active / fail-closed).
        const beforeUnlink = readProcessLockPayload(lockPath);
        if (beforeUnlink && samePayloadIdentity(beforeUnlink, existing)) {
          try {
            unlinkSync(lockPath);
            reclaimedPreviousBoot = fromPreviousBoot;
          } catch (unlinkErr) {
            if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
          }
        }
      }
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort: the target lock is the authoritative file after linkSync.
    }
  }
}

export interface ReleaseProcessLockOptions {
  /**
   * Test seam: invoked once after the ownership check and before the unlink, to
   * deterministically simulate a concurrent replacement of the lock file.
   * Production callers leave this unset.
   */
  beforeReleaseUnlink?: () => void;
}

export function releaseProcessLock(handle: ProcessLockHandle, options: ReleaseProcessLockOptions = {}): boolean {
  const current = readProcessLockPayload(handle.path);
  if (!current || current.pid !== handle.pid || current.token !== handle.token) return false;
  options.beforeReleaseUnlink?.();
  // Identity-checked unlink (mirrors the reclaim path): re-read immediately
  // before removing so a lock replaced between the ownership check and here is
  // not deleted. POSIX has no atomic compare-and-unlink; this narrows the window
  // to the same minimum as reclaim rather than leaving release as the weak link.
  const beforeUnlink = readProcessLockPayload(handle.path);
  if (!beforeUnlink || beforeUnlink.pid !== handle.pid || beforeUnlink.token !== handle.token) return false;
  unlinkSync(handle.path);
  return true;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    return nodeErr.code !== 'ESRCH';
  }
}
