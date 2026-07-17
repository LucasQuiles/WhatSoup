import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { withTransaction, getTransactionRunner } from '../../src/core/db-tx.ts';

// Covers the canonical BEGIN/COMMIT/ROLLBACK wrapper introduced in
// src/core/db-tx.ts. The two real-DB cases exercise the happy path and the
// callback-throw rollback path. The two fault-injection cases use a stub
// Database to simulate BEGIN and COMMIT statement failures (per A4 in the
// execution plan: node:sqlite Database instances are not safely reopenable
// after close(), so close/reopen cannot be used to simulate BEGIN failure).

function makeRealDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `whatsoup-db-tx-${randomBytes(4).toString('hex')}.db`);
  const db = new Database(path);
  db.open();
  return { db, path };
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = path + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
}

/**
 * Build a stub Database-shaped object whose `raw.prepare(sql)` returns a
 * statement whose `run()` behavior is controlled per SQL string. Any SQL not
 * in the control map returns a no-op `run()`.
 */
function stubDb(controls: Record<string, () => void>): Database {
  const prepare = (sql: string) => {
    const controlled = controls[sql];
    return {
      run: () => {
        if (controlled) controlled();
      },
    };
  };
  return { raw: { prepare } } as unknown as Database;
}

describe('withTransaction', () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    const made = makeRealDb();
    db = made.db;
    path = made.path;
  });

  afterEach(() => {
    db.close();
    cleanup(path);
  });

  it('commits the writes performed inside the callback and returns its value', () => {
    const result = withTransaction(db, () => {
      db.raw
        .prepare(
          "INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX1', 'text', 0, 1)",
        )
        .run();
      return 42;
    });
    expect(result).toBe(42);

    const row = db.raw
      .prepare('SELECT message_id FROM messages WHERE message_id=?')
      .get('TX1') as { message_id: string } | undefined;
    expect(row?.message_id).toBe('TX1');
  });

  it('rolls back and re-throws when the callback throws', () => {
    expect(() =>
      withTransaction(db, () => {
        db.raw
          .prepare(
            "INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX2', 'text', 0, 1)",
          )
          .run();
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const count = (
      db.raw.prepare('SELECT COUNT(*) as c FROM messages WHERE message_id=?').get('TX2') as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('does not run the callback or attempt rollback when BEGIN fails', () => {
    const callback = vi.fn();
    const rollbackSpy = vi.fn();
    const fakeDb = stubDb({
      BEGIN: () => {
        throw new Error('begin-failed');
      },
      ROLLBACK: rollbackSpy,
    });

    expect(() => withTransaction(fakeDb, callback)).toThrow('begin-failed');
    expect(callback).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('attempts rollback and re-throws the original error when COMMIT fails', () => {
    const rollbackSpy = vi.fn();
    const commitError = new Error('commit-disk-full');
    const fakeDb = stubDb({
      COMMIT: () => {
        throw commitError;
      },
      ROLLBACK: rollbackSpy,
    });

    let sawCallback = false;
    expect(() =>
      withTransaction(fakeDb, () => {
        sawCallback = true;
      }),
    ).toThrow('commit-disk-full');

    expect(sawCallback).toBe(true);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows rollback failures and re-throws the original callback error', () => {
    const rollbackSpy = vi.fn(() => {
      throw new Error('rollback-io-error');
    });
    const callbackError = new Error('callback-failed');
    const fakeDb = stubDb({ ROLLBACK: rollbackSpy });

    let thrown: unknown;
    try {
      withTransaction(fakeDb, () => {
        throw callbackError;
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(callbackError);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('caches and reuses the transaction runner per database instance', () => {
    const { db: db1, path: path1 } = makeRealDb();
    const { db: db2, path: path2 } = makeRealDb();
    try {
      const runner1a = getTransactionRunner(db1);
      const runner1b = getTransactionRunner(db1);
      const runner2 = getTransactionRunner(db2);

      expect(runner1a).toBe(runner1b);
      expect(runner1a).not.toBe(runner2);

      runner1a(() => {
        db1.raw.prepare("INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX-CACHE1', 'text', 0, 1)").run();
        return undefined;
      });

      runner2(() => {
        db2.raw.prepare("INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('y', 'y', 'y', 'TX-CACHE2', 'text', 0, 1)").run();
        return undefined;
      });

      expect((db1.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c).toBe(1);
      expect((db2.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c).toBe(1);
    } finally {
      db1.close();
      db2.close();
      cleanup(path1);
      cleanup(path2);
    }
  });

  it('handles nested transaction attempts (does not nest, just runs sequentially)', () => {
    const result1 = withTransaction(db, () => {
      db.raw.prepare("INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX-NESTED1', 'text', 0, 1)").run();
      return 'outer';
    });
    const result2 = withTransaction(db, () => {
      db.raw.prepare("INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX-NESTED2', 'text', 0, 1)").run();
      return 'inner';
    });

    expect(result1).toBe('outer');
    expect(result2).toBe('inner');
    const count = (db.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('preserves callback return value of various types', () => {
    const objResult = withTransaction(db, () => ({ x: 1 }));
    expect(objResult).toEqual({ x: 1 });

    const arrayResult = withTransaction(db, () => [1, 2, 3]);
    expect(arrayResult).toEqual([1, 2, 3]);

    const nullResult = withTransaction(db, () => null);
    expect(nullResult).toBeNull();

    const undefinedResult = withTransaction(db, () => undefined);
    expect(undefinedResult).toBeUndefined();
  });

  it('converts COMMIT error to include rollback attempt details', () => {
    const commitErr = new Error('COMMIT failed: disk full');
    const rollbackSpy = vi.fn();
    const fakeDb = stubDb({
      COMMIT: () => { throw commitErr; },
      ROLLBACK: rollbackSpy,
    });

    expect(() => withTransaction(fakeDb, () => 'executed')).toThrow('COMMIT failed: disk full');
    expect(rollbackSpy).toHaveBeenCalled();
  });
});
