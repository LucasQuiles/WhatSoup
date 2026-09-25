/**
 * Consistent online backup of a live SQLite database for operator commands
 * that mutate host state (release activation, batch catch-up closure).
 *
 * Uses `VACUUM INTO` on a read-only connection: the copy is written inside one
 * read transaction, so it is a consistent snapshot that includes committed WAL
 * frames while the service keeps writing. The async `node:sqlite` backup()
 * API was not used because its completion depends on thread-pool scheduling
 * and stalled for 10-20 s per call inside the test runner. The copy is
 * verified with `PRAGMA quick_check` before it is accepted: a backup that
 * cannot prove itself is no backup, and callers treat a throw here as "refuse
 * before mutating".
 */
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteBackupReceipt {
  sourcePath: string;
  backupPath: string;
  pages: number;
  quickCheck: 'ok';
}

const PRIVATE_FILE_MODE = 0o600;

/**
 * Settle the copy into a single self-contained file (a WAL-mode source can
 * yield a WAL-mode copy, which would otherwise grow -wal/-shm sidecars on
 * open), then run quick_check on it and read its page count.
 */
function settleAndQuickCheck(dbPath: string): { verdict: string; pages: number } {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const pages = Number((db.prepare('PRAGMA page_count').get() as Record<string, unknown>)['page_count']);
    if (rows.length !== 1) return { verdict: `rows=${rows.length}`, pages };
    return { verdict: String(Object.values(rows[0] ?? {})[0]), pages };
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
  try {
    source.prepare('VACUUM INTO ?').run(backupPath);
  } finally {
    source.close();
  }
  chmodSync(backupPath, PRIVATE_FILE_MODE);
  const { verdict, pages } = settleAndQuickCheck(backupPath);
  if (verdict !== 'ok') throw new Error(`SQLite backup quick_check failed: ${verdict}`);
  return { sourcePath, backupPath, pages, quickCheck: 'ok' };
}
