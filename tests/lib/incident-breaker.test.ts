// tests/lib/incident-breaker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBreakerState,
  saveBreakerState,
  registerOnset,
  recordAttempt,
  attemptsInWindow,
  clearIncident,
} from '../../src/lib/incident-breaker.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'breaker-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('incident-breaker', () => {
  it('returns a fresh empty state when no file exists', () => {
    const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    expect(s.onset).toBeNull();
    expect(s.attempts).toEqual([]);
    expect(s.escalated).toBe(false);
  });

  it('registers an onset only once', () => {
    const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    registerOnset(s, '2026-06-21 05:00:00');
    registerOnset(s, '2026-06-21 05:06:00');
    expect(s.onset).toBe('2026-06-21 05:00:00');
  });

  it('counts attempts inside the sliding window and prunes old ones', () => {
    const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    recordAttempt(s, '2026-06-21 05:00:00');
    recordAttempt(s, '2026-06-21 05:06:00');
    recordAttempt(s, '2026-06-21 05:12:00');
    // window anchored at 05:12:00, 600s back = 05:02:00 → only the last two count
    expect(attemptsInWindow(s, '2026-06-21 05:12:00', 600)).toBe(2);
  });

  it('persists and reloads state across a save/load cycle', () => {
    const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    registerOnset(s, '2026-06-21 05:00:00');
    s.escalated = true;
    saveBreakerState(dir, s);
    const reloaded = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    expect(reloaded.onset).toBe('2026-06-21 05:00:00');
    expect(reloaded.escalated).toBe(true);
  });

  it('clearIncident resets onset, attempts, trip, and escalation', () => {
    const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
    registerOnset(s, '2026-06-21 05:00:00');
    recordAttempt(s, '2026-06-21 05:00:00');
    s.tripped = true; s.escalated = true;
    clearIncident(s);
    expect(s.onset).toBeNull();
    expect(s.attempts).toEqual([]);
    expect(s.tripped).toBe(false);
    expect(s.escalated).toBe(false);
  });
});
