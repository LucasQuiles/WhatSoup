/**
 * Consistent online backup of a live SQLite database for operator commands
 * that mutate host state (release activation, batch catch-up closure).
 *
 * Uses SQLite's online backup API through `node:sqlite`, reading the source
 * through a read-only connection, so committed WAL frames are captured while
 * the service keeps writing. The copy is verified with `PRAGMA quick_check`
 * before it is accepted: a backup that cannot prove itself is no backup, and
 * callers treat a throw here as "refuse before mutating".
 */
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

export interface SqliteBackupReceipt {
  sourcePath: string;
  backupPath: string;
  pages: number;
  quickCheck: 'ok';
}

const PRIVATE_FILE_MODE = 0o600;

/**
 * Settle the copy into a single self-contained file (a WAL-mode source yields
 * a WAL-mode copy, which would otherwise grow -wal/-shm sidecars on open),
 * then run quick_check on it.
 */
function settleAndQuickCheck(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    if (rows.length !== 1) return `rows=${rows.length}`;
    return String(Object.values(rows[0] ?? {})[0]);
  } finally {
    db.close();
  }
}

/**
 * Copy `sourcePath` to `backupPath` (which must not exist yet) and verify it.
 * The backup file is mode 0600 because it carries message content.
 */
export async function backupSqliteConsistent(
  sourcePath: string,
  backupPath: string,
): Promise<SqliteBackupReceipt> {
  const stat = lstatSync(sourcePath);
  if (!stat.isFile()) throw new Error('SQLite backup source must be an existing regular file');
  // Never overwrite: an existing file at the destination may be the only good
  // copy from an earlier run.
  if (existsSync(backupPath)) throw new Error('SQLite backup destination already exists');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let pages: number;
  try {
    pages = await backup(source, backupPath);
  } finally {
    source.close();
  }
  chmodSync(backupPath, PRIVATE_FILE_MODE);
  const verdict = settleAndQuickCheck(backupPath);
  if (verdict !== 'ok') throw new Error(`SQLite backup quick_check failed: ${verdict}`);
  return { sourcePath, backupPath, pages, quickCheck: 'ok' };
}
