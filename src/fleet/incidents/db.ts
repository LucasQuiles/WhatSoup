import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { forceEnsurePrivateDirectorySync } from '../../lib/private-fs.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../lib/sqlite-constants.ts';
import { xdgDir } from '../paths.ts';
import { INCIDENT_SCHEMA_VERSION, MIGRATIONS } from './schema.ts';

export class IncidentStoreCorruptError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`incident store state_recovery_required: ${reason}`);
    this.name = 'IncidentStoreCorruptError';
    this.reason = reason;
  }
}

export function defaultIncidentDbPath(): string {
  return join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'fleet', 'incidents.db');
}

function isFreshTarget(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  return statSync(dbPath).size === 0;
}

function applyMigrations(db: DatabaseSync, fromVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function readExistingVersion(db: DatabaseSync): number {
  const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (!check || check.quick_check !== 'ok') {
    throw new IncidentStoreCorruptError('quick_check failed');
  }
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value?: unknown }
    | undefined;
  const value = typeof row?.value === 'string' ? Number.parseInt(row.value, 10) : NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new IncidentStoreCorruptError('unsupported schema_version missing');
  }
  if (value > INCIDENT_SCHEMA_VERSION) {
    throw new IncidentStoreCorruptError(`unsupported schema_version ${value}`);
  }
  return value;
}

export function openIncidentDb(dbPath: string): DatabaseSync {
  forceEnsurePrivateDirectorySync(dirname(dbPath), 'incident store directory');
  const fresh = isFreshTarget(dbPath);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    throw new IncidentStoreCorruptError('failed to open database file');
  }

  try {
    db.exec('PRAGMA journal_mode = WAL');
    // Receipts promise "a response lost after commit is safe" (spec §3), so
    // commits must survive power loss — WAL's default NORMAL does not.
    db.exec('PRAGMA synchronous = FULL');
    db.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    db.exec('PRAGMA foreign_keys = ON');
    if (fresh) {
      applyMigrations(db, 0);
    } else {
      applyMigrations(db, readExistingVersion(db));
    }
  } catch (err) {
    db.close();
    throw err instanceof IncidentStoreCorruptError
      ? err
      : new IncidentStoreCorruptError('database unreadable');
  }

  chmodSync(dbPath, 0o600);
  return db;
}
