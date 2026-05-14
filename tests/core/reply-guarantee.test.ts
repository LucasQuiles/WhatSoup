import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createAuditedReplyGuaranteeSender,
  DEFAULT_REPLY_GUARANTEE_TEXT,
  ReplyGuaranteeManager,
  type ReplyGuaranteeDurability,
} from '../../src/core/reply-guarantee.ts';
import { Database } from '../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../src/core/outbound-sends.ts';
import type { ChatResolver } from '../../src/core/chats-resolver.ts';

function makeDurability(status: string | undefined = 'processing'): ReplyGuaranteeDurability {
  return {
    getInboundStatus: vi.fn(() => status),
    completeTurn: vi.fn(),
  };
}

describe('ReplyGuaranteeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one audited fallback and completes the inbound turn when a turn stays open', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => ({ transportId: 'wamid.rgp' }));
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 7, chatJid: '15550100001@s.whatsapp.net' });

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
    expect(sendFallback).toHaveBeenCalledWith({
      chatJid: '15550100001@s.whatsapp.net',
      text: DEFAULT_REPLY_GUARANTEE_TEXT,
      inboundSeq: 7,
    });
    expect(durability.completeTurn).toHaveBeenCalledWith({
      inbound: {
        seq: 7,
        terminalReason: 'rgp_fallback_sent',
      },
    });
  });

  it('arms only one timer per inbound seq', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 8, chatJid: '15550100001@s.whatsapp.net' });
    manager.arm({ inboundSeq: 8, chatJid: '15550100001@s.whatsapp.net' });

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
  });

  it('disarms a completed turn before the timeout fires', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 9, chatJid: '15550100001@s.whatsapp.net' });
    manager.disarm(9);

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).not.toHaveBeenCalled();
    expect(durability.completeTurn).not.toHaveBeenCalled();
  });

  it('rechecks durability and skips fallback when the inbound row already completed', async () => {
    const durability = makeDurability('complete');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 10, chatJid: '15550100001@s.whatsapp.net' });

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).not.toHaveBeenCalled();
    expect(durability.completeTurn).not.toHaveBeenCalled();
  });

  it('rate-limits fallback sends per chat', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 11, chatJid: '15550100001@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);
    manager.arm({ inboundSeq: 12, chatJid: '15550100001@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
    expect(durability.completeTurn).toHaveBeenCalledOnce();
  });

  it('keeps inbound open when fallback send fails', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => {
      throw new Error('transport unavailable');
    });
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 13, chatJid: '15550100001@s.whatsapp.net' });

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
    expect(durability.completeTurn).not.toHaveBeenCalled();
  });

  it('shutdown clears outstanding timers', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 14, chatJid: '15550100001@s.whatsapp.net' });
    manager.shutdown();

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).not.toHaveBeenCalled();
  });
});

describe('createAuditedReplyGuaranteeSender', () => {
  it('sends through the shared send pipeline and records an outbound_sends rgp audit row', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const messenger = {
        sendMessage: vi.fn(async () => ({ waMessageId: 'wamid.rgp' })),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const resolver: ChatResolver = {
        resolve: ({ chatJid }) => chatJid ?? 'missing@s.whatsapp.net',
      };
      const sender = createAuditedReplyGuaranteeSender({
        messenger,
        resolver,
        auditWriter: createOutboundSendsWriter({ db: db.raw, line: 'personal' }),
      });

      await sender({
        inboundSeq: 21,
        chatJid: '15550100021@s.whatsapp.net',
        text: DEFAULT_REPLY_GUARANTEE_TEXT,
      });

      expect(messenger.sendMessage).toHaveBeenCalledWith(
        '15550100021@s.whatsapp.net',
        DEFAULT_REPLY_GUARANTEE_TEXT,
      );
      const row = db.raw
        .prepare('SELECT line, caller, chat_jid, target_kind, status, transport_message_id FROM outbound_sends')
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        line: 'personal',
        caller: 'rgp',
        chat_jid: '15550100021@s.whatsapp.net',
        target_kind: 'chatJid',
        status: 'sent',
        transport_message_id: 'wamid.rgp',
      });
    } finally {
      db.close();
    }
  });
});
