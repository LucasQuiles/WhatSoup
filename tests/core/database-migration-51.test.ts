import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigration51 } from '../../src/core/database-migration-51.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const DESTINATION_CANARY = 'CANARY-2562-RAW-DESTINATION@s.whatsapp.net';
const ALIAS_CANARY = 'CANARY-2562-RAW-ALIAS';
const PROFILE_CANARY = 'CANARY-2562-RAW-PROFILE';
const HASH_CANARY = 'CANARY-2562-RAW-HASH';
const PROVIDER_ID_CANARY = 'CANARY-2562-RAW-PROVIDER-ID';
const ERROR_CANARY = 'CANARY-2562-RAW-ERROR';

function createLegacyOutboundSends(raw: DatabaseSync): void {
  raw.exec(`
    CREATE TABLE outbound_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line TEXT NOT NULL,
      caller TEXT NOT NULL CHECK (caller IN ('mcp', 'health', 'rgp')),
      chat_jid TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('chatJid', 'alias')),
      alias TEXT,
      profile TEXT,
      text_hash TEXT NOT NULL,
      text_length INTEGER NOT NULL,
      link_preview_mode TEXT,
      status TEXT NOT NULL,
      error TEXT,
      transport_message_id TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
}

function insertLegacy(raw: DatabaseSync, id: number, status: string): void {
  raw.prepare(`
    INSERT INTO outbound_sends (
      id, line, caller, chat_jid, target_kind, alias, profile,
      text_hash, text_length, link_preview_mode, status, error,
      transport_message_id, created_at, completed_at
    ) VALUES (
      ?, 'personal', 'mcp', ?, 'alias', ?, ?,
      ?, 987654, 'off', ?, ?, ?,
      '2026-07-01 00:00:00',
      CASE WHEN ? = 'intent' THEN NULL ELSE '2026-07-01 00:00:01' END
    )
  `).run(
    id,
    `${DESTINATION_CANARY}-${id}`,
    `${ALIAS_CANARY}-${id}`,
    `${PROFILE_CANARY}-${id}`,
    `${HASH_CANARY}-${id}`,
    status,
    `${ERROR_CANARY}-${id}`,
    `${PROVIDER_ID_CANARY}-${id}`,
    status,
  );
}

describe('migration 51 metadata-only outbound-send evidence', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
    createLegacyOutboundSends(raw);
  });

  afterEach(() => {
    raw.close();
  });

  it('scrubs legacy metadata and maps every row without interpreting old prose or status', () => {
    insertLegacy(raw, 1, 'intent');
    insertLegacy(raw, 2, 'sent');
    insertLegacy(raw, 3, 'failed');

    runMigration51(raw);

    const columns = raw
      .prepare("PRAGMA table_info('outbound_sends')")
      .all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual([
      'id',
      'audit_receipt',
      'schema_version',
      'caller',
      'target_kind',
      'outcome_code',
      'failure_code',
      'failure_stage',
      'mutation_state',
      'retryable',
      'evidence_coverage',
      'logical_attempt_count',
      'provider_submission_count',
      'created_at',
      'completed_at',
    ]);

    const rows = raw.prepare(`
      SELECT *
      FROM outbound_sends
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row).toMatchObject({
        id: index + 1,
        schema_version: 1,
        caller: 'mcp',
        target_kind: 'alias',
        outcome_code: 'legacy_unclassified',
        failure_code: 'legacy_unclassified',
        failure_stage: 'unknown',
        mutation_state: 'unknown',
        retryable: null,
        evidence_coverage: 'legacy_unclassified',
        logical_attempt_count: null,
        provider_submission_count: null,
        created_at: '2026-07-01 00:00:00',
        completed_at: null,
      });
      expect(row.audit_receipt).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    }
    expect(new Set(rows.map((row) => row.audit_receipt)).size).toBe(3);

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(DESTINATION_CANARY);
    expect(serialized).not.toContain(ALIAS_CANARY);
    expect(serialized).not.toContain(PROFILE_CANARY);
    expect(serialized).not.toContain(HASH_CANARY);
    expect(serialized).not.toContain(PROVIDER_ID_CANARY);
    expect(serialized).not.toContain(ERROR_CANARY);
  });

  it('rejects receipt, counter, and lifecycle contradictions', () => {
    runMigration51(raw);

    expect(() => raw.prepare(`
      INSERT INTO outbound_sends (
        audit_receipt, caller, target_kind, outcome_code,
        failure_stage, mutation_state, evidence_coverage,
        logical_attempt_count, provider_submission_count
      ) VALUES (
        'NOT-LOWERCASE-HEX', 'mcp', 'chatJid', 'intent',
        'not_started', 'not_started', 'typed', 1, 0
      )
    `).run()).toThrow();

    expect(() => raw.prepare(`
      INSERT INTO outbound_sends (
        audit_receipt, caller, target_kind, outcome_code,
        failure_code, failure_stage, mutation_state, retryable,
        evidence_coverage, logical_attempt_count,
        provider_submission_count, completed_at
      ) VALUES (
        '00000000000000000000000000000001', 'mcp', 'chatJid', 'submitted',
        'transport.transient_provider', 'ack_received', 'acknowledged', 1,
        'typed', 1, 1, datetime('now')
      )
    `).run()).toThrow();

    expect(() => raw.prepare(`
      INSERT INTO outbound_sends (
        audit_receipt, caller, target_kind, outcome_code,
        failure_code, failure_stage, mutation_state, retryable,
        evidence_coverage, logical_attempt_count,
        provider_submission_count, completed_at
      ) VALUES (
        '00000000000000000000000000000002', 'health', 'alias', 'failed_not_sent',
        'unknown', 'provider_call_started', 'maybe_mutated', 0,
        'untyped', 1, 0, datetime('now')
      )
    `).run()).toThrow();
  });

  it('accepts each current terminal outcome with its exact evidence tuple', () => {
    runMigration51(raw);

    const insert = raw.prepare(`
      INSERT INTO outbound_sends (
        audit_receipt, caller, target_kind, outcome_code,
        failure_code, failure_stage, mutation_state, retryable,
        evidence_coverage, logical_attempt_count,
        provider_submission_count, completed_at
      ) VALUES (?, 'mcp', 'chatJid', ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    insert.run(
      '00000000000000000000000000000001',
      'submitted',
      null,
      'ack_received',
      'acknowledged',
      null,
      'typed',
      1,
      '2026-07-01 00:00:01',
    );
    insert.run(
      '00000000000000000000000000000002',
      'confirmed',
      null,
      'ack_received',
      'acknowledged',
      null,
      'typed',
      1,
      '2026-07-01 00:00:02',
    );
    insert.run(
      '00000000000000000000000000000003',
      'failed_not_sent',
      'transport.auth_required',
      'not_started',
      'not_mutated',
      0,
      'typed',
      0,
      '2026-07-01 00:00:03',
    );
    insert.run(
      '00000000000000000000000000000004',
      'ambiguous',
      'unknown',
      'unknown',
      'unknown',
      0,
      'untyped',
      0,
      '2026-07-01 00:00:04',
    );

    expect(raw.prepare('SELECT COUNT(*) AS count FROM outbound_sends').get()).toEqual({ count: 4 });
  });

  it('is idempotent against an already migrated schema', () => {
    insertLegacy(raw, 1, 'sent');

    runMigration51(raw);
    runMigration51(raw);

    expect(raw.prepare('SELECT COUNT(*) AS count FROM outbound_sends').get()).toEqual({ count: 1 });
    expect(raw.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });

  it('is registered as the current schema migration', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      expect(CURRENT_SCHEMA_MIGRATION).toBe(52);
      expect(db.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 51',
      ).get()).toEqual({ version: 51 });
    } finally {
      db.close();
    }
  });
});
