import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb, IncidentStoreCorruptError } from '../../../src/fleet/incidents/db.ts';
import { INCIDENT_SCHEMA_VERSION } from '../../../src/fleet/incidents/schema.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(dir, 'fleet', 'incidents.db');
}

describe('openIncidentDb', () => {
  it('creates a fresh database with schema v1 and private modes', () => {
    const db = openIncidentDb(dbPath());
    const version = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe(String(INCIDENT_SCHEMA_VERSION));

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('events');
    expect(names).toContain('incidents');
    expect(names).toContain('transitions');

    expect(statSync(dbPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'fleet')).mode & 0o777).toBe(0o700);
    db.close();
  });

  it('reopens an existing database without touching stored rows', () => {
    const db1 = openIncidentDb(dbPath());
    db1.prepare(`INSERT INTO meta (key, value) VALUES ('canary', 'kept')`).run();
    db1.close();

    const db2 = openIncidentDb(dbPath());
    const row = db2
      .prepare(`SELECT value FROM meta WHERE key = 'canary'`)
      .get() as { value: string };
    expect(row.value).toBe('kept');
    db2.close();
  });

  it('fails closed on a corrupt non-empty file instead of re-initializing', () => {
    const db = openIncidentDb(dbPath());
    db.close();
    writeFileSync(dbPath(), 'not a sqlite database, definitely corrupt bytes');

    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
    expect(() => openIncidentDb(dbPath())).toThrow(/state_recovery_required/);
  });

  it('fails closed on an unknown schema version', () => {
    const db = openIncidentDb(dbPath());
    db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    db.close();

    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
  });
});
