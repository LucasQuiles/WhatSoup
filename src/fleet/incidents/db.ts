import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, rmSync, statSync } from 'node:fs';
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

export interface IncidentDbOpenHooks {
  /** Test seam: runs on the temporary pre-migration copy before it is verified. */
  afterPreMigrationCopy?: (tmpPath: string) => void;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    // intentional: lstat failing means nothing is at the path, which is the answer
    return false;
  }
}

// A copy counts only if it is a regular file (never a symlink), opens
// read-only, passes quick_check and carries exactly the old schema version.
function isValidPreMigrationCopy(copyPath: string, version: number): boolean {
  try {
    if (!lstatSync(copyPath).isFile()) return false;
  } catch {
    // intentional: an unreadable path is not a usable copy, and the caller fails closed
    return false;
  }
  let copy: DatabaseSync | undefined;
  try {
    copy = new DatabaseSync(copyPath, { readOnly: true });
    const check = copy.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') return false;
    const row = copy.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value?: unknown }
      | undefined;
    return row?.value === String(version);
  } catch {
    // intentional: a copy that cannot be opened or read is invalid, and the caller fails closed
    return false;
  } finally {
    copy?.close();
  }
}

// A WAL-mode source can yield a WAL-mode copy; settle it into one
// self-contained file so the read-only check and a later restore need no
// sidecar files (same approach as scripts/lib/sqlite-consistent-backup.ts).
function settleCopy(path: string): void {
  const copy = new DatabaseSync(path);
  try {
    copy.exec('PRAGMA journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

// An earlier release refuses a database above its own schema version, so a
// migration first leaves a copy that release can open. The copy is written
// under a temporary name, verified, and then linked into place, which never
// replaces anything already at the destination. An existing destination is
// kept only if it passes the same verification; otherwise the open fails
// closed and names the file to inspect.
function keepPreMigrationCopy(
  db: DatabaseSync,
  dbPath: string,
  fromVersion: number,
  hooks: IncidentDbOpenHooks,
): void {
  if (fromVersion >= INCIDENT_SCHEMA_VERSION) return;
  const copyPath = `${dbPath}.schema-v${fromVersion}.bak`;
  if (pathEntryExists(copyPath)) {
    if (isValidPreMigrationCopy(copyPath, fromVersion)) return;
    throw new IncidentStoreCorruptError(
      `pre-migration copy ${copyPath} is not a valid schema v${fromVersion} database; inspect or move it`,
    );
  }
  const tmpPath = `${copyPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    db.prepare('VACUUM INTO ?').run(tmpPath);
    settleCopy(tmpPath);
    chmodSync(tmpPath, 0o600);
    hooks.afterPreMigrationCopy?.(tmpPath);
    if (!isValidPreMigrationCopy(tmpPath, fromVersion)) {
      throw new Error('pre-migration copy failed verification');
    }
    linkSync(tmpPath, copyPath);
  } catch {
    throw new IncidentStoreCorruptError(`pre-migration copy failed: ${copyPath}`);
  } finally {
    rmSync(tmpPath, { force: true });
    rmSync(`${tmpPath}-journal`, { force: true });
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

export function openIncidentDb(dbPath: string, hooks: IncidentDbOpenHooks = {}): DatabaseSync {
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
      const fromVersion = readExistingVersion(db);
      keepPreMigrationCopy(db, dbPath, fromVersion, hooks);
      applyMigrations(db, fromVersion);
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
