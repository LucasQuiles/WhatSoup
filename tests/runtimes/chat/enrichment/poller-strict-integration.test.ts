import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../../src/runtimes/chat/providers/pinecone.ts';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../../src/config.ts', () => ({
  config: {
    models: {
      extraction: 'test-extraction',
      validation: 'test-validation',
    },
    enrichmentIntervalMs: 60_000,
    enrichmentBatchSize: 200,
    enrichmentMinConfidence: 0.7,
    enrichmentMaxRetries: 3,
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockLogger,
}));

import { Database } from '../../../../src/core/database.ts';
import { getUnprocessedMessages, storeMessageIfNew } from '../../../../src/core/messages.ts';
import { EnrichmentPoller } from '../../../../src/runtimes/chat/enrichment/poller.ts';

describe('EnrichmentPoller strict provider integration', () => {
  let db: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('records a bounded failed receipt and leaves a message retryable when extraction throws', async () => {
    storeMessageIfNew(db, {
      chatJid: 'private-chat@g.us',
      conversationKey: 'private-chat_at_g.us',
      senderJid: 'private-sender@s.whatsapp.net',
      senderName: 'Private Sender',
      messageId: 'private-message-id',
      content: 'PRIVATE-ENRICHMENT-CONTENT',
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_785_401_000,
    });
    const provider: LLMProvider = {
      name: 'rejecting',
      generate: vi.fn().mockRejectedValue(new Error('PRIVATE-ENRICHMENT-ERROR')),
    };
    const poller = new EnrichmentPoller(
      db,
      {} as PineconeMemory,
      provider,
      provider,
    );

    await (poller as unknown as { runCycle(): Promise<void> }).runCycle();

    expect(getUnprocessedMessages(db, 10)).toHaveLength(1);
    expect(db.raw.prepare(`
      SELECT
        status,
        failure_code,
        stage,
        retryable,
        success_at,
        messages_selected,
        messages_succeeded,
        messages_deferred,
        messages_terminal,
        error
      FROM enrichment_runs
      WHERE source = 'online'
    `).get()).toEqual({
      status: 'failed',
      failure_code: 'segment_failed',
      stage: 'segment',
      retryable: 1,
      success_at: null,
      messages_selected: 1,
      messages_succeeded: 0,
      messages_deferred: 1,
      messages_terminal: 0,
      error: null,
    });
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('PRIVATE-ENRICHMENT');
  });
});
