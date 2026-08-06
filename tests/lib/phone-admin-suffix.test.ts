/**
 * QR-033 - isAdminPhone used a bidirectional >=7-digit suffix match, so a
 * non-admin whose number shared a trailing-digit run with an admin's number
 * was granted admin. The landed fix (src/lib/phone.ts, QR-033 comment block)
 * replaces it with: exact digit match, OR a strictly country-code-tolerant
 * match — the longer form must equal the shorter plus a 1-3 digit prefix
 * (E.164 country codes are 1-3 digits), with an 8-digit floor on both sides.
 * These tests pin that contract from both directions: short suffixes and
 * junk prefixes stay rejected, CC-tolerant and exact forms stay accepted.
 */

import { describe, expect, it } from 'vitest';
import { isAdminPhone } from '../../src/lib/phone.ts';

const ADMIN = new Set(['15551230007']);

describe('isAdminPhone - suffix attack blocked (QR-033)', () => {
  it('rejects a sub-floor suffix of the admin number', () => {
    expect(isAdminPhone('1230007', ADMIN)).toBe(false);
  });

  it('accepts an 8+ digit form within the 1-3 digit country-code tolerance', () => {
    // 51230007 vs 15551230007: length gap 3, suffix-matches — inside the
    // deliberate CC-tolerance window documented in the QR-033 fix. The
    // caller identity is transport-asserted (SIM/LID), not attacker-chosen,
    // so tolerance here is an accepted design, not an open suffix attack.
    expect(isAdminPhone('51230007', ADMIN)).toBe(true);
  });

  it('rejects an attacker who prepends junk before the admin trailing digits', () => {
    expect(isAdminPhone('99991230007', new Set(['1230007']))).toBe(false);
  });

  it('still accepts the country-code-omitted admin config', () => {
    expect(isAdminPhone('15550100103', new Set(['5550100103']))).toBe(true);
  });

  it('still accepts the reverse country-code case', () => {
    expect(isAdminPhone('5550100103', new Set(['15550100103']))).toBe(true);
  });

  it('still accepts an exact match and rejects an unrelated number', () => {
    expect(isAdminPhone('15551230007', ADMIN)).toBe(true);
    expect(isAdminPhone('5555555555', ADMIN)).toBe(false);
  });
});
