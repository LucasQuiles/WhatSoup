/**
 * QR-028 — outbound send retries must be idempotent.
 *
 * `sendWithRetry` races `messenger.sendMessage` against a SEND_TIMEOUT. On
 * timeout (or any transient error) it retries — but Baileys mints a FRESH
 * `key.id` per `sendMessage` call, so a slow-but-delivered message was delivered
 * twice. The fix threads a STABLE client `messageId` through every attempt, so
 * WhatsApp dedups the retransmission (at-least-once, no duplicate).
 *
 * The verifiable invariant: across all retry attempts of one logical send, the
 * same non-empty `messageId` is passed to `messenger.sendMessage`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CHAT_JID = 'idem@s.whatsapp.net';

describe('OutboundQueue.sendWithRetry — stable messageId across retries (QR-028)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('passes the SAME messageId on a retried attempt', async () => {
    const seenIds: Array<string | undefined> = [];
    let attempt = 0;
    const messenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, _text: string, opts?: { messageId?: string }) => {
        seenIds.push(opts?.messageId);
        attempt += 1;
        if (attempt === 1) throw new Error('transient'); // force one retry
        return { waMessageId: opts?.messageId ?? null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => {}),
    };

    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.enqueueText('Reply that may be slow');
    await vi.runAllTimersAsync();
    await queue.flush();

    // Two attempts happened (one transient failure + one success)…
    expect(seenIds.length).toBeGreaterThanOrEqual(2);
    // …each with a non-empty messageId, and identical across attempts.
    expect(seenIds[0]).toBeTruthy();
    expect(new Set(seenIds).size).toBe(1);
  });

  it('uses a distinct messageId for a different logical send', async () => {
    const seenIds: string[] = [];
    const messenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, _text: string, opts?: { messageId?: string }) => {
        if (opts?.messageId) seenIds.push(opts.messageId);
        return { waMessageId: opts?.messageId ?? null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => {}),
    };

    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.enqueueText('First message');
    await vi.runAllTimersAsync();
    await queue.flush();
    queue.enqueueText('Second message');
    await vi.runAllTimersAsync();
    await queue.flush();

    expect(seenIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seenIds).size).toBe(seenIds.length); // all distinct
  });
});
