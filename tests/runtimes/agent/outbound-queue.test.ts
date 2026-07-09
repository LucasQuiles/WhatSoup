import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundQueue,
  TOOL_BATCH_DELAY_MS,
  TOOL_BATCH_MAX_AGE_MS,
  MIN_SEND_GAP_MS,
  TYPING_REFRESH_MS,
  TYPING_MAX_MS,
  TEXT_AGGREGATE_DELAY_MS,
  TERMINAL_TEXT_DEDUPE_WINDOW_MS,
  PROGRESS_TEXT_DEDUPE_WINDOW_MS,
  SEND_TIMEOUT_MS,
  MAX_CHUNKS,
  MAX_STATUS_MESSAGES_PER_TURN,
  STATUS_CAP_NOTICE,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { ToolUpdate } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { ProgressEvent } from '../../../src/runtimes/agent/operation-tracker.ts';
import type { Messenger, SendOptions } from '../../../src/core/types.ts';
import type { DurabilityEngine } from '../../../src/core/durability.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { RateLimitedError } from '../../../src/transport/contract/errors.ts';
import { canSendToGroup, recordGroupOutbound, __resetForTests } from '../../../src/core/echo-guard.ts';
import type { EchoGuardConfig } from '../../../src/core/echo-guard.ts';

// vi.mock is hoisted, so mockLog must be created with vi.hoisted to be accessible inside the factory
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

function makeMessenger(): { messenger: Messenger; calls: string[]; typingCalls: Array<boolean> } {
  const calls: string[] = [];
  const typingCalls: Array<boolean> = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => {
      calls.push(text);
      return { waMessageId: null };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async (_jid: string, typing: boolean) => {
      typingCalls.push(typing);
    }),
  };
  return { messenger, calls, typingCalls };
}

function makeDurabilityStub(): DurabilityEngine {
  let nextId = 0;
  return {
    createOutboundOp: vi.fn(() => {
      nextId += 1;
      return nextId;
    }),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markTerminal: vi.fn(),
  } as unknown as DurabilityEngine;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('OutboundQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Detect leaked timers BEFORE clearing them. Any pending timer at the end of
    // a test means the test failed to call queue.flush() or queue.abortTurn().
    // A typing heartbeat setInterval or a batch-idle setTimeout left running is
    // a resource leak that would corrupt subsequent tests if not caught here.
    const leakedTimers = vi.getTimerCount();
    vi.clearAllTimers(); // always clean up regardless, for test isolation
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(leakedTimers, 'Test leaked pending timers — call queue.flush() or queue.abortTurn() before the test ends').toBe(0);
  });

  // ─── Constant-value guards ────────────────────────────────────────────────
  // These tests pin the exported timing constants to their intended values.
  // Changing any constant in outbound-queue.ts will break the matching test here,
  // making accidental mutations visible immediately rather than through subtle
  // timing behaviour changes that might not have a direct assertion.

  it('TOOL_BATCH_DELAY_MS is 5000 ms', () => {
    expect(TOOL_BATCH_DELAY_MS).toBe(5000);
  });

  it('MIN_SEND_GAP_MS is 500 ms', () => {
    expect(MIN_SEND_GAP_MS).toBe(500);
  });

  it('TYPING_REFRESH_MS is 8000 ms', () => {
    expect(TYPING_REFRESH_MS).toBe(8_000);
  });

  it('routes tool-status batches to a redirect JID when configured', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.setToolUpdateRedirectJid('status-log@g.us');
    queue.enqueueToolUpdate({ category: 'running', detail: 'Running migration probe' });
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await queue.flush();

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      'status-log@g.us',
      expect.stringContaining('Running migration probe'),
    );
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(
      CHAT_JID,
      expect.stringContaining('Running migration probe'),
    );
  });

  it('logs and suppresses rejected tool-status redirect sends', async () => {
    mockLog.warn.mockClear();
    const redirectError = new Error('redirect socket unavailable');
    const { messenger } = makeMessenger();
    vi.mocked(messenger.sendMessage).mockImplementation(async (jid: string, text: string) => {
      if (jid === 'status-log@g.us') {
        throw redirectError;
      }
      return { waMessageId: null };
    });
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.setToolUpdateRedirectJid('status-log@g.us');
    queue.enqueueToolUpdate({ category: 'running', detail: 'Running redirect probe' });
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await Promise.resolve();
    queue.abortTurn();

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      'status-log@g.us',
      expect.stringContaining('Running redirect probe'),
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: redirectError,
        target: 'status-log@g.us',
        textLength: expect.any(Number),
      }),
      'tool-status redirect send failed',
    );
  });

  it('keeps normal text delivery on the main chat when tool-status redirect is configured', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.setToolUpdateRedirectJid('status-log@g.us');
    queue.enqueueText('Final answer for the user');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).toHaveBeenCalledWith(CHAT_JID, 'Final answer for the user', { messageId: expect.any(String) });
    expect(messenger.sendMessage).not.toHaveBeenCalledWith(
      'status-log@g.us',
      expect.stringContaining('Final answer'),
    );
  });

  // QR-114: the agent reply path must scrub operator-local internal artifacts
  // before egress (parity with the chat runtime + MCP send tools), on BOTH the
  // enqueued and streamed paths.
  it('redacts internal artifacts from an enqueued agent reply before send', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('Your key lives at ~/.ssh/id_rsa - check it');
    await vi.runAllTimersAsync();
    await queue.flush();

    const sent = calls.join('');
    // Security property: the operator-local path never reaches the user.
    expect(sent).not.toContain('~/.ssh/id_rsa');
    // The redaction marker is present (brackets are stripped by downstream
    // markdown handling; the marker text alone proves redactInternalArtifacts ran).
    expect(sent).toContain('internal-path');
  });

  it('redacts internal artifacts from a streamed agent reply before send', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueStreamingText('config is under ~/.config/whatsoup/instances/example/auth');
    await vi.advanceTimersByTimeAsync(TEXT_AGGREGATE_DELAY_MS);
    await queue.flush();

    const sent = calls.join('');
    expect(sent).not.toContain('~/.config/whatsoup/instances/example/auth');
    expect(sent).toContain('internal-path');
  });

  it('uses the default streaming aggregation window until overridden', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueStreamingText('hello ');
    queue.enqueueStreamingText('world');
    await vi.advanceTimersByTimeAsync(TEXT_AGGREGATE_DELAY_MS - 100);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(['hello world']);
    await queue.flush();
  });

  it('honors a positive streaming aggregation window override', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.setTextAggregateDelayMs(30_000);
    queue.enqueueStreamingText('chunk-a ');
    queue.enqueueStreamingText('chunk-b');

    expect(typingCalls.filter((value) => value === true)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual(['chunk-a chunk-b']);
    await queue.flush();
  });

  it('ignores non-positive streaming aggregation window overrides', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.setTextAggregateDelayMs(0);
    queue.setTextAggregateDelayMs(-500);
    queue.enqueueStreamingText('default-window');

    await vi.advanceTimersByTimeAsync(TEXT_AGGREGATE_DELAY_MS);
    expect(calls).toEqual(['default-window']);
    await queue.flush();
  });

  it('tracks lastActivity when text is enqueued', async () => {
    const { messenger } = makeMessenger();
    vi.setSystemTime(new Date('2026-04-06T00:00:00Z'));
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const queueState = queue as OutboundQueue & { lastActivity?: number };

    expect(queueState.lastActivity).toBe(Date.now());

    vi.setSystemTime(new Date('2026-04-06T00:05:00Z'));
    queue.enqueueText('Hello!');

    expect(queueState.lastActivity).toBe(Date.now());

    await queue.flush();
  });

  it('buffers streaming fragments in parts and clears them after flush', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const queueState = queue as unknown as { streamBufferParts?: string[] };

    queue.enqueueStreamingText('Hel');
    queue.enqueueStreamingText('lo');

    expect(queueState.streamBufferParts).toEqual(['Hel', 'lo']);

    await queue.flush();

    expect(calls).toEqual(['Hello']);
    expect(queueState.streamBufferParts).toEqual([]);
  });

  it('flush updates lastActivity and clears pending work state', async () => {
    const { messenger } = makeMessenger();
    vi.setSystemTime(new Date('2026-04-06T01:00:00Z'));
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const queueState = queue as OutboundQueue & {
      lastActivity?: number;
      hasPendingWork?: () => boolean;
    };

    queue.enqueueStreamingText('partial');
    expect(queueState.hasPendingWork?.()).toBe(true);

    vi.setSystemTime(new Date('2026-04-06T01:07:00Z'));
    await queue.flush();

    expect(queueState.lastActivity).toBe(Date.now());
    expect(queueState.hasPendingWork?.()).toBe(false);
  });

  // ─── Test 1: enqueueText sends immediately (after pacing) ──────────────────

  it('enqueueText sends a short message after pacing', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('Hello!');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['Hello!']);
  });

  it('enqueueText sends the message to the correct chatJid', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('Ping');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).toHaveBeenCalledWith(CHAT_JID, 'Ping', { messageId: expect.any(String) });
  });

  it('converts markdown checkboxes to WhatsApp box characters', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('- [ ] Buy milk\n- [x] Walk dog\n- [X] Call Bob');
    await vi.runAllTimersAsync();

    expect(calls[0]).toBe('▫︎ Buy milk\n▪︎ Walk dog\n▪︎ Call Bob');
  });

  // ─── Test 2: Multiple enqueueToolUpdate within 5s are combined ─────────────

  it('batches multiple enqueueToolUpdate calls within 5s window', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'Tool A started' });
    vi.advanceTimersByTime(MIN_SEND_GAP_MS);
    queue.enqueueToolUpdate({ category: 'running', detail: 'Tool B started' });
    vi.advanceTimersByTime(MIN_SEND_GAP_MS);
    queue.enqueueToolUpdate({ category: 'running', detail: 'Tool C started' });

    // No sends yet — still within the batch window
    expect(calls).toHaveLength(0);

    // Advance past the batch window, then flush (runAllTimersAsync loops on the typing heartbeat)
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await queue.flush(); // clears heartbeat; satisfies leak detector

    expect(calls).toHaveLength(1);
    // All three are in the same 'running' category → single group header + three bullets
    expect(calls[0]).toContain('🔧 Running:');
    expect(calls[0]).toContain('  • Tool A started');
    expect(calls[0]).toContain('  • Tool B started');
    expect(calls[0]).toContain('  • Tool C started');
  });

  it('resets the idle timer on each new enqueueToolUpdate', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'First' });
    vi.advanceTimersByTime(TOOL_BATCH_DELAY_MS - 100); // just inside the window
    // Still within window — send a second update that resets the timer
    queue.enqueueToolUpdate({ category: 'running', detail: 'Second' });
    vi.advanceTimersByTime(TOOL_BATCH_DELAY_MS - 100);
    // Should NOT have sent yet (timer was reset)
    expect(calls).toHaveLength(0);

    // Advance past the window, then flush to drain (runAllTimersAsync loops on heartbeat)
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await queue.flush(); // clears heartbeat; satisfies leak detector

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('🔧 Running:');
    expect(calls[0]).toContain('  • First');
    expect(calls[0]).toContain('  • Second');
  });

  // ─── Test 3: Tool batch flushes after 5s timeout ───────────────────────────

  it('flushes tool batch after TOOL_BATCH_DELAY_MS timeout', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'Running bash...' });
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('🔧 Running:\n  • Running bash...');

    // Heartbeat is still running after the batch fires — flush to clean up
    await queue.flush();
  });

  // ─── Test 4: Message >4000 chars is split ──────────────────────────────────

  it('splits a message longer than 4000 chars at a paragraph break', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    const para1 = 'A'.repeat(2000);
    const para2 = 'B'.repeat(2000);
    const long = `${para1}\n\n${para2}`;
    // length = 2000 + 2 + 2000 = 4002 > 4000

    queue.enqueueText(long);
    await vi.runAllTimersAsync();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const chunk of calls) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    // All content should be present
    const combined = calls.join('');
    expect(combined).toContain(para1.slice(0, 10));
    expect(combined).toContain(para2.slice(0, 10));
  });

  it('splits a message at last space when no paragraph break exists before limit', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    // Build a string just over 4000 chars with only spaces, no \n\n
    const words: string[] = [];
    let len = 0;
    while (len < 4050) {
      const word = 'word';
      words.push(word);
      len += word.length + 1;
    }
    const long = words.join(' ');

    queue.enqueueText(long);
    await vi.runAllTimersAsync();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const chunk of calls) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });

  it('hard-splits a message with no spaces or paragraph breaks', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    const long = 'X'.repeat(4001);
    queue.enqueueText(long);
    await vi.runAllTimersAsync();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const chunk of calls) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    expect(calls.join('')).toBe(long);
  });

  // ─── Test 5: Pacing enforces 500ms minimum gap ─────────────────────────────

  it('enforces 500ms minimum gap between sends', async () => {
    const { messenger } = makeMessenger();
    const sendTimes: number[] = [];

    const timedMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        sendTimes.push(Date.now());
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(timedMessenger, CHAT_JID);
    queue.enqueueText('First');
    queue.enqueueText('Second');
    queue.enqueueText('Third');

    await vi.runAllTimersAsync();

    expect(timedMessenger.sendMessage).toHaveBeenCalledTimes(3);
    // Gap between first and second send should be >= 500ms
    expect(sendTimes[1] - sendTimes[0]).toBeGreaterThanOrEqual(500);
    expect(sendTimes[2] - sendTimes[1]).toBeGreaterThanOrEqual(500);
  });

  // ─── Test 6: shutdown flushes pending ──────────────────────────────────────

  it('shutdown flushes a pending tool buffer', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'Pending update' });
    // Don't advance the 3s timer — call shutdown instead
    const shutdownPromise = queue.shutdown();
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('🔧 Running:\n  • Pending update');
  });

  it('shutdown flushes pending enqueued text', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('Queued message');
    const shutdownPromise = queue.shutdown();
    await vi.runAllTimersAsync();
    await shutdownPromise;

    expect(calls).toContain('Queued message');
  });

  it('flush sends all pending immediately', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'update 1' });
    queue.enqueueToolUpdate({ category: 'running', detail: 'update 2' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('🔧 Running:');
    expect(calls[0]).toContain('  • update 1');
    expect(calls[0]).toContain('  • update 2');
  });

  // ─── Grouped flush logic ───────────────────────────────────────────────────

  it('groups updates by category with header and bullets', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/config.ts' });
    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/main.ts' });
    queue.enqueueToolUpdate({ category: 'running', detail: 'List files in deploy/' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    const msg = calls[0];
    // Reading section
    expect(msg).toContain('📖 Reading:');
    expect(msg).toContain('  • src/config.ts');
    expect(msg).toContain('  • src/main.ts');
    // Running section
    expect(msg).toContain('🔧 Running:');
    expect(msg).toContain('  • List files in deploy/');
    // Reading appears before Running (first-appearance order)
    expect(msg.indexOf('📖 Reading:')).toBeLessThan(msg.indexOf('🔧 Running:'));
  });

  it('preserves first-appearance order across interleaved categories', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running',   detail: 'cmd A' });
    queue.enqueueToolUpdate({ category: 'reading',   detail: 'file B' });
    queue.enqueueToolUpdate({ category: 'running',   detail: 'cmd C' });
    queue.enqueueToolUpdate({ category: 'searching', detail: 'query D' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    const msg = calls[0];
    // 'running' appeared first → before 'reading' → before 'searching'
    expect(msg.indexOf('🔧 Running:')).toBeLessThan(msg.indexOf('📖 Reading:'));
    expect(msg.indexOf('📖 Reading:')).toBeLessThan(msg.indexOf('🔎 Searching:'));
    // cmd A and cmd C are grouped together under Running
    expect(msg).toContain('  • cmd A');
    expect(msg).toContain('  • cmd C');
    expect(msg).toContain('  • file B');
    expect(msg).toContain('  • query D');
  });

  it('renders a single update as a grouped section (no flat line)', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'searching', detail: 'Pinecone query' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('🔎 Searching:\n  • Pinecone query');
  });

  it('separates multiple category groups with a blank line', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'reading',  detail: 'a' });
    queue.enqueueToolUpdate({ category: 'fetching', detail: 'b' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    // Two sections separated by a blank line
    expect(calls[0]).toBe('📖 Reading:\n  • a\n\n🌐 Fetching:\n  • b');
  });

  // ─── Typing indicator ──────────────────────────────────────────────────────

  it('starts typing on first enqueueToolUpdate', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'doing work' });

    expect(typingCalls).toContain(true);
    expect(messenger.setTyping).toHaveBeenCalledWith(CHAT_JID, true);

    queue.abortTurn(); // clean up heartbeat
  });

  it('starts typing only once for multiple tool updates in the same turn', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'first' });
    queue.enqueueToolUpdate({ category: 'reading', detail: 'second' });
    queue.enqueueToolUpdate({ category: 'searching', detail: 'third' });

    expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

    queue.abortTurn(); // clean up heartbeat
  });

  it('typing persists through flushToolBuffer and stops with paused on flush()', async () => {
    // Typing indicator must stay alive for the entire turn — it should NOT be
    // cleared when an intermediate batch message is delivered. Only flush()
    // (triggered by the result event) should send 'paused'.
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'doing work' });
    // Typing is now on — no paused should have been sent yet
    expect(typingCalls.filter((v) => v === false)).toHaveLength(0);

    // Flush (simulates result event) → should stop typing with 'paused'
    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(typingCalls.filter((v) => v === false)).toHaveLength(1);
  });

  it('typing heartbeat re-asserts composing every TYPING_REFRESH_MS while a turn is active', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'long task' });
    // Initial composing sent immediately
    expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

    // Advance one refresh period → heartbeat fires once.
    // The tool batch timer also fires, sending the batched message.
    // After delivery, composing is re-asserted (line 274 in outbound-queue.ts).
    // So we get: heartbeat + re-assert-after-delivery = +2
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    const countAfterFirst = typingCalls.filter((v) => v === true).length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(2);

    // Advance another refresh period → heartbeat fires again
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    const countAfterSecond = typingCalls.filter((v) => v === true).length;
    expect(countAfterSecond).toBeGreaterThan(countAfterFirst);

    // Flush should stop the heartbeat and send paused
    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(typingCalls.filter((v) => v === false).length).toBeGreaterThanOrEqual(1);

    // After flush, heartbeat must be cleared — advancing time should not fire again
    const countBeforeIdle = typingCalls.filter((v) => v === true).length;
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
    expect(typingCalls.filter((v) => v === true)).toHaveLength(countBeforeIdle); // unchanged
  });

  it('abortTurn() clears timers and typing without sending paused', async () => {
    // On crash the typing indicator must NOT be explicitly stopped — it should
    // time out naturally on the recipient's side as a soft signal of trouble.
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'doing work' });
    expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

    queue.abortTurn();

    // No 'paused' must have been sent
    expect(typingCalls.filter((v) => v === false)).toHaveLength(0);

    // Heartbeat must be cleared — advancing 16s should not fire setTyping again
    await vi.advanceTimersByTimeAsync(16_000);
    expect(typingCalls.filter((v) => v === true)).toHaveLength(1); // unchanged
  });

  it('starts a new turn correctly after abortTurn()', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'first turn' });
    queue.abortTurn(); // clears first turn's heartbeat

    // New turn — typing should re-start
    queue.enqueueToolUpdate({ category: 'reading', detail: 'second turn' });
    expect(typingCalls.filter((v) => v === true)).toHaveLength(2);

    queue.abortTurn(); // clean up second turn's heartbeat
  });

  it('does not call setTyping on plain enqueueText (no tool activity)', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('plain response');
    await vi.runAllTimersAsync();

    expect(messenger.setTyping).not.toHaveBeenCalled();
  });

  it('suppresses typing transport rejections during start, refresh, and stop', async () => {
    const typingCalls: Array<boolean> = [];
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async (_jid: string, typing: boolean) => {
        typingCalls.push(typing);
        throw new Error(`typing ${typing ? 'start' : 'stop'} failed`);
      }),
    };
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.indicateTyping();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS);
    queue.endTurn();
    await Promise.resolve();

    expect(messenger.setTyping).toHaveBeenCalledWith(CHAT_JID, true);
    expect(typingCalls.filter((value) => value === true).length).toBeGreaterThanOrEqual(2);
    expect(typingCalls.filter((value) => value === false)).toHaveLength(1);
  });

  // ─── Serialization ─────────────────────────────────────────────────────────

  it('sends messages serially (only one in-flight at a time)', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const pending = new Map<string, ReturnType<typeof deferred<{ waMessageId: null }>>>();
    let concurrent = 0;

    const serialMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, text: string) => {
        concurrent += 1;
        started.push(text);
        const send = deferred<{ waMessageId: null }>();
        pending.set(text, send);
        try {
          return await send.promise;
        } finally {
          concurrent -= 1;
          finished.push(text);
        }
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(serialMessenger, CHAT_JID);
    queue.enqueueText('A');
    queue.enqueueText('B');
    queue.enqueueText('C');

    await vi.waitFor(() => {
      expect(serialMessenger.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(started).toEqual(['A']);
    expect(concurrent).toBe(1);

    pending.get('A')!.resolve({ waMessageId: null });
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
    await vi.waitFor(() => {
      expect(serialMessenger.sendMessage).toHaveBeenCalledTimes(2);
    });
    expect(started).toEqual(['A', 'B']);
    expect(finished).toEqual(['A']);
    expect(concurrent).toBe(1);

    pending.get('B')!.resolve({ waMessageId: null });
    await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
    await vi.waitFor(() => {
      expect(serialMessenger.sendMessage).toHaveBeenCalledTimes(3);
    });
    expect(started).toEqual(['A', 'B', 'C']);
    expect(finished).toEqual(['A', 'B']);
    expect(concurrent).toBe(1);

    pending.get('C')!.resolve({ waMessageId: null });
    await queue.flush();

    expect(finished).toEqual(['A', 'B', 'C']);
    expect(concurrent).toBe(0);
  });

  // ─── Retry tests ───────────────────────────────────────────────────────────

  it('retries on transient failure: fails twice, succeeds on 3rd attempt', async () => {
    mockLog.error.mockClear();
    mockLog.warn.mockClear();
    let callCount = 0;
    const retryMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, _text: string) => {
        callCount += 1;
        if (callCount < 3) {
          throw new Error('transient error');
        }
        // 3rd call succeeds
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(retryMessenger, CHAT_JID);
    queue.enqueueText('retry me');
    await vi.runAllTimersAsync();

    expect(retryMessenger.sendMessage).toHaveBeenCalledTimes(3);
    // No error logged because final attempt succeeded
    expect(mockLog.error).not.toHaveBeenCalled();
    // Warn logged once per failed attempt (2 failures before the successful 3rd)
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
  });

  it('suppresses a duplicate terminal text enqueue within the dedupe window', async () => {
    mockLog.info.mockClear();
    const { messenger, calls } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('There was an issue with my conversation data. An operator has been notified.');
    await vi.runAllTimersAsync();
    queue.markLastTerminal({ dedupeText: true });

    queue.enqueueText('There was an issue with my conversation data. An operator has been notified.');
    await vi.runAllTimersAsync();

    expect(calls).toEqual([
      'There was an issue with my conversation data. An operator has been notified.',
    ]);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: CHAT_JID,
        opType: 'text',
        terminal: true,
        suppressedCount: 1,
      }),
      'suppressed duplicate outbound terminal text',
    );
    expect(JSON.stringify(mockLog.info.mock.calls)).not.toContain('There was an issue with my conversation data');
  });

  it('does not suppress repeated nonterminal assistant text', async () => {
    const { messenger, calls } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('Repeat this exact instruction.');
    queue.enqueueText('Repeat this exact instruction.');
    await vi.runAllTimersAsync();

    expect(calls).toEqual([
      'Repeat this exact instruction.',
      'Repeat this exact instruction.',
    ]);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(2);
  });

  it('does not suppress ordinary terminal bookkeeping unless text dedupe is requested', async () => {
    const { messenger, calls } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('Repeatable normal answer');
    await vi.runAllTimersAsync();
    queue.markLastTerminal();

    queue.enqueueText('Repeatable normal answer');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['Repeatable normal answer', 'Repeatable normal answer']);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(2);
  });

  it('does not suppress a distinct terminal follow-up text', async () => {
    const { messenger, calls } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('Terminal notice A');
    await vi.runAllTimersAsync();
    queue.markLastTerminal({ dedupeText: true });

    queue.enqueueText('Terminal notice B');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['Terminal notice A', 'Terminal notice B']);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(2);
  });

  it('does not suppress matching terminal text across different chats', async () => {
    const chatA = makeMessenger();
    const chatB = makeMessenger();
    const queueA = new OutboundQueue(chatA.messenger, CHAT_JID);
    const queueB = new OutboundQueue(chatB.messenger, 'other@s.whatsapp.net');
    queueA.setDurability(makeDurabilityStub());
    queueB.setDurability(makeDurabilityStub());

    queueA.enqueueText('Shared terminal notice');
    await vi.runAllTimersAsync();
    queueA.markLastTerminal({ dedupeText: true });

    queueB.enqueueText('Shared terminal notice');
    await vi.runAllTimersAsync();

    expect(chatA.calls).toEqual(['Shared terminal notice']);
    expect(chatB.calls).toEqual(['Shared terminal notice']);
  });

  it('allows matching terminal text after the dedupe window expires', async () => {
    const { messenger, calls } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    vi.setSystemTime(new Date('2026-06-13T07:00:00Z'));
    queue.enqueueText('Windowed terminal notice');
    await vi.runAllTimersAsync();
    queue.markLastTerminal({ dedupeText: true });

    vi.setSystemTime(Date.now() + TERMINAL_TEXT_DEDUPE_WINDOW_MS + 1);
    queue.enqueueText('Windowed terminal notice');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['Windowed terminal notice', 'Windowed terminal notice']);
    expect(durability.createOutboundOp).toHaveBeenCalledTimes(2);
  });

  it('logs error and keeps queue draining when all 3 attempts fail', async () => {
    mockLog.error.mockClear();
    const failMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        throw new Error('permanent failure');
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const successCalls: string[] = [];
    // We'll chain a second queue item after the first fails completely
    // by using a separate messenger that tracks success
    let callNum = 0;
    const mixedMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, text: string) => {
        callNum += 1;
        // First 3 calls (for 'bad message') always fail
        // Call 4 is the delivery-failure notice (should succeed)
        // Call 5+ (for 'good message') succeed
        if (callNum <= 3) {
          throw new Error('permanent failure');
        }
        successCalls.push(text);
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(mixedMessenger, CHAT_JID);
    queue.enqueueText('bad message');
    queue.enqueueText('good message');
    await vi.runAllTimersAsync();

    // Error was logged for exhausted retries on 'bad message'
    expect(mockLog.error).toHaveBeenCalledOnce();
    const [errorArg, errorMsg] = mockLog.error.mock.calls[0];
    expect(errorArg).toMatchObject({ attempts: 3 });
    expect(typeof errorArg.textPreview).toBe('string');
    expect(errorMsg).toContain('retries');

    // Delivery-failure notice was sent
    expect(successCalls.some((t) => t.includes('could not be delivered'))).toBe(true);
    // Queue kept draining — 'good message' was delivered
    expect(successCalls.some((t) => t === 'good message')).toBe(true);
  });

  it('resets sending when the drain safety-net catches an unexpected pacing failure', async () => {
    mockLog.error.mockClear();
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    const internals = queue as unknown as {
      sendWithPacing: (text: string) => Promise<void>;
      sending: boolean;
      chain: Promise<void>;
    };
    const pacingError = new Error('unexpected pacing failure');
    internals.sendWithPacing = vi.fn(async () => {
      throw pacingError;
    });

    queue.enqueueText('message that trips the safety net');
    await internals.chain;

    expect(internals.sendWithPacing).toHaveBeenCalledWith('message that trips the safety net');
    expect(mockLog.error).toHaveBeenCalledWith(
      { err: pacingError },
      'drain queue error — resetting',
    );
    expect(internals.sending).toBe(false);
  });

  // ─── updateDeliveryJid ─────────────────────────────────────────────────────

  it('updateDeliveryJid retargets subsequent sends', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, 'original@s.whatsapp.net');

    queue.updateDeliveryJid('new@lid');
    queue.enqueueText('Hello retargeted');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).toHaveBeenCalledWith('new@lid', 'Hello retargeted', { messageId: expect.any(String) });
    expect(messenger.sendMessage).not.toHaveBeenCalledWith('original@s.whatsapp.net', expect.anything());
  });

  it('applies jitter so two consecutive retries use different delays', async () => {
    mockLog.error.mockClear();

    // Pin Math.random to two deterministic but different values across two calls.
    // Attempt 0 retry: random=0.0  → jitter factor = 0.75 + 0.0*0.5 = 0.75 → delay = 750ms
    // Attempt 1 retry: random=1.0  → jitter factor = 0.75 + 1.0*0.5 = 1.25 → delay = 2500ms
    // (base for attempt 0 = 1000ms, base for attempt 1 = 2000ms)
    const randomValues = [0.0, 1.0];
    let randomCallIndex = 0;
    const mathRandomSpy = vi.spyOn(Math, 'random').mockImplementation(() => {
      const v = randomValues[randomCallIndex % randomValues.length];
      randomCallIndex += 1;
      return v;
    });

    let callCount = 0;
    // Fail all 3 attempts so we can observe both retry delays fire
    const alwaysFailMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        throw new Error('fail');
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(alwaysFailMessenger, CHAT_JID);
    queue.enqueueText('test jitter');
    await vi.runAllTimersAsync();

    mathRandomSpy.mockRestore();

    // All 3 attempts exhausted, plus 1 best-effort notice call
    expect(alwaysFailMessenger.sendMessage).toHaveBeenCalledTimes(4);
    // Error logged
    expect(mockLog.error).toHaveBeenCalledOnce();

    // Verify that different random values were used (jitter was applied per attempt).
    // With random=0.0 → delay=750ms; random=1.0 → delay=2500ms.
    // The two delays (randomCallIndex advanced twice) confirm non-identical backoff.
    expect(randomCallIndex).toBeGreaterThanOrEqual(2);
  });

  it('honors structured rate-limit retryAfterMs before retrying', async () => {
    mockLog.warn.mockClear();
    let callCount = 0;
    const rateLimitedMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new RateLimitedError({
            channelId: makeChannelId('whatsapp', 'test'),
            operation: 'sendText',
            correlationId: 'corr-rate-limit',
            message: 'rate limited',
            scope: 'provider',
            retryAfterMs: 4_000,
          });
        }
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(rateLimitedMessenger, CHAT_JID);
    queue.enqueueText('respect retry-after');

    await vi.advanceTimersByTimeAsync(0);
    expect(rateLimitedMessenger.sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(rateLimitedMessenger.sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await queue.flush();

    expect(rateLimitedMessenger.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ retryAfterMs: 4_000 }),
      expect.stringContaining('retrying'),
    );
  });

  // ─── B05: Empty string guard ───────────────────────────────────────────────

  it('B05: enqueueText silently drops empty string', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('');
    await vi.runAllTimersAsync();

    expect(calls).toHaveLength(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('B05: enqueueText silently drops whitespace-only string', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueText('   \n\t  ');
    await vi.runAllTimersAsync();

    expect(calls).toHaveLength(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  // ─── B07: Queue exhaustion notification ───────────────────────────────────

  it('B07: sends exact failure notice after MAX_SEND_ATTEMPTS retries exhausted', async () => {
    mockLog.error.mockClear();
    const noticeCalls: string[] = [];
    let callNum = 0;
    const exhaustedMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, text: string) => {
        callNum += 1;
        // First 3 attempts fail (the original message)
        if (callNum <= 3) throw new Error('permanent failure');
        // Call 4 is the best-effort notice — capture it
        noticeCalls.push(text);
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(exhaustedMessenger, CHAT_JID);
    queue.enqueueText('message that will fail');
    await vi.runAllTimersAsync();

    expect(noticeCalls).toHaveLength(1);
    expect(noticeCalls[0]).toBe('⚠️ A response could not be delivered after 3 attempts.');
  });

  // ─── B12: Retry warn logs shape ───────────────────────────────────────────

  it('B12: warn log includes chatJid, attempt, maxAttempts, textPreview on each retry', async () => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
    let callCount = 0;
    const retryMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount < 3) throw new Error('transient');
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(retryMessenger, CHAT_JID);
    queue.enqueueText('retry shape test');
    await vi.runAllTimersAsync();

    // 2 retries before success on attempt 3
    expect(mockLog.warn).toHaveBeenCalledTimes(2);
    for (const [warnArg] of mockLog.warn.mock.calls) {
      expect(warnArg).toMatchObject({
        chatJid: CHAT_JID,
        maxAttempts: 3,
      });
      expect(typeof warnArg.attempt).toBe('number');
      expect(typeof warnArg.textPreview).toBe('string');
    }
  });

  it('B12: terminal failure error log includes chatJid, err, and textLength', async () => {
    mockLog.error.mockClear();
    let callNum = 0;
    const alwaysFailMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callNum += 1;
        if (callNum <= 3) throw new Error('hard fail');
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(alwaysFailMessenger, CHAT_JID);
    queue.enqueueText('terminal shape test');
    await vi.runAllTimersAsync();

    expect(mockLog.error).toHaveBeenCalledOnce();
    const [errorArg] = mockLog.error.mock.calls[0];
    expect(errorArg).toMatchObject({ chatJid: CHAT_JID, attempts: 3 });
    expect(typeof errorArg.textLength).toBe('number');
    expect(errorArg.textLength).toBe('terminal shape test'.length);
    expect(errorArg.err).toBeInstanceOf(Error);
    expect((errorArg.err as Error).message).toBe('hard fail');
  });

  // ─── enqueueProgressUpdate ──────────────────────────────────────────────

  describe('enqueueProgressUpdate', () => {
    const INSTANCE = 'TestBot';

    it('renders thinking_long in full mode', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('full');

      const event: ProgressEvent = { type: 'thinking_long', gapMs: 10_000 };
      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.runAllTimersAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(INSTANCE);
      expect(calls[0]).toContain('thinking');
    });

    it('renders operation_progress with elapsed time in full mode', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('full');

      const event: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 135_000,
        state: 'running',
      };
      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.runAllTimersAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('2m 15s');
      expect(calls[0]).toContain('running Bash');
    });

    it('renders operation_progress for Agent tool as "running a subagent" in full mode', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('full');

      const event: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-2',
        toolName: 'Agent',
        category: 'agent',
        elapsedMs: 30_000,
        state: 'running',
      };
      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.runAllTimersAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('running a subagent');
      expect(calls[0]).toContain('30s');
    });

    it('renders only first operation_progress in friendly mode', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');

      const event1: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 10_000,
        state: 'running',
      };
      const event2: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 20_000,
        state: 'running',
      };

      queue.enqueueProgressUpdate(event1, INSTANCE);
      await vi.runAllTimersAsync();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('working on something');

      queue.enqueueProgressUpdate(event2, INSTANCE);

      // Second event for same toolId only triggers typing, no new message
      expect(calls).toHaveLength(1);
      expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

      await queue.flush(); // clean up typing interval
    });

    it('suppresses operation_progress in minimal mode', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('minimal');

      const event: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 10_000,
        state: 'running',
      };
      queue.enqueueProgressUpdate(event, INSTANCE);

      // No message sent, only typing
      expect(calls).toHaveLength(0);
      expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

      queue.abortTurn(); // clean up typing interval
    });

    it('renders operation_stalled as still-working copy with elapsed time in full and friendly modes', async () => {
      const baseEvent = {
        type: 'operation_stalled' as const,
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running' as const,
        elapsedMs: 65_000,
      };

      for (const mode of ['full', 'friendly'] as const) {
        const { messenger, calls } = makeMessenger();
        const queue = new OutboundQueue(messenger, CHAT_JID);
        queue.setToolUpdateMode(mode);

        queue.enqueueProgressUpdate(baseEvent, INSTANCE);
        await vi.runAllTimersAsync();

        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls[0]).toContain('Still working');
        expect(calls[0]).toContain('1m 5s');
        expect(calls[0]).not.toContain('Something went wrong');
        expect(calls[0]).not.toContain('stuck');
      }
    });

    it('suppresses operation_slow and operation_stalled text in minimal mode', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('minimal');

      queue.enqueueProgressUpdate(
        {
          type: 'operation_slow',
          toolId: 'tool-1',
          toolName: 'Bash',
          category: 'running',
          elapsedMs: 45_000,
          expectedMs: 15_000,
        },
        INSTANCE,
      );
      queue.enqueueProgressUpdate(
        {
          type: 'operation_stalled',
          toolId: 'tool-1',
          toolName: 'Bash',
          category: 'running',
          elapsedMs: 65_000,
        },
        INSTANCE,
      );
      await vi.runOnlyPendingTimersAsync();

      expect(calls).toHaveLength(0);
      expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(2);

      queue.abortTurn();
    });

    it('renders operation_slow differently per mode', async () => {
      const baseEvent = {
        type: 'operation_slow' as const,
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running' as const,
        elapsedMs: 45_000,
        expectedMs: 15_000,
      };

      // Full mode — contains elapsed and instance name
      const full = makeMessenger();
      const qFull = new OutboundQueue(full.messenger, CHAT_JID);
      qFull.setToolUpdateMode('full');
      qFull.enqueueProgressUpdate(baseEvent, INSTANCE);
      await vi.runAllTimersAsync();
      expect(full.calls).toHaveLength(1);
      expect(full.calls[0]).toContain('45s');
      expect(full.calls[0]).toContain(INSTANCE);

      // Friendly mode — contains instance name, simpler language
      const friendly = makeMessenger();
      const qFriendly = new OutboundQueue(friendly.messenger, CHAT_JID);
      qFriendly.setToolUpdateMode('friendly');
      qFriendly.enqueueProgressUpdate(baseEvent, INSTANCE);
      await vi.runAllTimersAsync();
      expect(friendly.calls).toHaveLength(1);
      expect(friendly.calls[0]).toContain('still working');
      expect(friendly.calls[0]).toContain(INSTANCE);

      // Minimal mode — typing only, no placeholder message
      const minimal = makeMessenger();
      const qMinimal = new OutboundQueue(minimal.messenger, CHAT_JID);
      qMinimal.setToolUpdateMode('minimal');
      qMinimal.enqueueProgressUpdate(baseEvent, INSTANCE);
      await vi.runAllTimersAsync();
      expect(minimal.calls).toHaveLength(0);
      expect(minimal.typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

      qMinimal.abortTurn();
    });

    it('coalesces identical concurrent operation_slow placeholders into one message', async () => {
      // Reproduces the "Still working… x3 back to back" report: a parallel tool
      // batch arms one slow-timer per tool; in friendly mode every operation_slow
      // renders the same visible progress placeholder. Without coalescing the
      // user receives N identical messages.
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');

      for (const toolId of ['tool-a', 'tool-b', 'tool-c']) {
        queue.enqueueProgressUpdate(
          {
            type: 'operation_slow',
            toolId,
            toolName: 'Read',
            category: 'reading',
            elapsedMs: 9_000,
            expectedMs: 3_000,
          },
          INSTANCE,
        );
      }
      // Bounded advance: drains the single send without looping on the typing heartbeat
      // that the suppressed duplicates re-assert.
      await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);

      expect(calls).toEqual([`_${INSTANCE} is still working on it..._`]);

      queue.abortTurn(); // clean up typing interval
    });

    it('allows an identical progress placeholder again after the dedupe window elapses', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');
      queue.setProgressFloorMs(0); // isolate the 30s text-window layer; floor covered separately

      const event: ProgressEvent = {
        type: 'operation_slow',
        toolId: 'tool-a',
        toolName: 'Read',
        category: 'reading',
        elapsedMs: 9_000,
        expectedMs: 3_000,
      };

      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
      expect(calls).toHaveLength(1);

      // A second identical placeholder inside the window is suppressed…
      queue.enqueueProgressUpdate({ ...event, toolId: 'tool-b' }, INSTANCE);
      await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
      expect(calls).toHaveLength(1);

      // …but once the window passes, a genuine later nudge is allowed through.
      // (flush() would reset the dedupe map, so advance fake time instead.)
      await vi.advanceTimersByTimeAsync(PROGRESS_TEXT_DEDUPE_WINDOW_MS + 1);
      queue.enqueueProgressUpdate({ ...event, toolId: 'tool-c' }, INSTANCE);
      await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS);
      expect(calls).toHaveLength(2);

      queue.abortTurn(); // clean up typing interval
    });

    it('does NOT coalesce progress placeholders that render distinct text', async () => {
      // Safety boundary for the coalescing fix: only *identical* text is suppressed.
      // Two slow events with different elapsed render different strings and must both send,
      // so genuinely distinct progress information is never lost.
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('full');
      queue.setProgressFloorMs(0); // isolate the 30s text-window layer; floor covered separately

      queue.enqueueProgressUpdate(
        { type: 'operation_slow', toolId: 't1', toolName: 'Bash', category: 'running', elapsedMs: 45_000, expectedMs: 15_000 },
        INSTANCE,
      );
      queue.enqueueProgressUpdate(
        { type: 'operation_slow', toolId: 't2', toolName: 'Bash', category: 'running', elapsedMs: 90_000, expectedMs: 15_000 },
        INSTANCE,
      );
      await vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS * 2);

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('45s');
      expect(calls[1]).toContain('1m 30s');

      queue.abortTurn(); // clean up typing interval
    });

    it('suppresses thinking_long in minimal mode', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('minimal');

      queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 10_000 }, INSTANCE);

      expect(calls).toHaveLength(0);
      expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

      queue.abortTurn(); // clean up typing interval
    });

    it('renders thinking_stalled in full mode and typing only in minimal mode', async () => {
      // Full mode
      const full = makeMessenger();
      const qFull = new OutboundQueue(full.messenger, CHAT_JID);
      qFull.setToolUpdateMode('full');
      qFull.enqueueProgressUpdate({ type: 'thinking_stalled', gapMs: 60_000 }, INSTANCE);
      await vi.runAllTimersAsync();
      expect(full.calls).toHaveLength(1);
      expect(full.calls[0]).toContain('gone silent');

      // Minimal mode
      const minimal = makeMessenger();
      const qMinimal = new OutboundQueue(minimal.messenger, CHAT_JID);
      qMinimal.setToolUpdateMode('minimal');
      qMinimal.enqueueProgressUpdate({ type: 'thinking_stalled', gapMs: 60_000 }, INSTANCE);
      await vi.runAllTimersAsync();
      expect(minimal.calls).toHaveLength(0);
      expect(minimal.typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

      qMinimal.abortTurn();
    });

    it('clears friendlyProgressSent on abortTurn', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');
      queue.setProgressFloorMs(0); // isolate friendlyProgressSent reset; floor covered separately

      const event: ProgressEvent = {
        type: 'operation_progress',
        toolId: 'tool-1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 10_000,
        state: 'running',
      };

      // First progress shows message
      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.runAllTimersAsync();
      expect(calls).toHaveLength(1);

      // Abort clears dedup set
      queue.abortTurn();

      // Same toolId now shows message again
      queue.enqueueProgressUpdate(event, INSTANCE);
      await vi.runAllTimersAsync();
      expect(calls).toHaveLength(2);
    });
  });

  // ─── formatElapsed: exact-minute branch ──────────────────────────────────

  it('formatElapsed returns "Nm" (no seconds) when elapsed is an exact minute multiple', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');

    // 120 000 ms = 2m exactly → formatElapsed returns "2m" not "2m 0s"
    const event: ProgressEvent = {
      type: 'operation_progress',
      toolId: 'tool-exact-min',
      toolName: 'Bash',
      category: 'running',
      elapsedMs: 120_000,
      state: 'running',
    };
    queue.enqueueProgressUpdate(event, 'Bot');
    await vi.runAllTimersAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('2m');
    expect(calls[0]).not.toMatch(/2m \d+s/);
  });

  // ─── enqueueStreamingText: empty string guard ─────────────────────────────

  it('enqueueStreamingText ignores an empty string without starting typing', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueStreamingText('');

    // Empty string → early return → no typing indicator, no timer to clean up
    expect(typingCalls).toHaveLength(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    queue.abortTurn();
  });

  // ─── enqueueResultText branches ───────────────────────────────────────────

  it('enqueueResultText drops empty string', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueResultText('');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('enqueueResultText drops whitespace-only string', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueResultText('   ');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('enqueueResultText passes through in minimal mode when no visible text yet in turn', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    // No turnHasVisibleText yet → should pass through
    queue.enqueueResultText('Summary for the user');
    await vi.runAllTimersAsync();

    expect(calls).toEqual(['Summary for the user']);
  });

  it('enqueueResultText suppresses in minimal mode when visible text already sent', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    // Send visible text first (marks turnHasVisibleText)
    queue.enqueueText('Real response to user');
    await vi.runAllTimersAsync();

    const callCountBefore = calls.length;
    queue.enqueueResultText('Internal summary that should be suppressed');
    await vi.runAllTimersAsync();

    expect(calls).toHaveLength(callCountBefore); // no new message added
  });

  // ─── shouldShowMinimal: all switch branches ───────────────────────────────

  it('shouldShowMinimal: searching with "Checking my notes" prefix passes through in minimal mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    queue.enqueueToolUpdate({ category: 'searching', detail: 'Checking my notes on TypeScript' });
    await vi.advanceTimersByTimeAsync(1_500 + 100); // minimal mode uses 1500ms idle delay
    await queue.flush();

    expect(calls.some((c) => c.includes('Checking my notes on TypeScript'))).toBe(true);
  });

  it('shouldShowMinimal: searching without "Checking my notes" prefix is suppressed in minimal mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    queue.enqueueToolUpdate({ category: 'searching', detail: 'Pinecone semantic search' });
    await vi.advanceTimersByTimeAsync(1_500 + 100);
    await queue.flush();

    // Suppressed — only typing was activated, no message sent
    expect(calls).toHaveLength(0);
  });

  it('shouldShowMinimal: fetching category passes through in minimal mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    queue.enqueueToolUpdate({ category: 'fetching', detail: 'fetch-detail-marker' });
    await vi.advanceTimersByTimeAsync(1_500 + 100);
    await queue.flush();

    expect(calls.some((c) => c.includes('fetch-detail-marker'))).toBe(true);
  });

  it('shouldShowMinimal: skill, planning, blocked, cancelled, reading, modifying suppressed in minimal mode', async () => {
    const suppressedCategories: ToolUpdate['category'][] = [
      'skill', 'planning', 'blocked', 'cancelled', 'reading', 'modifying',
    ];
    for (const category of suppressedCategories) {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('minimal');

      queue.enqueueToolUpdate({ category, detail: `testing ${category}` });
      await vi.advanceTimersByTimeAsync(1_500 + 100);
      await queue.flush();

      expect(calls, `category '${category}' should be suppressed in minimal mode`).toHaveLength(0);
    }
  });

  it('shouldShowMinimal: error, agent, running, other suppressed in minimal mode', async () => {
    const suppressedCategories: ToolUpdate['category'][] = ['error', 'agent', 'running', 'other'];
    for (const category of suppressedCategories) {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('minimal');

      queue.enqueueToolUpdate({ category, detail: `testing ${category}` });
      await vi.advanceTimersByTimeAsync(1_500 + 100);
      await queue.flush();

      expect(calls, `category '${category}' should be suppressed in minimal mode`).toHaveLength(0);
    }
  });

  // ─── enqueueToolUpdate: friendly mode skip for skill/cancelled ────────────

  it('friendly mode: skill updates are suppressed (only typing activated)', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('friendly');

    queue.enqueueToolUpdate({ category: 'skill', detail: 'Loading skill context' });
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await queue.flush();

    expect(calls).toHaveLength(0);
    expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);
  });

  it('friendly mode: cancelled updates are suppressed (only typing activated)', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('friendly');

    queue.enqueueToolUpdate({ category: 'cancelled', detail: 'Cancelled operation' });
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
    await queue.flush();

    expect(calls).toHaveLength(0);
    expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);
  });

  it('friendly mode: non-suppressed categories use FRIENDLY_CATEGORY_META labels', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('friendly');

    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/app.ts' });
    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    // Friendly mode uses different label: "Looking at" not "Reading"
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Looking at');
    expect(calls[0]).not.toContain('📖 Reading:');
  });

  // ─── enqueueToolUpdate: minimal mode uses 1500ms delay ──────────────────

  it('minimal mode uses 1500ms idle timer (not 5000ms)', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    // fetching passes through in minimal mode
    queue.enqueueToolUpdate({ category: 'fetching', detail: 'api.example.com' });

    // Should NOT have fired after 1400ms
    await vi.advanceTimersByTimeAsync(1_400);
    expect(calls).toHaveLength(0);

    // Should fire after 1500ms
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    await queue.flush();
  });

  // ─── TOOL_BATCH_MAX_AGE_MS fires even when idle timer keeps resetting ────

  it('max-age timer fires after TOOL_BATCH_MAX_AGE_MS even when idle timer resets', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    // Keep sending updates to reset the idle timer every 4s
    queue.enqueueToolUpdate({ category: 'running', detail: 'step 1' });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.enqueueToolUpdate({ category: 'running', detail: 'step 2' });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.enqueueToolUpdate({ category: 'running', detail: 'step 3' });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.enqueueToolUpdate({ category: 'running', detail: 'step 4' });
    await vi.advanceTimersByTimeAsync(4_000);
    queue.enqueueToolUpdate({ category: 'running', detail: 'step 5' });
    // At this point 16s have elapsed total — max-age (30s) has not fired yet
    expect(calls).toHaveLength(0);

    // Advance to just past 30s total — max-age fires
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_MAX_AGE_MS - 16_000 + 100);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('step 1');
    expect(calls[0]).toContain('step 5');

    await queue.flush();
  });

  // ─── flushToolBuffer: detail deduplication within a category ─────────────

  it('deduplicates identical detail strings within the same category', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/config.ts' });
    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/config.ts' }); // duplicate
    queue.enqueueToolUpdate({ category: 'reading', detail: 'src/main.ts' });

    const flushPromise = queue.flush();
    await vi.runAllTimersAsync();
    await flushPromise;

    expect(calls).toHaveLength(1);
    // src/config.ts appears only once despite being added twice
    const matches = (calls[0].match(/src\/config\.ts/g) ?? []).length;
    expect(matches).toBe(1);
    expect(calls[0]).toContain('src/main.ts');
  });

  // ─── markLastTerminal: skipDurabilityMark option ─────────────────────────

  it('markLastTerminal with skipDurabilityMark:true does not call durability.markTerminal', async () => {
    const { messenger } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('Hello');
    await vi.runAllTimersAsync();

    queue.markLastTerminal({ skipDurabilityMark: true });

    expect(durability.markTerminal).not.toHaveBeenCalled();
  });

  it('markLastTerminal without skipDurabilityMark calls durability.markTerminal', async () => {
    const { messenger } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('Hello');
    await vi.runAllTimersAsync();

    queue.markLastTerminal();

    expect(durability.markTerminal).toHaveBeenCalledOnce();
  });

  // ─── markLastTerminal: dedupeText=true but no lastSubmittedTextDedupeKey ──

  it('markLastTerminal with dedupeText:true is a no-op when no text has been submitted yet', async () => {
    const { messenger } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    // Call markLastTerminal before any text is sent → lastSubmittedTextDedupeKey is undefined
    queue.markLastTerminal({ dedupeText: true });

    // No errors, queue still functional
    queue.enqueueText('Subsequent text');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).toHaveBeenCalledWith(CHAT_JID, 'Subsequent text', { messageId: expect.any(String) });
  });

  // ─── durability: markMaybeSent after retry exhaustion ────────────────────

  it('markMaybeSent called with error message when all retries fail and opId is set', async () => {
    const durability = makeDurabilityStub();
    let callNum = 0;
    const failMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callNum += 1;
        if (callNum <= 3) throw new Error('socket_error');
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(failMessenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('durability retry test');
    await vi.runAllTimersAsync();

    expect(durability.markMaybeSent).toHaveBeenCalledOnce();
    const [opIdArg, msgArg] = (durability.markMaybeSent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(typeof opIdArg).toBe('number');
    expect(typeof msgArg).toBe('string');
    expect(msgArg).toBe('socket_error');
  });

  // ─── retryAfterMs: boundary conditions ───────────────────────────────────

  it('retryAfterMs: non-numeric retryAfterMs in payload falls back to jitter delay', async () => {
    mockLog.warn.mockClear();
    let callCount = 0;
    const nonNumericPayloadMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          // payload.retryAfterMs is a string — should NOT be used, falls back to jitter
          const err: Error & { payload?: unknown } = new Error('bad_format');
          err.payload = { retryAfterMs: 'not-a-number' };
          throw err;
        }
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(nonNumericPayloadMessenger, CHAT_JID);
    queue.enqueueText('retryAfterMs string test');
    await vi.runAllTimersAsync();

    // Succeeded on second attempt — warn logged once
    expect(mockLog.warn).toHaveBeenCalledOnce();
    const [warnArg] = mockLog.warn.mock.calls[0];
    // No retryAfterMs field in warn log because the value was non-numeric
    expect(warnArg).not.toHaveProperty('retryAfterMs');
  });

  it('retryAfterMs: negative retryAfterMs in payload falls back to jitter delay', async () => {
    mockLog.warn.mockClear();
    let callCount = 0;
    const negativePayloadMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          const err: Error & { payload?: unknown } = new Error('rate_limited');
          err.payload = { retryAfterMs: -500 };
          throw err;
        }
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(negativePayloadMessenger, CHAT_JID);
    queue.enqueueText('negative retryAfterMs test');
    await vi.runAllTimersAsync();

    expect(mockLog.warn).toHaveBeenCalledOnce();
    const [warnArg] = mockLog.warn.mock.calls[0];
    expect(warnArg).not.toHaveProperty('retryAfterMs');
  });

  it('retryAfterMs: retryAfterMs exceeding SEND_RETRY_MAX_MS is clamped to 8000ms', async () => {
    mockLog.warn.mockClear();
    let callCount = 0;
    const clampedRetryMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          const err: Error & { payload?: unknown } = new Error('rate_limit_huge');
          err.payload = { retryAfterMs: 999_999 }; // well above SEND_RETRY_MAX_MS (8000)
          throw err;
        }
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(clampedRetryMessenger, CHAT_JID);
    queue.enqueueText('clamped retryAfterMs test');
    // Advance past the clamped delay (8000ms max) but not more
    await vi.advanceTimersByTimeAsync(8_001);
    await queue.flush();

    expect(clampedRetryMessenger.sendMessage).toHaveBeenCalledTimes(2);
    const [warnArg] = mockLog.warn.mock.calls[0];
    // retryAfterMs logged should equal SEND_RETRY_MAX_MS (8000), not 999_999
    expect(warnArg.retryAfterMs).toBe(8_000);
  });

  // ─── SEND_TIMEOUT logged as timeout:true on retry ────────────────────────

  it('timeout flag set in warn log when send times out', async () => {
    mockLog.warn.mockClear();
    let callCount = 0;
    const timeoutMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount <= 2) {
          // Never resolve → timeout fires after SEND_TIMEOUT_MS
          return new Promise<never>(() => {});
        }
        return { waMessageId: null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(timeoutMessenger, CHAT_JID);
    queue.enqueueText('timeout test');
    // Advance past first SEND_TIMEOUT_MS → first attempt times out
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1);
    // Advance past retry delay + second SEND_TIMEOUT_MS → second attempt times out
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 2_000);
    // Third attempt succeeds
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await queue.flush();

    expect(mockLog.warn).toHaveBeenCalled();
    const timeoutLogs = mockLog.warn.mock.calls.filter(([arg]) => arg.timeout === true);
    expect(timeoutLogs.length).toBeGreaterThanOrEqual(1);
  });

  // ─── QR-028: stable message id reused across timeout retries (no dup) ──────

  it('reuses ONE stable messageId across all retry attempts so a slow-but-delivered send is server-deduped', async () => {
    const ids: Array<string | undefined> = [];
    let callCount = 0;
    const idMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, _text: string, opts?: SendOptions) => {
        ids.push(opts?.messageId);
        callCount += 1;
        if (callCount <= 1) return new Promise<never>(() => {}); // first attempt times out
        return { waMessageId: opts?.messageId ?? null };
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(idMessenger, CHAT_JID);
    queue.enqueueText('idempotency test');
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1); // first attempt times out
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 2_000); // retry succeeds
    await queue.flush();

    expect(ids.length).toBeGreaterThanOrEqual(2);
    // Every attempt carried a non-empty id, and ALL attempts shared the SAME id.
    expect(ids[0]).toMatch(/^[0-9A-F]{8,}$/);
    expect(new Set(ids.filter((x) => x !== undefined)).size).toBe(1);
  });

  // ─── enqueuePoll ──────────────────────────────────────────────────────────

  it('enqueuePoll executes sendFn after flushing stream and tool buffers', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueStreamingText('streaming chunk');
    queue.enqueueToolUpdate({ category: 'running', detail: 'some task' });

    const sendFn = vi.fn(async () => {});

    const pollPromise = queue.enqueuePoll(sendFn);
    await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS + MIN_SEND_GAP_MS + 100);
    await pollPromise;

    // streaming text and tool batch flushed before the poll sendFn ran
    expect(calls.some((c) => c.includes('streaming chunk'))).toBe(true);
    expect(sendFn).toHaveBeenCalledOnce();

    await queue.flush(); // clears typing heartbeat
  });

  // ─── hasPendingPoll / setPollPending ─────────────────────────────────────

  it('hasPendingPoll returns false by default and true after setPollPending(true)', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    expect(queue.hasPendingPoll()).toBe(false);
    queue.setPollPending(true);
    expect(queue.hasPendingPoll()).toBe(true);
    queue.setPollPending(false);
    expect(queue.hasPendingPoll()).toBe(false);

    queue.abortTurn();
  });

  // ─── operation_progress / operation_slow / operation_stalled: pollPending ─

  it('operation_progress with pollPending=true only triggers typing (no message)', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');
    queue.setPollPending(true);

    const event: ProgressEvent = {
      type: 'operation_progress',
      toolId: 'tool-poll',
      toolName: 'Bash',
      category: 'running',
      elapsedMs: 10_000,
      state: 'running',
    };
    queue.enqueueProgressUpdate(event, 'Bot');

    expect(calls).toHaveLength(0);
    expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

    queue.abortTurn();
  });

  it('operation_slow with pollPending=true only triggers typing (no message)', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');
    queue.setPollPending(true);

    const event: ProgressEvent = {
      type: 'operation_slow',
      toolId: 'tool-poll-slow',
      toolName: 'Bash',
      category: 'running',
      elapsedMs: 30_000,
      expectedMs: 10_000,
    };
    queue.enqueueProgressUpdate(event, 'Bot');

    expect(calls).toHaveLength(0);
    expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

    queue.abortTurn();
  });

  it('operation_stalled with pollPending=true only triggers typing (no message)', async () => {
    const { messenger, calls, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');
    queue.setPollPending(true);

    const event: ProgressEvent = {
      type: 'operation_stalled',
      toolId: 'tool-poll-stalled',
      toolName: 'Bash',
      category: 'running',
      elapsedMs: 60_000,
    };
    queue.enqueueProgressUpdate(event, 'Bot');

    expect(calls).toHaveLength(0);
    expect(typingCalls.filter((v) => v === true).length).toBeGreaterThanOrEqual(1);

    queue.abortTurn();
  });

  // ─── indicateTyping ───────────────────────────────────────────────────────

  it('indicateTyping activates the composing indicator immediately', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.indicateTyping();

    expect(typingCalls.filter((v) => v === true)).toHaveLength(1);
    expect(messenger.setTyping).toHaveBeenCalledWith(CHAT_JID, true);

    queue.abortTurn();
  });

  it('indicateTyping is idempotent (second call does not add a second setTyping call)', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.indicateTyping();
    queue.indicateTyping();

    expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

    queue.abortTurn();
  });

  // ─── stopTyping: called when not typing (no-op) ───────────────────────────

  it('flush() is idempotent when called without any pending work', async () => {
    const { messenger, typingCalls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    // Never started typing — stopTyping is a no-op
    await queue.flush();
    await queue.flush();

    expect(typingCalls).toHaveLength(0);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  // ─── shutdown: toolTimer is null after flush ──────────────────────────────

  it('shutdown does not fail when no toolTimer is active', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    await queue.shutdown();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  // ─── hasPendingWork: various state combinations ───────────────────────────

  it('hasPendingWork returns true when tool buffer has items', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueToolUpdate({ category: 'running', detail: 'pending' });
    expect(queue.hasPendingWork?.()).toBe(true);

    queue.abortTurn();
  });

  it('hasPendingWork returns true while sending is in-progress', async () => {
    const sendStarted = deferred<void>();
    const sendAllowed = deferred<{ waMessageId: null }>();
    const slowMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        sendStarted.resolve();
        return sendAllowed.promise;
      }),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };

    const queue = new OutboundQueue(slowMessenger, CHAT_JID);
    queue.enqueueText('slow message');

    // Wait until send has started
    await sendStarted.promise;
    expect(queue.hasPendingWork?.()).toBe(true);

    sendAllowed.resolve({ waMessageId: null });
    await queue.flush();
    expect(queue.hasPendingWork?.()).toBe(false);
  });

  // ─── targetChatJid getter ─────────────────────────────────────────────────

  it('targetChatJid returns the JID provided at construction', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    expect(queue.targetChatJid).toBe(CHAT_JID);

    queue.abortTurn();
  });

  it('targetChatJid reflects the updated JID after updateDeliveryJid', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.updateDeliveryJid('newjid@s.whatsapp.net');
    expect(queue.targetChatJid).toBe('newjid@s.whatsapp.net');

    queue.abortTurn();
  });

  // ─── setInboundSeq / getLastOpId / clearLastOpId ─────────────────────────

  it('getLastOpId returns undefined before any sends', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    expect(queue.getLastOpId()).toBeUndefined();

    queue.abortTurn();
  });

  it('clearLastOpId resets lastOpId to undefined', async () => {
    const { messenger } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);

    queue.enqueueText('something');
    await vi.runAllTimersAsync();

    expect(queue.getLastOpId()).toBeDefined();
    queue.clearLastOpId();
    expect(queue.getLastOpId()).toBeUndefined();
  });

  it('setInboundSeq propagates seq to outbound ops via durability', async () => {
    const { messenger } = makeMessenger();
    const durability = makeDurabilityStub();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setDurability(durability);
    queue.setInboundSeq(42);

    queue.enqueueText('with seq');
    await vi.runAllTimersAsync();

    expect(durability.createOutboundOp).toHaveBeenCalledWith(
      expect.objectContaining({ sourceInboundSeq: 42 }),
    );
  });

  // ─── abortTurn: clears streamTimer when streaming is in progress ──────────

  it('abortTurn clears streamTimer and discards buffered streaming text', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);

    queue.enqueueStreamingText('partial stream');
    // streamTimer is now set; abort before it fires
    queue.abortTurn();

    // Advance time — should fire nothing (abortTurn cleared the timer)
    await vi.advanceTimersByTimeAsync(TEXT_AGGREGATE_DELAY_MS + 1_000);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  // ─── thinking_long: friendly mode passes through ─────────────────────────

  it('thinking_long in friendly mode sends a message (not suppressed)', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('friendly');

    queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 10_000 }, 'Bot');
    await vi.runAllTimersAsync();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('thinking');
  });

  // ─── outbound-queue.ts uncovered-branch coverage ──────────────────────────
  // Targets branches that the suite above did not exercise:
  //   * sendWithPacing echo-guard suppression (line 727 true branch)
  //   * warn-log text truncation when the failing text exceeds 80 chars (line 778)
  //   * error-log text truncation when the failing text exceeds 80 chars (line 788)
  //   * markMaybeSent 'send_failed' fallback when the thrown value has no .message (line 792)
  //   * shutdown() clearing a toolTimer that was (re)armed during flush's await (line 562)

  describe('outbound-queue.ts uncovered-branch coverage', () => {
    const GROUP_JID = '1111111000000000@g.us';

    it('sendWithPacing silently drops a group send suppressed by the echo-guard cooldown', async () => {
      // Seed an active cross-session cooldown so canSendToGroup() returns false.
      __resetForTests();
      recordGroupOutbound(GROUP_JID, 'a-different-sender-token');

      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, GROUP_JID);

      queue.enqueueText('this group send should be suppressed');
      await vi.runAllTimersAsync();

      // The echo guard dropped the send before it reached messenger.sendMessage.
      expect(messenger.sendMessage).not.toHaveBeenCalled();
      expect(calls).toEqual([]);

      __resetForTests();
    });

    it('retry warn log truncates textPreview to 80 chars plus ellipsis for long messages', async () => {
      mockLog.warn.mockClear();
      mockLog.error.mockClear();
      let callCount = 0;
      const longText = 'x'.repeat(120);
      const retryMessenger: Messenger = {
        sendMessage: vi.fn(async () => {
          callCount += 1;
          if (callCount < 2) throw new Error('transient');
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };

      const queue = new OutboundQueue(retryMessenger, CHAT_JID);
      queue.enqueueText(longText);
      await vi.runAllTimersAsync();

      // One retry fired before the successful second attempt.
      expect(mockLog.warn).toHaveBeenCalledOnce();
      const [warnArg] = mockLog.warn.mock.calls[0];
      // Truncation branch: preview is the first 80 chars followed by the ellipsis.
      expect(warnArg.textPreview).toBe('x'.repeat(80) + '…');
      expect(warnArg.textPreview).toHaveLength(81);
    });

    it('terminal error log truncates textPreview to 80 chars plus ellipsis when all retries fail on a long message', async () => {
      mockLog.warn.mockClear();
      mockLog.error.mockClear();
      let callNum = 0;
      const longText = 'y'.repeat(150);
      const alwaysFailMessenger: Messenger = {
        sendMessage: vi.fn(async () => {
          callNum += 1;
          if (callNum <= 3) throw new Error('hard fail');
          // 4th call is the best-effort notice — let it succeed.
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };

      const queue = new OutboundQueue(alwaysFailMessenger, CHAT_JID);
      queue.enqueueText(longText);
      await vi.runAllTimersAsync();

      expect(mockLog.error).toHaveBeenCalledOnce();
      const [errorArg] = mockLog.error.mock.calls[0];
      // Truncation branch on the terminal-failure path.
      expect(errorArg.textPreview).toBe('y'.repeat(80) + '…');
      expect(errorArg.textPreview).toHaveLength(81);
    });

    it('markMaybeSent receives "send_failed" when the thrown value has no .message property', async () => {
      mockLog.warn.mockClear();
      mockLog.error.mockClear();
      const durability = makeDurabilityStub();
      let callNum = 0;
      // Throw a bare object (not an Error) so `(lastErr as Error)?.message` is undefined.
      const nonErrorMessenger: Messenger = {
        sendMessage: vi.fn(async () => {
          callNum += 1;
          if (callNum <= 3) throw { code: 'weird_failure' };
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };

      const queue = new OutboundQueue(nonErrorMessenger, CHAT_JID);
      queue.setDurability(durability);
      queue.enqueueText('non-error throw');
      await vi.runAllTimersAsync();

      // The ?? fallback fired — markMaybeSent got the literal 'send_failed'.
      expect(durability.markMaybeSent).toHaveBeenCalledOnce();
      const [, reasonArg] = (durability.markMaybeSent as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(reasonArg).toBe('send_failed');
    });

    it('splitMessage skips the trailing empty chunk when text ends in whitespace past the boundary', async () => {
      // Force splitMessage's `if (remaining.length > 0)` false branch: the
      // chunk splits at maxLen and the leftover slice trims to an empty string.
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      // 4000 chars of body + a paragraph break + trailing spaces. splitMessage
      // cuts at index 4000 (no '\n\n' or space within the first 4000), leaving
      // a remainder that trimStart() reduces to '' — so no second chunk ships.
      const body = 'z'.repeat(4000) + '\n\n   ';
      queue.enqueueText(body);
      await vi.runAllTimersAsync();

      // Exactly one message was emitted — the trailing-whitespace remainder was
      // dropped by the `remaining.length > 0` guard, not sent as an empty chunk.
      expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
      expect(calls[0]).toBe('z'.repeat(4000));
    });

    it('shutdown clears a toolTimer that was re-armed while flush was awaiting the send chain', async () => {      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      // Block the first (and only) send so the chain stays pending while we
      // re-arm a tool timer mid-flush.
      const sendGate = deferred<void>();
      const blockingMessenger: Messenger = {
        sendMessage: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          await sendGate.promise;
          return { waMessageId: null };
        }),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
        setTyping: vi.fn(async () => {}),
      };
      const blockingQueue = new OutboundQueue(blockingMessenger, CHAT_JID);

      blockingQueue.enqueueText('in-flight send that holds the chain open');
      // Let the send start (chain becomes pending).
      await vi.advanceTimersByTimeAsync(0);

      // Begin shutdown — flush() runs flushToolBuffer() synchronously (no tool
      // buffer yet) then awaits the still-pending chain. While it is awaiting,
      // arm a fresh tool timer. The defensive clear at shutdown line 562 is the
      // only thing that cleans it up.
      const shutdownPromise = blockingQueue.shutdown();
      // Re-arm the tool timer AFTER flushToolBuffer ran but BEFORE the chain
      // resolves — i.e. while flush() is in its `await this.chain`.
      blockingQueue.enqueueToolUpdate({ category: 'running', detail: 'late update' });
      await vi.advanceTimersByTimeAsync(0);

      // Release the in-flight send so flush() can complete and shutdown can
      // reach the toolTimer-clear branch.
      sendGate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await shutdownPromise;

      // The in-flight text send was delivered; the late tool update was NOT
      // re-flushed by shutdown (shutdown's defensive clear only clears the
      // toolTimer, it does not re-flush). Exactly one message reached the
      // messenger from the send chain.
      expect(calls).toEqual(['in-flight send that holds the chain open']);
      expect(blockingMessenger.sendMessage).toHaveBeenCalledTimes(1);

      // The late enqueueToolUpdate also armed the 30s max-age timer, which
      // shutdown's defensive clear does NOT touch. Drain it so no timer leaks
      // (this also confirms shutdown's toolTimer clear left no duplicate work).
      await vi.advanceTimersByTimeAsync(TOOL_BATCH_MAX_AGE_MS);
      // The max-age flush now delivers the late tool-status update.
      expect(calls).toEqual([
        'in-flight send that holds the chain open',
        '🔧 Running:\n  • late update',
      ]);
    });
  });

  // ─── Layer 2: self-bounding typing refresh ───────────────────────────────

  describe('typing self-bound (TYPING_MAX_MS)', () => {
    it('self-expires the typing refresh after TYPING_MAX_MS without a new turn', async () => {
      const { messenger, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      queue.enqueueStreamingText('long turn');             // arms composing + 8s refresh
      expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

      // Advance just past the self-bound cap; the refresh must stop re-asserting.
      await vi.advanceTimersByTimeAsync(TYPING_MAX_MS + TYPING_REFRESH_MS);
      const assertsAtCap = typingCalls.filter((v) => v === true).length;

      // No further composing after the cap
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
      expect(typingCalls.filter((v) => v === true).length).toBe(assertsAtCap);

      // Drain streamTimer
      await queue.flush();
    });

    it('a fresh startTyping within a turn grants a full TYPING_MAX_MS window from the reset point', async () => {
      const { messenger, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      queue.enqueueStreamingText('chunk-1');
      // Advance to just before the original cap would fire
      await vi.advanceTimersByTimeAsync(TYPING_MAX_MS - TYPING_REFRESH_MS);
      queue.enqueueStreamingText('chunk-2');               // new activity → resets clock to T=0
      const assertsAfterReset = typingCalls.filter((v) => v === true).length;

      // Advance a full TYPING_MAX_MS from the reset — the interval should still
      // be firing (the full window was granted, not just the remaining slice).
      // We check at the midpoint and near the end of the new window.
      await vi.advanceTimersByTimeAsync(TYPING_MAX_MS / 2);
      const assertsMidWindow = typingCalls.filter((v) => v === true).length;
      expect(assertsMidWindow).toBeGreaterThan(assertsAfterReset);

      // Near the end of the full reset window (but before it expires) — still firing
      await vi.advanceTimersByTimeAsync(TYPING_MAX_MS / 2 - TYPING_REFRESH_MS);
      const assertsNearEnd = typingCalls.filter((v) => v === true).length;
      expect(assertsNearEnd).toBeGreaterThan(assertsMidWindow);

      // Past the full reset window — self-bound fires, no more re-asserts
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
      const assertsAtExpiry = typingCalls.filter((v) => v === true).length;
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
      expect(typingCalls.filter((v) => v === true).length).toBe(assertsAtExpiry);

      await queue.flush();
    });
  });

  // ─── Layer 1: endTurn() choke point ──────────────────────────────────────

  describe('endTurn()', () => {
    it('endTurn() drains the stream buffer and delivers the fragment before stopping typing', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      // Simulate an assistant_text fragment buffered mid-turn (streamTimer armed, not yet fired)
      queue.enqueueStreamingText('buffered fragment');
      // Buffer is pending — no send yet (streamTimer hasn't fired)
      expect(calls).toHaveLength(0);

      // endTurn() flushes the stream buffer synchronously then stops typing
      queue.endTurn();
      // Drain the send chain (send is async via Promise chain; zero-advance drains microtasks)
      await vi.advanceTimersByTimeAsync(0);

      // Fragment must now be delivered
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe('buffered fragment');
      // Typing must be stopped
      expect(typingCalls.filter((v) => v === false)).toHaveLength(1);

      // Advancing past TEXT_AGGREGATE_DELAY_MS must produce NO additional sends
      // and NO composing re-asserts (orphaned streamTimer must not fire)
      await vi.advanceTimersByTimeAsync(TEXT_AGGREGATE_DELAY_MS + TYPING_REFRESH_MS);
      expect(calls).toHaveLength(1);
      expect(typingCalls.filter((v) => v === true)).toHaveLength(1); // only the initial assert

      // Subsequent flush() must be a no-op for both stream content and typing
      await queue.flush();
      expect(calls).toHaveLength(1);
      expect(typingCalls.filter((v) => v === false)).toHaveLength(1); // still only one paused
    });

    it('endTurn() clears an active typing indicator and is idempotent', async () => {
      const { messenger, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);

      queue.enqueueStreamingText('working');               // arms composing + streamTimer
      expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

      queue.endTurn();                                      // turn-end choke point
      expect(typingCalls.filter((v) => v === false)).toHaveLength(1); // one 'paused'

      queue.endTurn();                                      // idempotent: no second paused
      expect(typingCalls.filter((v) => v === false)).toHaveLength(1);

      // No further composing re-asserts after endTurn
      await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2);
      expect(typingCalls.filter((v) => v === true)).toHaveLength(1);

      // Drain the streamTimer so the leak guard passes
      await queue.flush();
    });
  });

  // ─── PR-E: per-turn STATUS-narration cap ──────────────────────────────────
  // Caps status narration (tool-status batches + progress placeholders) per
  // turn; NEVER gates content; resets on the real turn-end choke (endTurn/
  // abortTurn), not on flush() (called mid-turn by polls).

  describe('PR-E status-narration cap', () => {
    // Reproduces the 07-09 flood: a single turn emitting dozens of tool-status
    // batches. With the cap, at most MAX_STATUS_MESSAGES_PER_TURN status
    // messages reach the chat.
    it('caps status narration at MAX_STATUS_MESSAGES_PER_TURN per turn', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');

      for (let i = 0; i < 30; i++) {
        queue.enqueueToolUpdate({ category: 'running', detail: `step ${i}` });
        await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
      }
      await queue.flush();

      const status = calls.filter((c) => c.includes('Working on') || c.startsWith('⚙️'));
      expect(status.length).toBeLessThanOrEqual(MAX_STATUS_MESSAGES_PER_TURN);
    });

    // When the cap trips, the user gets exactly ONE friendly notice (content,
    // so it always lands) and the typing indicator keeps signalling liveness.
    it('sends exactly one STATUS_CAP_NOTICE and keeps the typing indicator alive when the cap trips', async () => {
      const { messenger, calls, typingCalls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode('friendly');

      for (let i = 0; i < 30; i++) {
        queue.enqueueToolUpdate({ category: 'running', detail: `step ${i}` });
        await vi.advanceTimersByTimeAsync(TOOL_BATCH_DELAY_MS);
      }
      await queue.flush();

      const notices = calls.filter((c) => c === STATUS_CAP_NOTICE);
      expect(notices).toHaveLength(1);
      // Liveness signal preserved across the suppressed window.
      expect(typingCalls).toContain(true);
    });
  });
});

describe('OutboundQueue — echo-guard token inheritance across replacement (QR-069)', () => {
  const GROUP_JID = 'qr069-test-group@g.us';
  const CFG: EchoGuardConfig = { enabled: true, groupCooldownMs: 60_000 };

  beforeEach(() => __resetForTests());

  it('exposes a stable per-instance token; a fresh queue gets a random non-empty token', () => {
    const { messenger } = makeMessenger();
    const q = new OutboundQueue(messenger, GROUP_JID);
    expect(q.getSenderToken()).toMatch(/.+/);
    const q2 = new OutboundQueue(messenger, GROUP_JID);
    expect(q2.getSenderToken()).not.toBe(q.getSenderToken());
  });

  it('a replacement queue that INHERITS the prior token is exempt from the predecessor cooldown', () => {
    const { messenger } = makeMessenger();
    // Predecessor queue sends to the group, arming the cross-session cooldown.
    const oldQueue = new OutboundQueue(messenger, GROUP_JID);
    const oldToken = oldQueue.getSenderToken();
    recordGroupOutbound(GROUP_JID, oldToken);

    // BUG (QR-069): a replacement with a FRESH token is suppressed within the window.
    const freshReplacement = new OutboundQueue(messenger, GROUP_JID);
    expect(canSendToGroup(GROUP_JID, CFG, freshReplacement.getSenderToken())).toBe(false);

    // FIX: a replacement that inherits the prior token is NOT suppressed.
    const inheritingReplacement = new OutboundQueue(messenger, GROUP_JID, oldToken);
    expect(inheritingReplacement.getSenderToken()).toBe(oldToken);
    expect(canSendToGroup(GROUP_JID, CFG, inheritingReplacement.getSenderToken())).toBe(true);
  });

  describe('QR-126: outbound chunk-count cap (message-amplification guard)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('caps a huge reply at MAX_CHUNKS sends with a truncation notice', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      // 256 KB reply → 64 uncapped chunks (ceil(len / 4000)). A prompt-injected
      // max-length agent reply is the realistic trigger; the cap must bound the fan-out.
      queue.enqueueText('x'.repeat(256 * 1024));
      await vi.runAllTimersAsync();

      // Uncapped this is 64 sends; capped it is exactly MAX_CHUNKS.
      expect(calls.length).toBeLessThanOrEqual(MAX_CHUNKS);
      expect(calls.length).toBe(MAX_CHUNKS);
      // The final message is the visible truncation notice, not silently dropped.
      expect(calls[calls.length - 1]).toContain('[reply truncated]');
    });

    it('does not truncate a reply that fits within MAX_CHUNKS', async () => {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      // ~3 chunks worth — well under the cap; must pass through untouched.
      queue.enqueueText('y'.repeat(3 * 4000 + 100));
      await vi.runAllTimersAsync();

      expect(calls.length).toBeGreaterThan(1);
      expect(calls.length).toBeLessThan(MAX_CHUNKS);
      expect(calls.join('')).not.toContain('[reply truncated]');
    });
  });
});
