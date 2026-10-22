/**
 * Migration 65 (#3421 step 1): nullable caller-attribution columns on
 * tool_calls. Additive and idempotent, with no CHECK constraints, because the
 * tool_calls insert fails closed and a constraint violation would refuse a
 * tool call.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { runMigration65, TOOL_CALL_CALLER_COLUMNS } from '../../src/core/database-migration-65.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

const CALLER_COLUMNS = TOOL_CALL_CALLER_COLUMNS.map(([name]) => name);

function toolCallColumns(raw: DatabaseSync): Map<string, { type: string; notnull: number; dflt_value: unknown }> {
  const rows = raw.prepare("PRAGMA table_info('tool_calls')").all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown;
  }>;
  return new Map(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull, dflt_value: r.dflt_value }]));
}

describe('migration 65 — tool_calls caller attribution', () => {
  let db: Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('is applied by the registry and adds every caller column as nullable with no default', () => {
    db = new Database(':memory:');
    db.open();
    expect(CURRENT_SCHEMA_MIGRATION).toBe(66);
    const applied = db.raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    expect(applied.v).toBe(66);
    expect(db.raw.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = 65').get()).toEqual({ ok: 1 });

    const columns = toolCallColumns(db.raw);
    expect(CALLER_COLUMNS.map((name) => [name, columns.get(name)])).toEqual([
      ['caller_transport', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['caller_connection_id', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['caller_client_name', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['caller_client_version', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['caller_token_result', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['caller_turn_owned', { type: 'INTEGER', notnull: 0, dflt_value: null }],
      ['caller_actor_source', { type: 'TEXT', notnull: 0, dflt_value: null }],
      ['tool_sensitive', { type: 'INTEGER', notnull: 0, dflt_value: null }],
    ]);
  });

  it('accepts any value in the new columns, so the fail-closed insert cannot be refused by them', () => {
    db = new Database(':memory:');
    db.open();
    const tableSql = (db.raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'")
      .get() as { sql: string }).sql;
    for (const name of CALLER_COLUMNS) {
      expect(tableSql).toContain(`${name} `);
      const definition = tableSql.slice(tableSql.indexOf(name)).split(',')[0];
      expect(definition).not.toMatch(/CHECK/i);
    }
  });

  it('is idempotent on rerun and keeps legacy rows NULL', () => {
    db = new Database(':memory:');
    db.open();
    db.raw.prepare(
      `INSERT INTO tool_calls (conversation_key, tool_name, tool_group, tool_input, status,
         replay_policy, outcome_code, retry_disposition, operator_action, evidence_coverage)
       VALUES ('k', 'list_chats', 'other', '[metadata-only]', 'pending', 'read_only',
               'not_terminal', 'not_applicable', 'none', 'complete')`,
    ).run();

    runMigration65(db.raw);
    runMigration65(db.raw);

    const row = db.raw
      .prepare(`SELECT ${CALLER_COLUMNS.join(', ')} FROM tool_calls WHERE tool_name = 'list_chats'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual(Object.fromEntries(CALLER_COLUMNS.map((name) => [name, null])));
    expect([...toolCallColumns(db.raw).keys()].filter((name) => CALLER_COLUMNS.includes(name as never)))
      .toEqual(CALLER_COLUMNS);
  });

  it('no-ops when tool_calls is absent', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      runMigration65(raw);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'tool_calls'").get()).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});
