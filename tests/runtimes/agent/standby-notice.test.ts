import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { Database } from '../../../src/core/database.ts';
import {
  ensureStandbyNoticeSchema,
  stashStandbyNotice,
  consumeStandbyNotice,
  peekStandbyNotice,
  clearStandbyNotice,
} from '../../../src/runtimes/agent/standby-notice.ts';

const NOW = 1_781_000_000_000;
const paths: string[] = [];

function freshDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `whatsoup-standby-test-${randomBytes(4).toString('hex')}.db`);
  paths.push(path);
  const db = new Database(path);
  db.open();
  ensureStandbyNoticeSchema(db);
  return { db, path };
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = p + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  }
});

describe('standby-notice latch', () => {
  it('stashes and consumes a notice exactly once', () => {
    const { db } = freshDb();
    stashStandbyNotice(db, 'c1', 'Primary model hit a usage limit. Continuing on backup.', NOW);
    expect(consumeStandbyNotice(db, 'c1')).toBe('Primary model hit a usage limit. Continuing on backup.');
    // Second consume gets nothing — exactly-once.
    expect(consumeStandbyNotice(db, 'c1')).toBeNull();
    db.close();
  });

  it('consume on an empty conversation returns null', () => {
    const { db } = freshDb();
    expect(consumeStandbyNotice(db, 'absent')).toBeNull();
    db.close();
  });

  it('a newer stash supersedes an unconsumed one', () => {
    const { db } = freshDb();
    stashStandbyNotice(db, 'c1', 'first', NOW);
    stashStandbyNotice(db, 'c1', 'second', NOW + 5);
    expect(consumeStandbyNotice(db, 'c1')).toBe('second');
    db.close();
  });

  it('peek reads without consuming', () => {
    const { db } = freshDb();
    stashStandbyNotice(db, 'c1', 'pending', NOW);
    expect(peekStandbyNotice(db, 'c1')).toBe('pending');
    expect(peekStandbyNotice(db, 'c1')).toBe('pending'); // still there
    expect(consumeStandbyNotice(db, 'c1')).toBe('pending');
    expect(peekStandbyNotice(db, 'c1')).toBeNull();
    db.close();
  });

  it('clear drops a pending notice idempotently', () => {
    const { db } = freshDb();
    stashStandbyNotice(db, 'c1', 'pending', NOW);
    clearStandbyNotice(db, 'c1');
    expect(peekStandbyNotice(db, 'c1')).toBeNull();
    expect(() => clearStandbyNotice(db, 'c1')).not.toThrow();
    db.close();
  });

  it('survives a restart and flushes exactly once (crash-safety)', () => {
    const { db, path } = freshDb();
    stashStandbyNotice(db, 'c1', 'survive me', NOW);
    db.close(); // simulate process exit before the notice was consumed

    const db2 = new Database(path);
    db2.open();
    ensureStandbyNoticeSchema(db2);
    expect(consumeStandbyNotice(db2, 'c1')).toBe('survive me');
    expect(consumeStandbyNotice(db2, 'c1')).toBeNull();
    db2.close();
  });

  it('ensureStandbyNoticeSchema is idempotent', () => {
    const { db } = freshDb();
    expect(() => {
      ensureStandbyNoticeSchema(db);
      ensureStandbyNoticeSchema(db);
    }).not.toThrow();
    stashStandbyNotice(db, 'c1', 'x', NOW);
    expect(peekStandbyNotice(db, 'c1')).toBe('x');
    db.close();
  });
});
