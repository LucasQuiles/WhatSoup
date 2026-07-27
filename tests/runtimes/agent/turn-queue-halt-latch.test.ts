import { describe, expect, it } from 'vitest';

import { TurnQueueHaltLatch } from '../../../src/runtimes/agent/turn-queue-halt-latch.ts';

describe('TurnQueueHaltLatch', () => {
  it('preserves a halt through an alias chain and keeps the count monotonic', () => {
    const latch = new TurnQueueHaltLatch();
    latch.halt('phone');
    latch.rekey('phone', 'jid');
    latch.rekey('jid', 'lid');

    expect(latch.has('phone')).toBe(true);
    expect(latch.has('jid')).toBe(true);
    expect(latch.has('lid')).toBe(true);
    expect(latch.snapshot('per_chat', false)).toEqual({
      turnQueueHalted: true,
      turnQueueHaltedScopes: 1,
    });
  });

  it('coalesces two halted aliases when their scopes collide', () => {
    const latch = new TurnQueueHaltLatch();
    latch.halt('jid');
    latch.halt('lid');
    expect(latch.snapshot('per_chat', false).turnQueueHaltedScopes).toBe(2);

    latch.rekey('jid', 'lid');

    expect(latch.has('jid')).toBe(true);
    expect(latch.has('lid')).toBe(true);
    expect(latch.snapshot('per_chat', false).turnQueueHaltedScopes).toBe(1);
  });

  it('reports shared state from the live queue and never publishes single-scope halts', () => {
    const latch = new TurnQueueHaltLatch();
    latch.halt('per-chat-only');

    expect(latch.snapshot('shared', false)).toEqual({
      turnQueueHalted: false,
      turnQueueHaltedScopes: 0,
    });
    expect(latch.snapshot('shared', true)).toEqual({
      turnQueueHalted: true,
      turnQueueHaltedScopes: 1,
    });
    expect(latch.snapshot('single', true)).toEqual({
      turnQueueHalted: false,
      turnQueueHaltedScopes: 0,
    });
  });
});
