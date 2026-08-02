// src/lib/incident-breaker.ts
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FaultClass } from './fault-classifier.ts';

/** Incident rate-limit persistence record (#2249: distinct from circuit-breaker.ts's CircuitState — renamed to avoid the name collision). */
export interface IncidentBreakerState {
  host: string;
  faultClass: FaultClass;
  /** incident onset timestamp (sqlite 'YYYY-MM-DD HH:MM:SS' format), or null when no open incident. */
  onset: string | null;
  /** remediation-attempt timestamps (same format), pruned to the active window on record. */
  attempts: string[];
  /** breaker has tripped (attempt threshold exceeded in window). */
  tripped: boolean;
  /** a single durable HUMAN_REQUIRED escalation has already been raised for this incident. */
  escalated: boolean;
}

/** Difference in whole seconds between two sqlite-format UTC timestamps (a - b). */
function diffSeconds(a: string, b: string): number {
  const toMs = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');
  return Math.round((toMs(a) - toMs(b)) / 1000);
}

function stateFile(dir: string, host: string, faultClass: FaultClass): string {
  // Filesystem-safe key. host/faultClass are internal tokens (no slashes), but sanitize defensively.
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(dir, `${safe(host)}__${safe(faultClass)}.json`);
}

export function loadBreakerState(dir: string, host: string, faultClass: FaultClass): IncidentBreakerState {
  const file = stateFile(dir, host, faultClass);
  if (!existsSync(file)) {
    return { host, faultClass, onset: null, attempts: [], tripped: false, escalated: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<IncidentBreakerState>;
    return {
      host,
      faultClass,
      onset: parsed.onset ?? null,
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
      tripped: parsed.tripped ?? false,
      escalated: parsed.escalated ?? false,
    };
  } catch {
    // Corrupt state must never wedge the lane: start fresh.
    return { host, faultClass, onset: null, attempts: [], tripped: false, escalated: false };
  }
}

export function saveBreakerState(dir: string, state: IncidentBreakerState): void {
  mkdirSync(dir, { recursive: true });
  const file = stateFile(dir, state.host, state.faultClass);
  // Pid/token-suffixed tmp name, mirroring process-lock.ts's acquireProcessLock
  // (src/lib/process-lock.ts:193): a fixed `${file}.tmp` name lets two
  // concurrent saves for the same (host, faultClass) collide on the same tmp
  // path and clobber each other before either rename lands.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // openSync + writeFileSync(fd, ...) rather than writeFileSync(path, ...):
    // fsyncSync needs the open descriptor, and process-lock.ts's own
    // writeFileSync(tempPath, ..., { mode: 0o600, flag: 'wx' }) call has no
    // fd to fsync — this repo's fixed tmp-per-lock-attempt flow relies on
    // linkSync's atomicity instead, which isn't available for a plain
    // overwrite-in-place save.
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state), 'utf8');
      fsyncSync(fd); // durability: survive a crash between write and rename
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file); // atomic replace
  } finally {
    // Best-effort cleanup, mirroring process-lock.ts's finally block
    // (src/lib/process-lock.ts:263-268): after a successful renameSync the
    // tmp path no longer exists (rename moves it), so unlinkSync here throws
    // ENOENT on the success path — expected, not a failure. On a thrown
    // write/fsync error the tmp file is orphaned without this, per M1.
    try {
      unlinkSync(tmp);
    } catch {
      // Intentional: on the success path renameSync already moved the tmp
      // path away, so the ENOENT this throws here is expected, not a
      // failure worth surfacing.
    }
  }
}

export function registerOnset(state: IncidentBreakerState, nowIso: string): void {
  if (state.onset === null) state.onset = nowIso;
}

/** Count attempts within `windowSeconds` of `nowIso`, pruning anything older in place. */
export function attemptsInWindow(state: IncidentBreakerState, nowIso: string, windowSeconds: number): number {
  state.attempts = state.attempts.filter((t) => diffSeconds(nowIso, t) <= windowSeconds);
  return state.attempts.length;
}

export function recordAttempt(state: IncidentBreakerState, nowIso: string): void {
  state.attempts.push(nowIso);
}

export function clearIncident(state: IncidentBreakerState): void {
  state.onset = null;
  state.attempts = [];
  state.tripped = false;
  state.escalated = false;
}
