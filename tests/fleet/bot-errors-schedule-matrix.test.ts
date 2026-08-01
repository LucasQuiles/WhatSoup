import { describe, expect, it } from 'vitest';
import {
  WATCHDOG_CHECKS,
  HUB_ONLY_CHECKS,
  LOCAL_SAFE_CHECKS,
  SCHEDULE_LANES,
  REQUIRED_LANE_NAMES,
  MACOS_LOCAL_DEFAULT_CHECKS,
  MACOS_LOCAL_DEFAULT_CHECKS_STRING,
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
});
