// src/lib/incident-breaker.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FaultClass } from './fault-classifier.ts';

export interface BreakerState {
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

export function loadBreakerState(dir: string, host: string, faultClass: FaultClass): BreakerState {
  const file = stateFile(dir, host, faultClass);
  if (!existsSync(file)) {
    return { host, faultClass, onset: null, attempts: [], tripped: false, escalated: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BreakerState>;
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

export function saveBreakerState(dir: string, state: BreakerState): void {
  mkdirSync(dir, { recursive: true });
  const file = stateFile(dir, state.host, state.faultClass);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  renameSync(tmp, file); // atomic replace
}

export function registerOnset(state: BreakerState, nowIso: string): void {
  if (state.onset === null) state.onset = nowIso;
}

/** Count attempts within `windowSeconds` of `nowIso`, pruning anything older in place. */
export function attemptsInWindow(state: BreakerState, nowIso: string, windowSeconds: number): number {
  state.attempts = state.attempts.filter((t) => diffSeconds(nowIso, t) <= windowSeconds);
  return state.attempts.length;
}

export function recordAttempt(state: BreakerState, nowIso: string): void {
  state.attempts.push(nowIso);
}

export function clearIncident(state: BreakerState): void {
  state.onset = null;
  state.attempts = [];
  state.tripped = false;
  state.escalated = false;
}
