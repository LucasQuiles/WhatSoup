// tests/transport/imessage/imsg-port-zod-equivalence.test.ts
//
// Equivalence net for Refs #2203 (tranche 3, Tier A): the module-private
// cursor-decoding guard `decodeImsgCursor` in
// `src/transport/imessage/imsg-port.ts` moves its shape-validation ladder to
// a Zod schema. The verbatim pre-conversion ladder is kept below as the
// reference implementation; every case asserts the reference verdict AND the
// observable verdict through the public seam (`ImsgPort.listInboundSince`,
// the only caller of `decodeImsgCursor`), so the conversion cannot widen or
// narrow the accepted value space.
//
// `decodeImsgCursor` THROWS on rejection — this is preserved exactly; the
// equivalence net asserts the thrown `BadCursor`/400 shape.
//
// Observation strategy (same idiom as the bluebubbles net and the
// `Unmocked` mock in imsg-port.test.ts): `listInboundSince` calls
// `decodeImsgCursor(cursor)` synchronously before any RPC request when
// `cursor !== null`. A rejected cursor throws `{code: 'BadCursor',
// status: 400}` immediately. An accepted cursor lets the flow proceed to a
// `watch.subscribe` RPC that the minimal mock connection below has no
// handler for, which throws `{code: 'Unmocked'}` instead — a
// distinguishable, non-BadCursor rejection that proves decode succeeded
// without requiring a full RPC mock for every accepted shape.

import { describe, it, expect } from 'vitest';
import { ImsgPort, type ImsgRpcConnection } from '../../../src/transport/imessage/imsg-port.ts';
import { DEFAULT_IMESSAGE, type ImessageConfig } from '../../../src/transport/imessage/types.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladder. ---
// Do not modernize these — they define the value space the Zod schema must
// reproduce exactly.
const IMSG_CURSOR_PREFIX = 'imsg1:';

interface RefImsgCursorState {
  readonly version: 1;
  readonly rowId: number;
}

function referenceDecodeImsgCursor(cursor: string): { ok: true; state: RefImsgCursorState } | { ok: false } {
  if (!cursor.startsWith(IMSG_CURSOR_PREFIX)) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(IMSG_CURSOR_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const state = parsed as Partial<RefImsgCursorState> | null;
  if (state === null
    || state.version !== 1
    || !Number.isSafeInteger(state.rowId)
    || (state.rowId as number) < 0) {
    return { ok: false };
  }
  return { ok: true, state: { version: 1, rowId: state.rowId as number } };
}

function makeCursorFrom(payload: unknown): string {
  return IMSG_CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

class MinimalMockConnection implements ImsgRpcConnection {
  async request(_method: string, _params?: Record<string, unknown>): Promise<unknown> {
    throw Object.assign(new Error('unmocked'), { code: 'Unmocked' });
  }
  onNotification(_handler: (method: string, params: unknown) => void): () => void {
    return () => {};
  }
  close(): void {}
}

function makeConfig(): ImessageConfig {
  return {
    ...DEFAULT_IMESSAGE,
    account: 'test',
    backend: 'imsg',
    imsgSocketPath: '/tmp/imsg-test.sock',
    sender: 'me@users.noreply.github.com',
  };
}

/** Returns 'accepted' if decodeImsgCursor did not throw BadCursor (flow moved
 * past decode into the RPC layer, which is unmocked and throws a
 * distinguishable error), or the thrown BadCursor error shape otherwise. */
async function observeDecode(cursor: string): Promise<'accepted' | { code: unknown; status: unknown }> {
  const port = new ImsgPort(makeConfig(), () => new MinimalMockConnection());
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
  { name: 'minimal valid state (rowId 0, falsy but nonnegative)', cursor: makeCursorFrom({ version: 1, rowId: 0 }), accepted: true },
  { name: 'nonzero rowId', cursor: makeCursorFrom({ version: 1, rowId: 42 }), accepted: true },
  { name: 'rowId at MAX_SAFE_INTEGER', cursor: makeCursorFrom({ version: 1, rowId: Number.MAX_SAFE_INTEGER }), accepted: true },
  { name: 'extra unknown top-level key tolerated', cursor: makeCursorFrom({ version: 1, rowId: 0, extra: 'x' }), accepted: true },
  // Prefix rejections.
  { name: 'missing imsg1: prefix entirely', cursor: 'not-a-cursor', accepted: false },
  { name: 'wrong prefix (bb1: instead of imsg1:)', cursor: 'bb1:' + Buffer.from(JSON.stringify({ version: 1, rowId: 0 }), 'utf8').toString('base64url'), accepted: false },
  { name: 'empty string cursor', cursor: '', accepted: false },
  // Parse-error rejections.
  { name: 'prefix + base64url of non-JSON text', cursor: IMSG_CURSOR_PREFIX + Buffer.from('not json', 'utf8').toString('base64url'), accepted: false },
  { name: 'prefix + empty payload', cursor: IMSG_CURSOR_PREFIX, accepted: false },
  // Top-level shape rejections.
  { name: 'top-level null', cursor: makeCursorFrom(null), accepted: false },
  { name: 'top-level array', cursor: makeCursorFrom([1, 2]), accepted: false },
  { name: 'top-level string', cursor: makeCursorFrom('x'), accepted: false },
  { name: 'top-level number', cursor: makeCursorFrom(42), accepted: false },
  // version rejections.
  { name: 'version missing', cursor: makeCursorFrom({ rowId: 0 }), accepted: false },
  { name: 'version = 2', cursor: makeCursorFrom({ version: 2, rowId: 0 }), accepted: false },
  { name: 'version = 0', cursor: makeCursorFrom({ version: 0, rowId: 0 }), accepted: false },
  { name: 'version wrong type (string "1")', cursor: makeCursorFrom({ version: '1', rowId: 0 }), accepted: false },
  // rowId rejections.
  { name: 'rowId missing', cursor: makeCursorFrom({ version: 1 }), accepted: false },
  { name: 'rowId negative', cursor: makeCursorFrom({ version: 1, rowId: -1 }), accepted: false },
  { name: 'rowId fractional', cursor: makeCursorFrom({ version: 1, rowId: 1.5 }), accepted: false },
  { name: 'rowId unsafe integer (2**60) trap case', cursor: makeCursorFrom({ version: 1, rowId: 2 ** 60 }), accepted: false },
  { name: 'rowId wrong type (string)', cursor: makeCursorFrom({ version: 1, rowId: '5' }), accepted: false },
  { name: 'rowId null (missing ≠ null)', cursor: makeCursorFrom({ version: 1, rowId: null }), accepted: false },
];

describe('decodeImsgCursor equivalence (observed through ImsgPort.listInboundSince)', () => {
  for (const c of cases) {
    it(`${c.name} → ${c.accepted ? 'accepted' : 'rejected'}`, async () => {
      // The table must encode exactly what the pre-conversion ladder decided.
      const ref = referenceDecodeImsgCursor(c.cursor);
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
