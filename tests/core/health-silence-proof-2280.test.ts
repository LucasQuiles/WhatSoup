/**
 * Tests for #2280: silence from child is not proof of recovery.
 *
 * Exercises the real recovery-proof latch transition used by src/core/health.ts.
 *
 * fails-before:  statusReasons empty → status = healthy immediately,
 *                even when instance was recently degraded.
 * passes-after:  Empty statusReasons + recent degradation history →
 *                'degradation_silence_unproven' added → stays degraded.
 * no-regression: No previous degradation → empty statusReasons → healthy.
 * no-regression: Existing degradation reasons → unchanged, no silence added.
 */
import { describe, expect, it } from 'vitest';
import { applyRecoveryProof } from '../../src/core/recovery-debt.ts';

describe('degradation silence unproven (#2280)', () => {
  it('adds silence_unproven when empty reasons + previous degradation', () => {
    const reasons: string[] = [];
    const recentlyDegraded = new Set<string>(['test-instance']);
    applyRecoveryProof(reasons, recentlyDegraded, 'test-instance', 'retain');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('degraded');
    expect(reasons).toContain('degradation_silence_unproven');
  });

  it('leaves healthy when no previous degradation', () => {
    const reasons: string[] = [];
    const recentlyDegraded = new Set<string>();
    applyRecoveryProof(reasons, recentlyDegraded, 'test-instance', 'clear');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('healthy');
    expect(reasons).not.toContain('degradation_silence_unproven');
  });

  it('existing degradation reasons still produce degraded status', () => {
    const reasons = ['enrichment_stale'];
    const recentlyDegraded = new Set<string>(['test-instance']);
    applyRecoveryProof(reasons, recentlyDegraded, 'test-instance', 'degrade');
    const status = reasons.length > 0 ? 'degraded' : 'healthy';
    expect(status).toBe('degraded');
    expect(reasons).toEqual(['enrichment_stale']);
  });

  it('clears the prior latch only on explicit complete recovery proof', () => {
    const recentlyDegraded = new Set<string>(['test-instance']);
    const reasons: string[] = [];
    applyRecoveryProof(reasons, recentlyDegraded, 'test-instance', 'clear');
    expect(recentlyDegraded.has('test-instance')).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('fails closed when proof explicitly degrades without another reason', () => {
    const recentlyDegraded = new Set<string>();
    const reasons: string[] = [];
    applyRecoveryProof(reasons, recentlyDegraded, 'test-instance', 'degrade');
    expect(recentlyDegraded.has('test-instance')).toBe(true);
    expect(reasons).toEqual(['degradation_silence_unproven']);
  });
});
