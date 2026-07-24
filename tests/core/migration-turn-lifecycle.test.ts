/**
 * Turn-lifecycle migration tests — migrations 37–40 (turn terminal records,
 * turn recovery jobs, completed checkpoint identity, delivery proof).
 *
 * Split out of migration-safety.test.ts per the 2026-07-11 turn-lifecycle fitness
 * design: suites moved verbatim; only the import/helper boundary is new. The
 * migration-numbering split-brain guard and all legacy migration suites stay in
 * migration-safety.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';

// ─── Helpers (tiny local copies; shared with migration-safety.test.ts by design:
// a two-function module for 19 lines is premature, and the large legacy fixtures
// deliberately stay behind) ──────────────────────────────────────────────────

function tmpFile(): string {
  return join(tmpdir(), `whatsoup-mig-${randomBytes(8).toString('hex')}.db`);
}

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    for (const suffix of ['', '-wal', '-shm']) {
      const full = p + suffix;
      if (existsSync(full)) {
        try {
          unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

describe('turn terminal migration 37', () => {
  it('creates the primitive terminal-record schema on a fresh database', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const version = db.raw
        .prepare('SELECT version FROM schema_migrations WHERE version = 37')
        .get() as { version: number } | undefined;
      const columns = (
        db.raw.prepare("PRAGMA table_info('turn_terminal_records')").all() as Array<{ name: string }>
      ).map((column) => column.name);
      const table = db.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turn_terminal_records'")
        .get() as { sql: string };
      const terminalIndexes = (
        db.raw.prepare("PRAGMA index_list('turn_terminal_records')").all() as Array<{ name: string }>
      ).map((index) => index.name);

      expect(CURRENT_SCHEMA_MIGRATION).toBe(46);
      expect(version?.version).toBe(37);
      expect(columns).toEqual(expect.arrayContaining([
        'inbound_seq',
        'inbound_seq_key',
        'logical_turn_id',
        'generation',
        'attempt_kind',
        'attempt_failure_class',
        'inbound_disposition',
        'delivery_kind',
        'delivery_op_id',
        'recovery_owner_logical_turn_id',
        'recovery_owner_manager_id',
        'recovery_owner_generation',
        'reply_guarantee_disarmed',
        'duplicate_finalize_count',
      ]));
      expect(table.sql).toContain('turn_terminal_owner_coherence');
      expect(table.sql).toContain('turn_terminal_disarm_evidence');
      expect(table.sql).toContain('turn_terminal_unknown_stays_armed');
      expect(terminalIndexes).toContain('idx_turn_terminal_delivery_op');
    } finally {
      db.close();
    }
  });

  it('upgrades a populated version-36 database additively', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.raw.prepare(
          "INSERT INTO inbound_events (message_id, conversation_key, chat_jid) VALUES ('before-v37', 'key-before', 'jid-before')",
        ).run();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TABLE IF EXISTS turn_terminal_records');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 37').run();
        raw.close();
      }

      const upgraded = new Database(dbPath);
      upgraded.open();
      try {
        const existing = upgraded.raw
          .prepare("SELECT conversation_key FROM inbound_events WHERE message_id = 'before-v37'")
          .get() as { conversation_key: string } | undefined;
        const terminalTable = upgraded.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_terminal_records'")
          .get() as { name: string } | undefined;

        expect(existing?.conversation_key).toBe('key-before');
        expect(terminalTable?.name).toBe('turn_terminal_records');
      } finally {
        upgraded.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('is idempotent when migration 37 replays against the constrained table', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.prepare('DELETE FROM schema_migrations WHERE version = 37').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).not.toThrow();
      try {
        const versions = reopened.raw
          .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 37')
          .get() as { count: number };
        const tables = reopened.raw
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'turn_terminal_records'")
          .get() as { count: number };

        expect(versions.count).toBe(1);
        expect(tables.count).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });
});

describe('turn recovery migration 38', () => {
  it('creates a bounded replay-safe recovery schema on a fresh database', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const version = db.raw
        .prepare('SELECT version FROM schema_migrations WHERE version = 38')
        .get() as { version: number } | undefined;
      const columns = (
        db.raw.prepare("PRAGMA table_info('turn_recovery_jobs')").all() as Array<{ name: string }>
      ).map((column) => column.name);
      const table = db.raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'turn_recovery_jobs'")
        .get() as { sql: string };

      expect(version?.version).toBe(38);
      expect(columns).toEqual(expect.arrayContaining([
        'terminal_record_id',
        'source_inbound_seq_key',
        'source_logical_turn_id',
        'source_manager_id',
        'source_generation',
        'source_message_id',
        'owner_logical_turn_id',
        'owner_manager_id',
        'owner_generation',
        'assigned_owner_logical_turn_id',
        'assigned_owner_manager_id',
        'assigned_owner_generation',
        'replay_safe',
        'replay_safety_proof_id',
        'sender_jid',
        'sender_name',
        'replay_text',
        'is_group',
        'group_name',
        'state',
        'attempt_count',
        'claim_epoch',
        'assignment_epoch',
        'claim_token',
        'claim_expires_at',
        'last_requeue_claim_token_hash',
        'last_requeue_claim_epoch',
        'last_requeue_backoff_seconds',
        'next_attempt_at',
        'claimed_at',
        'completed_at',
      ]));
      expect(table.sql).toContain('turn_recovery_replay_safe');
      expect(table.sql).toContain('turn_recovery_payload_bounds');
      expect(table.sql).toContain('turn_recovery_state_coherence');
      expect(table.sql).toContain('turn_recovery_owner_separation');
      expect(table.sql).toContain('turn_recovery_last_requeue_coherence');
      expect(table.sql).toContain("'blocked_unsafe'");
      expect(table.sql).toContain("'exhausted'");
      expect(table.sql).toContain('REFERENCES turn_terminal_records');
    } finally {
      db.close();
    }
  });

  it('upgrades a populated version-37 database additively', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.raw.prepare(
          "INSERT INTO inbound_events (message_id, conversation_key, chat_jid) VALUES ('before-v38', 'key-before', 'jid-before')",
        ).run();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TABLE IF EXISTS turn_recovery_jobs');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 38').run();
        raw.close();
      }

      const upgraded = new Database(dbPath);
      upgraded.open();
      try {
        const existing = upgraded.raw
          .prepare("SELECT conversation_key FROM inbound_events WHERE message_id = 'before-v38'")
          .get() as { conversation_key: string } | undefined;
        const recoveryTable = upgraded.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_recovery_jobs'")
          .get() as { name: string } | undefined;

        expect(existing?.conversation_key).toBe('key-before');
        expect(recoveryTable?.name).toBe('turn_recovery_jobs');
      } finally {
        upgraded.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('is idempotent when migration 38 replays against the constrained table', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.prepare('DELETE FROM schema_migrations WHERE version = 38').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).not.toThrow();
      try {
        expect(reopened.raw.prepare(
          'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 38',
        ).get()).toEqual({ count: 1 });
        expect(reopened.raw.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'turn_recovery_jobs'",
        ).get()).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });
});

describe('completed checkpoint identity migration 39', () => {
  const columns = [
    'completed_inbound_seq',
    'completed_delivery_jid',
    'completed_delivery_namespace',
    'completed_scope',
    'completed_logical_turn_id',
    'completed_manager_id',
    'completed_generation',
  ];

  it('adds the nullable completion bundle without backfilling legacy checkpoints', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.raw.prepare(
          `INSERT INTO session_checkpoints
             (conversation_key, session_id, last_inbound_seq)
           VALUES ('legacy-conversation', 'legacy-session', 17)`,
        ).run();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_insert');
        raw.exec('DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_update');
        for (const column of columns) {
          raw.exec(`ALTER TABLE session_checkpoints DROP COLUMN ${column}`);
        }
        raw.prepare('DELETE FROM schema_migrations WHERE version = 39').run();
        raw.close();
      }

      const upgraded = new Database(dbPath);
      upgraded.open();
      try {
        const version = upgraded.raw
          .prepare('SELECT version FROM schema_migrations WHERE version = 39')
          .get() as { version: number } | undefined;
        const names = (upgraded.raw
          .prepare("PRAGMA table_info('session_checkpoints')")
          .all() as Array<{ name: string }>).map((column) => column.name);
        const legacy = upgraded.raw.prepare(
          `SELECT ${columns.join(', ')}
           FROM session_checkpoints WHERE conversation_key = 'legacy-conversation'`,
        ).get() as Record<string, unknown>;

        expect(version?.version).toBe(39);
        expect(names).toEqual(expect.arrayContaining(columns));
        expect(Object.values(legacy)).toEqual(columns.map(() => null));
      } finally {
        upgraded.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('is idempotent when migration 39 replays against an upgraded table', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.prepare('DELETE FROM schema_migrations WHERE version = 39').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).not.toThrow();
      try {
        expect(reopened.raw.prepare(
          'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 39',
        ).get()).toEqual({ count: 1 });
        const names = (reopened.raw
          .prepare("PRAGMA table_info('session_checkpoints')")
          .all() as Array<{ name: string }>).map((column) => column.name);
        for (const column of columns) {
          expect(names.filter((name) => name === column)).toHaveLength(1);
        }
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('rejects partial completed identity bundles at the durable boundary', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(() => db.raw.prepare(
        `INSERT INTO session_checkpoints
           (conversation_key, completed_delivery_jid)
         VALUES ('partial-insert', '15550199@s.whatsapp.net')`,
      ).run()).toThrow(/completed identity bundle/i);

      db.raw.prepare(
        `INSERT INTO session_checkpoints (conversation_key, session_id)
         VALUES ('partial-update', 'session')`,
      ).run();
      expect(() => db.raw.prepare(
        `UPDATE session_checkpoints
         SET completed_delivery_namespace = 's.whatsapp.net'
         WHERE conversation_key = 'partial-update'`,
      ).run()).toThrow(/completed identity bundle/i);
    } finally {
      db.close();
    }
  });
});

describe('turn recovery delivery proof migration 40', () => {
  const insertTransferWithoutDelivery = (db: DatabaseSync): void => {
    db.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid,
        inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation,
        attempt_kind, attempt_failure_class,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed
      ) VALUES (
        'per_chat', 'scope-40', '15550100001@s.whatsapp.net',
        40, 40,
        'turn-40', 'manager-40', 1,
        'failed', 'unknown_terminal',
        'transferred_to_recovery_owner', 'none', NULL,
        'recovery-turn-40', 'recovery-manager-40', 2, 0
      )
    `).run();
  };

  const insertTransferWithPendingDelivery = (
    db: DatabaseSync,
  ): { inboundSeq: number; opId: number } => {
    const inboundSeq = Number(db.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status)
      VALUES ('migration-40-progressed', 'scope-40-progressed',
              '15550100002@s.whatsapp.net', 'processing')
    `).run().lastInsertRowid);
    const opId = Number(db.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, replay_policy
      ) VALUES (
        'scope-40-progressed', '15550100002@s.whatsapp.net',
        'text', '{"text":"proof"}', 'pending', ?, 'unsafe'
      )
    `).run(inboundSeq).lastInsertRowid);
    const terminalRecordId = Number(db.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid,
        inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation,
        attempt_kind, attempt_failure_class,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed
      ) VALUES (
        'per_chat', 'scope-40-progressed', '15550100002@s.whatsapp.net',
        ?, ?, 'turn-40-progressed', 'manager-40-progressed', 1,
        'failed', 'unknown_terminal',
        'transferred_to_recovery_owner', 'enqueued', ?,
        'recovery-turn-40-progressed', 'recovery-manager-40-progressed', 2, 0
      )
    `).run(inboundSeq, inboundSeq, opId).lastInsertRowid);
    db.prepare(`
      INSERT INTO turn_recovery_jobs (
        terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation, source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
        replay_safe, sender_jid, replay_text, is_group, state
      ) VALUES (
        ?, 'per_chat', 'scope-40-progressed', '15550100002@s.whatsapp.net',
        ?, ?, 'turn-40-progressed', 'manager-40-progressed', 1, 'migration-40-progressed',
        'recovery-turn-40-progressed', 'recovery-manager-40-progressed', 2,
        'recovery-turn-40-progressed', 'recovery-manager-40-progressed', 2,
        1, '15550100005@s.whatsapp.net', 'exact recovery proof', 0, 'pending'
      )
    `).run(terminalRecordId, inboundSeq, inboundSeq);
    return { inboundSeq, opId };
  };

  it('rejects a raw-SQL recovery transfer without selected delivery evidence', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 40',
      ).get()).toEqual({ version: 40 });
      expect(() => insertTransferWithoutDelivery(db.raw))
        .toThrow(/transfer.*delivery|delivery.*transfer/i);
    } finally {
      db.close();
    }
  });

  it('clears an unsafe legacy six-field completed checkpoint bundle on upgrade', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.raw.prepare(`
          INSERT INTO session_checkpoints (
            conversation_key, session_id, last_inbound_seq
          ) VALUES ('legacy-six-field', 'legacy-provider-session', 99)
        `).run();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_insert');
        raw.exec('DROP TRIGGER IF EXISTS session_checkpoints_completed_identity_bundle_update');
        raw.prepare(`
          UPDATE session_checkpoints
          SET completed_delivery_jid = '15550199@s.whatsapp.net',
              completed_delivery_namespace = 's.whatsapp.net',
              completed_scope = 'per_chat',
              completed_logical_turn_id = 'legacy-turn',
              completed_manager_id = 'legacy-manager',
              completed_generation = 1
          WHERE conversation_key = 'legacy-six-field'
        `).run();
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      reopened.open();
      try {
        expect(reopened.raw.prepare(`
          SELECT last_inbound_seq, completed_inbound_seq,
                 completed_delivery_jid, completed_delivery_namespace,
                 completed_scope, completed_logical_turn_id,
                 completed_manager_id, completed_generation
          FROM session_checkpoints
          WHERE conversation_key = 'legacy-six-field'
        `).get()).toEqual({
          last_inbound_seq: 99,
          completed_inbound_seq: null,
          completed_delivery_jid: null,
          completed_delivery_namespace: null,
          completed_scope: null,
          completed_logical_turn_id: null,
          completed_manager_id: null,
          completed_generation: null,
        });
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('rejects a raw-SQL recovery transfer whose source inbound identity is null', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const opId = Number(db.raw.prepare(`
        INSERT INTO outbound_ops (
          conversation_key, chat_jid, op_type, payload, status,
          source_inbound_seq, replay_policy
        ) VALUES ('scope-40-null', '15550100003@s.whatsapp.net',
                  'text', '{"text":"proof"}', 'pending', NULL, 'unsafe')
      `).run().lastInsertRowid);

      expect(() => db.raw.prepare(`
        INSERT INTO turn_terminal_records (
          scope, conversation_key, delivery_jid,
          inbound_seq, inbound_seq_key,
          logical_turn_id, manager_id, generation,
          attempt_kind, attempt_failure_class,
          inbound_disposition, delivery_kind, delivery_op_id,
          recovery_owner_logical_turn_id, recovery_owner_manager_id,
          recovery_owner_generation, reply_guarantee_disarmed
        ) VALUES (
          'per_chat', 'scope-40-null', '15550100003@s.whatsapp.net',
          NULL, -1, 'turn-40-null', 'manager-40-null', 1,
          'failed', 'unknown_terminal',
          'transferred_to_recovery_owner', 'enqueued', ?,
          'recovery-turn-40-null', 'recovery-manager-40-null', 2, 0
        )
      `).run(opId)).toThrow(/transfer.*delivery|delivery.*transfer/i);
    } finally {
      db.close();
    }
  });

  it('allows only one transfer terminal to own a selected outbound operation', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { inboundSeq, opId } = insertTransferWithPendingDelivery(db.raw);
      expect(() => db.raw.prepare(`
        INSERT INTO turn_terminal_records (
          scope, conversation_key, delivery_jid,
          inbound_seq, inbound_seq_key,
          logical_turn_id, manager_id, generation,
          attempt_kind, attempt_failure_class,
          inbound_disposition, delivery_kind, delivery_op_id,
          recovery_owner_logical_turn_id, recovery_owner_manager_id,
          recovery_owner_generation, reply_guarantee_disarmed
        ) VALUES (
          'per_chat', 'scope-40-progressed', '15550100002@s.whatsapp.net',
          ?, ?, 'turn-40-second-owner', 'manager-40-second-owner', 2,
          'failed', 'unknown_terminal',
          'transferred_to_recovery_owner', 'enqueued', ?,
          'recovery-turn-40-second-owner', 'recovery-manager-40-second-owner', 3, 0
        )
      `).run(inboundSeq, inboundSeq, opId)).toThrow(/unique|delivery.*owner/i);
    } finally {
      db.close();
    }
  });

  it('reinstalls the transfer proof trigger when migration 40 replays', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery');
        raw.exec(`
          CREATE TRIGGER turn_terminal_transfer_requires_delivery
          BEFORE INSERT ON turn_terminal_records
          WHEN 0
          BEGIN
            SELECT 1;
          END
        `);
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      reopened.open();
      try {
        expect(() => insertTransferWithoutDelivery(reopened.raw))
          .toThrow(/transfer.*delivery|delivery.*transfer/i);
      } finally {
        reopened.close();
      }
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed when an existing recovery job link is corrupt', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        insertTransferWithPendingDelivery(db.raw);
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_recovery_immutable_envelope');
        raw.prepare(`
          UPDATE turn_recovery_jobs
          SET source_message_id = 'wrong-source-message'
        `).run();
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed when a legacy completed recovery job lacks terminal proof', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        insertTransferWithPendingDelivery(db.raw);
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec(`
          DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source;
          DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery;
        `);
        raw.prepare(`
          UPDATE turn_recovery_jobs
          SET state = 'completed',
              attempt_count = 1,
              claim_epoch = 1,
              claim_token = 'legacy-completed-claim',
              claimed_at = datetime('now', '-40 days'),
              claim_expires_at = datetime('now', '-39 days'),
              completed_at = datetime('now', '-40 days'),
              completion_kind = 'worker',
              completion_proof_id = 'legacy-completed-proof'
        `).run();
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed when a pre-40 database already contains an invalid transfer', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery');
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        insertTransferWithoutDelivery(raw);
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed for a pre-40 transfer with null source identity', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery');
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        const opId = Number(raw.prepare(`
          INSERT INTO outbound_ops (
            conversation_key, chat_jid, op_type, payload, status,
            source_inbound_seq, replay_policy
          ) VALUES ('scope-40-null-upgrade', '15550100004@s.whatsapp.net',
                    'text', '{"text":"proof"}', 'pending', NULL, 'unsafe')
        `).run().lastInsertRowid);
        raw.prepare(`
          INSERT INTO turn_terminal_records (
            scope, conversation_key, delivery_jid,
            inbound_seq, inbound_seq_key,
            logical_turn_id, manager_id, generation,
            attempt_kind, attempt_failure_class,
            inbound_disposition, delivery_kind, delivery_op_id,
            recovery_owner_logical_turn_id, recovery_owner_manager_id,
            recovery_owner_generation, reply_guarantee_disarmed
          ) VALUES (
            'per_chat', 'scope-40-null-upgrade', '15550100004@s.whatsapp.net',
            NULL, -1, 'turn-40-null-upgrade', 'manager-40-null-upgrade', 1,
            'failed', 'unknown_terminal',
            'transferred_to_recovery_owner', 'enqueued', ?,
            'recovery-turn-40-null-upgrade', 'recovery-manager-40-null-upgrade', 2, 0
          )
        `).run(opId);
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed when two pre-40 terminals select one delivery', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery');
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update');
        raw.exec('DROP INDEX IF EXISTS idx_turn_terminal_delivery_op');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        const { inboundSeq, opId } = insertTransferWithPendingDelivery(raw);
        raw.prepare(`
          INSERT INTO turn_terminal_records (
            scope, conversation_key, delivery_jid,
            inbound_seq, inbound_seq_key,
            logical_turn_id, manager_id, generation,
            attempt_kind, attempt_failure_class,
            inbound_disposition, delivery_kind, delivery_op_id,
            recovery_owner_logical_turn_id, recovery_owner_manager_id,
            recovery_owner_generation, reply_guarantee_disarmed
          ) VALUES (
            'per_chat', 'scope-40-progressed', '15550100002@s.whatsapp.net',
            ?, ?, 'turn-40-duplicate-upgrade', 'manager-40-duplicate-upgrade', 2,
            'failed', 'unknown_terminal',
            'transferred_to_recovery_owner', 'enqueued', ?,
            'recovery-turn-40-duplicate-upgrade', 'recovery-manager-40-duplicate-upgrade', 3, 0
          )
        `).run(inboundSeq, inboundSeq, opId);
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('fails the upgrade closed when a transfer terminal has no linked recovery job', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        insertTransferWithPendingDelivery(db.raw);
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.prepare('DELETE FROM turn_recovery_jobs').run();
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).toThrow(/Migration 40 failed/);
    } finally {
      cleanup(dbPath);
    }
  });

  it('accepts a valid pre-40 transfer whose selected delivery progressed monotonically', () => {
    const dbPath = tmpFile();
    try {
      {
        const db = new Database(dbPath);
        db.open();
        const { opId } = insertTransferWithPendingDelivery(db.raw);
        db.raw.prepare(`
          UPDATE outbound_ops
          SET status = 'submitted', wa_message_id = 'wa-progressed', submitted_at = datetime('now')
          WHERE id = ?
        `).run(opId);
        db.close();
      }
      {
        const raw = new DatabaseSync(dbPath);
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery');
        raw.exec('DROP TRIGGER IF EXISTS turn_terminal_transfer_requires_delivery_update');
        raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
        raw.close();
      }

      const reopened = new Database(dbPath);
      expect(() => reopened.open()).not.toThrow();
      reopened.close();
    } finally {
      cleanup(dbPath);
    }
  });
});
