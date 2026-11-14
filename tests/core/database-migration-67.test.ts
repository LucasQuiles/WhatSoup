import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../../src/core/database-schema-version.ts';
import { runMigration67 } from '../../src/core/database-migration-67.ts';

describe('migration 67 — protected delivery metadata', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('registers metadata-only delivery and deduplicated event tables', () => {
    db = new Database(':memory:');
    db.open();

    expect(CURRENT_SCHEMA_MIGRATION).toBe(67);
    expect(db.raw.prepare('SELECT 1 AS ok FROM schema_migrations WHERE version = 67').get())
      .toEqual({ ok: 1 });
    const deliveryColumns = (db.raw.prepare("PRAGMA table_info('protected_deliveries')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(deliveryColumns).toEqual(expect.arrayContaining([
      'stage_operation_id', 'resolve_operation_id', 'delivery_ref', 'delivery_id',
      'principal', 'recipient_jid', 'whatsapp_message_id', 'state', 'expires_at',
    ]));
    const eventColumns = (db.raw.prepare("PRAGMA table_info('protected_delivery_events')").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(eventColumns).toEqual(expect.arrayContaining(['event_id', 'delivery_ref', 'status', 'observed_at', 'relayed_at']));
  });

  it('does not persist a delivery URL or raw secret field', () => {
    db = new Database(':memory:');
    db.open();

    const tables = db.raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name IN ('protected_deliveries', 'protected_delivery_events')
      ORDER BY name
    `).all() as Array<{ sql: string }>;
    const sql = tables.map((row) => row.sql).join('\n').toLowerCase();
    expect(sql).not.toContain('link');
    expect(sql).not.toContain('secret_value');
    expect(sql).not.toContain('value');
  });

  it('is idempotent for a partially initialized test database', () => {
    db = new Database(':memory:');
    db.open();
    runMigration67(db.raw);
    runMigration67(db.raw);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'protected_deliveries'").get())
      .toEqual({ n: 1 });
  });
});
