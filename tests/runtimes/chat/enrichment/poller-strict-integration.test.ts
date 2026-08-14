import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../../../../src/runtimes/chat/providers/types.ts';
import type { PineconeMemory } from '../../../../src/runtimes/chat/providers/pinecone.ts';

const { mockLogger } = vi.hoisted(() => ({ mockLogger: {} as Record<string, ReturnType<typeof vi.fn>> }));

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

vi.mock('../../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockLogger);
  return { createChildLogger };
});

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

// #2567 slice 2 — crash-hygiene wiring: every enrichment cycle reconciles
// expired fact-export leases back to the retry lane, independent of which
// consumer model (in-process drainer vs external bridge) eventually owns
// the drain. A crashed consumer's rows must not stay 'leased' forever.
describe('expired-lease reconciliation wiring', () => {
  let db: Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('runCycle returns expired leases to retry_wait with the lease_expired code', async () => {
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, lease_owner, lease_expires_at, attempt_count)
       VALUES ('fe_expiredlease0000000001', 'expired-1', 'seed-chat@g.us', '{}', 'leased', 'dead-worker', 1, 1)`,
    ).run();
    const provider: LLMProvider = {
      name: 'noop',
      generate: vi.fn().mockResolvedValue('[]'),
    };
    const poller = new EnrichmentPoller(db, {} as PineconeMemory, provider, provider);

    await (poller as unknown as { runCycle(): Promise<void> }).runCycle();

    const row = db.raw.prepare(
      `SELECT state, failure_code, lease_owner FROM fact_export_queue WHERE fact_id = 'expired-1'`,
    ).get() as { state: string; failure_code: string | null; lease_owner: string | null };
    expect(row).toEqual({ state: 'retry_wait', failure_code: 'lease_expired', lease_owner: null });
  });
});
