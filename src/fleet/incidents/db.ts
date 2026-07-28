import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  let versionRow: unknown;
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (!check || check.quick_check !== 'ok') {
      throw new IncidentStoreCorruptError('quick_check failed');
    }
    versionRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  } catch (err) {
    if (err instanceof IncidentStoreCorruptError) throw err;
    throw new IncidentStoreCorruptError('database unreadable');
  }
  const value =
    versionRow && typeof (versionRow as { value?: unknown }).value === 'string'
      ? (versionRow as { value: string }).value
      : null;
  if (value !== String(INCIDENT_SCHEMA_VERSION)) {
    throw new IncidentStoreCorruptError(`unsupported schema_version ${value ?? 'missing'}`);
  }
}

export function openIncidentDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const fresh = isFreshTarget(dbPath);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    throw new IncidentStoreCorruptError('failed to open database file');
  }

  try {
    db.exec('PRAGMA journal_mode = WAL');
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
