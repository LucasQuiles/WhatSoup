/**
 * Shape tests for ChatRuntime.getHealthSnapshot().
 *
 * Verifies that the details object contains the expected keys with
 * the correct types — specifically queueDepth (number) and
 * enrichmentUnprocessed (number).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────
// Must be declared before any imports of the modules they replace.

vi.mock('../../../src/config.ts', () => ({
  config: {
    botName: 'TestBot',
    rateLimitNoticeWindowMs: 60_000,
    tokenBudget: 8_000,
    apiRetryDelayMs: 1_000,
    models: { conversation: 'claude-test', fallback: 'claude-fallback' },
    maxTokens: 1_024,
    systemPrompt: 'You are a test bot.',
    enrichmentIntervalMs: 60_000,
    enrichmentBatchSize: 200,
    enrichmentMaxRetries: 3,
  },
}));

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/core/health.ts', () => ({
  ENRICHMENT_STALE_MS: 3_600_000,
}));

// Stub EnrichmentPoller — controls lastRunAt and unprocessedCount
vi.mock('../../../src/runtimes/chat/enrichment/poller.ts', () => {
  class EnrichmentPoller {
    lastRunAt: string | null = null;
    unprocessedCount: number = 0;
    start = vi.fn();
    stop = vi.fn();
    constructor(..._args: unknown[]) {}
  }
  return { EnrichmentPoller };
});

// Stub ChatQueue so stats returns controllable values
vi.mock('../../../src/runtimes/chat/queue.ts', () => {
  class ChatQueue {
    private _stats = { activeChats: 0, queuedChats: 0, trackedChats: 0 };
    enqueue = vi.fn();
    get stats() { return this._stats; }
  }
  return { ChatQueue };
});

// Stub remaining heavy deps that ChatRuntime imports
vi.mock('../../../src/runtimes/chat/rate-limiter.ts', () => ({ checkRateLimit: vi.fn() }));
vi.mock('../../../src/runtimes/chat/window.ts', () => ({ loadConversationWindow: vi.fn() }));
vi.mock('../../../src/runtimes/chat/context.ts', () => ({ loadContext: vi.fn() }));
vi.mock('../../../src/core/messages.ts', () => ({ storeMessage: vi.fn() }));
vi.mock('../../../src/runtimes/chat/rate-limits-db.ts', () => ({ recordResponse: vi.fn() }));
vi.mock('../../../src/runtimes/chat/media/processor.ts', () => ({ processMedia: vi.fn() }));
vi.mock('../../../src/core/durability.ts', () => ({ sendTracked: vi.fn() }));
vi.mock('../../../src/core/conversation-key.ts', () => ({ toConversationKey: vi.fn() }));
vi.mock('../../../src/core/retry.ts', () => ({ jitteredDelay: vi.fn().mockReturnValue(0) }));
vi.mock('@whiskeysockets/baileys', () => ({ downloadMediaMessage: vi.fn() }));

// ── Imports ──────────────────────────────────────────────────────────────────

import { ChatRuntime } from '../../../src/runtimes/chat/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../src/runtimes/chat/providers/pinecone.ts';
import { EnrichmentPoller } from '../../../src/runtimes/chat/enrichment/poller.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return { sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }) };
}

function makeLLMProvider(): LLMProvider {
  return {
    name: 'mock',
    generate: vi.fn().mockResolvedValue({ content: 'ok', inputTokens: 10, outputTokens: 5, model: 'mock', durationMs: 10 }),
  };
}

function makePinecone(): PineconeMemory {
  return { query: vi.fn(), upsert: vi.fn() } as unknown as PineconeMemory;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatRuntime.getHealthSnapshot — shape', () => {
  let runtime: ChatRuntime;
  let poller: EnrichmentPoller;

  beforeEach(() => {
    runtime = new ChatRuntime(makeDb(), makeMessenger(), makePinecone(), makeLLMProvider(), makeLLMProvider());
    // Grab the EnrichmentPoller instance that was constructed internally
    // (it's the only instance created; vi.mocked class stores it nowhere, so
    //  we rely on the fact that we can reach it via getHealthSnapshot output,
    //  or we just test the output shape directly).
  });

  it('details contains queueDepth as a number', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(typeof snapshot.details['queueDepth']).toBe('number');
  });

  it('details contains enrichmentUnprocessed as a number', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(typeof snapshot.details['enrichmentUnprocessed']).toBe('number');
  });

  it('queueDepth reflects queue.queuedChats (zero when idle)', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['queueDepth']).toBe(0);
  });

  it('enrichmentUnprocessed reflects poller.unprocessedCount (zero when poller returns 0)', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(snapshot.details['enrichmentUnprocessed']).toBe(0);
  });

  it('enrichmentUnprocessed is 0 when enrichment is disabled', () => {
    const runtimeNoEnrichment = new ChatRuntime(
      makeDb(), makeMessenger(), makePinecone(), makeLLMProvider(), makeLLMProvider(),
      { enableEnrichment: false },
    );
    const snapshot = runtimeNoEnrichment.getHealthSnapshot();
    expect(typeof snapshot.details['enrichmentUnprocessed']).toBe('number');
    expect(snapshot.details['enrichmentUnprocessed']).toBe(0);
  });

  it('snapshot has a valid status string', () => {
    const snapshot = runtime.getHealthSnapshot();
    expect(['healthy', 'degraded', 'unhealthy']).toContain(snapshot.status);
  });
});
