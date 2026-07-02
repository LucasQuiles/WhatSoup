/**
 * Branch-coverage draft for src/core/lid-resolver.ts (RR-013 / strategy W4).
 *
 * The existing tests/core/lid-resolver-write-seam.test.ts already cover the
 * writeLidMapping seam (all three modes), importLidMappings batch path,
 * retention cleanup, and 2-instance convergence. This file deliberately does
 * NOT touch those; it targets the ~52 uncovered branch arms in the OTHER
 * surfaces:
 *
 *   - comparator helpers: timestampToEpochMs / compareLidUpdatedAt /
 *     isPreferredLidObservation (Number.isFinite false arm, null/NaN arms,
 *     localeCompare tie-breaker, empty-incoming early return)
 *   - mineMessageKey (L3): both null-guard arms, both orientation branches,
 *     neither-orientation fallthrough, already-mapped short-circuit, new pair
 *   - mineGroupParticipants (L4): Case 1 (id=PN), Case 2 (id=LID),
 *     no-match continue, already-known continue, discovered++ path,
 *     catch-on-error path
 *   - upsertLidMapping (L2): orphan access_list migration (rename + delete
 *     branches), phone===lid guard
 *   - hydrateLidMappings (L1): non-matching filename, malformed JSON,
 *     non-string payload, empty-string payload, missing-dir return-0
 *   - reconcileLidMappings (L6): unresolved-LIDs branch, LID-keyed chat
 *     migration (existing-target skip vs migrate)
 *   - setLidAuthDir / lookupLidFromDisk / resolveLid (L1.5): disabled-dir,
 *     missing file, malformed JSON, non-string, empty-string, success
 *   - resolveLidToJid, getAllLidMappings, canonicalizeChatJid (group/personal/
 *     lid-unmapped/lid-mapped/no-db/unknown-domain)
 *
 * REPO-HYGIENE: all phone/LID fixtures use reserved ranges only.
 *   - LID numbers:        1111111N  (bare digits, @lid form 1111111N@lid)
 *   - phone JIDs:         1555NNNN@s.whatsapp.net
 *   - group JID:          120363555555550001@g.us
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from '../../src/core/database.ts';
import {
  compareLidUpdatedAt,
  isPreferredLidObservation,
  mineMessageKey,
  mineGroupParticipants,
  upsertLidMapping,
  hydrateLidMappings,
  reconcileLidMappings,
  setLidAuthDir,
  resolveLid,
  resolveLidToJid,
  getAllLidMappings,
  canonicalizeChatJid,
} from '../../src/core/lid-resolver.ts';

// ── Reserved-range fixtures ──────────────────────────────────────────────────
const LID_1 = '11111110';
const LID_2 = '11111111';
const PHONE_1 = '15550001@s.whatsapp.net';
const PHONE_2 = '15550002@s.whatsapp.net';
const PHONE_3 = '15550003@s.whatsapp.net';
const GROUP_JID = '120363555555550001@g.us';

function freshDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function setPhone(db: Database, lid: string, phoneJid: string, updatedAt = "datetime('now')"): void {
  if (updatedAt.startsWith('datetime')) {
    db.raw.prepare(`INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ${updatedAt})`).run(lid, phoneJid);
  } else {
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)').run(lid, phoneJid, updatedAt);
  }
}

// ── compareLidUpdatedAt — non-parseable arms ─────────────────────────────────

describe('compareLidUpdatedAt — fallback arms when timestamps are unparseable', () => {
  it('treats a parseable left vs garbage right as left-preferred (+1)', () => {
    expect(compareLidUpdatedAt('2026-05-01T00:00:00Z', 'not-a-date')).toBe(1);
  });

  it('treats garbage left vs parseable right as right-preferred (-1)', () => {
    expect(compareLidUpdatedAt('not-a-date', '2026-05-01T00:00:00Z')).toBe(-1);
  });

  it('falls back to lexical localeCompare when BOTH are unparseable', () => {
    // Neither parses to a finite epoch → Number.isFinite false on both →
    // localeCompare branch. 'aaa' < 'bbb' so result is negative.
    expect(compareLidUpdatedAt('aaa', 'bbb')).toBeLessThan(0);
    expect(compareLidUpdatedAt('bbb', 'aaa')).toBeGreaterThan(0);
    expect(compareLidUpdatedAt('same', 'same')).toBe(0);
  });

  it('parses bare SQLite "YYYY-MM-DD HH:MM:SS" form by appending T...Z', () => {
    // Exercises the regex-true branch of timestampToEpochMs for both args.
    expect(compareLidUpdatedAt('2026-05-01 00:00:01', '2026-05-01 00:00:00')).toBe(1);
  });
});

// ── isPreferredLidObservation — early-return + tie-break arms ─────────────────

describe('isPreferredLidObservation — branch arms', () => {
  it('returns false immediately when incomingUpdatedAt is undefined', () => {
    expect(isPreferredLidObservation(PHONE_1, undefined, PHONE_2, '2026-05-01T00:00:00Z')).toBe(false);
  });

  it('returns false immediately when incomingUpdatedAt is empty string', () => {
    expect(isPreferredLidObservation(PHONE_1, '', PHONE_2, '2026-05-01T00:00:00Z')).toBe(false);
  });

  it('prefers the strictly fresher observation regardless of phone ordering', () => {
    expect(
      isPreferredLidObservation(PHONE_2, '2026-06-01T00:00:00Z', PHONE_1, '2026-01-01T00:00:00Z'),
    ).toBe(true);
  });

  it('on equal timestamps, prefers the alphabetically-EARLIER incoming phone_jid', () => {
    // byFreshness === 0 → localeCompare tie-break arm.
    expect(
      isPreferredLidObservation(PHONE_1, '2026-05-01T00:00:00Z', PHONE_2, '2026-05-01T00:00:00Z'),
    ).toBe(true); // PHONE_1 < PHONE_2
    expect(
      isPreferredLidObservation(PHONE_2, '2026-05-01T00:00:00Z', PHONE_1, '2026-05-01T00:00:00Z'),
    ).toBe(false); // PHONE_2 > PHONE_1
  });
});

// ── mineMessageKey (L3) ──────────────────────────────────────────────────────

describe('mineMessageKey — guard, orientation, and dedup branches', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('returns null when participant is missing (first short-circuit arm)', () => {
    expect(mineMessageKey(db, null, `${PHONE_1}`)).toBeNull();
  });

  it('returns null when participantAlt is missing (second short-circuit arm)', () => {
    expect(mineMessageKey(db, `${LID_1}@lid`, undefined)).toBeNull();
  });

  it('extracts pair when participant is LID and alt is PN', () => {
    const out = mineMessageKey(db, `${LID_1}@lid`, PHONE_1);
    expect(out).toEqual({ lid: LID_1, phoneJid: PHONE_1 });
  });

  it('extracts pair when participant is PN and alt is LID (reversed orientation)', () => {
    const out = mineMessageKey(db, PHONE_1, `${LID_1}@lid`);
    expect(out).toEqual({ lid: LID_1, phoneJid: PHONE_1 });
  });

  it('returns null when neither orientation matches (two PN JIDs)', () => {
    expect(mineMessageKey(db, PHONE_1, PHONE_2)).toBeNull();
  });

  it('normalizes a colon-device LID before returning', () => {
    const out = mineMessageKey(db, `${LID_1}:42@lid`, PHONE_1);
    expect(out).toEqual({ lid: LID_1, phoneJid: PHONE_1 });
  });

  it('returns null (already-mapped short-circuit) when the pair is already known', () => {
    setPhone(db, LID_1, PHONE_1);
    expect(mineMessageKey(db, `${LID_1}@lid`, PHONE_1)).toBeNull();
  });
});

// ── mineGroupParticipants (L4) ───────────────────────────────────────────────

describe('mineGroupParticipants — case branches, dedup, count, error path', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('Case 1: id is PN, lid field carries the LID → discovers and upserts', () => {
    const n = mineGroupParticipants(db, [{ id: PHONE_1, lid: `${LID_1}@lid` }]);
    expect(n).toBe(1);
    expect(resolveLid(db, LID_1)).toBe('15550001');
  });

  it('Case 2: id is LID, phoneNumber field carries the PN → discovers and upserts', () => {
    const n = mineGroupParticipants(db, [{ id: `${LID_2}@lid`, phoneNumber: PHONE_2 }]);
    expect(n).toBe(1);
    expect(resolveLid(db, LID_2)).toBe('15550002');
  });

  it('skips participants that match neither case (no lid/phoneNumber fields)', () => {
    const n = mineGroupParticipants(db, [{ id: PHONE_1 }, { id: `${LID_1}@lid` }]);
    expect(n).toBe(0);
  });

  it('skips already-known mappings (existing === bareNumber(pnJid) continue arm)', () => {
    setPhone(db, LID_1, PHONE_1);
    const n = mineGroupParticipants(db, [{ id: PHONE_1, lid: `${LID_1}@lid` }]);
    expect(n).toBe(0);
  });

  it('counts multiple distinct discoveries', () => {
    const n = mineGroupParticipants(db, [
      { id: PHONE_1, lid: `${LID_1}@lid` },
      { id: `${LID_2}@lid`, phoneNumber: PHONE_2 },
    ]);
    expect(n).toBe(2);
  });

  it('catch arm: a participant whose upsert throws is logged and skipped, not fatal', () => {
    // resolveLid (outside the try block) must succeed → use the real open db.
    // We spy on db.raw.exec to throw only when called with 'BEGIN', so that
    // upsertLidMapping's first statement ('BEGIN') triggers the catch arm while
    // resolveLid's SELECT continues to work via the prepared-statement path.
    const execSpy = vi.spyOn(db.raw, 'exec').mockImplementationOnce((sql: string) => {
      if (sql === 'BEGIN') throw new Error('injected: tx blocked');
      return (db.raw.exec as unknown as (sql: string) => void)(sql);
    });
    try {
      expect(() => mineGroupParticipants(db, [{ id: PHONE_1, lid: `${LID_1}@lid` }])).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
  });
});

// ── upsertLidMapping (L2) — orphan access_list migration ─────────────────────

describe('upsertLidMapping — orphaned access_list migration branches', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  function accessStatus(subjectId: string): string | undefined {
    return (db.raw
      .prepare("SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?")
      .get(subjectId) as { status: string } | undefined)?.status;
  }

  it('renames an orphaned LID-keyed access_list row to the real phone (no existing target)', () => {
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')",
    ).run(LID_1);

    upsertLidMapping(db, LID_1, PHONE_1, 'L2');

    expect(accessStatus(LID_1)).toBeUndefined();      // orphan key gone
    expect(accessStatus('15550001')).toBe('allowed'); // migrated to phone
  });

  it('deletes the orphan row when a phone-keyed entry already exists (no clobber)', () => {
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')",
    ).run(LID_1);
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')",
    ).run('15550001');

    upsertLidMapping(db, LID_1, PHONE_1, 'L2');

    expect(accessStatus(LID_1)).toBeUndefined();       // orphan deleted
    expect(accessStatus('15550001')).toBe('blocked');  // pre-existing preserved
  });

  // QR-106: deny-wins. A LID-keyed BLOCK must never be silently erased by a
  // LID→phone merge just because a non-blocked phone-keyed row exists — that is
  // blocklist evasion (access-policy keys the block on the resolved phone). The
  // surviving phone row must inherit the block.
  it('preserves a blocked orphan over an allowed phone row (deny-wins, no blocklist evasion)', () => {
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')",
    ).run(LID_1);
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')",
    ).run('15550001');

    upsertLidMapping(db, LID_1, PHONE_1, 'L2');

    expect(accessStatus(LID_1)).toBeUndefined();       // orphan deleted
    expect(accessStatus('15550001')).toBe('blocked');  // block followed the identity
  });

  it('deny-wins also elevates a blocked orphan over a pending phone row', () => {
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')",
    ).run(LID_1);
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'pending')",
    ).run('15550001');

    upsertLidMapping(db, LID_1, PHONE_1, 'L2');

    expect(accessStatus('15550001')).toBe('blocked');
  });

  it('does not re-block: allowed orphan over an allowed phone row stays allowed', () => {
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')",
    ).run(LID_1);
    db.raw.prepare(
      "INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')",
    ).run('15550001');

    upsertLidMapping(db, LID_1, PHONE_1, 'L2');

    expect(accessStatus('15550001')).toBe('allowed');  // no spurious escalation
  });

  it('no orphan migration when phone === lid (guard arm)', () => {
    // phone derived from JID equals the lid string → the `phone !== lid` guard
    // is false, so the migration block is skipped entirely.
    upsertLidMapping(db, LID_1, `${LID_1}@s.whatsapp.net`, 'L2');
    expect(resolveLid(db, LID_1)).toBe(LID_1);
  });

  it('no orphan row present → migration lookup returns undefined, no-op branch', () => {
    upsertLidMapping(db, LID_1, PHONE_1, 'L2');
    expect(resolveLid(db, LID_1)).toBe('15550001');
  });
});

// ── hydrateLidMappings (L1) ──────────────────────────────────────────────────

describe('hydrateLidMappings — file filtering and payload validation branches', () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    db = freshDb();
    dir = mkdtempSync(join(tmpdir(), 'ws-lid-hydrate-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 when the auth dir does not exist (readdir catch arm)', () => {
    expect(hydrateLidMappings(db, join(dir, 'does-not-exist'))).toBe(0);
  });

  it('ignores non-matching filenames, malformed JSON, non-string and empty payloads; counts only valid', () => {
    writeFileSync(join(dir, 'unrelated.json'), '"x"');                         // name no-match → continue
    writeFileSync(join(dir, `lid-mapping-${LID_1}_reverse.json`), '{bad');     // malformed JSON → catch
    writeFileSync(join(dir, `lid-mapping-${LID_2}_reverse.json`), '12345');    // non-string payload → skip
    writeFileSync(join(dir, 'lid-mapping-11111112_reverse.json'), '""');       // empty string → skip
    writeFileSync(join(dir, 'lid-mapping-11111113_reverse.json'), '"15550009"'); // valid → count

    const count = hydrateLidMappings(db, dir);
    expect(count).toBe(1);
    expect(resolveLid(db, '11111113')).toBe('15550009');
  });

  it('skip-if-exists: does not recount or overwrite an already-present LID', () => {
    setPhone(db, '11111113', PHONE_1);
    writeFileSync(join(dir, 'lid-mapping-11111113_reverse.json'), '"15550009"');
    const count = hydrateLidMappings(db, dir);
    expect(count).toBe(0);                       // existing row preserved
    expect(resolveLid(db, '11111113')).toBe('15550001');
  });
});

// ── reconcileLidMappings (L6) ────────────────────────────────────────────────

describe('reconcileLidMappings — unresolved LIDs and chat-key migration branches', () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    db = freshDb();
    dir = mkdtempSync(join(tmpdir(), 'ws-lid-recon-'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unresolved LIDs found in the messages table (lids.length > 0 warn arm)', () => {
    db.raw.prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, timestamp)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(`${LID_1}@lid`, `${LID_1}@lid`, `${LID_1}@lid`, 'm1');

    const out = reconcileLidMappings(db, dir);
    expect(out.unresolvedLids).toContain(LID_1);
  });

  it('migrates a LID-keyed chat to its phone key once a mapping exists', () => {
    setPhone(db, LID_1, PHONE_1);
    db.raw.prepare(
      'INSERT INTO chats (jid, conversation_key) VALUES (?, ?)',
    ).run(`${LID_1}@lid`, `${LID_1}@lid`);

    reconcileLidMappings(db, dir);

    const migrated = db.raw.prepare('SELECT jid FROM chats WHERE jid = ?').get('15550001@s.whatsapp.net');
    expect(migrated).toEqual({ jid: '15550001@s.whatsapp.net' });
    // The UPDATE renamed the single LID-keyed row in place: the chats table now
    // holds exactly the phone-keyed jid and no longer contains the old LID key.
    const allJids = db.raw
      .prepare('SELECT jid FROM chats ORDER BY jid')
      .all()
      .map((r) => (r as { jid: string }).jid);
    expect(allJids).toEqual(['15550001@s.whatsapp.net']);
  });

  it('does NOT migrate when the phone-keyed chat target already exists (existing-skip arm)', () => {
    setPhone(db, LID_1, PHONE_1);
    db.raw.prepare('INSERT INTO chats (jid, conversation_key) VALUES (?, ?)').run(`${LID_1}@lid`, 'ck1');
    db.raw.prepare('INSERT INTO chats (jid, conversation_key) VALUES (?, ?)').run('15550001@s.whatsapp.net', 'ck2');

    reconcileLidMappings(db, dir);

    // Both rows still present — no UPDATE fired because target existed.
    const oldRow = db.raw.prepare('SELECT jid, conversation_key FROM chats WHERE jid = ?').get(`${LID_1}@lid`);
    expect(oldRow).toEqual({ jid: `${LID_1}@lid`, conversation_key: 'ck1' });
    const targetRow = db.raw.prepare('SELECT conversation_key FROM chats WHERE jid = ?').get('15550001@s.whatsapp.net');
    expect(targetRow).toEqual({ conversation_key: 'ck2' });
  });
});

// ── L1.5 disk fallback via resolveLid / setLidAuthDir ────────────────────────

describe('resolveLid + setLidAuthDir — L1.5 disk fallback branches', () => {
  let db: Database;
  let dir: string;
  beforeEach(() => {
    db = freshDb();
    dir = mkdtempSync(join(tmpdir(), 'ws-lid-disk-'));
  });
  afterEach(() => {
    db.close();
    setLidAuthDir(''); // reset module state so other suites stay disabled
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on DB miss when auth dir is disabled (empty string)', () => {
    setLidAuthDir('');
    expect(resolveLid(db, LID_1)).toBeNull();
  });

  it('returns null when the reverse file is absent (readFileSync catch arm)', () => {
    setLidAuthDir(dir);
    expect(resolveLid(db, LID_1)).toBeNull();
  });

  it('returns null on malformed JSON in the reverse file (JSON.parse catch arm)', () => {
    setLidAuthDir(dir);
    writeFileSync(join(dir, `lid-mapping-${LID_1}_reverse.json`), '{nope');
    expect(resolveLid(db, LID_1)).toBeNull();
  });

  it('returns null when the parsed payload is non-string or empty', () => {
    setLidAuthDir(dir);
    writeFileSync(join(dir, `lid-mapping-${LID_1}_reverse.json`), '123');   // non-string
    writeFileSync(join(dir, `lid-mapping-${LID_2}_reverse.json`), '""');    // empty string
    expect(resolveLid(db, LID_1)).toBeNull();
    expect(resolveLid(db, LID_2)).toBeNull();
  });

  it('resolves from disk on DB miss and persists the mapping (success arm)', () => {
    setLidAuthDir(dir);
    writeFileSync(join(dir, `lid-mapping-${LID_1}_reverse.json`), '"15550001"');
    expect(resolveLid(db, LID_1)).toBe('15550001');
    // Persisted: a direct DB row now exists (no disk read needed next time).
    const row = db.raw.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?').get(LID_1);
    expect(row).toEqual({ phone_jid: '15550001@s.whatsapp.net' });
  });
});

// ── resolveLidToJid / getAllLidMappings ──────────────────────────────────────

describe('resolveLidToJid + getAllLidMappings', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); setLidAuthDir(''); });
  afterEach(() => { db.close(); });

  it('resolveLidToJid returns null for an unmapped LID (no-phone arm)', () => {
    expect(resolveLidToJid(db, `${LID_1}@lid`)).toBeNull();
  });

  it('resolveLidToJid builds the full personal JID for a mapped LID', () => {
    setPhone(db, LID_1, PHONE_1);
    expect(resolveLidToJid(db, `${LID_1}@lid`)).toBe('15550001@s.whatsapp.net');
  });

  it('getAllLidMappings returns the full lid → phone-digits map', () => {
    setPhone(db, LID_1, PHONE_1);
    setPhone(db, LID_2, PHONE_2);
    const map = getAllLidMappings(db);
    expect(map.get(LID_1)).toBe('15550001');
    expect(map.get(LID_2)).toBe('15550002');
    expect(map.size).toBe(2);
  });
});

// ── canonicalizeChatJid — all domain branches ────────────────────────────────

describe('canonicalizeChatJid — domain branch matrix', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); setLidAuthDir(''); });
  afterEach(() => { db.close(); });

  it('returns group JIDs unchanged', () => {
    expect(canonicalizeChatJid(GROUP_JID, db)).toBe(GROUP_JID);
  });

  it('returns personal JIDs unchanged', () => {
    expect(canonicalizeChatJid(PHONE_1, db)).toBe(PHONE_1);
  });

  it('returns a LID JID unchanged when no db is supplied (!db arm)', () => {
    expect(canonicalizeChatJid(`${LID_1}@lid`)).toBe(`${LID_1}@lid`);
    expect(canonicalizeChatJid(`${LID_1}@lid`, null)).toBe(`${LID_1}@lid`);
  });

  it('returns a LID JID unchanged when unmapped (resolved ?? chatJid arm)', () => {
    expect(canonicalizeChatJid(`${LID_1}@lid`, db)).toBe(`${LID_1}@lid`);
  });

  it('resolves a mapped LID JID to its phone JID', () => {
    setPhone(db, LID_1, PHONE_1);
    expect(canonicalizeChatJid(`${LID_1}@lid`, db)).toBe('15550001@s.whatsapp.net');
  });

  it('returns an unrecognized-domain JID unchanged (final fallthrough)', () => {
    // 'weird-no-domain' has no '@' so falls through all domain checks unchanged.
    expect(canonicalizeChatJid('weird-no-domain', db)).toBe('weird-no-domain');
  });

  // NOTE: the canonicalizeChatJid try/catch DB-error arm (lines 763-765) is
  // reachable only if resolveLidToJid throws. With a healthy :memory: db that
  // path is not naturally hit; the existing resolve tests cover the happy/miss
  // arms. Not faked here — see summary.
});

// ── lookupLidFromDisk path-traversal guard (#1089) ───────────────────────────

describe('resolveLid disk fallback — path-traversal guard (#1089)', () => {
  let db: Database;
  let baseDir: string;
  let authDir: string;
  beforeEach(() => {
    db = freshDb();
    baseDir = mkdtempSync(join(tmpdir(), 'ws-lid-trav-'));
    authDir = join(baseDir, 'auth');
    mkdirSync(authDir);
  });
  afterEach(() => {
    setLidAuthDir('');
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('does not read a reverse-mapping file outside the auth dir for a traversal LID', () => {
    setLidAuthDir(authDir);
    // Plant a file above authDir that an unguarded join would reach:
    //   join(baseDir/auth, `lid-mapping-../../../evil_reverse.json`)
    //   normalises to baseDir/evil_reverse.json (escapes authDir).
    writeFileSync(join(baseDir, 'evil_reverse.json'), '"15559999999"');
    expect(resolveLid(db, '../../../evil')).toBeNull();
  });

  it('still resolves a legitimate digit-only LID from disk', () => {
    setLidAuthDir(authDir);
    writeFileSync(join(authDir, 'lid-mapping-22223333_reverse.json'), '"15550007"');
    expect(resolveLid(db, '22223333')).toBe('15550007');
  });
});
