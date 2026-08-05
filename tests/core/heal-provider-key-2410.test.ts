/**
 * Tests for #2410: crash single-flight key includes provider.
 *
 * fails-before:  Two providers (A, B) crash with same class → error class is
 *                "crash__process_exit" for both → B's crash conflated into A's report.
 * passes-after:  Provider in error class → A's key "crash__process_exit__providerA",
 *                B's key "crash__process_exit__providerB" → distinct single-flight slots.
 * no-regression: No provider → key is "type__cause" (existing behavior).
 */
import { describe, expect, it } from 'vitest';
import { errorClassForHealEvidence } from '../../src/core/heal-evidence.ts';
import type { HealEvidenceV1 } from '../../src/core/heal-evidence.ts';

function makeCrashEvidence(overrides: Partial<HealEvidenceV1> = {}): HealEvidenceV1 {
  return {
    schemaVersion: 1 as const,
    type: 'crash',
    source: 'automatic_crash_reporter',
    cause: 'process_exit',
    stage: 'provider_session',
    impact: 'single_session',
    evidenceCoverage: 'crash_classified',
    counts: { occurrences: 1 },
    action: 'restart_provider',
    correlation: 'heal:v1:crash:process_exit',
    ...overrides,
  } as HealEvidenceV1;
}

describe('error class with provider (#2410)', () => {
  it('includes provider in error class when present', () => {
    const ev = makeCrashEvidence({ provider: 'openai' });
    const cls = errorClassForHealEvidence(ev);
    expect(cls).toBe('crash__process_exit__openai');
  });

  it('excludes provider from error class when absent', () => {
    const ev = makeCrashEvidence();
    const cls = errorClassForHealEvidence(ev);
    expect(cls).toBe('crash__process_exit');
  });

  it('different providers produce different error classes', () => {
    const evA = makeCrashEvidence({ provider: 'providerA' });
    const evB = makeCrashEvidence({ provider: 'providerB' });
    expect(errorClassForHealEvidence(evA)).not.toBe(errorClassForHealEvidence(evB));
  });

  it('same provider and crash class produce same error class', () => {
    const ev1 = makeCrashEvidence({ provider: 'openai', cause: 'process_exit' });
    const ev2 = makeCrashEvidence({ provider: 'openai', cause: 'process_exit' });
    expect(errorClassForHealEvidence(ev1)).toBe(errorClassForHealEvidence(ev2));
  });
});
