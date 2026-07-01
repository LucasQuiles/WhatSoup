import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createAuditedReplyGuaranteeSender,
  DEFAULT_REPLY_GUARANTEE_TEXT,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
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

  it('QR-107: a completeTurn failure AFTER a successful send does not release the rate-limit slot (no duplicate burst)', async () => {
    const durability = makeDurability('processing');
    // completeTurn throws (e.g. SQLITE_BUSY) AFTER sendFallback has already delivered.
    (durability.completeTurn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const sendFallback = vi.fn(async () => ({ transportId: 'wamid.rgp' }));
    const chatJid = '15550100009@s.whatsapp.net';
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 30_000,
    });

    // Turn A: fallback delivered, but completeTurn throws.
    manager.arm({ inboundSeq: 1, chatJid });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendFallback).toHaveBeenCalledOnce(); // the "still working" message WAS delivered

    // Turn B on the SAME chat times out well inside rateLimitMs. The slot must
    // remain reserved (a fallback was already delivered) — otherwise the finalize
    // failure is misread as a send failure and a DUPLICATE burst goes out.
    manager.arm({ inboundSeq: 2, chatJid });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce(); // still once — no duplicate fallback
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

  it('does not send concurrent duplicate fallbacks for the same chat (TOCTOU)', async () => {
    const durability = makeDurability('processing');
    let resolveSend: () => void = () => {};
    const sendFallback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    // Two open inbound turns on the SAME chat, both armed to fire together.
    manager.arm({ inboundSeq: 31, chatJid: 'chatA@s.whatsapp.net' });
    manager.arm({ inboundSeq: 32, chatJid: 'chatA@s.whatsapp.net' });

    // Both timers fire in the same tick; the first must reserve the rate-limit
    // slot synchronously (before awaiting the send) so the second is suppressed.
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
    resolveSend();
  });

  it('releases the rate-limit slot when the fallback send fails so a later turn can retry', async () => {
    const durability = makeDurability('processing');
    let attempt = 0;
    const sendFallback = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transport unavailable');
    });
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 10_000,
    });

    manager.arm({ inboundSeq: 41, chatJid: 'chatB@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100); // first attempt throws

    // Second turn fires well inside the rate-limit window. Because the prior
    // send FAILED, the slot must have been released so this retry is allowed.
    manager.arm({ inboundSeq: 42, chatJid: 'chatB@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledTimes(2);
  });

  it('notifyActivity resets the silence window so an active turn does not fire prematurely', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 51, chatJid: 'chatC@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(60);
    manager.notifyActivity('chatC@s.whatsapp.net'); // visible output at t=60 → reset
    await vi.advanceTimersByTimeAsync(60); // t=120, only 60ms since reset → not fired
    expect(sendFallback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40); // 100ms since reset → fires once
    expect(sendFallback).toHaveBeenCalledOnce();
  });

  it('notifyActivity for an unrelated chat leaves the armed timer untouched', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 61, chatJid: 'chatD@s.whatsapp.net' });
    manager.notifyActivity('other@s.whatsapp.net');
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
  });

  it('notifyActivity after disarm does not re-arm a timer', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 71, chatJid: 'chatE@s.whatsapp.net' });
    manager.disarm(71);
    manager.notifyActivity('chatE@s.whatsapp.net');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendFallback).not.toHaveBeenCalled();
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

  it('ignores an undefined inbound seq on arm/disarm and a disarm of an unknown seq', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: undefined, chatJid: 'x@s.whatsapp.net' }); // arm early-return
    manager.disarm(undefined); // disarm early-return
    manager.disarm(424_242); // disarm of an unarmed seq → no active entry

    await vi.advanceTimersByTimeAsync(100);
    expect(sendFallback).not.toHaveBeenCalled();
  });

  it('onTimeout returns early when no durability is wired', async () => {
    const sendFallback = vi.fn(async () => undefined);
    const manager = new ReplyGuaranteeManager({
      durability: undefined,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 15, chatJid: 'x@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).not.toHaveBeenCalled(); // !this.durability → return before send
  });

  it('falls back to defaults for an omitted timeout and an invalid rate limit', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => undefined);
    // timeoutMs omitted → DEFAULT (value===undefined arm); rateLimitMs=0 → invalid → fallback arm.
    const manager = new ReplyGuaranteeManager({ durability, sendFallback, rateLimitMs: 0 });

    manager.arm({ inboundSeq: 16, chatJid: 'x@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendFallback).not.toHaveBeenCalled(); // default 10-min window not yet elapsed

    await vi.advanceTimersByTimeAsync(DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS);
    expect(sendFallback).toHaveBeenCalledOnce();
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
