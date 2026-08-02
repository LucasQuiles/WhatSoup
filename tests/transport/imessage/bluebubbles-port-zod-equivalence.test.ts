// tests/transport/imessage/bluebubbles-port-zod-equivalence.test.ts
//
// Equivalence net for Refs #2203 (tranche 3, Tier A): the module-private
// cursor-decoding guard `decodeCursor` in
// `src/transport/imessage/bluebubbles-port.ts` moves its shape-validation
// ladder to a Zod schema. The verbatim pre-conversion ladder (plus its
// `isSafeNonNegativeInteger` helper, still used elsewhere in the source file
// and left untouched) is kept below as the reference implementation; every
// case asserts the reference verdict AND the observable verdict through the
// public seam (`BlueBubblesPort.listInboundSince`, the only caller of
// `decodeCursor`), so the conversion cannot widen or narrow the accepted
// value space.
//
// `decodeCursor` THROWS on rejection (unlike the null-returning guards in
// the other three tranche-3 files) — this is preserved exactly; the equivalence
// net asserts the thrown `BadCursor`/400 shape.
//
// Observation strategy: `listInboundSince` calls `decodeCursor(cursor)`
// synchronously before any HTTP request when `cursor !== null`. A rejected
// cursor throws `{code: 'BadCursor', status: 400}` immediately. An accepted
// cursor lets the flow proceed to an HTTP call that the minimal mock client
// below has no handler for, which throws `{code: 'Unmocked'}` instead — a
// distinguishable, non-BadCursor rejection that proves decode succeeded
// without requiring a full HTTP mock for every accepted shape.

import { describe, it, expect } from 'vitest';
import { BlueBubblesPort, type BlueBubblesHttpClient, type BlueBubblesHttpRequest } from '../../../src/transport/imessage/bluebubbles-port.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig } from '../../../src/transport/imessage/types.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize these — they define the value space the Zod schema must
// reproduce exactly.
const BB_CURSOR_PREFIX = 'bb1:';

interface RefBbCursorState {
  readonly version: 1;
  readonly afterRowId: number;
  readonly upperRowId: number | null;
  readonly bootstrapAfterMs: number | null;
}

function referenceIsSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function referenceDecodeCursor(cursor: string): { ok: true; state: RefBbCursorState } | { ok: false } {
  if (!cursor.startsWith(BB_CURSOR_PREFIX)) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(BB_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const state = parsed as Partial<RefBbCursorState> | null;
  if (state === null
    || state.version !== 1
    || !referenceIsSafeNonNegativeInteger(state.afterRowId)
    || (state.upperRowId !== null && !referenceIsSafeNonNegativeInteger(state.upperRowId))
    || (state.bootstrapAfterMs !== null && !referenceIsSafeNonNegativeInteger(state.bootstrapAfterMs))) {
    return { ok: false };
  }
  return {
    ok: true,
    state: {
      version: 1,
      afterRowId: state.afterRowId,
      upperRowId: state.upperRowId,
      bootstrapAfterMs: state.bootstrapAfterMs,
    },
  };
}

function makeCursorFrom(payload: unknown): string {
  return BB_CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

class MinimalMockHttpClient {
  client: BlueBubblesHttpClient = async (_req: BlueBubblesHttpRequest) => {
    throw Object.assign(new Error('unmocked'), { code: 'Unmocked' });
  };
}

function makeConfig(): ImessageConfig {
  return {
    ...DEFAULT_IMESSAGE,
    account: 'test',
    backend: 'bluebubbles',
    bluebubblesUrl: 'https://bb.example.test',
    bluebubblesPassword: 'pw',
    sender: 'me@users.noreply.github.com',
  };
}

/** Returns 'accepted' if decodeCursor did not throw BadCursor (flow moved
 *  past decode into the HTTP layer, which is unmocked and throws a
 *  distinguishable error), or the thrown BadCursor error shape otherwise. */
async function observeDecode(cursor: string): Promise<'accepted' | { code: unknown; status: unknown }> {
  const mock = new MinimalMockHttpClient();
  const port = new BlueBubblesPort(makeConfig(), mock.client);
  try {
    await port.listInboundSince(new Date(0), undefined, cursor);
    return 'accepted';
  } catch (err) {
    const e = err as { code?: unknown; status?: unknown };
    if (e.code === 'BadCursor') return { code: e.code, status: e.status };
    return 'accepted';
  }
}

interface Case {
  name: string;
  cursor: string;
  accepted: boolean;
}

const cases: Case[] = [
  // Accepted shapes.
  { name: 'minimal valid state (upperRowId/bootstrapAfterMs null)', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), accepted: true },
  { name: 'afterRowId nonzero with numeric upperRowId', cursor: makeCursorFrom({ version: 1, afterRowId: 5, upperRowId: 10, bootstrapAfterMs: null }), accepted: true },
  { name: 'bootstrapAfterMs = 0 (nonnegative, falsy)', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: 0 }), accepted: true },
  { name: 'all fields at MAX_SAFE_INTEGER', cursor: makeCursorFrom({ version: 1, afterRowId: Number.MAX_SAFE_INTEGER, upperRowId: Number.MAX_SAFE_INTEGER, bootstrapAfterMs: Number.MAX_SAFE_INTEGER }), accepted: true },
  { name: 'extra unknown top-level key tolerated', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: null, extra: 'x' }), accepted: true },
  // Prefix rejections.
  { name: 'missing bb1: prefix entirely', cursor: 'not-a-cursor', accepted: false },
  { name: 'wrong prefix (imsg1: instead of bb1:)', cursor: 'imsg1:' + Buffer.from(JSON.stringify({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), 'utf8').toString('base64url'), accepted: false },
  { name: 'empty string cursor', cursor: '', accepted: false },
  // Parse-error rejections.
  { name: 'prefix + base64url of non-JSON text', cursor: BB_CURSOR_PREFIX + Buffer.from('not json', 'utf8').toString('base64url'), accepted: false },
  { name: 'prefix + empty payload', cursor: BB_CURSOR_PREFIX, accepted: false },
  // Top-level shape rejections.
  { name: 'top-level null', cursor: makeCursorFrom(null), accepted: false },
  { name: 'top-level array', cursor: makeCursorFrom([1, 2]), accepted: false },
  { name: 'top-level string', cursor: makeCursorFrom('x'), accepted: false },
  { name: 'top-level number', cursor: makeCursorFrom(42), accepted: false },
  // version rejections.
  { name: 'version missing', cursor: makeCursorFrom({ afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'version = 2', cursor: makeCursorFrom({ version: 2, afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'version = 0', cursor: makeCursorFrom({ version: 0, afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'version wrong type (string "1")', cursor: makeCursorFrom({ version: '1', afterRowId: 0, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  // afterRowId rejections.
  { name: 'afterRowId missing', cursor: makeCursorFrom({ version: 1, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'afterRowId negative', cursor: makeCursorFrom({ version: 1, afterRowId: -1, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'afterRowId fractional', cursor: makeCursorFrom({ version: 1, afterRowId: 1.5, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'afterRowId unsafe integer (2**60) trap case', cursor: makeCursorFrom({ version: 1, afterRowId: 2 ** 60, upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  { name: 'afterRowId wrong type (string)', cursor: makeCursorFrom({ version: 1, afterRowId: '5', upperRowId: null, bootstrapAfterMs: null }), accepted: false },
  // upperRowId rejections (must be present: null or a valid integer).
  { name: 'upperRowId missing entirely (rejected, not treated as null)', cursor: makeCursorFrom({ version: 1, afterRowId: 0, bootstrapAfterMs: null }), accepted: false },
  { name: 'upperRowId negative', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: -1, bootstrapAfterMs: null }), accepted: false },
  { name: 'upperRowId fractional', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: 1.5, bootstrapAfterMs: null }), accepted: false },
  { name: 'upperRowId unsafe integer (2**60) trap case', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: 2 ** 60, bootstrapAfterMs: null }), accepted: false },
  { name: 'upperRowId wrong type (string)', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: '10', bootstrapAfterMs: null }), accepted: false },
  // bootstrapAfterMs rejections (must be present: null or a valid integer).
  { name: 'bootstrapAfterMs missing entirely (rejected, not treated as null)', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null }), accepted: false },
  { name: 'bootstrapAfterMs negative', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: -1 }), accepted: false },
  { name: 'bootstrapAfterMs fractional', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: 1.5 }), accepted: false },
  { name: 'bootstrapAfterMs unsafe integer (2**60) trap case', cursor: makeCursorFrom({ version: 1, afterRowId: 0, upperRowId: null, bootstrapAfterMs: 2 ** 60 }), accepted: false },
];

describe('decodeCursor equivalence (observed through BlueBubblesPort.listInboundSince)', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, async () => {
      // The table must encode exactly what the pre-conversion ladder decided.
      const ref = referenceDecodeCursor(c.cursor);
      expect(ref.ok).toBe(c.accepted);

      const observed = await observeDecode(c.cursor);
      if (c.accepted) {
        expect(observed).toBe('accepted');
      } else {
        expect(observed).toEqual({ code: 'BadCursor', status: 400 });
      }
    });
  }
});
