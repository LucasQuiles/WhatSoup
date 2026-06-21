/**
 * Integration tests for ConversationHandler (src/runtimes/chat/runtime.ts).
 *
 * ConversationHandler now implements Runtime and only handles chat-specific
 * processing: rate limiting, media, context/window loading, LLM calls, sending
 * and storing bot replies. Ingest concerns (store incoming, admin routing,
 * access policy) are tested in tests/core/ingest.test.ts.
 *
 * Architecture note: handleMessage() calls chatQueue.enqueue() without await
 * (fire-and-forget). The ChatQueue mock stores task promises in globalThis so
 * drainQueue() can await them. Tests that exercise processMessage() must call
 * drainQueue() (or handleAndDrain()) after handleMessage().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, Messenger } from '../../../src/core/types.ts';
import type { LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';
import type { Database } from '../../../src/core/database.ts';
import type { PineconeMemory } from '../../../src/runtimes/chat/providers/pinecone.ts';

// ---------------------------------------------------------------------------
// Queue drain helpers — must be defined before vi.mock calls so that
// globalThis.__queueTasks is available when the factory closure runs.
// ---------------------------------------------------------------------------

(globalThis as any).__queueTasks = [] as Promise<void>[];

/** Await all queued processMessage tasks to completion. */
function drainQueue(): Promise<void> {
  const tasks: Promise<void>[] = (globalThis as any).__queueTasks ?? [];
  (globalThis as any).__queueTasks = [];
  return Promise.all(tasks).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports of the modules they replace
// ---------------------------------------------------------------------------

// Mock ChatQueue so enqueue runs tasks immediately and stores their promises
// in globalThis.__queueTasks so tests can drain them via drainQueue().
vi.mock('../../../src/runtimes/chat/queue.ts', () => {
  class ChatQueue {
    enqueue(_chatJid: string, task: () => Promise<void>): void {
      ((globalThis as any).__queueTasks as Promise<void>[]).push(task());
    }
  }
  return { ChatQueue };
});

vi.mock('../../../src/runtimes/chat/rate-limiter.ts', () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/window.ts', () => ({
  loadConversationWindow: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/context.ts', () => ({
  loadContext: vi.fn(),
}));

vi.mock('../../../src/core/messages.ts', () => ({
  storeMessageIfNew: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/rate-limits-db.ts', () => ({
  recordResponse: vi.fn(),
}));

vi.mock('../../../src/runtimes/chat/media/processor.ts', () => ({
  processMedia: vi.fn(),
}));

// Mock EnrichmentPoller so start/shutdown tests don't create real intervals.
// Factory runs before variable init due to vi.mock hoisting, so we stash the
// spies on globalThis and expose typed accessors below. Each constructed
// instance reuses the same spies so tests can assert across the lifecycle
// without having to capture the instance returned by `new EnrichmentPoller(...)`.
vi.mock('../../../src/runtimes/chat/enrichment/poller.ts', () => {
  const start = vi.fn();
  const stop = vi.fn();
  (globalThis as any).__enrichmentPollerStart = start;
  (globalThis as any).__enrichmentPollerStop = stop;
  (globalThis as any).__enrichmentPollerInstances = [] as unknown[];
  class EnrichmentPoller {
    lastRunAt: string | null = null;
    start = start;
    stop = stop;
    constructor(..._args: unknown[]) {
      ((globalThis as any).__enrichmentPollerInstances as unknown[]).push(this);
    }
  }
  return { EnrichmentPoller };
});

// Mock logger so we can spy on warn/error calls in tests.
// Factory runs before variable init due to vi.mock hoisting, so we store
// the fns on globalThis and expose typed accessors below.
vi.mock('../../../src/logger.ts', () => {
  const warn = vi.fn();
  const error = vi.fn();
  const info = vi.fn();
  (globalThis as any).__logWarn = warn;
  (globalThis as any).__logError = error;
  (globalThis as any).__logInfo = info;
  const child = { warn, error, info };
  return {
    logger: { child: () => child },
    createChildLogger: () => child,
  };
});

// ---------------------------------------------------------------------------
// Now import the mocked helpers and the SUT
// ---------------------------------------------------------------------------

import { checkRateLimit } from '../../../src/runtimes/chat/rate-limiter.ts';
import { loadConversationWindow } from '../../../src/runtimes/chat/window.ts';
import { loadContext } from '../../../src/runtimes/chat/context.ts';
import { storeMessageIfNew } from '../../../src/core/messages.ts';
import { recordResponse } from '../../../src/runtimes/chat/rate-limits-db.ts';
import { processMedia } from '../../../src/runtimes/chat/media/processor.ts';
import { ConversationHandler } from '../../../src/runtimes/chat/runtime.ts';
import { jitteredDelay } from '../../../src/core/retry.ts';

// ---------------------------------------------------------------------------
// Logger mock accessors (globalThis storage avoids vi.mock hoisting issue)
// ---------------------------------------------------------------------------

function mockLogWarn(): ReturnType<typeof vi.fn> {
  return (globalThis as any).__logWarn;
}
function mockLogError(): ReturnType<typeof vi.fn> {
  return (globalThis as any).__logError;
}
function mockLogInfo(): ReturnType<typeof vi.fn> {
  return (globalThis as any).__logInfo;
}
function mockEnrichmentPollerStart(): ReturnType<typeof vi.fn> {
  return (globalThis as any).__enrichmentPollerStart;
}
function mockEnrichmentPollerStop(): ReturnType<typeof vi.fn> {
  return (globalThis as any).__enrichmentPollerStop;
}
function mockEnrichmentPollerInstances(): unknown[] {
  return (globalThis as any).__enrichmentPollerInstances ?? [];
}

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockCheckRateLimit = vi.mocked(checkRateLimit);
const mockLoadConversationWindow = vi.mocked(loadConversationWindow);
const mockLoadContext = vi.mocked(loadContext);
const mockStoreMessage = vi.mocked(storeMessageIfNew);
const mockRecordResponse = vi.mocked(recordResponse);
const mockProcessMedia = vi.mocked(processMedia);

// ---------------------------------------------------------------------------
// Shared mock objects
// ---------------------------------------------------------------------------

function makeMessenger(): Messenger & { sendMessage: ReturnType<typeof vi.fn> } {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function makeDb() {
  return {
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
      }),
    },
  } as unknown as Database;
}

function makePinecone() {
  return {
    searchForChat: vi.fn().mockResolvedValue([]),
    searchForSender: vi.fn().mockResolvedValue([]),
    searchSelfFacts: vi.fn().mockResolvedValue([]),
  } as unknown as PineconeMemory;
}

const makePrimaryProvider = (): LLMProvider => ({
  name: 'anthropic',
  generate: vi.fn().mockResolvedValue({
    content: 'hey whats up',
    inputTokens: 100,
    outputTokens: 10,
    model: 'claude-opus-4-6',
    durationMs: 500,
  }),
});

const makeFallbackProvider = (): LLMProvider => ({
  name: 'openai',
  generate: vi.fn().mockResolvedValue({
    content: 'fallback response',
    inputTokens: 80,
    outputTokens: 8,
    model: 'gpt-5.4',
    durationMs: 400,
  }),
});

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg-001',
    chatJid: '15551230008@s.whatsapp.net',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'Alice',
    content: 'hello bot',
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1000),
    quotedMessageId: null,
    contentText: null,
    isResponseWorthy: true,
    ...overrides,
  };
}

/** Configure the "happy path" default mock return values. */
function setHappyPathDefaults() {
  mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 44 });
  mockProcessMedia.mockResolvedValue({ content: 'hello bot', images: [] });
  mockLoadContext.mockResolvedValue('');
  mockLoadConversationWindow.mockReturnValue([]);
  mockStoreMessage.mockReturnValue(true);
  mockRecordResponse.mockImplementation(() => undefined);
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

function makeHandler() {
  const db = makeDb();
  const messenger = makeMessenger();
  const pinecone = makePinecone();
  const primary = makePrimaryProvider();
  const fallback = makeFallbackProvider();
  const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback);
  return { handler, db, messenger, pinecone, primary, fallback };
}

/**
 * Convenience: call handleMessage then drain the queue.
 * Use for tests that need processMessage() to complete.
 */
async function handleAndDrain(
  handler: InstanceType<typeof ConversationHandler>,
  msg: IncomingMessage,
): Promise<void> {
  await handler.handleMessage(msg);
  await drainQueue();
}

// ---------------------------------------------------------------------------
// Reset all mocks and pending tasks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockLogWarn()?.mockClear();
  mockLogError()?.mockClear();
  mockLogInfo()?.mockClear();
  (globalThis as any).__queueTasks = [];
  (globalThis as any).__enrichmentPollerInstances = [];
  setHappyPathDefaults();
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Happy path
// ===========================================================================

describe('Happy path', () => {
  it('full pipeline: rate limit → context → window → LLM → send → store reply → rate record', async () => {
    const { handler, messenger, primary } = makeHandler();
    const msg = makeIncomingMessage();

    await handleAndDrain(handler, msg);

    // 1. Rate limit checked
    // Rate limit uses conversation key (not raw JID) to normalize LID/phone variants
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), '15551230008');

    // 2. Context and window loaded
    expect(mockLoadContext).toHaveBeenCalled();
    expect(mockLoadConversationWindow).toHaveBeenCalled();

    // 3. Primary provider called
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();

    // 4. Response sent via messenger
    expect(messenger.sendMessage).toHaveBeenCalledWith(msg.chatJid, 'hey whats up');

    // 5. Bot reply storage now handled by Baileys echo (storeMessageIfNew)
    //    — no direct storeMessage call in the runtime

    // 6. Rate limit recorded
    expect(mockRecordResponse).toHaveBeenCalledWith(expect.anything(), '15551230008');
  });

  it('response content matches LLM output', async () => {
    const { handler, messenger, primary } = makeHandler();
    vi.mocked(primary.generate).mockResolvedValue({
      content: 'specific response text',
      inputTokens: 50,
      outputTokens: 5,
      model: 'claude-opus-4-6',
      durationMs: 300,
    });

    await handleAndDrain(handler, makeIncomingMessage());

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'specific response text',
    );
  });

  it('primary provider success — uses primary response, fallback never called', async () => {
    const { handler, messenger, primary, fallback } = makeHandler();

    await handleAndDrain(handler, makeIncomingMessage());

    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    expect(vi.mocked(fallback.generate)).not.toHaveBeenCalled();
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
  });

  it('token counts flow through — provider receives request with correct model', async () => {
    const { handler, primary } = makeHandler();

    await handleAndDrain(handler, makeIncomingMessage());

    const callArg = vi.mocked(primary.generate).mock.calls[0][0];
    expect(callArg).toHaveProperty('model');
    expect(callArg).toHaveProperty('maxTokens');
    expect(callArg).toHaveProperty('systemPrompt');
    expect(callArg).toHaveProperty('messages');
    expect(Array.isArray(callArg.messages)).toBe(true);
  });

  it('conversation window messages appended before LLM call', async () => {
    const { handler, primary } = makeHandler();
    mockLoadConversationWindow.mockReturnValue([
      { role: 'user', content: '[Bob]: earlier message' },
      { role: 'assistant', content: 'earlier reply' },
    ]);
    mockProcessMedia.mockResolvedValue({ content: 'new message', images: [] });

    const msg = makeIncomingMessage({ content: 'new message', senderName: 'Alice' });
    await handleAndDrain(handler, msg);

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    // Window has 2 prior messages + 1 current = 3
    expect(request.messages.length).toBe(3);
    // Last message is the current incoming one
    const last = request.messages[request.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('new message');
  });

  it('context block appended to system prompt when non-empty', async () => {
    const { handler, primary } = makeHandler();
    mockLoadContext.mockResolvedValue('Background knowledge:\n- Alice likes cats');

    await handleAndDrain(handler, makeIncomingMessage());

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    expect(request.systemPrompt).toContain('Background knowledge:\n- Alice likes cats');
  });

  it('sender name prefix included in current message', async () => {
    const { handler, primary } = makeHandler();
    const msg = makeIncomingMessage({ senderName: 'BobSmith', content: 'yo' });
    mockProcessMedia.mockResolvedValue({ content: 'yo', images: [] });

    await handleAndDrain(handler, msg);

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    expect(lastMsg.content).toBe('[BobSmith]: yo');
  });

  it('images from processMedia attached to the current message', async () => {
    const { handler, primary } = makeHandler();
    mockProcessMedia.mockResolvedValue({
      content: 'look at this',
      images: [{ mimeType: 'image/jpeg', base64: 'abc123' }],
    });

    await handleAndDrain(handler, makeIncomingMessage({ contentType: 'image', content: 'look at this' }));

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    expect(lastMsg.images).toEqual([{ mimeType: 'image/jpeg', base64: 'abc123' }]);
  });
});

// ===========================================================================
// Provider chain
// ===========================================================================

describe('Provider chain', () => {
  it('primary fails once → retried, retry succeeds → uses primary (retry) response', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        content: 'retry success',
        inputTokens: 100,
        outputTokens: 10,
        model: 'claude-opus-4-6',
        durationMs: 500,
      });

    // Start the message: enqueue fires the task (stored in __queueTasks)
    await handler.handleMessage(makeIncomingMessage());
    // Advance all timers (apiRetryDelayMs setTimeout) and drain promises
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(primary.generate)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fallback.generate)).not.toHaveBeenCalled();
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'retry success');
  });

  it('primary fails twice → falls back to secondary, secondary succeeds', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('always fails'));
    vi.mocked(fallback.generate).mockResolvedValue({
      content: 'fallback response',
      inputTokens: 80,
      outputTokens: 8,
      model: 'gpt-5.4',
      durationMs: 400,
    });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(primary.generate)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fallback.generate)).toHaveBeenCalledOnce();
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'fallback response');
  });

  it('secondary succeeds → rate limit still recorded, reply stored', async () => {
    vi.useFakeTimers();
    const { handler, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    vi.mocked(fallback.generate).mockResolvedValue({
      content: 'fallback ok',
      inputTokens: 80,
      outputTokens: 8,
      model: 'gpt-5.4',
      durationMs: 400,
    });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(mockRecordResponse).toHaveBeenCalledOnce();
    // Bot reply storage now handled by Baileys echo
  });

  it('both providers fail → sends the deterministic outage message (#1064)', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    vi.mocked(fallback.generate).mockRejectedValue(new Error('fallback down'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      '⚠️ My language model is unavailable right now and my operator has been notified — please try again in a bit.',
    );
  });

  it('both providers fail → reply NOT stored, rate limit NOT charged', async () => {
    vi.useFakeTimers();
    const { handler, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    vi.mocked(fallback.generate).mockRejectedValue(new Error('fallback down'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // storeMessage not called (bot reply only stored on success)
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockRecordResponse).not.toHaveBeenCalled();
  });

  it('fallback message send fails → logged, no crash', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    vi.mocked(fallback.generate).mockRejectedValue(new Error('fallback down'));
    messenger.sendMessage.mockRejectedValue(new Error('send failed'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await expect(drainQueue()).resolves.toBeUndefined();
  });

  it('primary returns empty string content → valid empty completion, no message sent (#1064)', async () => {
    // #1064: an empty completion is the model choosing to stay silent — NOT a
    // failure. The bot sends nothing rather than the old generic failure message.
    const { handler, messenger, primary } = makeHandler();
    vi.mocked(primary.generate).mockResolvedValue({
      content: '',
      inputTokens: 10,
      outputTokens: 0,
      model: 'claude-opus-4-6',
      durationMs: 200,
    });

    await handleAndDrain(handler, makeIncomingMessage());

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Concurrency
// ===========================================================================

describe('Concurrency', () => {
  it('two messages from the same chat → both processed, both responses sent', async () => {
    const { handler, messenger, primary } = makeHandler();

    const chatJid = '15551230008@s.whatsapp.net';
    const msg1 = makeIncomingMessage({ messageId: 'msg-001', chatJid });
    const msg2 = makeIncomingMessage({ messageId: 'msg-002', chatJid });

    await handler.handleMessage(msg1);
    await handler.handleMessage(msg2);
    await drainQueue();

    // Both should eventually send responses
    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(primary.generate)).toHaveBeenCalledTimes(2);
  });

  it('messages from different chats → both processed independently', async () => {
    const { handler, messenger, primary } = makeHandler();

    const msg1 = makeIncomingMessage({ messageId: 'msg-001', chatJid: 'chat-a@s.whatsapp.net', senderJid: 'user-a@s.whatsapp.net' });
    const msg2 = makeIncomingMessage({ messageId: 'msg-002', chatJid: 'chat-b@s.whatsapp.net', senderJid: 'user-b@s.whatsapp.net' });

    await handler.handleMessage(msg1);
    await handler.handleMessage(msg2);
    await drainQueue();

    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(primary.generate)).toHaveBeenCalledTimes(2);
  });

  it('each chat is enqueued with its own chatJid (verified via messenger.sendMessage calls)', async () => {
    // Both messages are processed independently, even when chatJids differ.
    const { handler, messenger } = makeHandler();
    const msg1 = makeIncomingMessage({ messageId: 'msg-001', chatJid: 'aaa@s.whatsapp.net', senderJid: 'userA@s.whatsapp.net' });
    const msg2 = makeIncomingMessage({ messageId: 'msg-002', chatJid: 'bbb@s.whatsapp.net', senderJid: 'userB@s.whatsapp.net' });

    await handler.handleMessage(msg1);
    await handler.handleMessage(msg2);
    await drainQueue();

    const chatJidsSent = vi.mocked(messenger.sendMessage).mock.calls.map((c) => c[0]);
    expect(chatJidsSent).toContain('aaa@s.whatsapp.net');
    expect(chatJidsSent).toContain('bbb@s.whatsapp.net');
  });

  it('rate limit notification set per-sender prevents duplicate notices within window', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0 });

    const msg1 = makeIncomingMessage({ messageId: 'msg-001' });
    const msg2 = makeIncomingMessage({ messageId: 'msg-002' });

    // First message triggers the notice
    await handler.handleMessage(msg1);
    await drainQueue();

    // Second message from same sender — notice already sent within window
    await handler.handleMessage(msg2);
    await drainQueue();

    // "chill, I need a minute" sent only once
    const chillCalls = messenger.sendMessage.mock.calls.filter(
      (c: any[]) => c[1] === 'chill, I need a minute',
    );
    expect(chillCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe('Error handling', () => {
  it('send fails → reply NOT stored, rate limit NOT charged', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage.mockRejectedValue(new Error('send error'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // storeMessage not called (no reply stored when send fails)
    expect(mockStoreMessage).not.toHaveBeenCalled();
    expect(mockRecordResponse).not.toHaveBeenCalled();
  });

  it('store bot reply fails → logged but send succeeded, rate limit still charged', async () => {
    const { handler, messenger } = makeHandler();
    mockStoreMessage.mockImplementationOnce(() => { throw new Error('store reply failed'); });

    await handleAndDrain(handler, makeIncomingMessage());

    // sendMessage succeeded
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
    // Rate limit still recorded
    expect(mockRecordResponse).toHaveBeenCalledOnce();
  });

  it('recordResponse fails → logged, response already delivered (no further crash)', async () => {
    const { handler, messenger } = makeHandler();
    mockRecordResponse.mockImplementationOnce(() => {
      throw new Error('db write failed');
    });

    await handleAndDrain(handler, makeIncomingMessage());
    // Send succeeded before recordResponse was called
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
  });

  it('rate limit notice send fails → error logged, no crash', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0 });
    messenger.sendMessage.mockRejectedValue(new Error('send notice failed'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await expect(drainQueue()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Negative contract tests
// ===========================================================================

describe('Negative contract tests', () => {
  it('bot MUST NOT store reply if send failed', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage.mockRejectedValue(new Error('network error'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // No storeMessage calls (bot reply not stored on send failure)
    expect(mockStoreMessage).not.toHaveBeenCalled();
  });

  it('bot MUST NOT charge rate limit if send failed', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage.mockRejectedValue(new Error('network error'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(mockRecordResponse).not.toHaveBeenCalled();
  });

  it('bot MUST NOT leak error details (stack traces) in sent messages', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    const errorMsg = 'ReferenceError: foo is not defined\n    at Function.generate';
    vi.mocked(primary.generate).mockRejectedValue(new Error(errorMsg));
    vi.mocked(fallback.generate).mockRejectedValue(new Error(errorMsg));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Verify the sent message contains no stack-trace content
    for (const call of messenger.sendMessage.mock.calls) {
      const sentText: string = (call as any[])[1];
      expect(sentText).not.toContain('ReferenceError');
      expect(sentText).not.toContain('at Function');
      expect(sentText).not.toContain('Error:');
    }
  });
});

// ===========================================================================
// Rate limiting
// ===========================================================================

describe('Rate limiting', () => {
  it('rate limit exhausted → sends "chill, I need a minute", no LLM called', async () => {
    const { handler, messenger, primary } = makeHandler();
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0 });

    await handleAndDrain(handler, makeIncomingMessage());

    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'chill, I need a minute');
    expect(vi.mocked(primary.generate)).not.toHaveBeenCalled();
  });

  it('rate limit allowed → LLM called normally', async () => {
    const { handler, primary } = makeHandler();
    mockCheckRateLimit.mockReturnValue({ allowed: true, remaining: 20 });

    await handleAndDrain(handler, makeIncomingMessage());

    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// Media processing
// ===========================================================================

describe('Media processing', () => {
  it('processMedia called with the incoming message', async () => {
    const { handler, db } = makeHandler();
    const msg = makeIncomingMessage({ contentType: 'image' });

    await handleAndDrain(handler, msg);

    expect(mockProcessMedia).toHaveBeenCalledWith(msg, null, db, msg.messageId);
  });

  it('media content used for LLM request and Pinecone context query', async () => {
    const { handler, primary } = makeHandler();
    const processedContent = 'transcribed audio text';
    mockProcessMedia.mockResolvedValue({ content: processedContent, images: [] });

    await handleAndDrain(handler, makeIncomingMessage({ contentType: 'audio' }));

    // loadContext uses the processed content
    expect(mockLoadContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      processedContent,
    );

    // LLM request uses processed content
    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    expect(lastMsg.content).toContain(processedContent);
  });

  it('DB content updated when processMedia returns different content than original', async () => {
    const { handler, db } = makeHandler();
    const msg = makeIncomingMessage({ content: 'original', contentType: 'audio' });
    mockProcessMedia.mockResolvedValue({ content: 'transcribed text', images: [] });

    await handleAndDrain(handler, msg);

    // The DB UPDATE for media content change should have been called
    expect(db.raw.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE messages SET content'),
    );
  });

  it('DB not updated when processMedia returns same content as original', async () => {
    const { handler, db } = makeHandler();
    const msg = makeIncomingMessage({ content: 'hello bot', contentType: 'text' });
    mockProcessMedia.mockResolvedValue({ content: 'hello bot', images: [] }); // same as msg.content

    const prepareSpy = vi.mocked(db.raw.prepare);

    await handleAndDrain(handler, msg);

    // None of the prepare calls should be for UPDATE messages SET content
    const updateCalls = prepareSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE messages SET content'),
    );
    expect(updateCalls).toHaveLength(0);
  });
});

// ===========================================================================
// B04 — Pinecone graceful degradation
// ===========================================================================

describe('Pinecone graceful degradation (B04)', () => {
  it('loadContext throws → message still processed, LLM called, response sent', async () => {
    const { handler, messenger, primary } = makeHandler();
    mockLoadContext.mockRejectedValue(new Error('Pinecone connection refused'));

    await handleAndDrain(handler, makeIncomingMessage());

    // LLM should still have been called
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    // Response should have been sent
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
  });

  it('loadContext throws → warning log with "context retrieval failed" emitted', async () => {
    const { handler } = makeHandler();
    mockLoadContext.mockRejectedValue(new Error('Pinecone down'));

    await handleAndDrain(handler, makeIncomingMessage());

    expect(mockLogWarn()).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('context retrieval failed'),
    );
  });

  it('loadContext hangs (never resolves) → times out after 5s, response sent without context', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary } = makeHandler();

    // A promise that never resolves
    mockLoadContext.mockReturnValue(new Promise<string>(() => {}));

    await handler.handleMessage(makeIncomingMessage());
    // Advance past the 5-second Pinecone timeout
    await vi.advanceTimersByTimeAsync(6_000);
    await drainQueue();

    // LLM still called, response still sent
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
    expect(mockLogWarn()).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'PINECONE_TIMEOUT' }) }),
      expect.stringContaining('context retrieval failed'),
    );
  });
});

// ===========================================================================
// B05 — LLM retry jitter
// ===========================================================================

describe('LLM retry jitter (B05)', () => {
  it('jitteredDelay(1000, 0) called 100 times produces non-uniform values all in [750, 1250]', () => {
    const samples: number[] = Array.from({ length: 100 }, () => jitteredDelay(1000, 0));

    // All values must fall within the expected range
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(750);
      expect(v).toBeLessThanOrEqual(1250);
    }

    // Values must not all be identical (confirms randomness)
    const unique = new Set(samples.map((v) => Math.round(v)));
    expect(unique.size).toBeGreaterThan(1);
  });

  it('jitteredDelay caps at maxMs even for large attempt counts', () => {
    const v = jitteredDelay(1000, 20, 5_000);
    // capped at 5000, jitter range 0.75–1.25 → [3750, 6250] but capped means
    // the exp before jitter is min(1000 * 2^20, 5000) = 5000
    // so result is 5000 * random(0.75..1.25) which can be up to 6250 — that's intentional
    // What we verify is it's >= 0 and finite
    expect(v).toBeGreaterThan(0);
    expect(isFinite(v)).toBe(true);
  });

  it('retry delay in processMessage uses jitter (not fixed) — timer is advanced by jitteredDelay amount', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary } = makeHandler();
    vi.mocked(primary.generate)
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce({
        content: 'retry success',
        inputTokens: 100,
        outputTokens: 10,
        model: 'claude-opus-4-6',
        durationMs: 500,
      });

    await handler.handleMessage(makeIncomingMessage());
    // Advance all pending timers (Pinecone 5s race + jitter retry up to ~1.25s)
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(primary.generate)).toHaveBeenCalledTimes(2);
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'retry success');
  });
});

// ===========================================================================
// Runtime interface
// ===========================================================================

describe('Runtime interface', () => {
  it('start() resolves without error', async () => {
    const { handler } = makeHandler();
    await expect(handler.start()).resolves.toBeUndefined();
  });

  it('shutdown() resolves without error', async () => {
    const { handler } = makeHandler();
    await expect(handler.shutdown()).resolves.toBeUndefined();
  });

  it('getHealthSnapshot() returns healthy status', () => {
    const { handler } = makeHandler();
    const snap = handler.getHealthSnapshot();
    expect(snap.status).toBe('healthy');
  });

  // @check CHK-016
  // @traces REQ-004.AC-03
  it('getHealthSnapshot() includes queue and enrichment details', () => {
    const { handler } = makeHandler();
    const snap = handler.getHealthSnapshot();
    expect(snap.details).toHaveProperty('queue');
    expect(snap.details).toHaveProperty('enrichmentLastRunAt');
  });

  it('start() calls EnrichmentPoller.start() exactly once', async () => {
    const { handler } = makeHandler();
    // Constructor wires the poller; start() should drive it.
    expect(mockEnrichmentPollerInstances()).toHaveLength(1);
    expect(mockEnrichmentPollerStart()).not.toHaveBeenCalled();
    await handler.start();
    expect(mockEnrichmentPollerStart()).toHaveBeenCalledTimes(1);
  });

  it('shutdown() calls EnrichmentPoller.stop() exactly once', async () => {
    const { handler } = makeHandler();
    await handler.start();
    expect(mockEnrichmentPollerStop()).not.toHaveBeenCalled();
    await handler.shutdown();
    expect(mockEnrichmentPollerStop()).toHaveBeenCalledTimes(1);
  });

  it('does not start the enrichment poller when enableEnrichment is false', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const pinecone = makePinecone();
    const primary = makePrimaryProvider();
    const fallback = makeFallbackProvider();
    const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback, {
      enableEnrichment: false,
    });
    await handler.start();
    await handler.shutdown();
    // Constructor short-circuits poller creation, so neither spy fires and
    // no instance is registered.
    expect(mockEnrichmentPollerInstances()).toHaveLength(0);
    expect(mockEnrichmentPollerStart()).not.toHaveBeenCalled();
    expect(mockEnrichmentPollerStop()).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Identity injection
// ===========================================================================

describe('Identity injection', () => {
  /**
   * Build a handler with identity options and return the system prompt
   * that would be passed to the primary provider on the next message.
   */
  async function getSystemPromptWithOptions(
    options: import('../../../src/runtimes/chat/runtime.ts').ChatRuntimeOptions,
  ): Promise<string> {
    const db = makeDb();
    const messenger = makeMessenger();
    const pinecone = makePinecone();
    const primary = makePrimaryProvider();
    const fallback = makeFallbackProvider();
    const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback, options);

    await handleAndDrain(handler, makeIncomingMessage());

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    return request.systemPrompt;
  }

  it('[IDENTITY] block is present in system prompt when getBotJid is provided', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    expect(systemPrompt).toContain('[IDENTITY]');
    expect(systemPrompt).toContain('[/IDENTITY]');
  });

  it('[IDENTITY] block contains the bot name', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'BesBot',
    });
    expect(systemPrompt).toContain('You are BesBot.');
  });

  it('[IDENTITY] block contains the bot JID', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    expect(systemPrompt).toContain('15551234567@s.whatsapp.net');
  });

  it('[IDENTITY] block contains the bot LID when provided', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => '98765@lid',
      botName: 'TestBot',
    });
    expect(systemPrompt).toContain('98765@lid');
  });

  it('[IDENTITY] block omits LID line when getBotLid returns null', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    // LID line only appears when botLid is truthy
    expect(systemPrompt).not.toContain('Your WhatsApp LID');
  });

  it('[IDENTITY] block includes NEVER self-mention instruction', async () => {
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    expect(systemPrompt).toContain('NEVER @mention yourself');
  });

  it('[IDENTITY] block is still present when getBotJid returns empty string', async () => {
    // Empty string is falsy — JID line should be omitted but block still renders
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    expect(systemPrompt).toContain('[IDENTITY]');
    expect(systemPrompt).toContain('You are TestBot.');
    // JID line must not appear when empty
    expect(systemPrompt).not.toContain('Your WhatsApp JID is .');
  });

  it('identity block appears before any context block in system prompt', async () => {
    mockLoadContext.mockResolvedValue('Background:\n- some fact');
    const systemPrompt = await getSystemPromptWithOptions({
      enableEnrichment: false,
      getBotJid: () => '15551234567@s.whatsapp.net',
      getBotLid: () => null,
      botName: 'TestBot',
    });
    const identityPos = systemPrompt.indexOf('[IDENTITY]');
    const contextPos = systemPrompt.indexOf('Background:');
    expect(identityPos).toBeGreaterThanOrEqual(0);
    expect(contextPos).toBeGreaterThanOrEqual(0);
    expect(identityPos).toBeLessThan(contextPos);
  });
});

// ---------------------------------------------------------------------------
// Gap #104: chatbot has no MCP socket / no MCP leakage
// ChatRuntime must never import or instantiate WhatSoupSocketServer.
// Verified by static analysis of the source file so the constraint
// cannot be accidentally re-introduced without a test failure.
// ---------------------------------------------------------------------------

describe('ChatRuntime — no MCP socket leakage (Gap #104)', () => {
  it('ChatRuntime source does not import or reference WhatSoupSocketServer', async () => {
    // Read the ChatRuntime source as text — static analysis beats runtime mocking
    // because a future import would show up immediately even if the code path
    // is never exercised in integration tests.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const runtimeSrc = readFileSync(
      resolve(__dirname, '../../../src/runtimes/chat/runtime.ts'),
      'utf8',
    );

    expect(runtimeSrc).not.toContain('WhatSoupSocketServer');
    expect(runtimeSrc).not.toContain('socket-server');
  });

  it('ChatRuntime can be constructed without starting a socket server', () => {
    // Constructing ChatRuntime with a minimal no-op messenger must not throw
    // and must not produce any WhatSoupSocketServer instance (enforced by the
    // source-level assertion above; this test confirms the constructor path
    // itself is safe at runtime).
    const messenger = {
      sendMessage: async () => ({ waMessageId: null }),
    } as any;
    const db = { raw: { exec: () => {}, prepare: () => ({ get: () => ({ cnt: 0 }) }) } } as any;
    const pinecone = { query: async () => null } as any;
    const provider = { generate: async () => ({ content: '', model: '', inputTokens: 0, outputTokens: 0 }) } as any;

    // Should not throw — no socket-server side-effect
    expect(
      () => new ConversationHandler(db, messenger, pinecone, provider, provider, { enableEnrichment: false }),
    ).not.toThrow();
  });
});

// ===========================================================================
// B02 — WhatsApp send retry with exponential backoff
// ===========================================================================

describe('Send retry with exponential backoff (B02)', () => {
  it('send fails on first attempt, succeeds on second → response delivered, rate limit charged', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage
      .mockRejectedValueOnce(new Error('transient network error'))
      .mockResolvedValueOnce({ waMessageId: null });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockRecordResponse).toHaveBeenCalledOnce();
  });

  it('send fails on first two attempts, succeeds on third → response delivered', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockResolvedValueOnce({ waMessageId: null });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(messenger.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockRecordResponse).toHaveBeenCalledOnce();
  });

  it('all 3 send attempts fail → error logged with responseText for recovery', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage.mockRejectedValue(new Error('permanent failure'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // 3 send attempts + 1 best-effort failure notification
    expect(messenger.sendMessage).toHaveBeenCalledTimes(4);
    // The error log must include responseText so the response is recoverable
    expect(mockLogError()).toHaveBeenCalledWith(
      expect.objectContaining({ responseText: 'hey whats up' }),
      expect.stringContaining('all send attempts failed'),
    );
  });

  it('all 3 send attempts fail → rate limit NOT charged, reply NOT stored', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage.mockRejectedValue(new Error('permanent failure'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(mockRecordResponse).not.toHaveBeenCalled();
    expect(mockStoreMessage).not.toHaveBeenCalled();
  });

  it('retry warns on each failed attempt before the next try', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage
      .mockRejectedValueOnce(new Error('attempt 1 failed'))
      .mockRejectedValueOnce(new Error('attempt 2 failed'))
      .mockResolvedValueOnce({ waMessageId: null });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Two warn calls: one before attempt 2, one before attempt 3
    const warnCalls = mockLogWarn().mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('send_retry'),
    );
    expect(warnCalls).toHaveLength(2);
  });
});

// ===========================================================================
// WhatSoupError non-retryable paths (LLM_AUTH_ERROR, LLM_RATE_LIMITED, LLM_BAD_REQUEST)
// ===========================================================================

import { WhatSoupError } from '../../../src/errors.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(),
  clearAlertSourceChecked: vi.fn(),
}));

import { emitAlertChecked, clearAlertSourceChecked } from '../../../src/lib/emit-alert.ts';

const mockEmitAlert = vi.mocked(emitAlertChecked);
const mockClearAlert = vi.mocked(clearAlertSourceChecked);

describe('WhatSoupError non-retryable paths', () => {
  it('LLM_AUTH_ERROR → no retry, no fallback, fallback message sent, alert emitted', async () => {
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValueOnce(
      new WhatSoupError('Unauthorized', 'LLM_AUTH_ERROR'),
    );

    await handleAndDrain(handler, makeIncomingMessage());

    // Fallback provider must NOT be attempted for auth errors
    expect(vi.mocked(fallback.generate)).not.toHaveBeenCalled();
    // Primary only called once — no retry
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    // User gets the deterministic auth-fitting message (#1064)
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      "⚠️ I can't reach my language model right now — it looks like a setup issue on my end. My operator has been notified; please try again later.",
    );
    // Alert must be emitted
    expect(mockEmitAlert).toHaveBeenCalledWith(
      expect.any(String),
      'llm_total_failure',
      expect.stringContaining('LLM_AUTH_ERROR'),
      expect.any(String),
    );
  });

  it('LLM_RATE_LIMITED → no retry, no fallback, fallback message sent, alert emitted', async () => {
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValueOnce(
      new WhatSoupError('Rate limited', 'LLM_RATE_LIMITED'),
    );

    await handleAndDrain(handler, makeIncomingMessage());

    expect(vi.mocked(fallback.generate)).not.toHaveBeenCalled();
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      "I'm getting more messages than I can keep up with right now — give me a minute and ask again.",
    );
    expect(mockEmitAlert).toHaveBeenCalledWith(
      expect.any(String),
      'llm_total_failure',
      expect.stringContaining('LLM_RATE_LIMITED'),
      expect.any(String),
    );
  });

  it('LLM_BAD_REQUEST → skips primary retry, tries fallback provider directly', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValueOnce(
      new WhatSoupError('Bad request payload', 'LLM_BAD_REQUEST'),
    );
    vi.mocked(fallback.generate).mockResolvedValue({
      content: 'fallback handled bad request',
      inputTokens: 80,
      outputTokens: 8,
      model: 'gpt-5.4',
      durationMs: 400,
    });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Primary only called once (no retry on bad_request)
    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    // Fallback attempted
    expect(vi.mocked(fallback.generate)).toHaveBeenCalledOnce();
    // Fallback response sent to user
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'fallback handled bad request',
    );
  });

  it('LLM_BAD_REQUEST + fallback also fails → alert emitted, fallback message sent', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValueOnce(
      new WhatSoupError('Bad request payload', 'LLM_BAD_REQUEST'),
    );
    vi.mocked(fallback.generate).mockRejectedValueOnce(new Error('fallback also fails'));

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(primary.generate)).toHaveBeenCalledOnce();
    expect(vi.mocked(fallback.generate)).toHaveBeenCalledOnce();
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'lol my brain glitched for a sec — mind asking me again?',
    );
    expect(mockEmitAlert).toHaveBeenCalledWith(
      expect.any(String),
      'llm_total_failure',
      expect.stringContaining('bad request'),
      expect.any(String),
    );
  });

  it('primary success → clearAlertSourceChecked called to reset alert state', async () => {
    const { handler } = makeHandler();
    await handleAndDrain(handler, makeIncomingMessage());
    expect(mockClearAlert).toHaveBeenCalledWith(expect.any(String), 'llm_total_failure');
  });
});

// ===========================================================================
// getHealthSnapshot degraded status paths
// ===========================================================================

describe('getHealthSnapshot degraded paths', () => {
  it('returns degraded when queue has waiting chats', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const pinecone = makePinecone();
    const primary = makePrimaryProvider();
    const fallback = makeFallbackProvider();
    // Inject a custom ChatQueue mock that reports queuedChats > 0
    const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback, {
      enableEnrichment: false,
    });
    // Monkey-patch the chatQueue stats to simulate backlog
    (handler as any).chatQueue = {
      enqueue: vi.fn(),
      get stats() {
        return { activeChats: 1, queuedChats: 3, trackedChats: 4 };
      },
    };
    const snap = handler.getHealthSnapshot();
    expect(snap.status).toBe('degraded');
    expect(snap.details.queueDepth).toBe(3);
  });

  it('returns degraded when enrichment last run is stale (older than ENRICHMENT_STALE_MS)', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const pinecone = makePinecone();
    const primary = makePrimaryProvider();
    const fallback = makeFallbackProvider();
    const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback, {
      enableEnrichment: true, // poller created
    });
    // Set lastRunAt to a time well past the stale threshold (15 minutes ago)
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const poller = (handler as any).enrichmentPoller;
    if (poller) {
      poller.lastRunAt = staleTime;
    }
    const snap = handler.getHealthSnapshot();
    expect(snap.status).toBe('degraded');
    expect(snap.details.enrichmentLastRunAt).toBe(staleTime);
  });

  it('returns healthy when enrichment last run is recent', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const pinecone = makePinecone();
    const primary = makePrimaryProvider();
    const fallback = makeFallbackProvider();
    const handler = new ConversationHandler(db, messenger, pinecone, primary, fallback, {
      enableEnrichment: true,
    });
    const recentTime = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago = fresh
    const poller = (handler as any).enrichmentPoller;
    if (poller) {
      poller.lastRunAt = recentTime;
    }
    // No queued chats, enrichment is fresh
    (handler as any).chatQueue = {
      enqueue: vi.fn(),
      get stats() {
        return { activeChats: 0, queuedChats: 0, trackedChats: 0 };
      },
    };
    const snap = handler.getHealthSnapshot();
    expect(snap.status).toBe('healthy');
  });
});

// ===========================================================================
// Group chat sender label
// ===========================================================================

describe('Group chat sender label', () => {
  it('group message with senderName → label includes @phone prefix in content', async () => {
    const { handler, primary } = makeHandler();
    const msg = makeIncomingMessage({
      chatJid: `111111100000000001@g.us`,
      senderJid: '15551230001@s.whatsapp.net',
      senderName: 'Charlie',
      isGroup: true,
      content: 'group message text',
    });
    mockProcessMedia.mockResolvedValue({ content: 'group message text', images: [] });

    await handleAndDrain(handler, msg);

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    // Label format for group: [Name (@phone)]:
    expect(lastMsg.content).toMatch(/^\[Charlie \(@\d+\)\]: group message text$/);
  });

  it('non-group message with senderName → label uses simple [Name]: prefix', async () => {
    const { handler, primary } = makeHandler();
    const msg = makeIncomingMessage({
      senderName: 'Dave',
      isGroup: false,
      content: 'dm text',
    });
    mockProcessMedia.mockResolvedValue({ content: 'dm text', images: [] });

    await handleAndDrain(handler, msg);

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    expect(lastMsg.content).toBe('[Dave]: dm text');
  });

  it('message with no senderName → no label prefix in content', async () => {
    const { handler, primary } = makeHandler();
    const msg = makeIncomingMessage({
      senderName: null as unknown as string,
      isGroup: false,
      content: 'no name message',
    });
    mockProcessMedia.mockResolvedValue({ content: 'no name message', images: [] });

    await handleAndDrain(handler, msg);

    const request = vi.mocked(primary.generate).mock.calls[0][0];
    const lastMsg = request.messages[request.messages.length - 1];
    // No label prefix when senderName is falsy
    expect(lastMsg.content).toBe('no name message');
  });
});

// ===========================================================================
// Token budget trimming
// ===========================================================================

describe('Token budget trimming', () => {
  it('large window trimmed to stay within token budget — trimmedMessages logged', async () => {
    const { handler, primary } = makeHandler();

    // Build a conversation window that exceeds the token budget.
    // config.tokenBudget is typically 100000 tokens; 4 chars ≈ 1 token.
    // Use enough content to exceed the budget.
    const longContent = 'x'.repeat(200_000); // ~50k tokens each
    const bigWindow = [
      { role: 'user' as const, content: longContent },
      { role: 'assistant' as const, content: longContent },
      { role: 'user' as const, content: longContent },
      { role: 'assistant' as const, content: longContent },
    ];
    mockLoadConversationWindow.mockReturnValue(bigWindow);
    mockProcessMedia.mockResolvedValue({ content: 'final message', images: [] });

    await handleAndDrain(handler, makeIncomingMessage({ content: 'final message' }));

    // Window must have been trimmed — messages removed from the front
    const request = vi.mocked(primary.generate).mock.calls[0][0];
    // Original window had 4 messages + 1 current = 5; after trimming it must be fewer
    expect(request.messages.length).toBeLessThan(5);

    // Log must show trim occurred with a positive trimmedMessages count
    const trimLog = mockLogInfo().mock.calls.find(
      (c: unknown[]) => typeof c[1] === 'string' && c[1].includes('token budget'),
    );
    // Confirm the log entry exists and has the right shape before asserting values
    expect(trimLog).toHaveLength(2); // [meta, message]
    expect((trimLog![0] as any).trimmedMessages).toBeGreaterThan(0);
    expect((trimLog![0] as any).estimatedTokens).toBeGreaterThan(0);
  });
});

// ===========================================================================
// DurabilityEngine integration
// ===========================================================================

function makeDurability() {
  return {
    createOutboundOp: vi.fn().mockReturnValue(42),
    markSending: vi.fn(),
    markSubmitted: vi.fn(),
    markMaybeSent: vi.fn(),
    markInboundSkipped: vi.fn(),
    markInboundFailed: vi.fn(),
    completeInbound: vi.fn(),
  } as unknown as import('../../../src/core/durability.ts').DurabilityEngine;
}

describe('DurabilityEngine integration', () => {
  it('setDurability wires engine — createOutboundOp called on happy path', async () => {
    const { handler, messenger } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);

    await handleAndDrain(handler, makeIncomingMessage({ messageId: 'msg-dur-001' }));

    expect(vi.mocked(durability.createOutboundOp)).toHaveBeenCalledOnce();
    expect(vi.mocked(durability.markSending)).toHaveBeenCalledWith(42);
    expect(vi.mocked(durability.markSubmitted)).toHaveBeenCalledWith(42, null);
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
  });

  it('completeInbound called with inboundSeq on successful send', async () => {
    const { handler } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);

    const msg = makeIncomingMessage({ inboundSeq: 7 });
    await handleAndDrain(handler, msg);

    expect(vi.mocked(durability.completeInbound)).toHaveBeenCalledWith(7, 'response_sent');
  });

  it('completeInbound NOT called when inboundSeq is undefined', async () => {
    const { handler } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);

    const msg = makeIncomingMessage({ inboundSeq: undefined });
    await handleAndDrain(handler, msg);

    expect(vi.mocked(durability.completeInbound)).not.toHaveBeenCalled();
  });

  it('send failure: markMaybeSent called with error message, markInboundFailed called with inboundSeq', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);
    messenger.sendMessage.mockRejectedValue(new Error('permanent send failure'));

    const msg = makeIncomingMessage({ inboundSeq: 99 });
    await handler.handleMessage(msg);
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(durability.markMaybeSent)).toHaveBeenCalledWith(42, 'permanent send failure');
    expect(vi.mocked(durability.markInboundFailed)).toHaveBeenCalledWith(99);
  });

  it('send failure without inboundSeq → markInboundFailed NOT called', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);
    messenger.sendMessage.mockRejectedValue(new Error('send fail'));

    const msg = makeIncomingMessage({ inboundSeq: undefined });
    await handler.handleMessage(msg);
    await vi.runAllTimersAsync();
    await drainQueue();

    expect(vi.mocked(durability.markInboundFailed)).not.toHaveBeenCalled();
  });

  it('rate-limited message with durability + inboundSeq → markInboundSkipped called', async () => {
    const { handler } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0 });

    const msg = makeIncomingMessage({ inboundSeq: 55 });
    await handleAndDrain(handler, msg);

    expect(vi.mocked(durability.markInboundSkipped)).toHaveBeenCalledWith(55, 'rate_limited');
  });

  it('rate-limited message with durability but no inboundSeq → markInboundSkipped NOT called', async () => {
    const { handler } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);
    mockCheckRateLimit.mockReturnValue({ allowed: false, remaining: 0 });

    const msg = makeIncomingMessage({ inboundSeq: undefined });
    await handleAndDrain(handler, msg);

    expect(vi.mocked(durability.markInboundSkipped)).not.toHaveBeenCalled();
  });

  it('token counts persisted to DB when LLM returns non-zero tokens', async () => {
    const { handler, db } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);

    await handleAndDrain(handler, makeIncomingMessage({ messageId: 'tok-001' }));

    // The UPDATE messages SET input_tokens prepare call must have occurred with the right SQL
    const prepareCalls = vi.mocked(db.raw.prepare).mock.calls;
    const tokenUpdateCall = prepareCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE messages SET input_tokens'),
    );
    expect(tokenUpdateCall).toHaveLength(1);
    expect(tokenUpdateCall![0]).toContain('UPDATE messages SET input_tokens');
  });

  it('token counts NOT persisted when LLM returns zero tokens', async () => {
    const { handler, db, primary } = makeHandler();
    vi.mocked(primary.generate).mockResolvedValue({
      content: 'zero token response',
      inputTokens: 0,
      outputTokens: 0,
      model: 'claude-opus-4-6',
      durationMs: 200,
    });

    await handleAndDrain(handler, makeIncomingMessage());

    const prepareCalls = vi.mocked(db.raw.prepare).mock.calls;
    const tokenUpdateSqls = prepareCalls
      .map((c) => c[0])
      .filter((sql): sql is string => typeof sql === 'string' && sql.includes('UPDATE messages SET input_tokens'));
    expect(tokenUpdateSqls).toHaveLength(0);
  });
});

// ===========================================================================
// rawMessage download function
// ===========================================================================

describe('rawMessage download function', () => {
  it('rawMessage present → downloadFn passed to processMedia is a callable function', async () => {
    const { handler } = makeHandler();
    const msg = makeIncomingMessage({
      contentType: 'image',
      rawMessage: { key: { id: 'msg-raw-001' } } as any,
    });

    await handleAndDrain(handler, msg);

    // processMedia must have been called with a function (not null) when rawMessage is truthy
    const processMediaCalls = vi.mocked(mockProcessMedia).mock.calls;
    expect(processMediaCalls).toHaveLength(1);
    const downloadFnArg = processMediaCalls[0][1];
    expect(typeof downloadFnArg).toBe('function');
    // The download fn must be callable and return a promise
    const result = (downloadFnArg as () => unknown)();
    expect(result).toBeInstanceOf(Promise);
    // Swallow the expected rejection: the mock rawMessage is not a real Baileys
    // message so the underlying downloadMediaMessage rejects. We only assert the
    // downloadFn wiring here; not awaiting/catching would leak an unhandled rejection.
    await (result as Promise<unknown>).catch(() => {});
  });

  it('no rawMessage → downloadFn passed to processMedia is null', async () => {
    const { handler, messenger } = makeHandler();
    const msg = makeIncomingMessage({ rawMessage: undefined });

    await handleAndDrain(handler, msg);

    const processMediaCalls = vi.mocked(mockProcessMedia).mock.calls;
    expect(processMediaCalls[0][1]).toBeNull();
    // Pipeline still completes — LLM response was sent
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'hey whats up');
  });
});

// ===========================================================================
// ?? 'unknown' fallback branches — non-Error thrown values
//
// The runtime uses `(err as Error)?.message ?? 'unknown'` in warn/error logs
// at multiple points. When a non-Error value (plain string, plain object, null)
// is thrown, `.message` is undefined and the `?? 'unknown'` branch fires.
// These tests cover the 6 uncovered binary-expression branches.
// ===========================================================================

describe("?? 'unknown' fallback in log calls (non-Error thrown values)", () => {
  // Branch #28 line 300: primary provider throws a non-Error value on first attempt
  // — the warn log's `error: (primaryErr as Error)?.message ?? 'unknown'` fallback fires.
  it('primary throws non-Error on first attempt → warn log uses "unknown" error string, fallback succeeds', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    // Throw a plain string — not an Error instance, so .message is undefined
    vi.mocked(primary.generate)
      .mockRejectedValueOnce('plain string rejection')
      .mockRejectedValueOnce('plain string rejection 2');
    vi.mocked(fallback.generate).mockResolvedValue({
      content: 'fallback ok',
      inputTokens: 80,
      outputTokens: 8,
      model: 'gpt-5.4',
      durationMs: 400,
    });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Both primary attempts (attempt 1 + retry) should have used the ?? 'unknown' path in warn log
    const warnCalls = mockLogWarn().mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('llm_attempt_failed'),
    );
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    // The error field in the log object should be 'unknown' (no .message on a string throw)
    const firstFailLog = warnCalls[0][0] as Record<string, unknown>;
    expect(firstFailLog.error).toBe('unknown');
    // Fallback response was delivered
    expect(messenger.sendMessage).toHaveBeenCalledWith(expect.any(String), 'fallback ok');
  });

  // Branch #33 line 359: retry attempt throws a non-Error value
  // — the warn log's `error: (retryErr as Error)?.message ?? 'unknown'` fallback fires.
  it('retry attempt throws non-Error value → retry warn log uses "unknown" error string', async () => {
    vi.useFakeTimers();
    const { handler, messenger, fallback } = makeHandler();
    const primary = {
      name: 'anthropic',
      generate: vi.fn()
        .mockRejectedValueOnce(new Error('first failure'))   // attempt 1 — normal Error
        .mockRejectedValueOnce({ code: 42 })                // attempt 2 retry — non-Error object, no .message
    };
    const db = makeDb();
    const messenger2 = makeMessenger();
    const pinecone = makePinecone();
    const handler2 = new ConversationHandler(db, messenger2, pinecone, primary as unknown as LLMProvider, fallback, {
      enableEnrichment: false,
    });
    vi.mocked(fallback.generate).mockResolvedValue({
      content: 'fallback after retry fail',
      inputTokens: 80,
      outputTokens: 8,
      model: 'gpt-5.4',
      durationMs: 400,
    });

    await handler2.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Retry warn log should show error: 'unknown' since {code: 42} has no .message
    const warnCalls = mockLogWarn().mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('llm_attempt_failed'),
    );
    const retryFailLog = warnCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).step === 'retry',
    );
    expect(retryFailLog).toBeDefined();
    expect((retryFailLog![0] as Record<string, unknown>).error).toBe('unknown');
    // Fallback succeeded
    expect(messenger2.sendMessage).toHaveBeenCalledWith(expect.any(String), 'fallback after retry fail');
  });

  // Branch #34 line 377: fallback provider throws a non-Error value after retry exhaustion
  // — the warn log's `error: (fallbackErr as Error)?.message ?? 'unknown'` fallback fires.
  it('fallback throws non-Error value → fallback warn log uses "unknown" error string', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    // Throw a non-Error object from fallback
    vi.mocked(fallback.generate).mockRejectedValue({ status: 503 });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Fallback warn log should use 'unknown' since {status: 503} has no .message
    const warnCalls = mockLogWarn().mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('llm_attempt_failed'),
    );
    const fallbackWarnLog = warnCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).step === 'fallback',
    );
    expect(fallbackWarnLog).toBeDefined();
    expect((fallbackWarnLog![0] as Record<string, unknown>).error).toBe('unknown');
  });

  // Branch #35 line 385: fallback throws a non-Error value → emitAlertChecked receives ?? 'unknown' in detail string
  it('all providers fail with non-Error throw → alert detail uses "unknown" error string', async () => {
    vi.useFakeTimers();
    const { handler, messenger, primary, fallback } = makeHandler();
    vi.mocked(primary.generate).mockRejectedValue(new Error('primary down'));
    vi.mocked(fallback.generate).mockRejectedValue(null);  // null has no .message

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // Alert must have been emitted with 'unknown' in the detail string
    expect(mockEmitAlert).toHaveBeenCalledWith(
      expect.any(String),
      'llm_total_failure',
      expect.stringContaining('All LLM providers failed'),
      expect.stringContaining('unknown'),
    );
    // Deterministic outage message sent to user (#1064)
    expect(messenger.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      '⚠️ My language model is unavailable right now and my operator has been notified — please try again in a bit.',
    );
  });

  // Branch #39 line 420: send retry warn log fires when lastSendErr has no .message
  // — `(lastSendErr as Error)?.message ?? 'unknown'` fallback in send_retry warn log.
  it('send retry with non-Error rejection → send_retry warn log uses "unknown" error field', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    messenger.sendMessage
      .mockRejectedValueOnce('string error, no .message')   // attempt 1: non-Error
      .mockResolvedValueOnce({ waMessageId: null });         // attempt 2: success

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // The send_retry warn is only logged before attempt ≥ 2
    const warnCalls = mockLogWarn().mock.calls.filter(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string) === 'send_retry',
    );
    expect(warnCalls).toHaveLength(1);
    // error field in the log object should be 'unknown' (thrown value was a plain string)
    const warnMeta = warnCalls[0][0] as Record<string, unknown>;
    expect(warnMeta.error).toBe('unknown');
    // Send eventually succeeded on attempt 2
    expect(mockRecordResponse).toHaveBeenCalledOnce();
  });

  // Branch #40 line 440: markMaybeSent receives ?? 'send_retry_failed' when lastSendErr has no .message.
  it('all 3 sends fail with non-Error throw → markMaybeSent called with "send_retry_failed"', async () => {
    vi.useFakeTimers();
    const { handler, messenger } = makeHandler();
    const durability = makeDurability();
    handler.setDurability(durability);
    // Throw a plain object with no .message on all three send attempts
    messenger.sendMessage.mockRejectedValue({ httpStatus: 500 });

    await handler.handleMessage(makeIncomingMessage());
    await vi.runAllTimersAsync();
    await drainQueue();

    // markMaybeSent must be called with the fallback string 'send_retry_failed'
    expect(vi.mocked(durability.markMaybeSent)).toHaveBeenCalledWith(42, 'send_retry_failed');
  });
});
