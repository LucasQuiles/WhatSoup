/**
 * Direct unit coverage for console/src/lib/validation.ts.
 *
 * The module exports two pure helpers used by wizard/edit-modal form validation:
 * - normalizePhoneInput: digit-strip + 10-digit NANP prefix
 * - validatePhone: 10-15 digit range check after normalization
 *
 * The intentional server-side duplicate at src/lib/phone.ts is documented in the
 * module header and tested under tests/lib/phone.test.ts; this file pins the
 * console-side contract independently.
 */
import { describe, expect, it } from 'vitest';
import {
  isE164WireInput,
  normalizePhoneIdentityInput,
  normalizePhoneInput,
  validatePhone,
  validatePhoneIdentityInput,
} from '../../console/src/lib/validation';

describe('isE164WireInput', () => {
  it('accepts only canonical plus-prefixed provider wire identities', () => {
    expect(isE164WireInput('+15551234567')).toBe(true);
    expect(isE164WireInput('+447700900123')).toBe(true);
    expect(isE164WireInput('15551234567')).toBe(false);
    expect(isE164WireInput('+05551234567')).toBe(false);
    expect(isE164WireInput('+1 (555) 123-4567')).toBe(false);
  });
});

describe('normalizePhoneInput', () => {
  it('prepends 1 to a 10-digit NANP string', () => {
    expect(normalizePhoneInput('5551234567')).toBe('15551234567');
  });

  it('leaves an 11-digit string unchanged', () => {
    expect(normalizePhoneInput('15551234567')).toBe('15551234567');
  });

  it('strips formatting characters before checking length', () => {
    expect(normalizePhoneInput('(555) 123-4567')).toBe('15551234567');
    expect(normalizePhoneInput('+1 555.123.4567')).toBe('15551234567');
  });

  it('coerces finite numbers via String()', () => {
    expect(normalizePhoneInput(15551234567)).toBe('15551234567');
  });

  it('returns empty string for nullish, NaN, and non-numeric input', () => {
    expect(normalizePhoneInput(null)).toBe('');
    expect(normalizePhoneInput(undefined)).toBe('');
    expect(normalizePhoneInput('')).toBe('');
    expect(normalizePhoneInput('abc')).toBe('');
    expect(normalizePhoneInput(Number.NaN)).toBe('');
    expect(normalizePhoneInput(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('does not prepend 1 to non-10-digit strings (only the 10-digit case prefixes)', () => {
    expect(normalizePhoneInput('5551234')).toBe('5551234');
    expect(normalizePhoneInput('555123456789')).toBe('555123456789');
  });
});

describe('admin phone identity input', () => {
  it('accepts supported phone formatting and normalizes it to canonical digits', () => {
    expect(validatePhoneIdentityInput('(555) 123-4567')).toBe(true);
    expect(validatePhoneIdentityInput('+44 7700 900123')).toBe(true);
    expect(normalizePhoneIdentityInput('(555) 123-4567')).toBe('15551234567');
  });

  it('fails closed on embedded text and invalid country-code prefixes', () => {
    expect(validatePhoneIdentityInput('privileged-user+15551234567')).toBe(false);
    expect(validatePhoneIdentityInput('+05551234567')).toBe(false);
    expect(normalizePhoneIdentityInput('privileged-user+15551234567')).toBe('');
  });
});

describe('validatePhone', () => {
  it('accepts 10-digit input (becomes 11 digits after normalization)', () => {
    expect(validatePhone('5551234567')).toBe(true);
  });

  it('accepts 11-digit international-format input', () => {
    expect(validatePhone('15551234567')).toBe(true);
  });

  it('accepts boundaries at 10 and 15 digits', () => {
    expect(validatePhone('123456789012')).toBe(true);
    expect(validatePhone('123456789012345')).toBe(true);
  });

  it('rejects fewer than 10 digits after normalization', () => {
    expect(validatePhone('123')).toBe(false);
    expect(validatePhone('123456789')).toBe(false);
  });

  it('rejects more than 15 digits after normalization', () => {
    expect(validatePhone('1234567890123456')).toBe(false);
  });

  it('rejects nullish + non-numeric input', () => {
    expect(validatePhone(null)).toBe(false);
    expect(validatePhone(undefined)).toBe(false);
    expect(validatePhone('')).toBe(false);
    expect(validatePhone('abc')).toBe(false);
    expect(validatePhone(Number.NaN)).toBe(false);
  });
});
