import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export type ProcessLockErrorReason = 'active' | 'stale' | 'corrupt';

export interface ProcessLockPayload {
  pid: number;
  token: string;
  startedAt: string;
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

export function createProcessLockPayload(options: AcquireProcessLockOptions = {}): ProcessLockPayload {
  return {
    pid: options.pid ?? process.pid,
    token: options.token ?? randomUUID(),
    startedAt: (options.now ?? new Date()).toISOString(),
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
    };
  } catch {
    return null;
  }
}

export function acquireProcessLock(lockPath: string, options: AcquireProcessLockOptions = {}): ProcessLockHandle {
  const payload = createProcessLockPayload(options);
  const tempPath = `${lockPath}.${payload.pid}.${payload.token}.tmp`;

  writeFileSync(tempPath, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tempPath, lockPath);
    return { path: lockPath, pid: payload.pid, token: payload.token };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'EEXIST') throw err;

    const existing = readProcessLockPayload(lockPath);
    if (!existing) throw new ProcessLockError('corrupt', lockPath);

    const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    throw new ProcessLockError(isProcessAlive(existing.pid) ? 'active' : 'stale', lockPath, existing.pid);
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
