import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';

describe('Migration v2 — durability tables', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => { db.close(); });

  it('creates inbound_events table with correct columns', () => {
    const cols = db.raw.prepare("PRAGMA table_info(inbound_events)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('seq');
    expect(names).toContain('message_id');
    expect(names).toContain('conversation_key');
    expect(names).toContain('processing_status');
    expect(names).toContain('terminal_reason');
  });

  it('migration 36 adds a nullable failure_class column to inbound_events', () => {
    const cols = db.raw.prepare("PRAGMA table_info(inbound_events)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const failureClass = cols.find(c => c.name === 'failure_class');
    expect(failureClass?.type, 'inbound_events.failure_class should exist after migration 36 as TEXT').toBe('TEXT');
    // No default, no backfill; nullable (notnull=0).
    expect(failureClass!.dflt_value, 'failure_class must have no column default').toBeNull();
    expect(failureClass!.notnull, 'failure_class must be nullable').toBe(0);
  });

  it('failure_class has no CHECK constraint (bounded in code, not schema) and accepts NULL + any text', () => {
    const sql = (db.raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='inbound_events'",
    ).get() as { sql: string }).sql;
    expect(sql).not.toMatch(/failure_class[^,]*CHECK/i);
    // A pre-taxonomy row leaves failure_class NULL.
    db.raw.prepare("INSERT INTO inbound_events (message_id, conversation_key, chat_jid) VALUES ('fc-null', 'k', 'j')").run();
    const nullRow = db.raw.prepare("SELECT failure_class FROM inbound_events WHERE message_id = 'fc-null'").get() as { failure_class: string | null };
    expect(nullRow.failure_class).toBeNull();
    // No schema CHECK: the code layer (coerceInboundFailureClass) is the only gate.
    expect(() => {
      db.raw.prepare("INSERT INTO inbound_events (message_id, conversation_key, chat_jid, failure_class) VALUES ('fc-raw', 'k', 'j', 'anything')").run();
    }).not.toThrow();
  });

  it('creates outbound_ops table with replay_policy column', () => {
    const cols = db.raw.prepare("PRAGMA table_info(outbound_ops)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('status');
    expect(names).toContain('wa_message_id');
    expect(names).toContain('payload_hash');
    expect(names).toContain('is_terminal');
    expect(names).toContain('replay_policy');
  });

  it('creates tool_calls table', () => {
    const cols = db.raw.prepare("PRAGMA table_info(tool_calls)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('replay_policy');
    expect(cols.map(c => c.name)).toContain('outbound_op_id');
  });

  it('creates session_checkpoints with versioning fields', () => {
    const cols = db.raw.prepare("PRAGMA table_info(session_checkpoints)").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('checkpoint_version');
    expect(names).toContain('updated_at');
    expect(names).toContain('claude_pid');
    expect(names).toContain('session_status');
  });

  it('creates recovery_runs table', () => {
    const cols = db.raw.prepare("PRAGMA table_info(recovery_runs)").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('tool_calls_quarantined');
  });

  it('message_id is unique in inbound_events', () => {
    db.raw.prepare("INSERT INTO inbound_events (message_id, conversation_key, chat_jid) VALUES ('m1', 'k1', 'j1')").run();
    expect(() => {
      db.raw.prepare("INSERT INTO inbound_events (message_id, conversation_key, chat_jid) VALUES ('m1', 'k1', 'j1')").run();
    }).toThrow();
  });

  it('conversation_key is unique in session_checkpoints', () => {
    db.raw.prepare("INSERT INTO session_checkpoints (conversation_key) VALUES ('k1')").run();
    expect(() => {
      db.raw.prepare("INSERT INTO session_checkpoints (conversation_key) VALUES ('k1')").run();
    }).toThrow();
  });
});
