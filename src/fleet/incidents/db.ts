import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { forceEnsurePrivateDirectorySync, fsyncDirectoryRequired } from '../../lib/private-fs.ts';
import { defaultIsProcessAlive } from '../../lib/process-lock.ts';
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

// The digest covers every sqlite_master entry (type, name, table and SQL, not
// the page numbers a copy renumbers) and every row of every table it lists,
// sqlite_sequence included. Each value is its storage class (typeof) plus its
// exact bytes: hex(CAST(value AS BLOB)) for text, blob and integer, and
// printf('%!.17g') for a real, whose text form keeps 15 digits only. quote()
// is not used, because it stops a text value at an embedded NUL. Rows are
// sorted by those strings, so the digest depends on content alone, never on
// row order or page layout. Indexes are covered through their definitions.
// The reads run in one read transaction, so every table comes from the same
// snapshot; no write lock is taken.
function contentDigest(db: DatabaseSync): string {
  const hash = createHash('sha256');
  const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;
  db.exec('BEGIN');
  try {
    const entries = db
      .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
      .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    for (const entry of entries) {
      hash.update(`${JSON.stringify([entry.type, entry.name, entry.tbl_name, entry.sql])}\n`);
      if (entry.type !== 'table') continue;
      const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(entry.name) as Array<{ name: string }>;
      const values = columns
        .map(({ name }) => quoteName(name))
        .map((column) => `typeof(${column}), CASE typeof(${column}) WHEN 'real' THEN printf('%!.17g', ${column})`
          + ` ELSE hex(CAST(${column} AS BLOB)) END`)
        .join(', ');
      const order = columns.flatMap((_column, index) => [String(2 * index + 1), String(2 * index + 2)]).join(', ');
      for (const row of db.prepare(`SELECT ${values} FROM ${quoteName(entry.name)} ORDER BY ${order}`).iterate()) {
        hash.update(`${JSON.stringify(Object.values(row as Record<string, unknown>))}\n`);
      }
    }
  } finally {
    db.exec('ROLLBACK');
  }
  return hash.digest('hex');
}

// An existing entry may predate rows written since it was made (an earlier
// release ran on a restored database, say), so it is kept only when it is a
// single-link regular file that is not the live database and holds exactly
// the live content now.
function isCurrentPreMigrationCopy(
  db: DatabaseSync,
  dbPath: string,
  copyPath: string,
  version: number,
): boolean {
  try {
    const entry = lstatSync(copyPath);
    const live = statSync(dbPath);
    if (!entry.isFile() || entry.nlink !== 1) return false;
    if (entry.dev === live.dev && entry.ino === live.ino) return false;
  } catch {
    // intentional: an entry that cannot be examined is not a usable copy, and the caller fails closed
    return false;
  }
  if (!isValidPreMigrationCopy(copyPath, version)) return false;
  let copy: DatabaseSync | undefined;
  try {
    copy = new DatabaseSync(copyPath, { readOnly: true });
    return contentDigest(copy) === contentDigest(db);
  } catch {
    // intentional: a copy that cannot be read in full is not a usable copy, and the caller fails closed
    return false;
  } finally {
    copy?.close();
  }
}

// A crash between the copy and its link leaves `<copy>.tmp-<pid>-<uuid>`, and
// maybe its `-journal`. Remove the regular files of exactly that shape whose
// process is gone; a running process may still be writing its own.
const LEFTOVER_COPY_SUFFIX =
  /^\.tmp-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-journal)?$/;

function removeLeftoverCopies(copyPath: string): void {
  const directory = dirname(copyPath);
  const prefix = basename(copyPath);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // intentional: an unreadable directory leaves nothing to remove; the open goes on
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = name.slice(prefix.length).match(LEFTOVER_COPY_SUFFIX);
    if (!match || defaultIsProcessAlive(Number(match[1]))) continue;
    const path = join(directory, name);
    try {
      if (lstatSync(path).isFile()) unlinkSync(path);
    } catch {
      // intentional: a leftover that cannot be removed now is tried again on the next open
    }
  }
}

function flushFile(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
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
// under a temporary name, verified, flushed and then linked into place, which
// never replaces anything already at the destination; the directory is
// flushed before the migration, so a migration that survives a power loss
// leaves its copy too. An existing destination is kept only if it is a
// current copy (isCurrentPreMigrationCopy); otherwise the open fails closed
// and names the file to move aside, and the entry is never changed.
function keepPreMigrationCopy(
  db: DatabaseSync,
  dbPath: string,
  fromVersion: number,
  hooks: IncidentDbOpenHooks,
): void {
  if (fromVersion >= INCIDENT_SCHEMA_VERSION) return;
  const copyPath = `${dbPath}.schema-v${fromVersion}.bak`;
  removeLeftoverCopies(copyPath);
  if (pathEntryExists(copyPath)) {
    if (!isCurrentPreMigrationCopy(db, dbPath, copyPath, fromVersion)) {
      throw new IncidentStoreCorruptError(
        `pre-migration copy ${copyPath} is not a current copy of this schema v${fromVersion} database; move it aside`,
      );
    }
    // An open that linked this copy may have died or failed before its folder
    // flush, so the copy and the folder are flushed again before migrating.
    try {
      flushFile(copyPath);
      fsyncDirectoryRequired(dirname(copyPath));
    } catch {
      throw new IncidentStoreCorruptError(`pre-migration copy failed: ${copyPath}`);
    }
    return;
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
    flushFile(tmpPath);
    linkSync(tmpPath, copyPath);
    // Drop the temporary name before the directory flush, so the flush makes
    // that removal durable too and the copy keeps one link.
    rmSync(tmpPath, { force: true });
    fsyncDirectoryRequired(dirname(copyPath));
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
