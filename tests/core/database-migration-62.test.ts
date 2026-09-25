/**
 * Migration 62 (#3295 S1): `deferred_turn_obligations` — fresh create,
 * idempotent re-run, and the CHECK/unique constraints that back the store's
 * state machine.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigration62 } from '../../src/core/database-migration-62.ts';

describe('database migration 62', () => {
  let raw: DatabaseSync;

  beforeEach(() => {
    raw = new DatabaseSync(':memory:');
  });

  afterEach(() => {
    raw.close();
  });

  function insertObligation(overrides: Record<string, unknown> = {}): void {
    const row = {
      scope: 'per_chat',
      conversation_key: '15550100001',
      delivery_jid: '15550100001:7@s.whatsapp.net',
      inbound_seq: 7,
      source_message_id: 'wamid-7',
      received_at_unix: 1_750_000_007,
      replay_safe: 1,
      sender_jid: 'probe@s.whatsapp.net',
      replay_text: 'follower',
      is_group: 0,
      content_type: 'text',
      status: 'pending',
      ...overrides,
    };
    const columns = Object.keys(row);
    raw.prepare(`
      INSERT INTO deferred_turn_obligations (${columns.join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})
    `).run(...Object.values(row) as Array<string | number>);
  }

  it('creates the table and both indexes on a fresh database', () => {
    runMigration62(raw);
    const objects = raw.prepare(`
      SELECT name, type FROM sqlite_master
      WHERE name LIKE 'deferred_turn_obligations%'
      ORDER BY name
    `).all() as Array<{ name: string; type: string }>;
    expect(objects).toEqual([
      { name: 'deferred_turn_obligations', type: 'table' },
      { name: 'deferred_turn_obligations_drain', type: 'index' },
      { name: 'deferred_turn_obligations_source', type: 'index' },
    ]);
  });

  it('re-runs without error and without duplicating objects', () => {
    runMigration62(raw);
    insertObligation();
    runMigration62(raw);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM deferred_turn_obligations').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects unknown status values and replay-unsafe rows at the schema layer', () => {
    runMigration62(raw);
    expect(() => insertObligation({ status: 'wedged' })).toThrow(/CHECK/i);
    expect(() => insertObligation({ replay_safe: 0 })).toThrow(/CHECK/i);
  });

  it('enforces one obligation per (scope, inbound_seq) while allowing other scopes', () => {
    runMigration62(raw);
    insertObligation();
    expect(() => insertObligation({ source_message_id: 'wamid-dup' })).toThrow(/UNIQUE/i);
    insertObligation({ scope: 'global', conversation_key: 'global-key' });
    const count = raw.prepare('SELECT COUNT(*) AS n FROM deferred_turn_obligations').get() as { n: number };
    expect(count.n).toBe(2);
  });
});
