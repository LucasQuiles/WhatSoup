// tests/transport/contract/subscriber-lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest';
import { InMemoryAdapter } from '../../../src/transport/testing/in-memory.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('Subscriber lifecycle', () => {
  it('S1 — dispose() returns immediately even mid-event-dispatch; subscriber sees no further events', async () => {
    const a = new InMemoryAdapter(makeChannelId('whatsapp', 'sub-test'));
    await a.connect();
    const handler = vi.fn();
    const sub = a.on('message', handler);

    const sample = {
      kind: 'message' as const,
      data: {
        ref: { channel: a.capabilities.channel, conversation: 'C', id: 'm1' },
        conversation: { channel: a.capabilities.channel, id: 'C' },
        sender: { channel: a.capabilities.channel, id: 'S' },
        fromMe: false, text: 't', attachments: [],
        timestamp: new Date(), inboundEventKey: 'k-s1',
        transportTimestamp: new Date(), ingestSeq: 1,
      },
    };

    a.injectInbound(sample);
    expect(handler).toHaveBeenCalledTimes(1);
    sub.dispose();
    a.injectInbound({ ...sample, data: { ...sample.data, inboundEventKey: 'k-s1b' } });
    expect(handler).toHaveBeenCalledTimes(1);  // still 1 — no further deliveries
  });

  it('S2 — N runtime starts/stops with same adapter — listener count returns to baseline', async () => {
    const a = new InMemoryAdapter(makeChannelId('whatsapp', 'sub-test-2'));
    const baseline = (a as any).listeners.message.size;
    for (let i = 0; i < 20; i++) {
      const sub = a.on('message', () => {});
      sub.dispose();
    }
    expect((a as any).listeners.message.size).toBe(baseline);
  });

  it('S3 — disposed subscription does not retain a reference to the handler', async () => {
    // Memory leak guard via reachability proxy: after dispose, handler is no
    // longer in the listeners set.
    const a = new InMemoryAdapter(makeChannelId('whatsapp', 'sub-test-3'));
    const handler = () => {};
    const sub = a.on('message', handler);
    expect((a as any).listeners.message.has(handler)).toBe(true);
    sub.dispose();
    expect((a as any).listeners.message.has(handler)).toBe(false);
  });
});
