// Falsifiers for #2519 (client slice): stream gap detection and the
// realtime-owned query registry. Pure-helper coverage lives here; the
// RealtimeProvider integration lives in use-websocket.test.tsx.
//
// Draft-2 (#2519/#2521 residuals): the durable/ephemeral split. Typing frames
// advance the raw sequence but not durable_sequence, so a gap composed only of
// typing frames is judged 'ephemeral_gap' (typing cache reconcile) instead of
// forcing a full realtime-owned reconciliation.
import { describe, expect, it } from 'vitest';
import {
  detectFrameGap,
  detectHelloGap,
  getInvalidationKeys,
  INVALIDATION_TYPES,
  REALTIME_OWNED_QUERY_KEYS,
  type StreamCursor,
} from '../../console/src/lib/realtime-events';

/** Cursor verified against a legacy (pre-durable) server: no durable field. */
const CURSOR: StreamCursor = { generation: 'gen-a', sequence: 5, durableSequence: null };
/** Cursor verified against a durable-aware server. */
const DURABLE_CURSOR: StreamCursor = { generation: 'gen-a', sequence: 5, durableSequence: 3 };

describe('detectHelloGap (#2519)', () => {
  it('first-ever connection is never a gap', () => {
    expect(detectHelloGap({ generation: null, sequence: null, durableSequence: null }, {})).toBeNull();
    expect(
      detectHelloGap(
        { generation: null, sequence: null, durableSequence: null },
        { streamGeneration: 'gen-a', sequence: 3 },
      ),
    ).toBeNull();
  });

  it('an unverifiable hello after a verified session requires reconciliation', () => {
    expect(detectHelloGap(CURSOR, {})).toBe('unverifiable');
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a' })).toBe('unverifiable');
    expect(detectHelloGap(CURSOR, { sequence: 5 })).toBe('unverifiable');
  });

  it('a generation change means a server restart: reconcile', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-b', sequence: 5 })).toBe('generation_changed');
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-b', sequence: 5, durableSequence: 3 }),
    ).toBe('generation_changed');
  });

  it('a legacy sequence advance while away means missed frames: reconcile', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 9 })).toBe('sequence_gap');
  });

  it('a legacy sequence BEHIND the cursor is a full gap, never trusted', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 3 })).toBe('sequence_gap');
  });

  it('same generation and sequence proves nothing was missed', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 5 })).toBeNull();
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 5, durableSequence: 3 }),
    ).toBeNull();
  });

  it('a typing-only gap (raw ahead, durable unchanged) is ephemeral, not a full reconcile', () => {
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 9, durableSequence: 3 }),
    ).toBe('ephemeral_gap');
  });

  it('a durable advance while away means missed durable frames: full reconcile', () => {
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 9, durableSequence: 5 }),
    ).toBe('sequence_gap');
  });

  it('a durable sequence BEHIND the cursor is a full gap, never trusted', () => {
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 9, durableSequence: 1 }),
    ).toBe('sequence_gap');
  });

  it('a raw sequence regression with an intact durable chain is still a full gap', () => {
    // Raw regression is never explainable by missed typing frames.
    expect(
      detectHelloGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 3, durableSequence: 3 }),
    ).toBe('sequence_gap');
  });

  it('a durable-aware hello against a legacy cursor falls back to the raw rule', () => {
    expect(
      detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 5, durableSequence: 99 }),
    ).toBeNull();
    expect(
      detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 9, durableSequence: 99 }),
    ).toBe('sequence_gap');
  });
});

describe('detectFrameGap (#2519)', () => {
  it('contiguous legacy frames advance without a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 6 })).toBeNull();
  });

  it('a skipped legacy sequence is a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 8 })).toBe('sequence_gap');
  });

  it('a legacy sequence at or behind the cursor is a gap, never trusted', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 5 })).toBe('sequence_gap');
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 3 })).toBe('sequence_gap');
  });

  it('a mid-stream generation change is a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-b', sequence: 6 })).toBe('generation_changed');
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-b', sequence: 6, durableSequence: 4 }),
    ).toBe('generation_changed');
  });

  it('legacy frames without an envelope are tolerated', () => {
    expect(detectFrameGap(CURSOR, {})).toBeNull();
    expect(
      detectFrameGap(
        { generation: null, sequence: null, durableSequence: null },
        { streamGeneration: 'gen-a', sequence: 2 },
      ),
    ).toBeNull();
  });

  it('a durable frame advancing durable by exactly one is contiguous', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 6, durableSequence: 4 }),
    ).toBeNull();
  });

  it('a durable frame skipping durable positions means a missed durable frame: full gap', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 7, durableSequence: 5 }),
    ).toBe('sequence_gap');
  });

  it('a durable frame that does not advance durable is a full gap (duplicate/regression)', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 6, durableSequence: 3 }),
    ).toBe('sequence_gap');
  });

  it('an ephemeral frame carrying the cursor durable position is contiguous', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 6, durableSequence: 3 }, true),
    ).toBeNull();
  });

  it('an ephemeral frame revealing an advanced durable position means a durable frame was dropped', () => {
    // A typing frame does not advance durable_sequence itself, so durable
    // moving under it proves a durable frame never arrived at this client.
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 7, durableSequence: 4 }, true),
    ).toBe('sequence_gap');
  });

  it('a raw skip with an intact durable chain is an ephemeral gap (missed typing only)', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 8, durableSequence: 3 }, true),
    ).toBe('ephemeral_gap');
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 8, durableSequence: 4 }),
    ).toBe('ephemeral_gap');
  });

  it('a raw sequence at or behind the cursor is a full gap even with durable intact', () => {
    expect(
      detectFrameGap(DURABLE_CURSOR, { streamGeneration: 'gen-a', sequence: 4, durableSequence: 3 }, true),
    ).toBe('sequence_gap');
  });

  it('a durable-aware frame against a legacy cursor falls back to the raw rule', () => {
    expect(
      detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 6, durableSequence: 99 }),
    ).toBeNull();
  });
});

describe('REALTIME_OWNED_QUERY_KEYS closure (#2519)', () => {
  it('covers every family getInvalidationKeys can emit', () => {
    // Every invalidation type's keys must be prefix-covered by the registry:
    // a new event family added without registry membership would silently
    // reintroduce the partial-reconciliation staleness class. The type list is
    // DERIVED from the parser's own INVALIDATION_TYPES registry, so a new
    // event type cannot dodge this closure by omission from a manual literal.
    expect(INVALIDATION_TYPES.size).toBeGreaterThan(0);
    const families = new Set(REALTIME_OWNED_QUERY_KEYS.map((key) => String(key[0])));
    for (const type of INVALIDATION_TYPES) {
      const keys = getInvalidationKeys({ type, instance: 'synthetic-a' });
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(families.has(String(key[0])), `family ${String(key[0])} (from ${type}) must be realtime-owned`).toBe(
          true,
        );
      }
    }
  });
});
