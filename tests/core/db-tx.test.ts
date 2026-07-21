import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { withImmediateTransaction, withTransaction } from '../../src/core/db-tx.ts';

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
});

describe('withImmediateTransaction', () => {
  it('prepares BEGIN IMMEDIATE and commits exactly once', () => {
    const calls: string[] = [];
    const fakeDb = stubDb({
      'BEGIN IMMEDIATE': () => calls.push('begin'),
      COMMIT: () => calls.push('commit'),
      ROLLBACK: () => calls.push('rollback'),
    });

    const result = withImmediateTransaction(fakeDb, () => {
      calls.push('callback');
      return 17;
    });

    expect(result).toBe(17);
    expect(calls).toEqual(['begin', 'callback', 'commit']);
  });

  it('preserves the callback error when rollback also fails', () => {
    const callbackError = new Error('immediate-callback-failed');
    const rollbackSpy = vi.fn(() => {
      throw new Error('immediate-rollback-failed');
    });
    const fakeDb = stubDb({ ROLLBACK: rollbackSpy });

    let thrown: unknown;
    try {
      withImmediateTransaction(fakeDb, () => {
        throw callbackError;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(callbackError);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('does not run the callback or rollback when BEGIN IMMEDIATE fails', () => {
    const callback = vi.fn();
    const rollbackSpy = vi.fn();
    const beginError = new Error('immediate-begin-failed');
    const fakeDb = stubDb({
      'BEGIN IMMEDIATE': () => {
        throw beginError;
      },
      ROLLBACK: rollbackSpy,
    });

    expect(() => withImmediateTransaction(fakeDb, callback)).toThrow(beginError);
    expect(callback).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
  });

  it('re-throws an ambiguous COMMIT failure after one best-effort rollback', () => {
    const commitError = new Error('immediate-commit-ambiguous');
    const rollbackSpy = vi.fn();
    const fakeDb = stubDb({
      COMMIT: () => {
        throw commitError;
      },
      ROLLBACK: rollbackSpy,
    });

    expect(() => withImmediateTransaction(fakeDb, () => 'done')).toThrow(commitError);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it('fails nested transaction misuse closed and rolls back the outer write', () => {
    const made = makeRealDb();
    try {
      expect(() =>
        withImmediateTransaction(made.db, () => {
          made.db.raw.prepare(
            "INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', 'TX-NESTED', 'text', 0, 1)",
          ).run();
          withTransaction(made.db, () => undefined);
        }),
      ).toThrow(/transaction/i);
      expect(
        made.db.raw.prepare('SELECT COUNT(*) AS c FROM messages WHERE message_id = ?').get('TX-NESTED'),
      ).toEqual({ c: 0 });
    } finally {
      made.db.close();
      cleanup(made.path);
    }
  });
});
