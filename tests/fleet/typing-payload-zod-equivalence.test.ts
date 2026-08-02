// tests/fleet/typing-payload-zod-equivalence.test.ts
//
// Equivalence net for #2203: the exported `isTypingHealthEntry` guard in
// `src/fleet/typing-payload.ts` moves from a hand-rolled typeof ladder to a
// Zod schema. The verbatim pre-conversion ladder is kept below as the
// reference implementation; every case asserts the reference verdict AND
// the live export's verdict, so the conversion cannot widen or narrow the
// accepted value space. `isTypingHealthEntry` is itself the public seam
// (unlike the module-private guards elsewhere in #2203), so cases call it
// directly rather than round-tripping through JSON — this is also why NaN
// and +/-Infinity are representable here even though they are not
// JSON-serializable, and the previous `tests/fleet/typing-payload.test.ts`
// coverage (including its Infinity cases) is ported case-for-case below.

import { describe, expect, it } from 'vitest';
import { isTypingHealthEntry } from '../../src/fleet/typing-payload.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize this — it defines the value space the Zod schema must
// reproduce exactly.
function referenceIsTypingHealthEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;

  const candidate = entry as { jid?: unknown; since?: unknown };
  return (
    typeof candidate.jid === 'string'
    && candidate.jid.trim().length > 0
    && typeof candidate.since === 'number'
    && Number.isFinite(candidate.since)
  );
}

interface Case {
  name: string;
  value: unknown;
  accepted: boolean;
}

const cases: Case[] = [
  // Valid shapes.
  { name: 'minimal { jid, since } object', value: { jid: '15551234567@s.whatsapp.net', since: 1_700_000_000_000 }, accepted: true },
  { name: 'since = 0 (finite, falsy)', value: { jid: 'x', since: 0 }, accepted: true },
  { name: 'extra keys tolerated (passthrough semantics)', value: { jid: 'x', since: 1, extra: 'ok' }, accepted: true },
  // Non-object roots.
  { name: 'null', value: null, accepted: false },
  { name: 'undefined', value: undefined, accepted: false },
  { name: 'string primitive', value: 'jid', accepted: false },
  { name: 'number primitive', value: 42, accepted: false },
  { name: 'boolean primitive', value: true, accepted: false },
  { name: 'empty array', value: [], accepted: false },
  { name: 'array of primitives', value: ['x', 1], accepted: false },
  // Invalid jid.
  { name: 'missing jid', value: { since: 1 }, accepted: false },
  { name: 'empty-string jid', value: { jid: '', since: 1 }, accepted: false },
  { name: 'whitespace-only jid (spaces)', value: { jid: '   ', since: 1 }, accepted: false },
  { name: 'whitespace-only jid (tab/newline)', value: { jid: '\t\n', since: 1 }, accepted: false },
  { name: 'jid preserved untrimmed on acceptance (guard must not mutate the value)', value: { jid: '  15551234567@s.whatsapp.net  ', since: 1 }, accepted: true },
  { name: 'non-string jid (number)', value: { jid: 123, since: 1 }, accepted: false },
  { name: 'non-string jid (null)', value: { jid: null, since: 1 }, accepted: false },
  { name: 'non-string jid (object)', value: { jid: {}, since: 1 }, accepted: false },
  // Invalid since.
  { name: 'missing since', value: { jid: 'x' }, accepted: false },
  { name: 'non-number since (string)', value: { jid: 'x', since: '1' }, accepted: false },
  { name: 'non-number since (null)', value: { jid: 'x', since: null }, accepted: false },
  { name: 'NaN since (non-finite) trap case', value: { jid: 'x', since: Number.NaN }, accepted: false },
  { name: 'POSITIVE_INFINITY since (non-finite) trap case', value: { jid: 'x', since: Number.POSITIVE_INFINITY }, accepted: false },
  { name: 'NEGATIVE_INFINITY since (non-finite) trap case', value: { jid: 'x', since: Number.NEGATIVE_INFINITY }, accepted: false },
];

describe('isTypingHealthEntry equivalence', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, () => {
      // The table must encode exactly what the pre-conversion ladder decided.
      expect(referenceIsTypingHealthEntry(c.value)).toBe(c.accepted);
      expect(isTypingHealthEntry(c.value)).toBe(c.accepted);
    });
  }

  it('does not mutate the input value (jid must stay untrimmed for downstream callers)', () => {
    const raw = { jid: '  peer  ', since: 1 };
    expect(isTypingHealthEntry(raw)).toBe(true);
    expect(raw.jid).toBe('  peer  ');
  });

  it('narrows `unknown` to TypingHealthEntry when true', () => {
    const raw: unknown = { jid: 'peer', since: 1_000 };
    if (isTypingHealthEntry(raw)) {
      // If the guard truly narrowed, `.jid` and `.since` must be typed.
      const jid: string = raw.jid;
      const since: number = raw.since;
      expect(jid).toBe('peer');
      expect(since).toBe(1_000);
    } else {
      throw new Error('expected guard to accept valid shape');
    }
  });
});
