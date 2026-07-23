/**
 * Unit tests for the pure FallbackRecoveryTransaction decision core (DUR-02).
 *
 * No runtime, no timers, no alert I/O — this proves the canary-validation
 * logic in isolation: a probe result must be usable, target-matched, and
 * fresh before a transition commits. Wiring into AgentRuntime is proven
 * separately in fallback-probe-stall*.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateFallbackRecoveryTransaction,
  formatFallbackRecoveryReceiptEvidence,
  type FallbackRecoveryContext,
  type FallbackRecoveryEvidence,
} from '../../../src/runtimes/agent/fallback-recovery-transaction.ts';

const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms

function ctx(overrides: Partial<FallbackRecoveryContext> = {}): FallbackRecoveryContext {
  return {
    instanceName: 'test',
    primaryProvider: 'claude-cli',
    primaryModel: 'claude-opus-4-8[1m]',
    fallbackProvider: 'opencode-cli',
    fallbackModel: 'kimi/kimi-k3',
    probeAttemptsAtTransition: 7,
    now: NOW,
    maxEvidenceAgeMs: 60_000,
    ...overrides,
  };
}

function evidence(overrides: Partial<FallbackRecoveryEvidence> = {}): FallbackRecoveryEvidence {
  return {
    status: 'usable',
    provider: 'claude-cli',
    model: 'claude-opus-4-8[1m]',
    checkedAt: NOW - 1_000,
    ...overrides,
  };
}

describe('evaluateFallbackRecoveryTransaction', () => {
  it('commits on a fresh, target-matched, usable probe result', () => {
    const decision = evaluateFallbackRecoveryTransaction(evidence(), ctx());
    expect(decision.commit).toBe(true);
    if (!decision.commit) throw new Error('unreachable');
    expect(decision.receipt).toEqual({
      instanceName: 'test',
      transitionAt: NOW,
      reasonCode: 'primary-probe-ok',
      from: { provider: 'opencode-cli', model: 'kimi/kimi-k3' },
      to: { provider: 'claude-cli', model: 'claude-opus-4-8[1m]' },
      evidence: { provider: 'claude-cli', model: 'claude-opus-4-8[1m]', status: 'usable', checkedAt: NOW - 1_000 },
      canary: 'passed',
      probeAttemptsAtTransition: 7,
    });
  });

  it('rejects — never on the probe alone: a non-usable status never commits regardless of other fields', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ status: 'model-unavailable' }),
      ctx(),
    );
    expect(decision).toEqual({ commit: false, rejectReason: 'evidence-not-usable' });
  });

  it('rejects a provider-mismatched evidence sample — cannot revert THIS window off evidence for a different provider', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ provider: 'opencode-cli' }),
      ctx(),
    );
    expect(decision).toEqual({ commit: false, rejectReason: 'evidence-provider-mismatch' });
  });

  it('rejects a model-mismatched evidence sample when the primary pins a specific model', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ model: 'claude-sonnet-5' }),
      ctx(),
    );
    expect(decision).toEqual({ commit: false, rejectReason: 'evidence-model-mismatch' });
  });

  it('accepts a null observed model when the primary has no pinned model (provider-default routing)', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ model: null }),
      ctx({ primaryModel: null }),
    );
    expect(decision.commit).toBe(true);
  });

  it('rejects stale evidence beyond maxEvidenceAgeMs — a cached usable sample cannot commit a later transition', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ checkedAt: NOW - 61_000 }),
      ctx({ maxEvidenceAgeMs: 60_000 }),
    );
    expect(decision).toEqual({ commit: false, rejectReason: 'evidence-stale' });
  });

  it('rejects evidence checked in the future (clock skew / corrupt timestamp) — never manufactures freshness', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ checkedAt: NOW + 5_000 }),
      ctx(),
    );
    expect(decision).toEqual({ commit: false, rejectReason: 'evidence-stale' });
  });

  it('accepts evidence exactly at the freshness boundary', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ checkedAt: NOW - 60_000 }),
      ctx({ maxEvidenceAgeMs: 60_000 }),
    );
    expect(decision.commit).toBe(true);
  });
});

describe('formatFallbackRecoveryReceiptEvidence', () => {
  it('renders an allowlisted key=value string from the receipt only — never the raw probe result', () => {
    const decision = evaluateFallbackRecoveryTransaction(evidence(), ctx());
    if (!decision.commit) throw new Error('unreachable');
    const text = formatFallbackRecoveryReceiptEvidence(decision.receipt);
    expect(text).toContain('from_provider=opencode-cli');
    expect(text).toContain('from_model=kimi/kimi-k3');
    expect(text).toContain('to_provider=claude-cli');
    expect(text).toContain('to_model=claude-opus-4-8[1m]');
    expect(text).toContain('evidence_status=usable');
    expect(text).toContain('evidence_provider=claude-cli');
    expect(text).toContain('evidence_model=claude-opus-4-8[1m]');
    expect(text).toContain(`checked_at=${new Date(NOW - 1_000).toISOString()}`);
    expect(text).toContain('canary=passed');
    expect(text).toContain('probe_attempts=7');
  });

  it('renders "unknown" for a null model rather than the literal string "null"', () => {
    const decision = evaluateFallbackRecoveryTransaction(
      evidence({ model: null }),
      ctx({ primaryModel: null }),
    );
    if (!decision.commit) throw new Error('unreachable');
    const text = formatFallbackRecoveryReceiptEvidence(decision.receipt);
    expect(text).not.toContain('=null');
    expect(text).toContain('to_model=unknown');
    expect(text).toContain('evidence_model=unknown');
  });
});
