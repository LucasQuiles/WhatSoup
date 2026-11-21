import { afterEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

describe('migration 68 — secret input metadata journal', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('records intake and transport metadata without a value-bearing column', () => {
    db = new Database(':memory:');
    db.open();

    expect(CURRENT_SCHEMA_MIGRATION).toBe(70);
    expect(db.raw.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = 68').get())
      .toEqual({ ok: 1 });
    const columns = (db.raw.prepare("PRAGMA table_info('protected_secret_inputs')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'intake_id', 'create_operation_id', 'resolve_operation_id', 'principal', 'recipient_jid',
      'resource_id', 'kind', 'purpose', 'input_state', 'delivery_status', 'whatsapp_message_id', 'expires_at',
    ]));
    const schema = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'protected_secret_inputs'")
      .get() as { sql: string };
    expect(schema.sql.toLowerCase()).not.toContain('link');
    expect(schema.sql.toLowerCase()).not.toContain('secret_value');
    expect(schema.sql.toLowerCase()).not.toContain('credential_value');
    expect(schema.sql).toContain("'mfa'");
  });
});
