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
    // T8-F1: chat/runtime.ts's redactInternalArtifacts ctx now reads
    // config.adminPhones (isOperatorDmPeer) — empty so this test's fixture
    // JIDs never resolve as operator DMs (unchanged pre-F1 behavior).
    adminPhones: new Set<string>(),
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
    cycleHealthState = 'not_started';
    latestCycleReceipt: {
      status: string;
      failureCode: string;
      stage: string;
      retryable: boolean;
      evidenceCoverage: string;
      completedAt: string | null;
    } | null = null;
    start = vi.fn();
    stop = vi.fn();
    hydrateLatestCycleReceipt = vi.fn();
    constructor(..._args: unknown[]) {}
  }
  return { EnrichmentPoller };
});

// Stub ChatQueue so stats returns controllable values
vi.mock('../../../src/runtimes/chat/queue.ts', () => {
  class ChatQueue {
    private _stats = { activeChats: 0, queuedChats: 0, trackedChats: 0 };
    enqueue = vi.fn().mockResolvedValue(true);
    get droppedCount() { return 0; }
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
vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMediaMock } = await import('../../helpers/baileys-mock.ts');
  return baileysMediaMock();
});

// ── Imports ──────────────────────────────────────────────────────────────────

import { ChatRuntime } from '../../../src/runtimes/chat/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../src/runtimes/chat/providers/pinecone.ts';

type SnapshotPoller = {
  lastRunAt: string | null;
  unprocessedCount: number;
  cycleHealthState: 'not_started' | 'no_work' | 'current' | 'partial' | 'failed' | 'stale' | 'unreadable' | 'invalid';
  latestCycleReceipt: {
    status: string;
    failureCode: string;
    stage: string;
    retryable: boolean;
    evidenceCoverage: string;
    startedAt?: string | null;
    completedAt: string | null;
  } | null;
};

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
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
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
  let poller: SnapshotPoller;

  beforeEach(() => {
    runtime = new ChatRuntime(makeDb(), makeMessenger(), makePinecone(), makeLLMProvider(), makeLLMProvider());
    poller = (runtime as unknown as { enrichmentPoller: SnapshotPoller }).enrichmentPoller;
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

  it('degrades a fresh runtime when the latest durable enrichment receipt failed', () => {
    poller.lastRunAt = new Date().toISOString();
    poller.cycleHealthState = 'failed';
    poller.latestCycleReceipt = {
      status: 'failed',
      failureCode: 'selection_failed',
      stage: 'selection',
      retryable: true,
      evidenceCoverage: 'typed',
      completedAt: '2026-07-30T00:00:01.000Z',
    };

    const snapshot = runtime.getHealthSnapshot();

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.details['enrichmentCycle']).toEqual({
      state: 'failed',
      lastAttemptAt: '2026-07-30T00:00:01.000Z',
      lastSuccessAt: poller.lastRunAt,
      status: 'failed',
      failureCode: 'selection_failed',
      stage: 'selection',
      retryable: true,
      evidenceCoverage: 'typed',
    });
  });

  it('projects a stale cycle state when the last proven success is stale', () => {
    const staleAt = new Date(Date.now() - 3_600_001).toISOString();
    poller.lastRunAt = staleAt;
    poller.cycleHealthState = 'current';
    poller.latestCycleReceipt = {
      status: 'completed',
      failureCode: 'none',
      stage: 'none',
      retryable: false,
      evidenceCoverage: 'typed',
      completedAt: staleAt,
    };

    const snapshot = runtime.getHealthSnapshot();

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.details['enrichmentCycle']).toMatchObject({
      state: 'stale',
      lastSuccessAt: staleAt,
      status: 'completed',
    });
  });

  it('distinguishes disabled enrichment from a not-started enabled poller', () => {
    const enabledSnapshot = runtime.getHealthSnapshot();
    const disabledRuntime = new ChatRuntime(
      makeDb(), makeMessenger(), makePinecone(), makeLLMProvider(), makeLLMProvider(),
      { enableEnrichment: false },
    );
    const disabledSnapshot = disabledRuntime.getHealthSnapshot();

    expect(enabledSnapshot.details['enrichmentCycle']).toMatchObject({ state: 'not_started' });
    expect(disabledSnapshot.details['enrichmentCycle']).toMatchObject({ state: 'disabled' });
  });
});
