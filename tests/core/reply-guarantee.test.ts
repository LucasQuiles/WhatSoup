import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createReplyGuaranteeLivenessSender,
  DEFAULT_REPLY_GUARANTEE_TEXT,
  DEFAULT_REPLY_GUARANTEE_TIMEOUT_MS,
  ReplyGuaranteeManager,
  type ReplyGuaranteeDurability,
} from '../../src/core/reply-guarantee.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import type { InboundStatus } from '../../src/core/durability.ts';
import type { Messenger } from '../../src/core/types.ts';
import { finalizeRuntimeTurn } from '../../src/runtimes/agent/turn-finalizer.ts';

function makeDurability(status: InboundStatus | undefined = 'processing'): ReplyGuaranteeDurability {
  return {
    getInboundStatus: vi.fn(() => status),
  };
}

describe('ReplyGuaranteeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves terminal ownership open after a liveness timeout so provider CAS can still win', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const deliveryJid = '15550100000@s.whatsapp.net';
      const seq = durability.journalInbound('wamid-rgp-cas', '15550100000', deliveryJid, 'agent');
      const manager = new ReplyGuaranteeManager({
        durability,
        sendFallback: vi.fn(async () => ({ terminalReason: 'rgp_liveness_nudged' })),
        timeoutMs: 100,
        rateLimitMs: 1_000,
      });

      manager.arm({ inboundSeq: seq, chatJid: deliveryJid });
      await vi.advanceTimersByTimeAsync(100);

      expect(durability.getInboundStatus(seq)).toBe('processing');
      const terminal = finalizeRuntimeTurn({
        instanceName: 'test',
        durability,
        identity: {
          scope: 'singleton',
          conversationKey: '15550100000',
          deliveryJid,
          inboundSeq: seq,
          logicalTurnId: 'turn-rgp-cas',
          managerId: 'manager-rgp-cas',
          generation: 1,
        },
        attemptOutcome: { kind: 'suppressed_by_policy' },
        answerEvidence: { kind: 'ready', opIds: [] },
      });
      expect(terminal).toMatchObject({ kind: 'terminal' });
      expect(durability.getTurnTerminal(seq, 'turn-rgp-cas', 1)).toBeDefined();
    } finally {
      db.close();
    }
  });

  it('sends one liveness fallback without taking terminal ownership from the provider turn', async () => {
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
    expect(durability.getInboundStatus(7)).toBe('processing');
  });

  it('accepts sender metadata without interpreting it as a terminal reason', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => ({ terminalReason: 'rgp_liveness_nudged' }));
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 1_000,
    });

    manager.arm({ inboundSeq: 17, chatJid: '15550100017@s.whatsapp.net' });

    await vi.advanceTimersByTimeAsync(100);

    expect(sendFallback).toHaveBeenCalledOnce();
    expect(durability.getInboundStatus(17)).toBe('processing');
  });

  it('keeps the rate-limit slot after a successful liveness send', async () => {
    const durability = makeDurability('processing');
    const sendFallback = vi.fn(async () => ({ transportId: 'wamid.rgp' }));
    const chatJid = '15550100009@s.whatsapp.net';
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback,
      timeoutMs: 100,
      rateLimitMs: 30_000,
    });

    // Turn A: the liveness fallback succeeds.
    manager.arm({ inboundSeq: 1, chatJid });
    await vi.advanceTimersByTimeAsync(100);
    expect(sendFallback).toHaveBeenCalledOnce();

    // Turn B on the SAME chat times out well inside rateLimitMs. The slot must
    // remain reserved because a liveness fallback was already emitted.
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

  it('re-arms an open inbound after a real typing adapter failure', async () => {
    const durability = makeDurability('processing');
    const messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: 'unused' })),
      setTyping: vi.fn()
        .mockRejectedValueOnce(new Error('typing transport unavailable'))
        .mockResolvedValue(undefined),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback: createReplyGuaranteeLivenessSender({ messenger }),
      timeoutMs: 100,
      rateLimitMs: 10_000,
    });

    manager.arm({ inboundSeq: 43, chatJid: 'chatB@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);

    expect(messenger.setTyping).toHaveBeenCalledTimes(1);
    expect(manager.isArmed(43)).toBe(true);

    // The failed adapter call released its rate slot and the same still-open
    // inbound remained monitored, so it retries after another bounded window.
    await vi.advanceTimersByTimeAsync(100);
    expect(messenger.setTyping).toHaveBeenCalledTimes(2);
    expect(manager.isArmed(43)).toBe(true);

    (durability.getInboundStatus as ReturnType<typeof vi.fn>).mockReturnValue('complete');
    await vi.advanceTimersByTimeAsync(100);
    expect(messenger.setTyping).toHaveBeenCalledTimes(2);
    expect(manager.isArmed(43)).toBe(false);
  });

  it('releases the rate slot and keeps monitoring when the typing adapter is missing', async () => {
    const durability = makeDurability('processing');
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: 'unused' })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };
    const manager = new ReplyGuaranteeManager({
      durability,
      sendFallback: createReplyGuaranteeLivenessSender({ messenger }),
      timeoutMs: 100,
      rateLimitMs: 10_000,
    });

    manager.arm({ inboundSeq: 44, chatJid: 'chatB@s.whatsapp.net' });
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.isArmed(44)).toBe(true);

    const setTyping = vi.fn(async () => undefined);
    messenger.setTyping = setTyping;
    await vi.advanceTimersByTimeAsync(100);

    expect(setTyping).toHaveBeenCalledOnce();
    expect(manager.isArmed(44)).toBe(true);
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

describe('createReplyGuaranteeLivenessSender', () => {
  it('uses typing-only liveness and does not send or audit filler text', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const messenger = {
        sendMessage: vi.fn(async () => ({ waMessageId: 'wamid.rgp' })),
        setTyping: vi.fn(async () => undefined),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const sender = createReplyGuaranteeLivenessSender({
        messenger,
      });

      const result = await sender({
        inboundSeq: 21,
        chatJid: '15550100021@s.whatsapp.net',
        text: DEFAULT_REPLY_GUARANTEE_TEXT,
      });

      expect(result).toEqual({ terminalReason: 'rgp_liveness_nudged' });
      expect(messenger.setTyping).toHaveBeenCalledWith(
        '15550100021@s.whatsapp.net',
        'composing',
      );
      expect(messenger.sendMessage).not.toHaveBeenCalled();
      const row = db.raw
        .prepare('SELECT COUNT(*) AS count FROM outbound_sends')
        .get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('fails when the messenger has no typing adapter', async () => {
    const sender = createReplyGuaranteeLivenessSender({
      messenger: {
        sendMessage: vi.fn(async () => ({ waMessageId: 'unused' })),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      },
    });

    await expect(sender({
      inboundSeq: 22,
      chatJid: '15550100022@s.whatsapp.net',
      text: DEFAULT_REPLY_GUARANTEE_TEXT,
    })).rejects.toThrow(/typing/i);
  });

  it('propagates a rejected typing adapter call', async () => {
    const transportError = new Error('typing transport unavailable');
    const sender = createReplyGuaranteeLivenessSender({
      messenger: {
        sendMessage: vi.fn(async () => ({ waMessageId: 'unused' })),
        setTyping: vi.fn(async () => {
          throw transportError;
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      },
    });

    await expect(sender({
      inboundSeq: 23,
      chatJid: '15550100023@s.whatsapp.net',
      text: DEFAULT_REPLY_GUARANTEE_TEXT,
    })).rejects.toBe(transportError);
  });
});
