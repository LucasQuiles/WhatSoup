// FLOS Stage 1 — Contract E clock model (design §2, O4/O5).
// Progress age derives from mono_ms deltas WITHIN a boot_id; across boots it
// is UTC reconstruction with an explicit `age_basis: utc_reconstructed`.
// Anomalies never manufacture green: a future at_utc within the allowance is
// clamped and counted; beyond the allowance the age becomes `unknown` — and
// unknown MUST NOT satisfy any settlement predicate (fail-closed).
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLOCK_ALLOWANCE_SECONDS,
  deriveProgressAge,
  maxHoldAge,
} from '../../../src/core/observability/lifecycle-clock.ts';

const AT = '2026-08-29T03:00:00Z';
const AT_EPOCH_MS = Date.parse(AT);

describe('lifecycle progress-age derivation (O4/O5)', () => {
  it('uses monotonic deltas within a boot', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 10_000, at_utc: AT },
      now: { boot_id: 'b1', mono_ms: 70_000, at_utc_epoch_ms: AT_EPOCH_MS + 999_999 },
    });
    expect(r).toEqual({ age_seconds: 60, age_basis: 'monotonic', clock_anomaly: false });
  });

  it('a regressing monotonic reading within a boot is impossible — unknown, anomaly', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 50_000, at_utc: AT },
      now: { boot_id: 'b1', mono_ms: 10_000, at_utc_epoch_ms: AT_EPOCH_MS },
    });
    expect(r.age_basis).toBe('unknown');
    expect(r.age_seconds).toBeNull();
    expect(r.clock_anomaly).toBe(true);
  });

  it('reconstructs from UTC across a boot change, marked utc_reconstructed', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 999, at_utc: AT },
      now: { boot_id: 'b2', mono_ms: 5, at_utc_epoch_ms: AT_EPOCH_MS + 120_000 },
    });
    expect(r).toEqual({ age_seconds: 120, age_basis: 'utc_reconstructed', clock_anomaly: false });
  });

  it('clamps a future at_utc within the allowance to age 0 and counts the anomaly', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 0, at_utc: AT },
      now: { boot_id: 'b2', mono_ms: 0, at_utc_epoch_ms: AT_EPOCH_MS - 10_000 },
    });
    expect(r).toEqual({ age_seconds: 0, age_basis: 'utc_reconstructed', clock_anomaly: true });
  });

  it('a future at_utc beyond the allowance is unknown — fail-closed, never green', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 0, at_utc: AT },
      now: { boot_id: 'b2', mono_ms: 0, at_utc_epoch_ms: AT_EPOCH_MS - (DEFAULT_CLOCK_ALLOWANCE_SECONDS + 5) * 1000 },
    });
    expect(r.age_basis).toBe('unknown');
    expect(r.age_seconds).toBeNull();
    expect(r.clock_anomaly).toBe(true);
  });

  it('a malformed at_utc is unknown, never a throw', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 0, at_utc: 'not-a-time' },
      now: { boot_id: 'b2', mono_ms: 0, at_utc_epoch_ms: AT_EPOCH_MS },
    });
    expect(r.age_basis).toBe('unknown');
    expect(r.clock_anomaly).toBe(true);
  });

  it('honors a custom allowance', () => {
    const r = deriveProgressAge({
      last: { boot_id: 'b1', mono_ms: 0, at_utc: AT },
      now: { boot_id: 'b2', mono_ms: 0, at_utc_epoch_ms: AT_EPOCH_MS - 40_000 },
      allowance_seconds: 60,
    });
    expect(r).toEqual({ age_seconds: 0, age_basis: 'utc_reconstructed', clock_anomaly: true });
  });
});

describe('max-hold (a regressing wall clock never regresses a derived age)', () => {
  it('holds the prior age when a reconstruction regresses within the allowance', () => {
    expect(maxHoldAge(300, 290)).toEqual({ age_seconds: 300, age_basis: 'utc_reconstructed', clock_anomaly: true });
  });

  it('keeps a monotonically advancing age untouched', () => {
    expect(maxHoldAge(300, 360)).toEqual({ age_seconds: 360, age_basis: 'utc_reconstructed', clock_anomaly: false });
  });

  it('a regression beyond the allowance is unknown (V6 path), not a silent hold', () => {
    const r = maxHoldAge(300, 200);
    expect(r.age_basis).toBe('unknown');
    expect(r.age_seconds).toBeNull();
    expect(r.clock_anomaly).toBe(true);
  });

  it('honors a custom allowance for the regression bound', () => {
    expect(maxHoldAge(300, 200, 120)).toEqual({ age_seconds: 300, age_basis: 'utc_reconstructed', clock_anomaly: true });
  });
});
