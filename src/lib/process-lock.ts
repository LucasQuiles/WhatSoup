import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

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
}

export interface AcquireProcessLockOptions {
  pid?: number;
  token?: string;
  now?: Date;
  bootId?: string;
  isProcessAlive?: (pid: number) => boolean;
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

function defaultReadMacBootTime(): string {
  return execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8' });
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

export function readProcessLockPayload(lockPath: string): ProcessLockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ProcessLockPayload>;
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.token !== 'string'
      || typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      token: parsed.token,
      startedAt: parsed.startedAt,
      ...(typeof parsed.bootId === 'string' ? { bootId: parsed.bootId } : {}),
    };
  } catch {
    return null;
  }
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
    for (;;) {
      try {
        linkSync(tempPath, lockPath);
        return { path: lockPath, pid: payload.pid, token: payload.token };
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') throw err;

        const existing = readProcessLockPayload(lockPath);
        if (!existing) throw new ProcessLockError('corrupt', lockPath);
        if (isProcessAlive(existing.pid)) throw new ProcessLockError('active', lockPath, existing.pid);

        // The holder pid is dead. Reclaim ONLY when both boot ids are known and
        // differ — the lock was written before the last restart, so the holder
        // cannot still be running. A dead pid within the same boot stays
        // fail-closed (it may be a transiently-unsignalable holder, and a
        // same-boot pid could be reused).
        const fromPreviousBoot = Boolean(existing.bootId)
          && Boolean(payload.bootId)
          && existing.bootId !== payload.bootId;
        if (reclaimed || !fromPreviousBoot) {
          throw new ProcessLockError('stale', lockPath, existing.pid);
        }

        reclaimed = true;
        try {
          unlinkSync(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
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

export function releaseProcessLock(handle: ProcessLockHandle): boolean {
  const current = readProcessLockPayload(handle.path);
  if (!current || current.pid !== handle.pid || current.token !== handle.token) return false;
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
