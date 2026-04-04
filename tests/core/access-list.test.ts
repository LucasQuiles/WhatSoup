import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import {
  lookupAccess,
  insertPending,
  updateAccess,
  getPendingCount,
  extractLocal,
} from '../../src/core/access-list.ts';

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-test-${randomBytes(4).toString('hex')}.db`);
}

const dbPath = tempDbPath();
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('access-list', () => {
  beforeEach(() => {
    // Remove all rows
    db.raw.prepare('DELETE FROM access_list').run();
  });

  // @check CHK-074
  // @traces REQ-013.AC-01
  it('composite key schema: phone and group subjects are distinct rows', () => {
    insertPending(db, 'phone', '15550001111', 'TestUser');
    insertPending(db, 'group', '15550001111', 'GroupWithSameId');
    const phoneEntry = lookupAccess(db, 'phone', '15550001111');
    const groupEntry = lookupAccess(db, 'group', '15550001111');
    expect(phoneEntry).not.toBeNull();
    expect(groupEntry).not.toBeNull();
    expect(phoneEntry!.subjectType).toBe('phone');
    expect(groupEntry!.subjectType).toBe('group');
    // Both exist as separate rows
    expect(phoneEntry!.subjectId).toBe('15550001111');
    expect(groupEntry!.subjectId).toBe('15550001111');
  });

  // --- positive tests ---

  // @check CHK-075
  // @traces REQ-013.AC-02
  it('lookupAccess returns the entry for a known phone', () => {
    insertPending(db, 'phone', '15550001111', 'TestUser');
    const entry = lookupAccess(db, 'phone', '15550001111');
    expect(entry).not.toBeNull();
    expect(entry!.subjectType).toBe('phone');
    expect(entry!.subjectId).toBe('15550001111');
    expect(entry!.status).toBe('pending');
    expect(entry!.displayName).toBe('TestUser');
  });

  // @check CHK-076
  // @traces REQ-013.AC-03
  it('lookupAccess returns the entry for a known group JID', () => {
    const groupJid = '120363123456789@g.us';
    insertPending(db, 'group', groupJid, 'My Group');
    const entry = lookupAccess(db, 'group', groupJid);
    expect(entry).not.toBeNull();
    expect(entry!.subjectType).toBe('group');
    expect(entry!.subjectId).toBe(groupJid);
    expect(entry!.status).toBe('pending');
  });

  // @check CHK-077
  // @traces REQ-013.AC-04
  it('unknown group returns null (silent ignore)', () => {
    const entry = lookupAccess(db, 'group', '999363999999999@g.us');
    expect(entry).toBeNull();
  });

  it('insertPending creates a pending entry with requested_at set', () => {
    insertPending(db, 'phone', '15550002222', 'Bob');
    const entry = lookupAccess(db, 'phone', '15550002222');
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('pending');
    expect(entry!.requestedAt).not.toBeNull();
    expect(entry!.decidedAt).toBeNull();
  });

  it('updateAccess changes status and sets decided_at', () => {
    insertPending(db, 'phone', '15550003333', 'Carol');
    updateAccess(db, 'phone', '15550003333', 'allowed');
    const entry = lookupAccess(db, 'phone', '15550003333');
    expect(entry!.status).toBe('allowed');
    expect(entry!.decidedAt).not.toBeNull();
  });

  it('updateAccess works for group subjects', () => {
    const groupJid = '120363111111111@g.us';
    insertPending(db, 'group', groupJid, 'TestGroup');
    updateAccess(db, 'group', groupJid, 'allowed');
    const entry = lookupAccess(db, 'group', groupJid);
    expect(entry!.status).toBe('allowed');
    expect(entry!.decidedAt).not.toBeNull();
  });

  // --- negative / edge-case tests ---

  it('lookupAccess returns null for an unknown phone', () => {
    const entry = lookupAccess(db, 'phone', '99999999999');
    expect(entry).toBeNull();
  });

  it('getPendingCount returns accurate count', () => {
    expect(getPendingCount(db)).toBe(0);

    insertPending(db, 'phone', '15550004444', 'Dave');
    expect(getPendingCount(db)).toBe(1);

    insertPending(db, 'phone', '15550005555', 'Eve');
    expect(getPendingCount(db)).toBe(2);

    updateAccess(db, 'phone', '15550004444', 'blocked');
    expect(getPendingCount(db)).toBe(1);
  });
});

describe('extractLocal', () => {
  it('strips @s.whatsapp.net suffix', () => {
    expect(extractLocal('15184194479@s.whatsapp.net')).toBe('15184194479');
  });

  it('strips @lid suffix', () => {
    expect(extractLocal('81536414179557@lid')).toBe('81536414179557');
  });

  it('returns the string unchanged when there is no @ symbol', () => {
    expect(extractLocal('15184194479')).toBe('15184194479');
  });
});
