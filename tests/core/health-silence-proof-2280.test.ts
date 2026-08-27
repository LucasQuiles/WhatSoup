/**
 * Tests for #2280: silence from child is not proof of recovery.
 *
 * Exercises the real addDegradationSilenceProof from src/core/health.ts.
 *
 * fails-before:  statusReasons empty → status = healthy immediately,
 *                even when instance was recently degraded.
 * passes-after:  Empty statusReasons + recent degradation history →
 *                'degradation_silence_unproven' added → stays degraded.
 * no-regression: No previous degradation → empty statusReasons → healthy.
 * no-regression: Existing degradation reasons → unchanged, no silence added.
 */
import { describe, expect, it } from 'vitest';
import {
  addDegradationSilenceProof,
  MODEL_STALE_RELIANCE_MS,
  releaseDegradationLatchOnRecoveryProof,
} from '../../src/core/health.ts';

describe('degradation silence unproven (#2280)', () => {
  it('adds silence_unproven when empty reasons + previous degradation', () => {
    const reasons: string[] = [];
    const recentlyDegraded = new Set<string>(['test-instance']);
    addDegradationSilenceProof(reasons, recentlyDegraded, 'test-instance');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('degraded');
    expect(reasons).toContain('degradation_silence_unproven');
  });

  it('leaves healthy when no previous degradation', () => {
    const reasons: string[] = [];
    const recentlyDegraded = new Set<string>();
    addDegradationSilenceProof(reasons, recentlyDegraded, 'test-instance');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('healthy');
    expect(reasons).not.toContain('degradation_silence_unproven');
  });

  it('existing degradation reasons still produce degraded status', () => {
    const reasons = ['enrichment_stale'];
    const recentlyDegraded = new Set<string>(['test-instance']);
    addDegradationSilenceProof(reasons, recentlyDegraded, 'test-instance');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('degraded');
    expect(reasons).toEqual(['enrichment_stale']);
  });

  it('accepts the latch Map the live call site now holds', () => {
    const reasons: string[] = [];
    const recentlyDegraded = new Map<string, number>([['test-instance', 1_000]]);
    addDegradationSilenceProof(reasons, recentlyDegraded, 'test-instance');
    expect(reasons).toContain('degradation_silence_unproven');
  });
});

// Recovery-proof release contract: the latch releases ONLY on a successful
// PRIMARY-provider turn receipt strictly newer than the latch point and fresh
// per the existing turn-reliance window. Everything else fails closed.
describe('releaseDegradationLatchOnRecoveryProof', () => {
  const NAME = 'test-instance';
  const NOW = 10_000_000;
  const LATCHED_AT = NOW - 60_000;
  const receipt = (at: number, provider = 'claude-cli') => ({
    last_successful_turn_at: at,
    last_successful_turn_provider: provider,
  });

  function latched(): Map<string, number> {
    return new Map([[NAME, LATCHED_AT]]);
  }

  it('releases on a fresh primary receipt strictly newer than the latch point', () => {
    const map = latched();
    const released = releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli', NOW);
    expect(released).toBe(true);
    expect(map.has(NAME)).toBe(false);
  });

  it('does not release on a receipt at or before the latch point', () => {
    for (const at of [LATCHED_AT, LATCHED_AT - 1]) {
      const map = latched();
      expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(at), 'claude-cli', NOW)).toBe(false);
      expect(map.has(NAME)).toBe(true);
    }
  });

  it('does not release on a receipt newer than the latch but outside the freshness window', () => {
    const staleNow = LATCHED_AT + 1_000 + MODEL_STALE_RELIANCE_MS + 1;
    const map = latched();
    const released = releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli', staleNow);
    expect(released).toBe(false);
    expect(map.has(NAME)).toBe(true);
  });

  it('does not release without turn-capability evidence or without a receipt', () => {
    const map = latched();
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, null, 'claude-cli', NOW)).toBe(false);
    expect(releaseDegradationLatchOnRecoveryProof(
      map,
      NAME,
      { last_successful_turn_at: null, last_successful_turn_provider: 'claude-cli' },
      'claude-cli',
      NOW,
    )).toBe(false);
    expect(map.has(NAME)).toBe(true);
  });

  it('does not release when the receipt provider is not the primary, or the primary is unknown', () => {
    const map = latched();
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1, 'openai-api'), 'claude-cli', NOW)).toBe(false);
    // primaryProviderId null = fallback window live or fallback state absent.
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1), null, NOW)).toBe(false);
    expect(releaseDegradationLatchOnRecoveryProof(
      map,
      NAME,
      { last_successful_turn_at: NOW - 1, last_successful_turn_provider: null },
      'claude-cli',
      NOW,
    )).toBe(false);
    expect(map.has(NAME)).toBe(true);
  });

  it('never releases an instance that is not latched, and never touches other latches', () => {
    const map = new Map([['other-instance', LATCHED_AT]]);
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1), 'claude-cli', NOW)).toBe(false);
    expect(map.has('other-instance')).toBe(true);
  });

  it('release then silence-proof: a released instance no longer latches the silence reason', () => {
    const map = latched();
    releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli', NOW);
    const reasons: string[] = [];
    const latchedAgain = addDegradationSilenceProof(reasons, map, NAME);
    expect(latchedAgain).toBe(false);
    expect(reasons).toEqual([]);
  });
});
