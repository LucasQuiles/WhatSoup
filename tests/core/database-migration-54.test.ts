import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { runMigration54 } from '../../src/core/database-migration-54.ts';

function createLegacyResumeTables(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE session_checkpoints (
      id INTEGER PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      session_id TEXT,
      session_status TEXT NOT NULL,
      completed_inbound_seq INTEGER,
      completed_delivery_jid TEXT,
      completed_delivery_namespace TEXT,
      completed_scope TEXT,
      completed_logical_turn_id TEXT,
      completed_manager_id TEXT,
      completed_generation INTEGER,
      checkpoint_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE agent_sessions (
      id INTEGER PRIMARY KEY,
      workspace_key TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
}

function insertCheckpoint(
  raw: DatabaseSync,
  id: number,
  status: string,
  fields: Partial<Record<
    | 'session_id'
    | 'completed_inbound_seq'
    | 'completed_delivery_jid'
    | 'completed_delivery_namespace'
    | 'completed_scope'
    | 'completed_logical_turn_id'
    | 'completed_manager_id'
    | 'completed_generation',
    string | number | null
  >>,
): void {
  raw.prepare(`
    INSERT INTO session_checkpoints (
      id, conversation_key, session_id, session_status,
      completed_inbound_seq, completed_delivery_jid,
      completed_delivery_namespace, completed_scope,
      completed_logical_turn_id, completed_manager_id, completed_generation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `conversation-${id}`,
    fields.session_id ?? null,
    status,
    fields.completed_inbound_seq ?? null,
    fields.completed_delivery_jid ?? null,
    fields.completed_delivery_namespace ?? null,
    fields.completed_scope ?? null,
    fields.completed_logical_turn_id ?? null,
    fields.completed_manager_id ?? null,
    fields.completed_generation ?? null,
  );
}

describe('migration 54 completed-delivery identity admissions', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createLegacyResumeTables(raw);
  });

  afterEach(() => raw.close());

  it('quarantines only incomplete resumable checkpoints and remains idempotent', () => {
    insertCheckpoint(raw, 1, 'active', { session_id: 'legacy-active' });
    insertCheckpoint(raw, 2, 'suspended', {
      session_id: 'legacy-suspended',
      completed_inbound_seq: 2,
      completed_delivery_jid: 'conversation-2@s.whatsapp.net',
    });
    insertCheckpoint(raw, 3, 'active', {
      session_id: 'complete-active',
      completed_inbound_seq: 3,
      completed_delivery_jid: 'conversation-3@s.whatsapp.net',
      completed_delivery_namespace: 's.whatsapp.net',
      completed_scope: 'per_chat',
      completed_logical_turn_id: 'turn-3',
      completed_manager_id: 'manager-3',
      completed_generation: 1,
    });
    insertCheckpoint(raw, 4, 'ended', { session_id: 'ended-legacy' });
    insertCheckpoint(raw, 5, 'orphaned', { session_id: 'orphaned-legacy' });

    runMigration54(raw);
    runMigration54(raw);

    expect(raw.prepare(`
      SELECT target_kind, target_id, state, reason, attempts, owner, next_action,
             resolved_at
      FROM completed_delivery_identity_admissions
      ORDER BY target_id
    `).all()).toEqual([
      {
        target_kind: 'checkpoint',
        target_id: 1,
        state: 'quarantined',
        reason: 'missing',
        attempts: 1,
        owner: 'fresh_inbound',
        next_action: 'fresh_inbound',
        resolved_at: null,
      },
      {
        target_kind: 'checkpoint',
        target_id: 2,
        state: 'quarantined',
        reason: 'missing',
        attempts: 1,
        owner: 'fresh_inbound',
        next_action: 'fresh_inbound',
        resolved_at: null,
      },
      {
        target_kind: 'checkpoint',
        target_id: 5,
        state: 'quarantined',
        reason: 'missing',
        attempts: 1,
        owner: 'fresh_inbound',
        next_action: 'fresh_inbound',
        resolved_at: null,
      },
    ]);
    expect(raw.prepare(`
      SELECT id, session_status FROM session_checkpoints ORDER BY id
    `).all()).toEqual([
      { id: 1, session_status: 'orphaned' },
      { id: 2, session_status: 'orphaned' },
      { id: 3, session_status: 'active' },
      { id: 4, session_status: 'ended' },
      { id: 5, session_status: 'orphaned' },
    ]);
  });

  it('creates a bounded content-free ledger on a fresh database', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(56);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 53',
      ).get()).toEqual({ version: 53 });
      const names = (db.raw.prepare(
        "PRAGMA table_info('completed_delivery_identity_admissions')",
      ).all() as Array<{ name: string }>).map(({ name }) => name);
      expect(names).toEqual([
        'id',
        'target_kind',
        'target_id',
        'state',
        'reason',
        'attempts',
        'owner',
        'next_action',
        'created_at',
        'last_transition_at',
        'resolved_at',
      ]);
      for (const forbidden of ['conversation_key', 'session_id', 'delivery_jid', 'error']) {
        expect(names).not.toContain(forbidden);
      }
      expect(() => db.raw.prepare(`
        INSERT INTO completed_delivery_identity_admissions (
          target_kind, target_id, state, reason, attempts, owner, next_action
        ) VALUES ('checkpoint', 0, 'quarantined', 'missing', 2, 'automatic', 'retry')
      `).run()).toThrow();
    } finally {
      db.close();
    }
  });

  it('creates the ledger but skips checkpoint backfill when a historical fixture has no checkpoint table', () => {
    const partial = new DatabaseSync(':memory:');
    try {
      expect(() => runMigration54(partial)).not.toThrow();
      expect(partial.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'completed_delivery_identity_admissions'",
      ).get()).toEqual({ name: 'completed_delivery_identity_admissions' });
      expect(partial.prepare(
        'SELECT COUNT(*) AS count FROM completed_delivery_identity_admissions',
      ).get()).toEqual({ count: 0 });
    } finally {
      partial.close();
    }
  });
});
