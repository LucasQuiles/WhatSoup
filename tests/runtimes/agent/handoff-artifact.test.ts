import { describe, it, expect, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { Database } from '../../../src/core/database.ts';
import {
  ensureHandoffArtifactSchema,
  upsertHandoffArtifact,
  getHandoffArtifact,
  deleteHandoffArtifact,
  clearChatAndDeleteHandoffArtifact,
  deleteMessagesAndHandoffArtifacts,
  deleteExpiredHandoffArtifacts,
  HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE,
  HANDOFF_ARTIFACT_RETENTION_MS,
  type HandoffArtifact,
} from '../../../src/runtimes/agent/handoff-artifact.ts';
import { HandoffDistillRunner } from '../../../src/runtimes/agent/handoff-distill-runner.ts';
import type { DistillBudgetConfig } from '../../../src/runtimes/agent/handoff-distill-gate.ts';

const dbPath = join(tmpdir(), `whatsoup-handoff-test-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();
ensureHandoffArtifactSchema(db);

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

function artifact(over: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    conversationKey: 'conv-1',
    summary: 'debugging fallback handoff',
    seededArtifacts: 'open PRs: #1',
    updatedAt: 1_781_000_000_000,
    sourceProvider: 'claude-cli',
    sourceModel: 'claude-opus-4-8',
    tokenBaseline: 1234,
    ...over,
  };
}

function deferredDistillRunner() {
  let resolve!: (outcome: { summary: string; seededArtifacts: null; tokensUsed: number }) => void;
  const pending = new Promise<{ summary: string; seededArtifacts: null; tokensUsed: number }>((release) => {
    resolve = release;
  });
  const persist = vi.fn();
  const onSucceeded = vi.fn();
  const config: DistillBudgetConfig = {
    maxTokensPerWindow: 100_000,
    maxCallsPerWindow: 10,
    windowMs: 3_600_000,
    failureThreshold: 3,
    breakerCooldownMs: 60_000,
    globalConcurrency: 1,
  };
  const runner = new HandoffDistillRunner({
    config,
    now: () => 1_000,
    growthThreshold: 1,
    tokenGrowth: () => 2,
    distillFor: () => pending,
    persist,
    onDegraded: vi.fn(),
    onSucceeded,
    sourceFor: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  return { runner, persist, onSucceeded, resolve };
}

describe('handoff-artifact store', () => {
  it('round-trips an artifact through upsert/get', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'rt' }));
    expect(getHandoffArtifact(db, 'rt')).toEqual(artifact({ conversationKey: 'rt' }));
  });

  it('upsert replaces an existing row by conversation_key', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'ov', summary: 'first', updatedAt: 1 }));
    upsertHandoffArtifact(db, artifact({ conversationKey: 'ov', summary: 'second', updatedAt: 2 }));
    const got = getHandoffArtifact(db, 'ov');
    expect(got?.summary).toBe('second');
    expect(got?.updatedAt).toBe(2);
  });

  it('preserves null summary / seeded / model', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'nulls', summary: null, seededArtifacts: null, sourceModel: null }));
    const got = getHandoffArtifact(db, 'nulls');
    expect(got).toMatchObject({ summary: null, seededArtifacts: null, sourceModel: null });
  });

  it('returns null for a missing conversation', () => {
    expect(getHandoffArtifact(db, 'does-not-exist')).toBeNull();
  });

  it('deletes an artifact (idempotently)', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'del' }));
    expect(getHandoffArtifact(db, 'del')).not.toBeNull();
    deleteHandoffArtifact(db, 'del');
    expect(getHandoffArtifact(db, 'del')).toBeNull();
    // Deleting again is a no-op, not an error.
    expect(() => deleteHandoffArtifact(db, 'del')).not.toThrow();
    expect(getHandoffArtifact(db, 'del')).toBeNull();
  });

  it('ensureHandoffArtifactSchema is idempotent', () => {
    expect(() => {
      ensureHandoffArtifactSchema(db);
      ensureHandoffArtifactSchema(db);
    }).not.toThrow();
    // Table still usable after re-ensuring.
    upsertHandoffArtifact(db, artifact({ conversationKey: 'after-reensure' }));
    expect(getHandoffArtifact(db, 'after-reensure')?.tokenBaseline).toBe(1234);
  });

  it('drains every artifact older than the 24-hour cutoff through deterministic bounded batches', () => {
    const retentionDb = new Database(':memory:');
    retentionDb.open();
    ensureHandoffArtifactSchema(retentionDb);
    const cutoff = 2_000_000_000_000;
    try {
      for (let index = 0; index <= HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE; index += 1) {
        upsertHandoffArtifact(retentionDb, artifact({
          conversationKey: `retention-batch-${String(index).padStart(3, '0')}`,
          updatedAt: cutoff - 1,
        }));
      }
      upsertHandoffArtifact(retentionDb, artifact({ conversationKey: 'retention-exact-cutoff', updatedAt: cutoff }));
      upsertHandoffArtifact(retentionDb, artifact({ conversationKey: 'retention-recent', updatedAt: cutoff + 1 }));

      expect(HANDOFF_ARTIFACT_RETENTION_MS).toBe(24 * 60 * 60 * 1_000);
      expect(deleteExpiredHandoffArtifacts(retentionDb, cutoff)).toBe(HANDOFF_ARTIFACT_RETENTION_BATCH_SIZE + 1);
      expect(getHandoffArtifact(retentionDb, 'retention-batch-000')).toBeNull();
      expect(getHandoffArtifact(retentionDb, 'retention-batch-099')).toBeNull();
      expect(getHandoffArtifact(retentionDb, 'retention-batch-100')).toBeNull();
      expect(getHandoffArtifact(retentionDb, 'retention-exact-cutoff')).not.toBeNull();
      expect(getHandoffArtifact(retentionDb, 'retention-recent')).not.toBeNull();
    } finally {
      retentionDb.close();
    }
  });

  it('deletes the cleared conversation artifact without touching another conversation', () => {
    const lifecycleDb = new Database(':memory:');
    lifecycleDb.open();
    ensureHandoffArtifactSchema(lifecycleDb);
    try {
      upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey: 'clear-target' }));
      upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey: 'clear-other' }));
      lifecycleDb.raw.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
        VALUES ('clear-target@s.whatsapp.net', 'clear-target', 'sender@s.whatsapp.net', 'clear-message', 'secret', 1)
      `).run();

      const invalidated: string[][] = [];
      expect(clearChatAndDeleteHandoffArtifact(lifecycleDb, 'clear-target', (conversationKeys) => {
        invalidated.push([...conversationKeys]);
        expect(getHandoffArtifact(lifecycleDb, 'clear-target')).not.toBeNull();
      })).toEqual({
        messages: 1,
        handoffArtifacts: 1,
      });
      expect(invalidated).toEqual([['clear-target']]);
      expect(getHandoffArtifact(lifecycleDb, 'clear-target')).toBeNull();
      expect(getHandoffArtifact(lifecycleDb, 'clear-other')).not.toBeNull();
      expect(lifecycleDb.raw.prepare(
        `SELECT deleted_at FROM messages WHERE message_id = 'clear-message'`,
      ).get()).toMatchObject({ deleted_at: expect.any(String) });
    } finally {
      lifecycleDb.close();
    }
  });

  it('fences a deferred distill before clear can remove its conversation artifact', async () => {
    const lifecycleDb = new Database(':memory:');
    lifecycleDb.open();
    ensureHandoffArtifactSchema(lifecycleDb);
    try {
      const { runner, persist, onSucceeded, resolve } = deferredDistillRunner();
      upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey: 'clear-in-flight' }));

      const tick = runner.tickConversation('clear-in-flight');
      clearChatAndDeleteHandoffArtifact(lifecycleDb, 'clear-in-flight', (conversationKeys) => {
        conversationKeys.forEach((conversationKey) => runner.invalidateConversation(conversationKey));
      });
      resolve({ summary: 'stale after clear', seededArtifacts: null, tokensUsed: 1 });
      await tick;

      expect(getHandoffArtifact(lifecycleDb, 'clear-in-flight')).toBeNull();
      expect(persist).not.toHaveBeenCalled();
      expect(onSucceeded).not.toHaveBeenCalled();
    } finally {
      lifecycleDb.close();
    }
  });

  it('deletes every affected conversation artifact before revoking multiple messages', () => {
    const lifecycleDb = new Database(':memory:');
    lifecycleDb.open();
    ensureHandoffArtifactSchema(lifecycleDb);
    try {
      for (const conversationKey of ['revoke-a', 'revoke-b', 'revoke-other']) {
        upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey }));
      }
      const insertMessage = lifecycleDb.raw.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
        VALUES (?, ?, 'sender@s.whatsapp.net', ?, 'secret', 1)
      `);
      insertMessage.run('revoke-a@s.whatsapp.net', 'revoke-a', 'revoke-message-a');
      insertMessage.run('revoke-b@s.whatsapp.net', 'revoke-b', 'revoke-message-b');

      const invalidated: string[][] = [];
      expect(deleteMessagesAndHandoffArtifacts(
        lifecycleDb,
        ['revoke-message-a', '', 'unknown-message', 'revoke-message-b'],
        (conversationKeys) => {
          invalidated.push([...conversationKeys]);
          for (const conversationKey of conversationKeys) {
            expect(getHandoffArtifact(lifecycleDb, conversationKey)).not.toBeNull();
          }
        },
      )).toEqual({ messages: 2, handoffArtifacts: 2, conversations: 2 });
      expect(invalidated).toEqual([['revoke-a', 'revoke-b']]);
      expect(getHandoffArtifact(lifecycleDb, 'revoke-a')).toBeNull();
      expect(getHandoffArtifact(lifecycleDb, 'revoke-b')).toBeNull();
      expect(getHandoffArtifact(lifecycleDb, 'revoke-other')).not.toBeNull();
      const unknownInvalidator = vi.fn();
      expect(deleteMessagesAndHandoffArtifacts(lifecycleDb, ['', 'unknown-message'], unknownInvalidator))
        .toEqual({ messages: 0, handoffArtifacts: 0, conversations: 0 });
      expect(unknownInvalidator).not.toHaveBeenCalled();
    } finally {
      lifecycleDb.close();
    }
  });

  it('fences a deferred distill before revoke can remove its conversation artifact', async () => {
    const lifecycleDb = new Database(':memory:');
    lifecycleDb.open();
    ensureHandoffArtifactSchema(lifecycleDb);
    try {
      const { runner, persist, onSucceeded, resolve } = deferredDistillRunner();
      upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey: 'revoke-in-flight' }));
      lifecycleDb.raw.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
        VALUES ('revoke-in-flight@s.whatsapp.net', 'revoke-in-flight', 'sender@s.whatsapp.net', 'revoke-in-flight-message', 'secret', 1)
      `).run();

      const tick = runner.tickConversation('revoke-in-flight');
      deleteMessagesAndHandoffArtifacts(lifecycleDb, ['revoke-in-flight-message'], (conversationKeys) => {
        conversationKeys.forEach((conversationKey) => runner.invalidateConversation(conversationKey));
      });
      resolve({ summary: 'stale after revoke', seededArtifacts: null, tokensUsed: 1 });
      await tick;

      expect(getHandoffArtifact(lifecycleDb, 'revoke-in-flight')).toBeNull();
      expect(persist).not.toHaveBeenCalled();
      expect(onSucceeded).not.toHaveBeenCalled();
    } finally {
      lifecycleDb.close();
    }
  });

  it('keeps artifact invalidation when the subsequent local message revoke fails', () => {
    const lifecycleDb = new Database(':memory:');
    lifecycleDb.open();
    ensureHandoffArtifactSchema(lifecycleDb);
    try {
      upsertHandoffArtifact(lifecycleDb, artifact({ conversationKey: 'revoke-failure' }));
      lifecycleDb.raw.prepare(`
        INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
        VALUES ('revoke-failure@s.whatsapp.net', 'revoke-failure', 'sender@s.whatsapp.net', 'revoke-failure-message', 'secret', 1)
      `).run();
      lifecycleDb.raw.exec(`
        CREATE TRIGGER fail_handoff_revoke_after_invalidation
        BEFORE UPDATE ON messages
        BEGIN
          SELECT RAISE(ABORT, 'injected local message revoke failure');
        END;
      `);

      expect(() => deleteMessagesAndHandoffArtifacts(lifecycleDb, ['revoke-failure-message']))
        .toThrow('injected local message revoke failure');
      expect(getHandoffArtifact(lifecycleDb, 'revoke-failure')).toBeNull();
      expect(lifecycleDb.raw.prepare(
        `SELECT deleted_at FROM messages WHERE message_id = 'revoke-failure-message'`,
      ).get()).toEqual({ deleted_at: null });
    } finally {
      lifecycleDb.close();
    }
  });
});

describe('residual-branch coverage', () => {
  // handoff-artifact.ts line 45 — `tokenBaseline: Number(row['token_baseline'] ?? 0)`
  // The NOT NULL DEFAULT 0 column in the schema means a real SQLite row never
  // surfaces `null`, so we feed `rowToArtifact` directly via a mock prepare/get
  // chain to exercise the `?? 0` fallback path.
  it('falls back to 0 when stored token_baseline is null', () => {
    const getFn = vi.fn().mockReturnValue({
      conversation_key: 'null-baseline',
      summary: null,
      seeded_artifacts: null,
      updated_at: 1_781_000_000_000,
      source_provider: 'claude-cli',
      source_model: null,
      token_baseline: null,
    });
    const prepareFn = vi.fn().mockReturnValue({ get: getFn });
    const mockDb = { raw: { prepare: prepareFn } } as unknown as Database;

    const result = getHandoffArtifact(mockDb, 'null-baseline');

    expect(prepareFn).toHaveBeenCalledWith(
      'SELECT * FROM agent_handoff_artifacts WHERE conversation_key = ?',
    );
    expect(getFn).toHaveBeenCalledWith('null-baseline');
    expect(result?.tokenBaseline).toBe(0);
  });
});
