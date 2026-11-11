/**
 * The single-writer lock for one user's launchd state. Every activation and
 * reconcile under a HOME shares the wrapper symlink or installed plists, so the
 * key is the HOME, not the instance.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { acquireProcessLock, type ProcessLockHandle } from '../../../src/lib/process-lock.ts';

export function activationLockPath(home: string): string {
  return path.join(home, '.local', 'state', 'whatsoup', 'release-activation.lock');
}

/**
 * Throws, having changed nothing live, while another writer holds the lock. A
 * holder that died in this boot is reclaimed, so a killed run cannot block the
 * next one. Liveness is the real process table, never a host seam.
 */
export function acquireActivationLock(home: string): ProcessLockHandle {
  const lockPath = activationLockPath(home);
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return acquireProcessLock(lockPath, { reclaimDeadSameBoot: true });
}
