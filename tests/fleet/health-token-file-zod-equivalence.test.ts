// tests/fleet/health-token-file-zod-equivalence.test.ts
//
// Equivalence net for #2203: `isCanonicalHealthToken` in
// `src/fleet/health-token-file.ts` moves from a hand-rolled typeof ladder to a
// Zod schema. The verbatim pre-conversion ladder is kept below as the
// reference implementation. Because the guard is a plain string check
// (`z.string().regex(...)` vs `typeof value === 'string' && RE.test(value)`),
// equivalence here is exact over arbitrary JavaScript values, including host
// objects — every case asserts both verdicts match.

import { describe, it, expect } from 'vitest';
import {
  isCanonicalHealthToken,
  parseCanonicalHealthTokenFile,
} from '../../src/fleet/health-token-file.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize this — it defines the value space the Zod schema must
// reproduce exactly.
const CANONICAL_HEALTH_TOKEN_RE = /^[0-9a-f]{64}$/;

function referenceIsCanonicalHealthToken(value: unknown): boolean {
  return typeof value === 'string' && CANONICAL_HEALTH_TOKEN_RE.test(value);
}

const TOKEN = 'a'.repeat(64);

interface Case {
  name: string;
  value: unknown;
  accepted: boolean;
}

const cases: Case[] = [
  { name: 'canonical 64-hex lowercase', value: TOKEN, accepted: true },
  { name: 'mixed digits and letters, 64-hex', value: `0123456789abcdef${'0'.repeat(48)}`, accepted: true },
  { name: 'uppercase hex', value: 'A'.repeat(64), accepted: false },
  { name: '63-hex (too short)', value: 'a'.repeat(63), accepted: false },
  { name: '65-hex (too long)', value: 'a'.repeat(65), accepted: false },
  { name: 'empty string', value: '', accepted: false },
  { name: 'non-hex characters', value: 'g'.repeat(64), accepted: false },
  { name: 'canonical with trailing newline', value: `${TOKEN}\n`, accepted: false },
  { name: 'canonical with leading space', value: ` ${TOKEN}`, accepted: false },
  { name: 'number', value: 42, accepted: false },
  { name: 'null', value: null, accepted: false },
  { name: 'undefined', value: undefined, accepted: false },
  { name: 'boolean', value: true, accepted: false },
  { name: 'plain object', value: {}, accepted: false },
  { name: 'array wrapping a canonical token', value: [TOKEN], accepted: false },
  { name: 'String object wrapping a canonical token', value: new String(TOKEN), accepted: false },
  { name: 'Date instance', value: new Date(0), accepted: false },
  { name: 'function', value: () => TOKEN, accepted: false },
];

describe('isCanonicalHealthToken equivalence', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, () => {
      // The table must encode exactly what the pre-conversion ladder decided.
      expect(referenceIsCanonicalHealthToken(c.value)).toBe(c.accepted);
      expect(isCanonicalHealthToken(c.value)).toBe(c.accepted);
    });
  }
});

describe('parseCanonicalHealthTokenFile still routes through the guard', () => {
  it('accepts the canonical single-assignment file with trailing newline', () => {
    expect(parseCanonicalHealthTokenFile(`WHATSOUP_HEALTH_TOKEN=${TOKEN}\n`)).toBe(TOKEN);
  });

  it('accepts the canonical single-assignment file without trailing newline', () => {
    expect(parseCanonicalHealthTokenFile(`WHATSOUP_HEALTH_TOKEN=${TOKEN}`)).toBe(TOKEN);
  });

  it('rejects a malformed token payload', () => {
    expect(parseCanonicalHealthTokenFile(`WHATSOUP_HEALTH_TOKEN=${'A'.repeat(64)}\n`)).toBeNull();
  });

  it('rejects a second line', () => {
    expect(parseCanonicalHealthTokenFile(`WHATSOUP_HEALTH_TOKEN=${TOKEN}\nEXTRA=1\n`)).toBeNull();
  });

  it('rejects a wrong prefix', () => {
    expect(parseCanonicalHealthTokenFile(`OTHER_TOKEN=${TOKEN}\n`)).toBeNull();
  });
});
