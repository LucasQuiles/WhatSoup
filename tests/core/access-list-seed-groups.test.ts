import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import {
  lookupAccess,
  updateAccess,
  insertPending,
  seedAutoRespondGroups,
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

// Synthetic group JIDs (the repo's publication guard forbids real-shaped
// 120363… JIDs in committed text; the 1111111… prefix is the reserved test form).
const G1 = '111111100000001@g.us';
const G2 = '111111100000002@g.us';

describe('seedAutoRespondGroups', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM access_list').run();
  });

  it('inserts declared groups as allowed and reports the count', () => {
    const n = seedAutoRespondGroups(db, [G1, G2]);
    expect(n).toBe(2);
    expect(lookupAccess(db, 'group', G1)?.status).toBe('allowed');
    expect(lookupAccess(db, 'group', G2)?.status).toBe('allowed');
  });

  it('is idempotent — a second seed inserts nothing', () => {
    expect(seedAutoRespondGroups(db, [G1])).toBe(1);
    expect(seedAutoRespondGroups(db, [G1])).toBe(0);
    expect(lookupAccess(db, 'group', G1)?.status).toBe('allowed');
  });

  it('never overrides an explicit block decision', () => {
    seedAutoRespondGroups(db, [G1]);
    updateAccess(db, 'group', G1, 'blocked');
    const n = seedAutoRespondGroups(db, [G1]);
    expect(n).toBe(0);
    expect(lookupAccess(db, 'group', G1)?.status).toBe('blocked');
  });

  it('leaves a pending review untouched', () => {
    insertPending(db, 'group', G1, 'Pending Group');
    const n = seedAutoRespondGroups(db, [G1]);
    expect(n).toBe(0);
    expect(lookupAccess(db, 'group', G1)?.status).toBe('pending');
  });

  it('trims, skips blanks, and de-duplicates the input list', () => {
    const n = seedAutoRespondGroups(db, [` ${G1} `, G1, '', '   ', G2]);
    expect(n).toBe(2);
    expect(lookupAccess(db, 'group', G1)?.status).toBe('allowed');
    expect(lookupAccess(db, 'group', G2)?.status).toBe('allowed');
  });

  it('does not touch phone subjects sharing the same id string', () => {
    insertPending(db, 'phone', G1, 'phone-shaped');
    seedAutoRespondGroups(db, [G1]);
    expect(lookupAccess(db, 'phone', G1)?.status).toBe('pending');
    expect(lookupAccess(db, 'group', G1)?.status).toBe('allowed');
  });
});
