/**
 * QR-034: access_list orphan migration must run from ALL resolution paths.
 *
 * An access_list row is "orphaned" when a sender is blocked/approved before
 * their LID→phone mapping is known, so the row is keyed under the raw LID
 * number. shouldRespond keys the blocklist on the RESOLVED phone, so the orphan
 * must follow the identity to the phone key once the mapping resolves — else a
 * blocked sender silently regains access (blocklist evasion).
 *
 * Before QR-034 the migration ran ONLY via upsertLidMapping (L2/L3/L4); L1
 * startup hydration and L1.5 on-miss disk fallback resolved the mapping WITHOUT
 * migrating. These tests lock in that the now-shared migrateAccessListOrphan()
 * runs from L1 and L1.5 too, while preserving the original L2 behavior.
 *
 * REPO-HYGIENE: reserved-range fixtures only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../src/core/database.ts';
import {
  upsertLidMapping,
  hydrateLidMappings,
  setLidAuthDir,
  resolveLid,
} from '../../src/core/lid-resolver.ts';

const LID = '11111110';
const PHONE_DIGITS = '15550001';
const PHONE_JID = `${PHONE_DIGITS}@s.whatsapp.net`;

function freshDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function seedOrphan(db: Database, subjectId: string, status: string): void {
  db.raw
    .prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, ?)")
    .run(subjectId, status);
}

function statusOf(db: Database, subjectId: string): string | undefined {
  const row = db.raw
    .prepare("SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?")
    .get(subjectId) as { status: string } | undefined;
  return row?.status;
}

function writeReverseFile(dir: string, lid: string, phoneDigits: string): void {
  writeFileSync(join(dir, `lid-mapping-${lid}_reverse.json`), JSON.stringify(phoneDigits));
}

describe('QR-034 — access_list orphan migration runs from all resolution paths', () => {
  let db: Database;
  let authDir: string;

  beforeEach(() => {
    db = freshDb();
    authDir = mkdtempSync(join(tmpdir(), 'qr034-'));
  });

  afterEach(() => {
    db.raw.close();
    setLidAuthDir('');
    rmSync(authDir, { recursive: true, force: true });
  });

  it('L1 hydration migrates a blocked orphan from the LID-number key to the phone key', () => {
    seedOrphan(db, LID, 'blocked'); // blocked under the raw LID number
    writeReverseFile(authDir, LID, PHONE_DIGITS);

    hydrateLidMappings(db, authDir);

    expect(statusOf(db, PHONE_DIGITS)).toBe('blocked'); // block followed the identity
    expect(statusOf(db, LID)).toBeUndefined(); // no longer stranded under the LID key
  });

  it('L1.5 on-miss disk fallback migrates the orphan when resolveLid resolves the mapping', () => {
    seedOrphan(db, LID, 'blocked');
    setLidAuthDir(authDir);
    writeReverseFile(authDir, LID, PHONE_DIGITS);

    // DB has no lid_mapping yet → resolveLid falls through to lookupLidFromDisk (L1.5).
    expect(resolveLid(db, LID)).toBe(PHONE_DIGITS);

    expect(statusOf(db, PHONE_DIGITS)).toBe('blocked');
    expect(statusOf(db, LID)).toBeUndefined();
  });

  it('clobber-drop: when a phone-keyed row already exists, the orphan is dropped and the explicit decision wins', () => {
    seedOrphan(db, LID, 'blocked'); // stale orphan
    seedOrphan(db, PHONE_DIGITS, 'allowed'); // explicit phone-keyed decision

    upsertLidMapping(db, LID, PHONE_JID, 'L2');

    expect(statusOf(db, PHONE_DIGITS)).toBe('allowed'); // explicit decision preserved
    expect(statusOf(db, LID)).toBeUndefined(); // redundant orphan dropped
  });

  it('upsert regression-lock: L2 still migrates the orphan (original behavior preserved)', () => {
    seedOrphan(db, LID, 'blocked');

    upsertLidMapping(db, LID, PHONE_JID, 'L2');

    expect(statusOf(db, PHONE_DIGITS)).toBe('blocked');
    expect(statusOf(db, LID)).toBeUndefined();
  });

  it('no-op: with no orphan present, no spurious access_list row is created', () => {
    upsertLidMapping(db, LID, PHONE_JID, 'L2');

    expect(statusOf(db, PHONE_DIGITS)).toBeUndefined();
    expect(statusOf(db, LID)).toBeUndefined();
    const count = db.raw.prepare('SELECT COUNT(*) AS c FROM access_list').get() as { c: number };
    expect(count.c).toBe(0);
  });
});
