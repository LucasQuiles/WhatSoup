/**
 * Tests for `modelEvidenceStaleWhileRelied` (src/core/health.ts) — the S-04a
 * degrade predicate.
 *
 * Stale model-usability evidence read as `healthy` (a false green: rb-bot on
 * mini7 showed top-level `status: healthy` with `modelUsableStale: true` and
 * 19h-old evidence). The fix degrades stale evidence, but ONLY when the model
 * was recently relied upon — a legitimately idle bot with no pending turn has
 * naturally stale evidence and must stay healthy (owner decision 2026-07-17).
 */
import { describe, it, expect } from 'vitest';
import { modelEvidenceStaleWhileRelied, MODEL_STALE_RELIANCE_MS } from '../../src/core/health.ts';

const NOW = 1_700_000_000_000;

describe('modelEvidenceStaleWhileRelied', () => {
  it('degrades when evidence is stale AND a turn was attempted within the reliance window', () => {
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: true, last_successful_turn_at: NOW - 60_000, last_turn_error_at: null },
      NOW,
    )).toBe(true);
  });

  it('degrades when stale and a recent turn ERROR (not just success) is within the window', () => {
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: true, last_successful_turn_at: null, last_turn_error_at: NOW - 120_000 },
      NOW,
    )).toBe(true);
  });

  it('stays healthy for a never-turned idle bot even when evidence is stale', () => {
    // The live mini7 rb-bot snapshot: stale, but lastSuccessfulTurnAt=null and
    // lastTurnErrorAt=null → not recently relied upon → benign.
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: true, last_successful_turn_at: null, last_turn_error_at: null },
      NOW,
    )).toBe(false);
  });

  it('stays healthy when the last turn is older than the reliance window', () => {
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: true, last_successful_turn_at: NOW - MODEL_STALE_RELIANCE_MS - 1, last_turn_error_at: null },
      NOW,
    )).toBe(false);
  });

  it('does not degrade when evidence is fresh, regardless of recent turns', () => {
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: false, last_successful_turn_at: NOW - 60_000, last_turn_error_at: null },
      NOW,
    )).toBe(false);
  });

  it('does not degrade when staleness is unknown (null)', () => {
    expect(modelEvidenceStaleWhileRelied(
      { model_usable_stale: null, last_successful_turn_at: NOW - 60_000, last_turn_error_at: null },
      NOW,
    )).toBe(false);
  });

  it('returns false for a null turn capability', () => {
    expect(modelEvidenceStaleWhileRelied(null, NOW)).toBe(false);
  });
});
