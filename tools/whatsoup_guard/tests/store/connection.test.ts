import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { openDatabase, openDatabaseWithMigrations, type StoreLogger } from '../../src/store/connection.ts';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/store/migrations.ts';

const dirs: string[] = [];
interface CapturedLog {
  level: 'info' | 'error';
  payload: Record<string, string | number>;
  message: string | undefined;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-store-'));
  dirs.push(dir);
  return join(dir, 'guard.sqlite');
}

function appTables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => name !== 'sqlite_sequence');
}

function indexes(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function migrationVersions(db: ReturnType<typeof openDatabase>): number[] {
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => (row as { version: number }).version);
}

function allMigrationVersions(): number[] {
  return Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1);
}

function captureLogger(out: CapturedLog[]): StoreLogger {
  return {
    info(payload, message) {
      out.push({ level: 'info', payload, message });
    },
    error(payload, message) {
      out.push({ level: 'error', payload, message });
    },
  };
}

describe('openDatabase', () => {
  it('creates the schema in :memory:', () => {
    const db = openDatabase(':memory:');

    expect(appTables(db)).toEqual(['baseline', 'events', 'mutes', 'runtime_state', 'schema_migrations']);

    db.close();
  });

  it('creates schema, indexes, and migration tracking in a temp-file database', () => {
    const db = openDatabase(tempDbPath());

    expect(appTables(db)).toEqual(['baseline', 'events', 'mutes', 'runtime_state', 'schema_migrations']);
    expect(indexes(db)).toEqual([
      'idx_events_fingerprint',
      'idx_events_kind',
      'idx_events_ts',
      'idx_mutes_expires',
    ]);
    expect(migrationVersions(db)).toEqual(allMigrationVersions());

    db.close();
  });

  it('reopens the same temp-file database idempotently without duplicating migration versions', () => {
    const file = tempDbPath();
    openDatabase(file).close();
    const db = openDatabase(file);

    expect(migrationVersions(db)).toEqual(allMigrationVersions());
    expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({ count: CURRENT_SCHEMA_VERSION });

    db.close();
  });

  it('upgrades an existing guard database without losing events', () => {
    const file = tempDbPath();
    const oldDb = openDatabaseWithMigrations(file, MIGRATIONS.slice(0, 3));
    oldDb.prepare(`
      INSERT INTO events (ts, kind, payload)
      VALUES ('2026-05-08T10:00:00.000Z', 'heartbeat', '{"status":"old"}')
    `).run();
    oldDb.close();

    const db = openDatabase(file);

    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 });
    expect(migrationVersions(db).at(-1)).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('enables foreign key enforcement', () => {
    const db = openDatabase(':memory:');

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    db.close();
  });

  it('uses WAL for file-backed databases when SQLite supports it', () => {
    const db = openDatabase(tempDbPath());

    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');

    db.close();
  });

  it('does not require WAL for in-memory databases', () => {
    const db = openDatabase(':memory:');

    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');

    db.close();
  });

  it('rolls back failed migrations and closes the database handle', () => {
    const file = tempDbPath();

    expect(() =>
      openDatabaseWithMigrations(file, [
        'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)',
        'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)',
      ]),
    ).toThrow(/database migration failed/);

    const db = openDatabaseWithMigrations(file, []);
    expect(appTables(db)).toEqual(['schema_migrations']);
    expect(() => db.prepare('CREATE TABLE can_write_after_failure (id INTEGER PRIMARY KEY)').run()).not.toThrow();

    db.close();
  });

  it('emits safe structured lifecycle logs without full local paths', () => {
    const file = tempDbPath();
    const logs: CapturedLog[] = [];
    const db = openDatabase(file, { logger: captureLogger(logs) });

    expect(logs.map((log) => log.payload.event)).toEqual([
      'database_open_start',
      'database_migration_start',
      'database_migration_succeeded',
      'database_open_succeeded',
    ]);
    expect(logs.every((log) => log.payload.path_class === 'file')).toBe(true);
    expect(logs.every((log) => log.payload.db_name === basename(file))).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(dirname(file));

    db.close();
  });

  it('emits safe migration failure logs before closing failed handles', () => {
    const file = tempDbPath();
    const logs: CapturedLog[] = [];

    expect(() =>
      openDatabaseWithMigrations(
        file,
        [
          'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)',
          'CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)',
        ],
        { logger: captureLogger(logs) },
      ),
    ).toThrow(/database migration failed/);
    expect(logs.map((log) => log.payload.event)).toContain('database_migration_failed');
    expect(JSON.stringify(logs)).not.toContain(dirname(file));

    const db = openDatabaseWithMigrations(file, []);
    expect(() => db.prepare('CREATE TABLE can_write_after_logged_failure (id INTEGER PRIMARY KEY)').run()).not.toThrow();
    db.close();
  });

  it('surfaces open failures without leaking full local database paths', () => {
    const file = join(tempDbPath(), 'missing-parent', 'guard.sqlite');

    expect(() => openDatabase(file)).toThrow(/database open failed/);
    expect(() => openDatabase(file)).not.toThrow(dirname(file));
    expect(() => openDatabase(file)).toThrow(basename(file));
  });
});
