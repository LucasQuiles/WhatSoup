import { describe, it, expect, vi } from 'vitest';
import { sendDirect, sendDirectWithReceipt } from '../../../src/runtimes/agent/chat-transport.ts';

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

describe('sendDirectWithReceipt (#2981 car-B — id-bearing envelope)', () => {
  it('B1: bypass path surfaces the receipt waMessageId', async () => {
    const port = makePort({ sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'wamid-77' }) });
    await expect(
      sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text', true),
    ).resolves.toEqual({ accepted: true, messageId: 'wamid-77' });
  });

  it('B2: fallback (no-queue) path surfaces the receipt waMessageId', async () => {
    const port = makePort({
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'wamid-88' }),
      getQueueForChat: () => null,
    });
    await expect(
      sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text'),
    ).resolves.toEqual({ accepted: true, messageId: 'wamid-88' });
  });

  it('B3: queue path reports acceptance with a null id (outcome deferred by design)', async () => {
    const enqueueText = vi.fn();
    const port = makePort({ getQueueForChat: () => ({ enqueueText }) });
    await expect(
      sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text'),
    ).resolves.toEqual({ accepted: true, messageId: null });
    expect(enqueueText).toHaveBeenCalledWith('text');
  });

  it('B4: a thrown send maps to accepted:false with a null id', async () => {
    const port = makePort({ sendMessage: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(
      sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text', true),
    ).resolves.toEqual({ accepted: false, messageId: null });
  });

  it('B5: a receipt without an attributable id stays accepted with a null id', async () => {
    const port = makePort({ sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }) });
    await expect(
      sendDirectWithReceipt(port, 'jid@s.whatsapp.net', 'text', true),
    ).resolves.toEqual({ accepted: true, messageId: null });
  });

  it('B6: the boolean sendDirect wrapper still reports acceptance identically', async () => {
    const ok = makePort({ sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'wamid-9' }) });
    await expect(sendDirect(ok, 'jid@s.whatsapp.net', 'text', true)).resolves.toBe(true);
    const bad = makePort({ sendMessage: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(sendDirect(bad, 'jid@s.whatsapp.net', 'text', true)).resolves.toBe(false);
  });
});
