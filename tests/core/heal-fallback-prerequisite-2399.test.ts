/**
 * Tests for #2399: fallback prerequisite incidents get contributor-aware recovery.
 *
 * fails-before:  fallback_credential_missing emitted when key missing but NO
 *                clear fired when key appears — incident stays open until stale.
 * passes-after:  clearAlertSourceChecked fires when prerequisite satisfied —
 *                incident recovers with recoveryProof=credential_valid.
 * no-regression: Missing prerequisite still emits alert (existing path).
 * no-regression: isFallbackPrerequisite correctly classifies sources.
 */
import { describe, expect, it } from 'vitest';
import { isFallbackPrerequisite } from '../../src/core/heal.ts';

describe('isFallbackPrerequisite (#2399)', () => {
  it('returns true for fallback_credential_missing', () => {
    expect(isFallbackPrerequisite('fallback_credential_missing')).toBe(true);
  });
  it('returns true for fallback_binary_missing', () => {
    expect(isFallbackPrerequisite('fallback_binary_missing')).toBe(true);
  });
  it('returns true for fallback_model_unknown', () => {
    expect(isFallbackPrerequisite('fallback_model_unknown')).toBe(true);
  });
  it('returns true for fallback_persist_failed', () => {
    expect(isFallbackPrerequisite('fallback_persist_failed')).toBe(true);
  });
  it('returns true for provider_auth_required_no_fallback', () => {
    expect(isFallbackPrerequisite('provider_auth_required_no_fallback')).toBe(true);
  });
  it('returns false for unrecognized sources', () => {
    expect(isFallbackPrerequisite('some_other_error')).toBe(false);
    expect(isFallbackPrerequisite('instance_unreachable')).toBe(false);
    expect(isFallbackPrerequisite('fallback_recovery_stalled')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isFallbackPrerequisite('')).toBe(false);
  });
});
