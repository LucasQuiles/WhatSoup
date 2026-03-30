import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundQueue,
  TOOL_BATCH_DELAY_MS,
  MIN_SEND_GAP_MS,
  TYPING_REFRESH_MS,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { ToolUpdate } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { Messenger } from '../../../src/core/types.ts';

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
    setTyping: vi.fn(async (_jid: string, typing: boolean) => {
      typingCalls.push(typing);
    }),
  };
  return { messenger, calls, typingCalls };
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

    expect(messenger.sendMessage).toHaveBeenCalledWith(CHAT_JID, 'Ping');
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

  // ─── Serialization ─────────────────────────────────────────────────────────

  it('sends messages serially (only one in-flight at a time)', async () => {
    const inFlight: number[] = [];
    let concurrent = 0;

    const serialMessenger: Messenger = {
      sendMessage: vi.fn(async (_jid: string, text: string) => {
        concurrent += 1;
        inFlight.push(concurrent);
        // Simulate async delay
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        concurrent -= 1;
        return { waMessageId: null };
      }),
    };

    const queue = new OutboundQueue(serialMessenger, CHAT_JID);
    queue.enqueueText('A');
    queue.enqueueText('B');
    queue.enqueueText('C');

    await vi.runAllTimersAsync();

    // Max concurrent should never exceed 1
    expect(Math.max(...inFlight)).toBe(1);
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

  it('logs error and keeps queue draining when all 3 attempts fail', async () => {
    mockLog.error.mockClear();
    const failMessenger: Messenger = {
      sendMessage: vi.fn(async () => {
        throw new Error('permanent failure');
      }),
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

  // ─── updateDeliveryJid ─────────────────────────────────────────────────────

  it('updateDeliveryJid retargets subsequent sends', async () => {
    const { messenger } = makeMessenger();
    const queue = new OutboundQueue(messenger, 'original@s.whatsapp.net');

    queue.updateDeliveryJid('new@lid');
    queue.enqueueText('Hello retargeted');
    await vi.runAllTimersAsync();

    expect(messenger.sendMessage).toHaveBeenCalledWith('new@lid', 'Hello retargeted');
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
    };

    const queue = new OutboundQueue(alwaysFailMessenger, CHAT_JID);
    queue.enqueueText('terminal shape test');
    await vi.runAllTimersAsync();

    expect(mockLog.error).toHaveBeenCalledOnce();
    const [errorArg] = mockLog.error.mock.calls[0];
    expect(errorArg).toMatchObject({ chatJid: CHAT_JID, attempts: 3 });
    expect(typeof errorArg.textLength).toBe('number');
    expect(errorArg.textLength).toBe('terminal shape test'.length);
    expect(errorArg.err).toBeDefined();
  });
});
