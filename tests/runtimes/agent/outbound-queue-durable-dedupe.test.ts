/**
 * OutboundQueue durable terminal-text dedupe (M1).
 *
 * The in-memory recentTerminalTextKeys window dies with the process, so a
 * restart could re-emit a terminal notice the user already received (the
 * production 403-duplicate storm rode this hole). The queue now ALSO consults
 * the durability layer: a terminal op with the same (chat_jid, payload_hash)
 * already `echoed` within the same window suppresses the enqueue. Same sha256
 * keying as the durable layer (hash of the {text} payload JSON).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockLog,
}));

const CHAT_JID = 'test@s.whatsapp.net';
const NOTICE = 'There was an issue with my conversation data. An operator has been notified.';

function makeMessenger(): { messenger: Messenger; calls: string[] } {
  const calls: string[] = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => {
      calls.push(text);
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  };
  return { messenger, calls };
}

/** Simulate a PREVIOUS process delivering a terminal notice: op echoed in the DB. */
function seedEchoedTerminalNotice(
  engine: DurabilityEngine,
  opts: { text?: string; isTerminal?: boolean } = {},
): number {
  const opId = engine.createOutboundOp({
    conversationKey: CHAT_JID,
    chatJid: CHAT_JID,
    opType: 'text',
    payload: JSON.stringify({ text: opts.text ?? NOTICE }),
    replayPolicy: 'unsafe',
    isTerminal: opts.isTerminal ?? true,
  });
  engine.markSending(opId);
  engine.markSubmitted(opId, `WA_SEED_${opId}`);
  engine.markEchoed(opId);
  return opId;
}

describe('OutboundQueue — durable terminal-text dedupe across restart', () => {
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => {
    const leakedTimers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
    expect(leakedTimers, 'Test leaked pending timers').toBe(0);
  });

  it('suppresses a terminal text whose durable twin was echoed within the window (restart hole)', async () => {
    seedEchoedTerminalNotice(engine); // delivered by the previous process generation
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID); // fresh queue: empty in-memory window
    queue.setDurability(engine);

    queue.enqueueText(NOTICE);
    await vi.runAllTimersAsync();

    expect(calls).toEqual([]);
    // Suppressed BEFORE op creation: only the seeded op exists.
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM outbound_ops').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('does not suppress when the echoed twin is older than the dedupe window', async () => {
    const seededId = seedEchoedTerminalNotice(engine);
    db.raw.prepare(
      `UPDATE outbound_ops SET echoed_at = datetime('now', '-360 seconds') WHERE id = ?`,
    ).run(seededId);
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(engine);

    queue.enqueueText(NOTICE);
    await vi.runAllTimersAsync();

    expect(calls).toEqual([NOTICE]);
  });

  it('does not suppress when the echoed twin is not a terminal op', async () => {
    seedEchoedTerminalNotice(engine, { isTerminal: false });
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(engine);

    queue.enqueueText(NOTICE);
    await vi.runAllTimersAsync();

    expect(calls).toEqual([NOTICE]);
  });

  it('does not suppress a different terminal text', async () => {
    seedEchoedTerminalNotice(engine);
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(engine);

    queue.enqueueText('A completely different reply.');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['A completely different reply.']);
  });
});
