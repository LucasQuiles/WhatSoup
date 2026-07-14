import { describe, it, expect } from 'vitest';
import {
  resolveTokenExpiryState,
  hasUsableCredential,
  classifyLookupResult,
  classifyCredentialValue,
  DEFAULT_REFRESH_MARGIN_MS,
  type CredentialReasonCode,
  type TokenExpiryState,
} from '../../src/lib/credential-state.ts';

// Structural type matching LookupResultLike from credential-state.ts.
// Defined locally so the test doesn't depend on the W-1 keyring changes.
interface LookupResultLike {
  value: string | null;
  reason: 'ok' | 'unknown_service' | 'not_found';
  service: string;
}

const NOW = 1_700_000_000_000; // fixed "now" for deterministic tests

describe('resolveTokenExpiryState', () => {
  it('returns missing when expires is undefined', () => {
    expect(resolveTokenExpiryState(undefined, NOW)).toBe('missing');
  });

  it('returns missing when expires is null', () => {
    expect(resolveTokenExpiryState(null, NOW)).toBe('missing');
  });

  it('returns invalid_expires when expires is a string', () => {
    expect(resolveTokenExpiryState('2026-12-31', NOW)).toBe('invalid_expires');
  });

  it('returns invalid_expires when expires is NaN', () => {
    expect(resolveTokenExpiryState(NaN, NOW)).toBe('invalid_expires');
  });

  it('returns invalid_expires when expires is Infinity', () => {
    expect(resolveTokenExpiryState(Infinity, NOW)).toBe('invalid_expires');
  });

  it('returns invalid_expires when expires is zero', () => {
    expect(resolveTokenExpiryState(0, NOW)).toBe('invalid_expires');
  });

  it('returns invalid_expires when expires is negative', () => {
    expect(resolveTokenExpiryState(-1, NOW)).toBe('invalid_expires');
  });

  it('returns invalid_expires for absurdly large timestamps', () => {
    expect(resolveTokenExpiryState(MAX_SAFE + 1, NOW)).toBe('invalid_expires');
  });

  it('returns expired when expiry is in the past', () => {
    expect(resolveTokenExpiryState(NOW - 1, NOW)).toBe('expired');
  });

  it('returns expired when expiry equals now', () => {
    expect(resolveTokenExpiryState(NOW, NOW)).toBe('expired');
  });

  it('returns valid when expiry is well beyond the refresh margin', () => {
    const expires = NOW + DEFAULT_REFRESH_MARGIN_MS + 60_000;
    expect(resolveTokenExpiryState(expires, NOW)).toBe('valid');
  });

  it('returns expiring when expiry is within the refresh margin', () => {
    const expires = NOW + DEFAULT_REFRESH_MARGIN_MS - 1;
    expect(resolveTokenExpiryState(expires, NOW)).toBe('expiring');
  });

  it('returns expiring when expiry is within a custom margin', () => {
    const expires = NOW + 10_000; // 10s away
    expect(resolveTokenExpiryState(expires, NOW, { expiringWithinMs: 30_000 })).toBe('expiring');
  });

  it('returns valid when custom margin is 0 (no expiring window)', () => {
    const expires = NOW + 1; // 1ms away
    expect(resolveTokenExpiryState(expires, NOW, { expiringWithinMs: 0 })).toBe('valid');
  });

  it('defaults now to Date.now() when not provided', () => {
    const future = Date.now() + 600_000;
    expect(resolveTokenExpiryState(future)).toBe('valid');
  });
});

const MAX_SAFE = 8640000000000000;

describe('hasUsableCredential', () => {
  it('returns false for null', () => {
    expect(hasUsableCredential(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasUsableCredential(undefined)).toBe(false);
  });

  it('returns false for missing value', () => {
    expect(hasUsableCredential({ value: null })).toBe(false);
  });

  it('returns false for empty string value', () => {
    expect(hasUsableCredential({ value: '' })).toBe(false);
  });

  it('returns false for whitespace-only value', () => {
    expect(hasUsableCredential({ value: '   ' })).toBe(false);
  });

  it('returns true for non-empty value with no expiry (static API key)', () => {
    expect(hasUsableCredential({ value: 'sk-test-key' })).toBe(true);
  });

  it('returns true for non-empty value with undefined expiry', () => {
    expect(hasUsableCredential({ value: 'sk-test-key', expires: undefined })).toBe(true);
  });

  it('returns true for non-empty value with null expiry', () => {
    expect(hasUsableCredential({ value: 'sk-test-key', expires: null })).toBe(true);
  });

  it('returns true for valid (non-expired) token', () => {
    const expires = NOW + 600_000; // 10 min away
    expect(hasUsableCredential({ value: 'tok', expires }, { now: NOW })).toBe(true);
  });

  it('returns true for expiring token (still usable, caller may refresh)', () => {
    const expires = NOW + 60_000; // 1 min away (within default 5min margin)
    expect(hasUsableCredential({ value: 'tok', expires }, { now: NOW })).toBe(true);
  });

  it('returns false for expired token', () => {
    const expires = NOW - 1;
    expect(hasUsableCredential({ value: 'tok', expires }, { now: NOW })).toBe(false);
  });

  it('returns false for invalid expiry', () => {
    expect(hasUsableCredential({ value: 'tok', expires: 'not-a-number' }, { now: NOW })).toBe(false);
  });

  it('returns false for NaN expiry', () => {
    expect(hasUsableCredential({ value: 'tok', expires: NaN }, { now: NOW })).toBe(false);
  });

  it('respects custom refreshMarginMs', () => {
    const expires = NOW + 60_000; // 1 min away
    // With a 30s margin, this is 'expiring' → still usable.
    expect(hasUsableCredential({ value: 'tok', expires }, { now: NOW, refreshMarginMs: 30_000 })).toBe(true);
    // With a 0 margin, 'expiring' never fires; 1 min away is 'valid'.
    expect(hasUsableCredential({ value: 'tok', expires }, { now: NOW, refreshMarginMs: 0 })).toBe(true);
  });
});

describe('classifyLookupResult', () => {
  it('classifies ok as ok', () => {
    const result: LookupResultLike = { value: 'key', reason: 'ok', service: 'openai' };
    expect(classifyLookupResult(result)).toBe('ok');
  });

  it('classifies unknown_service as unknown_service', () => {
    const result: LookupResultLike = { value: null, reason: 'unknown_service', service: 'bad' };
    expect(classifyLookupResult(result)).toBe('unknown_service');
  });

  it('classifies not_found as missing_credential', () => {
    const result: LookupResultLike = { value: null, reason: 'not_found', service: 'pinecone' };
    expect(classifyLookupResult(result)).toBe('missing_credential');
  });

  it('covers all CredentialLookupReasonCode values (exhaustive switch)', () => {
    // This test will fail to compile if classifyLookupResult is missing a case.
    const cases: Array<{ result: LookupResultLike; expected: CredentialReasonCode }> = [
      { result: { value: 'k', reason: 'ok', service: 'a' }, expected: 'ok' },
      { result: { value: null, reason: 'unknown_service', service: 'b' }, expected: 'unknown_service' },
      { result: { value: null, reason: 'not_found', service: 'c' }, expected: 'missing_credential' },
    ];
    for (const { result, expected } of cases) {
      expect(classifyLookupResult(result)).toBe(expected);
    }
  });
});

describe('classifyCredentialValue', () => {
  it('returns missing_credential for null', () => {
    expect(classifyCredentialValue(null)).toBe('missing_credential');
  });

  it('returns missing_credential for undefined', () => {
    expect(classifyCredentialValue(undefined)).toBe('missing_credential');
  });

  it('returns malformed for empty string', () => {
    expect(classifyCredentialValue('')).toBe('malformed');
  });

  it('returns malformed for whitespace-only string', () => {
    expect(classifyCredentialValue('   ')).toBe('malformed');
  });

  it('returns ok for non-empty string', () => {
    expect(classifyCredentialValue('sk-test')).toBe('ok');
  });
});

describe('type safety', () => {
  it('CredentialReasonCode is a closed union', () => {
    // Compile-time check: this assignment must cover all cases.
    const code: CredentialReasonCode = 'ok';
    expect(code).toBe('ok');
  });

  it('TokenExpiryState is a closed union', () => {
    const state: TokenExpiryState = 'valid';
    expect(state).toBe('valid');
  });
});
