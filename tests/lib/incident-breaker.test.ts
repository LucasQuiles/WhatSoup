// tests/lib/incident-breaker.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #2323 M1 regression coverage: spy on openSync/writeFileSync while
// delegating everything else to the real implementation (same pattern as
// tests/core/substrate/vault-fs-errors.test.ts's fsMock), so the tmp-naming
// and cleanup-on-throw behavior of saveBreakerState can be observed/injected
// without reimplementing the filesystem.
const fsMock = vi.hoisted(() => ({
  openSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.openSync.mockImplementation(actual.openSync);
  fsMock.writeFileSync.mockImplementation(actual.writeFileSync);
  return { ...actual, openSync: fsMock.openSync, writeFileSync: fsMock.writeFileSync };
});

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

  describe('#2323 M1 — tmp-name collision fix', () => {
    beforeEach(() => {
      fsMock.openSync.mockClear();
      fsMock.writeFileSync.mockClear();
    });

    it('computes a distinct pid/uuid-suffixed tmp path per call, never the old shared `${file}.tmp` name', () => {
      const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
      registerOnset(s, '2026-06-21 05:00:00');
      saveBreakerState(dir, s);
      saveBreakerState(dir, s);

      // openSync's first arg is the tmp path saveBreakerState opened.
      const tmpPaths = fsMock.openSync.mock.calls.map((call) => call[0] as string);
      expect(tmpPaths).toHaveLength(2);
      const [first, second] = tmpPaths;
      // Two calls never reuse the same tmp path...
      expect(first).not.toBe(second);
      // ...and neither is the old fixed name that two concurrent writers
      // would have collided on before this fix.
      const stateFile = join(dir, 'ml-bot__auth_terminal.json');
      expect(first).not.toBe(`${stateFile}.tmp`);
      expect(second).not.toBe(`${stateFile}.tmp`);
      // Both are still scoped under the real state file's own name and
      // stamped with this process's pid, matching process-lock.ts's
      // `${lockPath}.${pid}.${token}.tmp` idiom (src/lib/process-lock.ts:193).
      expect(first).toMatch(new RegExp(`^${stateFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.[0-9a-f-]+\\.tmp$`));

      // No orphaned tmp files left behind after either successful save.
      expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });

    it('cleans up its own tmp file and leaves prior good state untouched when the write throws', () => {
      const s = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
      registerOnset(s, '2026-06-21 05:00:00');
      saveBreakerState(dir, s); // establish a known-good persisted state first

      recordAttempt(s, '2026-06-21 06:00:00'); // mutate in memory only
      fsMock.writeFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      });

      expect(() => saveBreakerState(dir, s)).toThrow(/ENOSPC/);

      // The prior good state on disk was never touched (renameSync never ran).
      const reloaded = loadBreakerState(dir, 'ml-bot', 'auth_terminal');
      expect(reloaded.onset).toBe('2026-06-21 05:00:00');
      expect(reloaded.attempts).toEqual([]);

      // The failed attempt's tmp file was NOT orphaned (try/finally cleanup).
      expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    });
  });
});
