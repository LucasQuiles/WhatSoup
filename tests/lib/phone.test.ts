import { describe, expect, it } from 'vitest';

import { isAdminPhone, normalizePhone, normalizePhoneE164 } from '../../src/lib/phone.ts';

describe('normalizePhone', () => {
  it('removes formatting and preserves all digits', () => {
    expect(normalizePhone('+1 (555) 588-0337')).toBe('15555880337');
    expect(normalizePhone('555.978.0919')).toBe('5559780919');
  });

  it('returns an empty string for empty runtime inputs', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('normalizePhoneE164', () => {
  it('prepends country code 1 for 10-digit NANP inputs', () => {
    expect(normalizePhoneE164('5559780919')).toBe('15559780919');
    expect(normalizePhoneE164('(555) 588-0337')).toBe('15555880337');
  });

  it('returns digits-only input unchanged when a country code is already present', () => {
    expect(normalizePhoneE164('+1 (555) 978-0919')).toBe('15559780919');
    expect(normalizePhoneE164('15555880337')).toBe('15555880337');
  });

  it('returns non-NANP lengths as digits only without adding a country code', () => {
    expect(normalizePhoneE164('+44-20-7946-0958')).toBe('442079460958');
    expect(normalizePhoneE164('5551234')).toBe('5551234');
  });
});

describe('isAdminPhone', () => {
  it('matches exact and normalized admin phones', () => {
    const admins = new Set(['15555880337', '5559780919']);

    expect(isAdminPhone('15555880337', admins)).toBe(true);
    expect(isAdminPhone('+1 (555) 978-0919', admins)).toBe(true);
  });

  it('matches when either side omits the country code', () => {
    expect(isAdminPhone('15559780919', new Set(['5559780919']))).toBe(true);
    expect(isAdminPhone('5559780919', new Set(['15559780919']))).toBe(true);
  });

  it('rejects short input on the normalized suffix-match path', () => {
    expect(isAdminPhone('123456', new Set(['9999999999']))).toBe(false);
    expect(isAdminPhone('15559780919', new Set(['123456']))).toBe(false);
  });

  it('rejects empty and unrelated phones', () => {
    const admins = new Set(['15559780919']);

    expect(isAdminPhone('', admins)).toBe(false);
    expect(isAdminPhone(null, admins)).toBe(false);
    expect(isAdminPhone('15559991234', admins)).toBe(false);
  });
});
