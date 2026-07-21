import { describe, expect, it } from 'vitest';

import {
  isAdminPhone,
  isE164Wire,
  normalizePhone,
  normalizePhoneE164,
} from '../../src/lib/phone.ts';

describe('isE164Wire', () => {
  it('accepts only canonical plus-prefixed E.164 wire identities', () => {
    expect(isE164Wire('+15550100101')).toBe(true);
    expect(isE164Wire('+155500000000001')).toBe(true);
    expect(isE164Wire('15550100101')).toBe(false);
    expect(isE164Wire('+01234567')).toBe(false);
    expect(isE164Wire('+1 (555) 010-0101')).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('removes formatting and preserves all digits', () => {
    expect(normalizePhone('+1 (555) 010-0101')).toBe('15550100101');
    expect(normalizePhone('555.010.0102')).toBe('5550100102');
  });

  it('returns an empty string for empty runtime inputs', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone(null)).toBe('');
    expect(normalizePhone(undefined)).toBe('');
  });
});

describe('normalizePhoneE164', () => {
  it('prepends country code 1 for 10-digit NANP inputs', () => {
    expect(normalizePhoneE164('5550100103')).toBe('15550100103');
    expect(normalizePhoneE164('(555) 010-0104')).toBe('15550100104');
  });

  it('returns digits-only input unchanged when a country code is already present', () => {
    expect(normalizePhoneE164('+1 (555) 010-0103')).toBe('15550100103');
    expect(normalizePhoneE164('15550100104')).toBe('15550100104');
  });

  it('returns non-NANP lengths as digits only without adding a country code', () => {
    expect(normalizePhoneE164('+44-20-7946-0958')).toBe('442079460958');
    expect(normalizePhoneE164('5551234')).toBe('5551234');
  });
});

describe('isAdminPhone', () => {
  it('matches a non-phone transport identity only by exact value', () => {
    const uuid = '01234567-89ab-cdef-0123-456789abcdef';
    expect(isAdminPhone(uuid, new Set([uuid]))).toBe(true);
    expect(isAdminPhone(`x${uuid}`, new Set([uuid]))).toBe(false);
    const numericUuid = '01234567-8901-2345-6789-012345678901';
    expect(isAdminPhone(numericUuid, new Set([numericUuid]))).toBe(true);
    expect(isAdminPhone(`9${numericUuid}`, new Set([numericUuid]))).toBe(false);
  });

  it('matches exact and normalized admin phones', () => {
    const admins = new Set(['15550100101', '5550100102']);

    expect(isAdminPhone('15550100101', admins)).toBe(true);
    expect(isAdminPhone('+1 (555) 010-0102', admins)).toBe(true);
  });

  it('matches when either side omits the country code', () => {
    expect(isAdminPhone('15550100103', new Set(['5550100103']))).toBe(true);
    expect(isAdminPhone('5550100103', new Set(['15550100103']))).toBe(true);
  });

  it('rejects short input on the normalized suffix-match path', () => {
    expect(isAdminPhone('123456', new Set(['9999999999']))).toBe(false);
    expect(isAdminPhone('15559780919', new Set(['123456']))).toBe(false);
  });

  it('QR-033: the admin check is not a fuzzy suffix match (no privilege escalation)', () => {
    const admins = new Set(['8459780919']); // operator, configured without country code
    // Controls — still admin across country-code formats:
    expect(isAdminPhone('8459780919', admins)).toBe(true);    // exact (CC-less)
    expect(isAdminPhone('18459780919', admins)).toBe(true);   // + NANP country code
    // Escalation vectors that MUST now be rejected:
    expect(isAdminPhone('99999998459780919', admins)).toBe(false); // attacker prepends junk, ends in admin digits
    expect(isAdminPhone('9780919', admins)).toBe(false);           // a short (7-digit) suffix of the admin number
    expect(isAdminPhone('559998459780919', admins)).toBe(false);   // 5 extra leading digits (not a 1-3 digit CC)
    // A real international CC-tolerant pair still matches (<= 3 digit CC):
    expect(isAdminPhone('447911123456', new Set(['447911123456']))).toBe(true); // exact full E.164
    expect(isAdminPhone('447911123456', new Set(['7911123456']))).toBe(true);   // +44 CC (2-digit) tolerance
  });

  it('rejects empty and unrelated phones', () => {
    const admins = new Set(['15550100103']);

    expect(isAdminPhone('', admins)).toBe(false);
    expect(isAdminPhone(null, admins)).toBe(false);
    expect(isAdminPhone('1555010199', admins)).toBe(false);
  });
});
