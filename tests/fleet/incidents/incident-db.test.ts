import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultIncidentDbPath,
  openIncidentDb,
  IncidentStoreCorruptError,
} from '../../../src/fleet/incidents/db.ts';
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

  it('resolves the default database path under the fleet XDG data root', () => {
    expect(defaultIncidentDbPath().endsWith(join('whatsoup', 'fleet', 'incidents.db'))).toBe(true);
  });

  it('fails closed on an unknown schema version', () => {
    const db = openIncidentDb(dbPath());
    db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    db.close();

    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
  });

  it('upgrades a lower-version database in place, preserving rows', () => {
    const db1 = openIncidentDb(dbPath());
    db1
      .prepare(
        `INSERT INTO events (
           producer_id, producer_domain_id, signal_id, payload_digest, payload_json,
           kind, subject, observed_at, received_at, disposition)
         VALUES ('p', 'd', 's1', 'sha256:x', '{}', 'heartbeat_observed', 'host:alpha',
                 '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:01.000Z', 'heartbeat_recorded')`,
      )
      .run();
    // Simulate a v1 database: drop post-v1 artifacts and rewind the marker.
    db1.exec('DROP TABLE IF EXISTS producers');
    db1.prepare(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`).run();
    db1.close();

    const db2 = openIncidentDb(dbPath());
    const version = db2
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe(String(INCIDENT_SCHEMA_VERSION));
    const kept = db2.prepare(`SELECT signal_id FROM events`).all() as Array<{ signal_id: string }>;
    expect(kept.map((r) => r.signal_id)).toEqual(['s1']);
    db2.close();
  });

  it('fails closed on a database whose version is ahead of the code', () => {
    const db = openIncidentDb(dbPath());
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(
      String(INCIDENT_SCHEMA_VERSION + 1),
    );
    db.close();
    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
  });
});
