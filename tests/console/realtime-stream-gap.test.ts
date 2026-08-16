// Falsifiers for #2519 (client slice): stream gap detection and the
// realtime-owned query registry. Pure-helper coverage lives here; the
// RealtimeProvider integration lives in use-websocket.test.tsx.
import { describe, expect, it } from 'vitest';
import {
  detectFrameGap,
  detectHelloGap,
  getInvalidationKeys,
  REALTIME_OWNED_QUERY_KEYS,
  type StreamCursor,
  type WsInvalidationEvent,
} from '../../console/src/lib/realtime-events';

const CURSOR: StreamCursor = { generation: 'gen-a', sequence: 5 };

describe('detectHelloGap (#2519)', () => {
  it('first-ever connection is never a gap', () => {
    expect(detectHelloGap({ generation: null, sequence: null }, {})).toBeNull();
    expect(
      detectHelloGap({ generation: null, sequence: null }, { streamGeneration: 'gen-a', sequence: 3 }),
    ).toBeNull();
  });

  it('an unverifiable hello after a verified session requires reconciliation', () => {
    expect(detectHelloGap(CURSOR, {})).toBe('unverifiable');
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a' })).toBe('unverifiable');
    expect(detectHelloGap(CURSOR, { sequence: 5 })).toBe('unverifiable');
  });

  it('a generation change means a server restart: reconcile', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-b', sequence: 5 })).toBe('generation_changed');
  });

  it('a sequence advance while away means missed frames: reconcile', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 9 })).toBe('sequence_gap');
  });

  it('same generation and sequence proves nothing was missed', () => {
    expect(detectHelloGap(CURSOR, { streamGeneration: 'gen-a', sequence: 5 })).toBeNull();
  });
});

describe('detectFrameGap (#2519)', () => {
  it('contiguous frames advance without a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 6 })).toBeNull();
  });

  it('a skipped sequence is a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-a', sequence: 8 })).toBe('sequence_gap');
  });

  it('a mid-stream generation change is a gap', () => {
    expect(detectFrameGap(CURSOR, { streamGeneration: 'gen-b', sequence: 6 })).toBe('generation_changed');
  });

  it('legacy frames without an envelope are tolerated', () => {
    expect(detectFrameGap(CURSOR, {})).toBeNull();
    expect(detectFrameGap({ generation: null, sequence: null }, { streamGeneration: 'gen-a', sequence: 2 })).toBeNull();
  });
});

describe('REALTIME_OWNED_QUERY_KEYS closure (#2519)', () => {
  it('covers every family getInvalidationKeys can emit', () => {
    // Every invalidation type's keys must be prefix-covered by the registry:
    // a new event family added without registry membership would silently
    // reintroduce the partial-reconciliation staleness class.
    const types: WsInvalidationEvent['type'][] = [
      'instance_status',
      'message_received',
      'chat_updated',
      'log_entry',
      'feed_event',
      'access_changed',
      'lid_conflict',
    ];
    const families = new Set(REALTIME_OWNED_QUERY_KEYS.map((key) => String(key[0])));
    for (const type of types) {
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
