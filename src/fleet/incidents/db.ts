import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { forceEnsurePrivateDirectorySync } from '../../lib/private-fs.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../../lib/sqlite-constants.ts';
import { xdgDir } from '../paths.ts';
import { INCIDENT_SCHEMA_VERSION, SCHEMA_STATEMENTS } from './schema.ts';

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

function initializeSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(INCIDENT_SCHEMA_VERSION),
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function validateExisting(db: DatabaseSync): void {
  const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (!check || check.quick_check !== 'ok') {
    throw new IncidentStoreCorruptError('quick_check failed');
  }
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value?: unknown }
    | undefined;
  const value = typeof row?.value === 'string' ? row.value : null;
  if (value !== String(INCIDENT_SCHEMA_VERSION)) {
    throw new IncidentStoreCorruptError(`unsupported schema_version ${value ?? 'missing'}`);
  }
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
      initializeSchema(db);
    } else {
      validateExisting(db);
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
