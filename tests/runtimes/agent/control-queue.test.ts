import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ControlQueue } from '../../../src/runtimes/agent/control-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import type { ToolUpdate } from '../../../src/runtimes/agent/outbound-queue.ts';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock sendTracked so we can verify it is called with the correct arguments
// without needing a real DurabilityEngine or database.
vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: vi.fn(async () => undefined),
}));

// Suppress logger noise in test output.
vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHAT_JID = 'test@s.whatsapp.net';

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ControlQueue', () => {
  let messenger: Messenger;
  let queue: ControlQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    messenger = makeMessenger();
    queue = new ControlQueue(CHAT_JID, messenger);
  });

  it('enqueueText buffers text and does not call messenger', () => {
    queue.enqueueText('hello world');
    queue.enqueueText('second line');

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    const log = queue.getLog();
    expect(log).toContain('hello world');
    expect(log).toContain('second line');
  });

  it('buffers streaming and result text without calling messenger', () => {
    queue.enqueueStreamingText('stream chunk');
    queue.enqueueResultText('terminal result');

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(queue.getLog()).toEqual(['stream chunk', 'terminal result']);
  });

  it('enqueueToolUpdate buffers a formatted entry and does not call messenger', () => {
    const update: ToolUpdate = { category: 'reading', detail: 'CLAUDE.md' };
    queue.enqueueToolUpdate(update);

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    const log = queue.getLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('reading');
    expect(log[0]).toContain('CLAUDE.md');
  });

  it('flush resolves without calling messenger', async () => {
    queue.enqueueText('buffered');
    await queue.flush();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('indicateTyping is a no-op and does not throw', () => {
    expect(() => queue.indicateTyping()).not.toThrow();
    expect(messenger.setTyping).not.toHaveBeenCalled();
  });

  it('executes poll callbacks immediately and propagates poll failures', async () => {
    const sendPoll = vi.fn(async () => undefined);

    await queue.enqueuePoll(sendPoll);
    expect(sendPoll).toHaveBeenCalledOnce();

    const failure = new Error('poll failed');
    await expect(queue.enqueuePoll(async () => {
      throw failure;
    })).rejects.toThrow(failure);
  });

  it('keeps control-only no-op settings local', async () => {
    queue.enqueueText('kept');

    expect(() => queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 1000 }, 'q')).not.toThrow();
    expect(() => queue.setToolUpdateMode('friendly')).not.toThrow();
    expect(() => queue.setToolUpdateRedirectJid('ops@s.whatsapp.net')).not.toThrow();
    expect(() => queue.setToolUpdateRedirectJid(null)).not.toThrow();
    expect(() => queue.setTextAggregateDelayMs(5)).not.toThrow();
    expect(() => queue.setPollPending(true)).not.toThrow();
    expect(() => queue.setPollPending(false)).not.toThrow();
    await expect(queue.shutdown()).resolves.toBeUndefined();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(messenger.setTyping).not.toHaveBeenCalled();
    expect(queue.getLog()).toEqual(['kept']);
  });

  it('abortTurn clears the buffer', () => {
    queue.enqueueText('line 1');
    queue.enqueueText('line 2');
    expect(queue.getLog()).toHaveLength(2);

    queue.abortTurn();
    expect(queue.getLog()).toHaveLength(0);
  });

  it('targetChatJid returns the configured JID', () => {
    expect(queue.targetChatJid).toBe(CHAT_JID);
  });

  it('updateDeliveryJid changes the JID returned by targetChatJid', () => {
    const newJid = 'new@s.whatsapp.net';
    queue.updateDeliveryJid(newJid);
    expect(queue.targetChatJid).toBe(newJid);
  });

  it('setInboundSeq is a no-op and does not throw', () => {
    expect(() => queue.setInboundSeq(42)).not.toThrow();
    expect(() => queue.setInboundSeq(undefined)).not.toThrow();
  });

  it('getLastOpId returns undefined', () => {
    expect(queue.getLastOpId()).toBeUndefined();
  });

  it('markLastTerminal is a no-op and does not throw', () => {
    expect(() => queue.markLastTerminal()).not.toThrow();
  });

  it('durability lifecycle methods are no-ops for control sessions', () => {
    queue.enqueueText('still buffered');

    expect(() => queue.clearLastOpId()).not.toThrow();
    expect(() => queue.setDurability({} as DurabilityEngine)).not.toThrow();

    expect(queue.getLastOpId()).toBeUndefined();
    expect(queue.getLog()).toEqual(['still buffered']);
  });

  it('sendControlMessage calls sendTracked with the formatted message and correct args', async () => {
    const { sendTracked } = await import('../../../src/core/durability.ts');

    const targetJid = 'control@s.whatsapp.net';
    const payload = { action: 'repair', turnId: 'abc-123' };
    await queue.sendControlMessage(targetJid, 'REPAIR', payload, undefined);

    expect(sendTracked).toHaveBeenCalledOnce();
    const [messengerArg, jidArg, textArg, durabilityArg, optsArg] = (sendTracked as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(messengerArg).toBe(messenger);
    expect(jidArg).toBe(targetJid);
    expect(textArg).toBe(`[REPAIR] ${JSON.stringify(payload)}`);
    expect(durabilityArg).toBeUndefined();
    expect(optsArg).toEqual({ replayPolicy: 'safe' });
  });

  it('getLog returns a copy — mutations do not affect the internal buffer', () => {
    queue.enqueueText('original');

    const snapshot = queue.getLog();
    snapshot.push('injected');

    // Internal buffer must be unchanged
    expect(queue.getLog()).toHaveLength(1);
    expect(queue.getLog()[0]).toBe('original');
  });
});
