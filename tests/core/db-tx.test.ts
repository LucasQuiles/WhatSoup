import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';

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

  // --- #2291 M8: composition. SQLite has no nested BEGIN, so a withTransaction
  // reached from inside another open transaction must use a SAVEPOINT. The
  // outer transaction stays the sole authority on COMMIT/ROLLBACK.

  function insert(id: string): void {
    db.raw
      .prepare(
        "INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES ('x', 'x', 'x', ?, 'text', 0, 1)",
      )
      .run(id);
  }

  function count(id: string): number {
    return (
      db.raw.prepare('SELECT COUNT(*) as c FROM messages WHERE message_id=?').get(id) as { c: number }
    ).c;
  }

  it('commits both levels when a nested withTransaction succeeds', () => {
    const result = withTransaction(db, () => {
      insert('TXN-OUTER');
      const inner = withTransaction(db, () => {
        insert('TXN-INNER');
        return 'inner-value';
      });
      expect(inner).toBe('inner-value');
      return 'outer-value';
    });

    expect(result).toBe('outer-value');
    expect(count('TXN-OUTER')).toBe(1);
    expect(count('TXN-INNER')).toBe(1);
  });

  it('unwinds only the inner level when the nested callback throws, leaving the outer transaction usable', () => {
    withTransaction(db, () => {
      insert('TXN-KEEP');

      expect(() =>
        withTransaction(db, () => {
          insert('TXN-DROP');
          throw new Error('inner-boom');
        }),
      ).toThrow('inner-boom');

      // The outer transaction must still be open and writable — this is the
      // exact behaviour a nested BEGIN destroyed (its catch ran ROLLBACK,
      // discarding the outer work too).
      expect(db.raw.isTransaction).toBe(true);
      insert('TXN-AFTER');
    });

    expect(count('TXN-KEEP')).toBe(1);
    expect(count('TXN-AFTER')).toBe(1);
    expect(count('TXN-DROP')).toBe(0);
  });

  it('composes when the OUTER transaction was opened by a raw BEGIN rather than by withTransaction', () => {
    // The scenario #2291 M8 actually describes, and the one an internal depth
    // counter cannot fix: ~23 callsites in src/core open transactions with a
    // bare db.exec('BEGIN'). A counter would read depth 0 here and issue a
    // second BEGIN, which throws. Reading isTransaction sees the real state.
    db.raw.exec('BEGIN');
    try {
      insert('RAW-OUTER');

      const value = withTransaction(db, () => {
        insert('RAW-INNER');
        return 7;
      });
      expect(value).toBe(7);

      expect(() =>
        withTransaction(db, () => {
          insert('RAW-DROP');
          throw new Error('raw-nested-boom');
        }),
      ).toThrow('raw-nested-boom');

      expect(db.raw.isTransaction).toBe(true);
      db.raw.exec('COMMIT');
    } catch (err) {
      if (db.raw.isTransaction) db.raw.exec('ROLLBACK');
      throw err;
    }

    expect(count('RAW-OUTER')).toBe(1);
    expect(count('RAW-INNER')).toBe(1);
    expect(count('RAW-DROP')).toBe(0);
  });

  it('gives each nesting level its own savepoint so a depth-2 failure unwinds one level only', () => {
    withTransaction(db, () => {
      insert('D1');
      withTransaction(db, () => {
        insert('D2');
        expect(() =>
          withTransaction(db, () => {
            insert('D3');
            throw new Error('depth3-boom');
          }),
        ).toThrow('depth3-boom');
        // Level 2 survives its child's failure.
        insert('D2-AFTER');
      });
    });

    expect(count('D1')).toBe(1);
    expect(count('D2')).toBe(1);
    expect(count('D2-AFTER')).toBe(1);
    expect(count('D3')).toBe(0);
  });

  it('discards committed inner work when the OUTER transaction rolls back', () => {
    expect(() =>
      withTransaction(db, () => {
        withTransaction(db, () => {
          insert('NEST-INNER-OK');
        });
        throw new Error('outer-boom');
      }),
    ).toThrow('outer-boom');

    // A released savepoint is not durable on its own — the outer ROLLBACK is
    // still the authority. Without this, "inner succeeded" could be mistaken
    // for "inner persisted".
    expect(count('NEST-INNER-OK')).toBe(0);
    expect(db.raw.isTransaction).toBe(false);
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
