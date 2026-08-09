import { describe, it, expect, vi } from 'vitest';
import { sendDirect } from '../../../src/runtimes/agent/chat-transport.ts';

function makePort(overrides: { sendMessage?: ReturnType<typeof vi.fn>; getQueueForChat?: () => unknown } = {}) {
  return {
    messenger: { sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue({ waMessageId: 'm1' }) },
    getQueueForChat: overrides.getQueueForChat ?? (() => null),
  } as unknown as Parameters<typeof sendDirect>[0];
}

describe('sendDirect (#2981)', () => {
  it('T1: surfaces a bypass-path send failure as false (not swallowed)', async () => {
    const port = makePort({ sendMessage: vi.fn().mockRejectedValue(new Error('boom')) });
    const result = await sendDirect(port, 'jid@s.whatsapp.net', 'text', true /* bypass */);
    expect(result).toBe(false);
  });

  it('T2: surfaces a fallback-path send failure as false (not swallowed)', async () => {
    const port = makePort({
      sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
      getQueueForChat: () => null, // force fallback path
    });
    const result = await sendDirect(port, 'jid@s.whatsapp.net', 'text');
    expect(result).toBe(false);
  });

  it('T3: returns true on successful bypass send', async () => {
    const port = makePort({ sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'm1' }) });
    const result = await sendDirect(port, 'jid@s.whatsapp.net', 'text', true);
    expect(result).toBe(true);
  });

  it('T4: returns true when queued (enqueueText is void — accepted, outcome deferred)', async () => {
    const port = makePort({ getQueueForChat: () => ({ enqueueText: vi.fn() }) });
    const result = await sendDirect(port, 'jid@s.whatsapp.net', 'text');
    expect(result).toBe(true);
  });
});
