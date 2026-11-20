import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultIncidentDbPath,
  openIncidentDb,
  IncidentStoreCorruptError,
} from '../../../src/fleet/incidents/db.ts';
import { INCIDENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/fleet/incidents/schema.ts';

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

// A database at the schema version before the current one, as an earlier
// release left it, with a canary row.
function writePreviousVersionDatabase(): number {
  const previous = INCIDENT_SCHEMA_VERSION - 1;
  mkdirSync(join(dir, 'fleet'), { recursive: true, mode: 0o700 });
  const old = new DatabaseSync(dbPath());
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= previous)) {
    for (const statement of migration.statements) old.exec(statement);
  }
  old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(previous));
  old.prepare(`INSERT INTO meta (key, value) VALUES ('canary', 'kept')`).run();
  old.close();
  return previous;
}

function readMeta(path: string, key: string): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
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
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    const db1 = new DatabaseSync(dbPath());
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 2)) {
      for (const statement of migration.statements) db1.exec(statement);
    }
    db1.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '2')`).run();
    db1
      .prepare(
        `INSERT INTO events (
           producer_id, producer_domain_id, signal_id, payload_digest, payload_json,
           kind, subject, observed_at, received_at, disposition)
         VALUES ('p', 'd', 's1', 'sha256:x', '{}', 'heartbeat_observed', 'host:alpha',
                 '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:01.000Z', 'heartbeat_recorded')`,
      )
      .run();
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

  // An earlier release refuses a database above its own schema version, so a
  // migration must leave a copy that release can open (the rollback path).
  it('keeps a private copy at the old schema version before migrating', () => {
    const previous = INCIDENT_SCHEMA_VERSION - 1;
    mkdirSync(join(dir, 'fleet'), { recursive: true, mode: 0o700 });
    const old = new DatabaseSync(dbPath());
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= previous)) {
      for (const statement of migration.statements) old.exec(statement);
    }
    old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(previous));
    old.prepare(`INSERT INTO meta (key, value) VALUES ('canary', 'kept')`).run();
    old.close();

    openIncidentDb(dbPath()).close();

    const copyPath = `${dbPath()}.schema-v${previous}.bak`;
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    const rows = copy.prepare(`SELECT key, value FROM meta ORDER BY key`).all() as Array<{ key: string; value: string }>;
    copy.close();
    expect(rows).toEqual([
      { key: 'canary', value: 'kept' },
      { key: 'schema_version', value: String(previous) },
    ]);
    expect(statSync(copyPath).mode & 0o777).toBe(0o600);
  });

  it('removes a copy that fails verification and tries again on the next open', () => {
    const previous = writePreviousVersionDatabase();
    const copyPath = `${dbPath()}.schema-v${previous}.bak`;
    expect(() => openIncidentDb(dbPath(), {
      afterPreMigrationCopy: (tmpPath) => writeFileSync(tmpPath, 'torn copy'),
    })).toThrow(IncidentStoreCorruptError);
    expect(readdirSync(join(dir, 'fleet')).filter((name) => name.includes('.bak'))).toEqual([]);
    expect(readMeta(dbPath(), 'schema_version')).toBe(String(previous));

    openIncidentDb(dbPath()).close();
    expect(readMeta(copyPath, 'schema_version')).toBe(String(previous));
    expect(readMeta(copyPath, 'canary')).toBe('kept');
  });

  it('fails closed on an empty existing copy and leaves it untouched', () => {
    const previous = writePreviousVersionDatabase();
    const copyPath = `${dbPath()}.schema-v${previous}.bak`;
    writeFileSync(copyPath, '');
    expect(() => openIncidentDb(dbPath())).toThrow(/schema-v\d+\.bak/);
    expect(statSync(copyPath).size).toBe(0);
    expect(readMeta(dbPath(), 'schema_version')).toBe(String(previous));
  });

  it('fails closed on a symlinked copy path without following it', () => {
    const previous = writePreviousVersionDatabase();
    const copyPath = `${dbPath()}.schema-v${previous}.bak`;
    // A valid old-version database behind the link: following it would pass.
    const target = join(dir, 'elsewhere.db');
    const raw = new DatabaseSync(dbPath());
    raw.prepare('VACUUM INTO ?').run(target);
    raw.close();
    symlinkSync(target, copyPath);
    expect(() => openIncidentDb(dbPath())).toThrow(/schema-v\d+\.bak/);
    expect(lstatSync(copyPath).isSymbolicLink()).toBe(true);
    expect(readMeta(dbPath(), 'schema_version')).toBe(String(previous));
  });

  it('keeps a valid existing copy instead of replacing it', () => {
    const previous = writePreviousVersionDatabase();
    const copyPath = `${dbPath()}.schema-v${previous}.bak`;
    const raw = new DatabaseSync(dbPath());
    raw.prepare('VACUUM INTO ?').run(copyPath);
    raw.prepare(`UPDATE meta SET value = 'changed' WHERE key = 'canary'`).run();
    raw.close();

    openIncidentDb(dbPath()).close();
    expect(readMeta(copyPath, 'canary')).toBe('kept');
    expect(readMeta(dbPath(), 'schema_version')).toBe(String(INCIDENT_SCHEMA_VERSION));
  });

  it('writes no schema copy for a fresh or already current database', () => {
    openIncidentDb(dbPath()).close();
    openIncidentDb(dbPath()).close();
    expect(readdirSync(join(dir, 'fleet')).filter((name) => name.endsWith('.bak'))).toEqual([]);
  });
});
