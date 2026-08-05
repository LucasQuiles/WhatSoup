import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  WATCHDOG_CHECKS,
  HUB_ONLY_CHECKS,
  LOCAL_SAFE_CHECKS,
  SCHEDULE_LANES,
  REQUIRED_LANE_NAMES,
  MACOS_LOCAL_DEFAULT_CHECKS,
  MACOS_LOCAL_DEFAULT_CHECKS_STRING,
  OBSERVER_RELATIONSHIPS,
  verifyWatchdogReceipt,
  WATCHDOG_RECEIPT_MAX_AGE_MS,
} from '../../src/fleet/bot-errors-schedule-matrix.ts';

describe('BOT ERRORS schedule matrix (#2466)', () => {
  // ── Watchdog check registry ─────────────────────────────────────────

  it('every watchdog check is unique', () => {
    expect(new Set(WATCHDOG_CHECKS).size).toBe(WATCHDOG_CHECKS.length);
  });

  it('hub-only checks are a subset of the full registry', () => {
    for (const check of HUB_ONLY_CHECKS) {
      expect(WATCHDOG_CHECKS).toContain(check);
    }
  });

  it('local-safe checks exclude every hub-only check', () => {
    for (const hubOnly of HUB_ONLY_CHECKS) {
      expect(LOCAL_SAFE_CHECKS).not.toContain(hubOnly);
    }
  });

  it('local-safe checks are a subset of the full registry', () => {
    for (const check of LOCAL_SAFE_CHECKS) {
      expect(WATCHDOG_CHECKS).toContain(check);
    }
  });

  it('local-safe + hub-only covers the entire registry with no overlap', () => {
    const localSet = new Set(LOCAL_SAFE_CHECKS);
    const hubSet = new Set(HUB_ONLY_CHECKS);
    // No overlap
    for (const c of localSet) expect(hubSet.has(c)).toBe(false);
    // Full coverage
    for (const c of WATCHDOG_CHECKS) {
      expect(localSet.has(c) || hubSet.has(c)).toBe(true);
    }
  });

  // ── Schedule lanes ──────────────────────────────────────────────────

  it('every schedule lane has a unique name', () => {
    const names = SCHEDULE_LANES.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('heartbeat-watchdog lane exists with 5-minute cadence', () => {
    const watchdog = SCHEDULE_LANES.find((l) => l.name === 'heartbeat-watchdog');
    expect(watchdog).toBeDefined();
    expect(watchdog!.cadenceSeconds).toBe(300);
    expect(watchdog!.macosLabel).toBe('heartbeat-watchdog');
    expect(watchdog!.linuxUnit).toBe('bot-errors-heartbeat-watchdog.timer');
  });

  it('dispatcher lane runs continuously (cadence 0)', () => {
    const dispatcher = SCHEDULE_LANES.find((l) => l.name === 'dispatcher');
    expect(dispatcher).toBeDefined();
    expect(dispatcher!.cadenceSeconds).toBe(0);
  });

  it('required lane names match the schedule lanes', () => {
    expect(REQUIRED_LANE_NAMES).toEqual(SCHEDULE_LANES.map((l) => l.name));
  });

  it('every lane declares both a linux unit and macos label', () => {
    for (const lane of SCHEDULE_LANES) {
      expect(lane.linuxUnit, `${lane.name} missing linuxUnit`).toBeTruthy();
      expect(lane.macosLabel, `${lane.name} missing macosLabel`).toBeTruthy();
    }
  });

  // ── Role-appropriate defaults ───────────────────────────────────────

  it('macOS local default checks match the local-safe set', () => {
    expect([...MACOS_LOCAL_DEFAULT_CHECKS]).toEqual([...LOCAL_SAFE_CHECKS]);
  });

  it('macOS local default checks string is comma-joined and non-empty', () => {
    expect(MACOS_LOCAL_DEFAULT_CHECKS_STRING).toBe(MACOS_LOCAL_DEFAULT_CHECKS.join(','));
    expect(MACOS_LOCAL_DEFAULT_CHECKS_STRING.length).toBeGreaterThan(0);
  });

  it('macOS local default excludes q_loop and collector (the named false-incident sources)', () => {
    expect(MACOS_LOCAL_DEFAULT_CHECKS).not.toContain('q_loop');
    expect(MACOS_LOCAL_DEFAULT_CHECKS).not.toContain('collector');
  });

  // ── Criterion 6: Independent observer relationships ──────────────────

  it('the heartbeat-watchdog lane has an independent observer (not itself)', () => {
    const watchdogObserver = OBSERVER_RELATIONSHIPS.find((r) => r.observed === 'heartbeat-watchdog');
    expect(watchdogObserver).toBeDefined();
    expect(watchdogObserver!.observer).not.toBe('heartbeat-watchdog');
    // The observer must be a real lane — assert the resolved name, not mere
    // presence, so a rename that orphans the relationship fails loudly.
    const observerLane = SCHEDULE_LANES.find((l) => l.name === watchdogObserver!.observer);
    expect(observerLane?.name).toBe(watchdogObserver!.observer);
  });

  it('no lane observes itself', () => {
    for (const rel of OBSERVER_RELATIONSHIPS) {
      expect(rel.observed).not.toBe(rel.observer);
    }
  });

  it('every observer relationship references declared lanes', () => {
    const laneNames = new Set(REQUIRED_LANE_NAMES);
    for (const rel of OBSERVER_RELATIONSHIPS) {
      expect(laneNames.has(rel.observed)).toBe(true);
      expect(laneNames.has(rel.observer)).toBe(true);
    }
  });

  // ── Criterion 5: Runtime readback validation ─────────────────────────

  describe('verifyWatchdogReceipt (runtime readback, criterion 5)', () => {
    const NOW = 1_000_000_000_000;
    const validChecks = [...LOCAL_SAFE_CHECKS];

    function validReceipt(ageMs = 60_000) {
      return {
        schemaVersion: 1,
        lastRunAt: NOW - ageMs,
        executedChecks: validChecks,
      };
    }

    it('accepts a fresh, complete receipt', () => {
      const verdict = verifyWatchdogReceipt(validReceipt(60_000), validChecks, NOW);
      expect(verdict.valid).toBe(true);
      expect(verdict.reasons).toHaveLength(0);
    });

    it('rejects a non-object receipt', () => {
      const verdict = verifyWatchdogReceipt('not-an-object', validChecks, NOW);
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons).toContain('receipt is not an object');
    });

    it('rejects a receipt missing schemaVersion', () => {
      const verdict = verifyWatchdogReceipt(
        { lastRunAt: NOW - 1_000, executedChecks: validChecks },
        validChecks,
        NOW,
      );
      expect(verdict.valid).toBe(false);
    });

    it('rejects a receipt missing lastRunAt', () => {
      const verdict = verifyWatchdogReceipt(
        { schemaVersion: 1, executedChecks: validChecks },
        validChecks,
        NOW,
      );
      expect(verdict.valid).toBe(false);
    });

    it('rejects a stale receipt (older than the max age)', () => {
      const staleAge = WATCHDOG_RECEIPT_MAX_AGE_MS + 1_000;
      const verdict = verifyWatchdogReceipt(validReceipt(staleAge), validChecks, NOW);
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons.some((r) => r.includes('stale'))).toBe(true);
    });

    it('rejects a future-dated receipt', () => {
      const verdict = verifyWatchdogReceipt(validReceipt(-1_000), validChecks, NOW);
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons.some((r) => r.includes('future'))).toBe(true);
    });

    it('rejects a receipt missing the expected check set', () => {
      const verdict = verifyWatchdogReceipt(
        { schemaVersion: 1, lastRunAt: NOW - 1_000, executedChecks: ['dispatcher'] },
        validChecks,
        NOW,
      );
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons.some((r) => r.includes('missing expected check'))).toBe(true);
    });

    it('rejects a receipt missing the executedChecks array entirely', () => {
      const verdict = verifyWatchdogReceipt(
        { schemaVersion: 1, lastRunAt: NOW - 1_000 },
        validChecks,
        NOW,
      );
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons.some((r) => r.includes('executedChecks'))).toBe(true);
    });

    it('flags unknown checks not in the registry', () => {
      const verdict = verifyWatchdogReceipt(
        { schemaVersion: 1, lastRunAt: NOW - 1_000, executedChecks: [...validChecks, 'bogus_check'] },
        validChecks,
        NOW,
      );
      expect(verdict.valid).toBe(false);
      expect(verdict.reasons.some((r) => r.includes('unknown check: bogus_check'))).toBe(true);
    });
  });

  // ── Criterion 7: Documentation checked against the matrix ────────────

  describe('README documentation parity (criterion 7)', () => {
    const readmePath = join(process.cwd(), 'deploy', 'scripts', 'README-bot-errors.md');
    const readme = readFileSync(readmePath, 'utf-8');

    it('README mentions every schedule lane by name', () => {
      for (const lane of SCHEDULE_LANES) {
        expect(readme).toContain(lane.name);
      }
    });

    it('README references the heartbeat-watchdog script', () => {
      expect(readme).toContain('bot-errors-heartbeat-watchdog');
    });

    it('README describes the heartbeat-watchdog as a five-minute schedule', () => {
      const watchdogLane = SCHEDULE_LANES.find((l) => l.name === 'heartbeat-watchdog');
      expect(watchdogLane).toBeDefined();
      expect(watchdogLane!.cadenceSeconds).toBe(300);
      // The README must reference "five-minute" or "5-minute" or "300" for the watchdog.
      expect(
        readme.includes('five-minute') || readme.includes('5-minute') || readme.includes('300'),
      ).toBe(true);
    });
  });
});
