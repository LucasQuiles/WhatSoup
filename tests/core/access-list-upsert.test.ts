import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { upsertAccess, lookupAccess, insertPending } from '../../src/core/access-list.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('upsertAccess (allowed)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a new allowed row when subject does not exist', () => {
    const result = upsertAccess(db, 'phone', '15551234567', 'allowed');
    expect(result).toEqual({ action: 'inserted' });
    const entry = lookupAccess(db, 'phone', '15551234567');
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('allowed');
    expect(entry!.decidedAt).not.toBeNull();
  });

  it('updates existing pending row to allowed', () => {
    insertPending(db, 'phone', '15551234567', 'Alice');
    const before = lookupAccess(db, 'phone', '15551234567');
    expect(before!.status).toBe('pending');

    const result = upsertAccess(db, 'phone', '15551234567', 'allowed');
    expect(result).toEqual({ action: 'updated' });
    const after = lookupAccess(db, 'phone', '15551234567');
    expect(after!.status).toBe('allowed');
    expect(after!.decidedAt).not.toBeNull();
  });

  it('works for group subject type', () => {
    const result = upsertAccess(db, 'group', '120363123456789_at_g.us', 'allowed');
    expect(result).toEqual({ action: 'inserted' });
    const entry = lookupAccess(db, 'group', '120363123456789_at_g.us');
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe('allowed');
  });

  it('is idempotent for already-allowed rows', () => {
    upsertAccess(db, 'phone', '15551234567', 'allowed');
    const result = upsertAccess(db, 'phone', '15551234567', 'allowed');
    expect(result).toEqual({ action: 'updated' });
    const entry = lookupAccess(db, 'phone', '15551234567');
    expect(entry!.status).toBe('allowed');
  });
});
