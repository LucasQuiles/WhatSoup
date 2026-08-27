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
  releaseDegradationLatchOnRecoveryProof,
  TURN_PROVABLE_STATUS_REASONS,
} from '../../src/core/health.ts';
import type { DegradationLatchEntry } from '../../src/core/health.ts';

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
    const recentlyDegraded = new Map([
      ['test-instance', { latchedAtMs: 1_000, reasons: new Set(['turn_capability_degraded']) }],
    ]);
    addDegradationSilenceProof(reasons, recentlyDegraded, 'test-instance');
    expect(reasons).toContain('degradation_silence_unproven');
  });
});

// Recovery-proof release contract: the latch releases ONLY on a successful
// PRIMARY-provider turn receipt strictly newer than the latch point, and only
// when every latched reason is turn-provable (a turn proves the turn pipeline
// only). Strictly-newer is the ONLY temporal guard — deliberately no
// wall-clock expiry (see the no-clock test below). Everything else fails
// closed. The latch is process-lifetime, in-memory state — a restart clears
// it by amnesia, which is loss of the latch, not a release channel.
describe('releaseDegradationLatchOnRecoveryProof', () => {
  const NAME = 'test-instance';
  const NOW = 10_000_000;
  const LATCHED_AT = NOW - 60_000;
  const receipt = (at: number, provider = 'claude-cli') => ({
    last_successful_turn_at: at,
    last_successful_turn_provider: provider,
  });

  function latched(reasons: string[] = ['turn_capability_degraded']): Map<string, DegradationLatchEntry> {
    return new Map([[NAME, { latchedAtMs: LATCHED_AT, reasons: new Set(reasons) }]]);
  }

  it('releases on a primary receipt strictly newer than the latch point', () => {
    const map = latched();
    const released = releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli');
    expect(released).toBe(true);
    expect(map.has(NAME)).toBe(false);
  });

  it('releases when every latched reason is turn-provable', () => {
    const map = latched(['turn_capability_degraded', 'agent_runtime_degraded', 'connection_disconnected']);
    const released = releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli');
    expect(released).toBe(true);
    expect(map.has(NAME)).toBe(false);
  });

  it('does not release when ANY latched reason is not turn-provable', () => {
    for (const reasons of [
      ['enrichment_runtime_degraded'],
      ['turn_capability_degraded', 'enrichment_runtime_degraded'],
      ['memory_readiness_degraded'],
      ['durability_delivery_debt'],
      ['runtime.outbound_queue_poisoned'],
      ['auth_failure.auth_bond_at_risk'],
      ['schema_future'],
    ]) {
      const map = latched(reasons);
      expect(
        releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli'),
        `latched reasons ${reasons.join(',')} must not release on a turn receipt`,
      ).toBe(false);
      expect(map.has(NAME)).toBe(true);
    }
  });

  it('pins the turn-provable reason taxonomy so membership changes are deliberate', () => {
    // A turn proves the turn pipeline: turn capability, agent runtime, and
    // the connection the turn rode in on — nothing else. Review adjusts this
    // set consciously, not by side effect.
    expect([...TURN_PROVABLE_STATUS_REASONS].sort()).toEqual([
      'agent_runtime_degraded',
      'agent_runtime_unhealthy',
      'connection_disconnected',
      'connection_recovering',
      'turn_capability_degraded',
    ]);
  });

  it('does not release on a receipt at or before the latch point', () => {
    for (const at of [LATCHED_AT, LATCHED_AT - 1]) {
      const map = latched();
      expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(at), 'claude-cli')).toBe(false);
      expect(map.has(NAME)).toBe(true);
    }
  });

  it('a genuine receipt does not expire: the release contract has no clock input', () => {
    // Release validity is strictly-newer-than-the-latch-point, full stop: if
    // anything bad happened after the receipt, the latch point advanced past
    // it by construction. A wall-clock freshness window would make release
    // depend on /health polling cadence and permanently strand idle
    // instances whose receipt "expired" unobserved. The predicate therefore
    // takes no clock at all — pinned here so a `now` parameter cannot creep
    // back without a deliberate contract change.
    expect(releaseDegradationLatchOnRecoveryProof.length).toBe(4);
    const map = latched();
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli')).toBe(true);
    expect(map.has(NAME)).toBe(false);
  });

  it('does not release without turn-capability evidence or without a receipt', () => {
    const map = latched();
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, null, 'claude-cli')).toBe(false);
    expect(releaseDegradationLatchOnRecoveryProof(
      map,
      NAME,
      { last_successful_turn_at: null, last_successful_turn_provider: 'claude-cli' },
      'claude-cli',
    )).toBe(false);
    expect(map.has(NAME)).toBe(true);
  });

  it('does not release when the receipt provider is not the primary, or the primary is unknown', () => {
    const map = latched();
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1, 'openai-api'), 'claude-cli')).toBe(false);
    // primaryProviderId null = the fallback snapshot shows a window (even one
    // whose expiry has since passed) or fallback state is absent.
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1), null)).toBe(false);
    expect(releaseDegradationLatchOnRecoveryProof(
      map,
      NAME,
      { last_successful_turn_at: NOW - 1, last_successful_turn_provider: null },
      'claude-cli',
    )).toBe(false);
    expect(map.has(NAME)).toBe(true);
  });

  it('never releases an instance that is not latched, and never touches other latches', () => {
    const map = new Map<string, DegradationLatchEntry>([
      ['other-instance', { latchedAtMs: LATCHED_AT, reasons: new Set(['turn_capability_degraded']) }],
    ]);
    expect(releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(NOW - 1), 'claude-cli')).toBe(false);
    expect(map.has('other-instance')).toBe(true);
  });

  it('release then silence-proof: a released instance no longer latches the silence reason', () => {
    const map = latched();
    releaseDegradationLatchOnRecoveryProof(map, NAME, receipt(LATCHED_AT + 1_000), 'claude-cli');
    const reasons: string[] = [];
    const latchedAgain = addDegradationSilenceProof(reasons, map, NAME);
    expect(latchedAgain).toBe(false);
    expect(reasons).toEqual([]);
  });
});
