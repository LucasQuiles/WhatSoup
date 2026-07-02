import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { SqliteIdentityStore } from '../../../src/core/outbound-identity/store.ts';

let db: Database;
let store: SqliteIdentityStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new SqliteIdentityStore(db.raw);
});

afterEach(() => {
  db.raw.close();
});

describe('SqliteIdentityStore.resolveLid', () => {
  it('returns the phone_jid for a mapped lid', () => {
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000402', '15550009999@s.whatsapp.net');
    expect(store.resolveLid('11111110000402')).toBe('15550009999@s.whatsapp.net');
  });

  it('returns null for an unmapped lid', () => {
    expect(store.resolveLid('11111119999999')).toBeNull();
  });
});

describe('SqliteIdentityStore.isWarm', () => {
  it('is warm when a contacts row exists by jid', () => {
    db.raw.prepare('INSERT INTO contacts (jid, canonical_phone) VALUES (?, ?)')
      .run('15550001111@s.whatsapp.net', '15550001111');
    expect(store.isWarm('15550001111@s.whatsapp.net', '15550001111')).toBe(true);
  });

  it('is warm when access_list has an allowed phone row', () => {
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'allowed')")
      .run('15550002222');
    expect(store.isWarm('15550002222@s.whatsapp.net', '15550002222')).toBe(true);
  });

  it('is NOT warm when access_list status is pending', () => {
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'pending')")
      .run('15550003333');
    expect(store.isWarm('15550003333@s.whatsapp.net', '15550003333')).toBe(false);
  });

  it('is warm when a prior INBOUND message exists', () => {
    db.raw.prepare(
      'INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, is_from_me, timestamp) VALUES (?, ?, ?, ?, 0, ?)',
    ).run('15550004444@s.whatsapp.net', '15550004444', '15550004444@s.whatsapp.net', 'm1', 1700000000);
    expect(store.isWarm('15550004444@s.whatsapp.net', '15550004444')).toBe(true);
  });

  it('is NOT warm for a BLOCKED sender even with a prior inbound (QR-098)', () => {
    // ingest stores every inbound before the block check, so a blocked sender
    // has is_from_me=0 rows — but the anti-exfil floor must not treat a sender
    // the bot refuses to reply to as a valid egress target.
    const phone = '15550006666';
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('phone', ?, 'blocked')").run(phone);
    db.raw.prepare(
      'INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, is_from_me, timestamp) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(`${phone}@s.whatsapp.net`, phone, `${phone}@s.whatsapp.net`, 'm-blk', 1700000000);
    expect(store.isWarm(`${phone}@s.whatsapp.net`, phone)).toBe(false);
  });

  it('is NOT warm when the only message is OUTBOUND (is_from_me=1)', () => {
    db.raw.prepare(
      'INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, is_from_me, timestamp) VALUES (?, ?, ?, ?, 1, ?)',
    ).run('15550005555@s.whatsapp.net', '15550005555', '15550009999@s.whatsapp.net', 'm2', 1700000000);
    expect(store.isWarm('15550005555@s.whatsapp.net', '15550005555')).toBe(false);
  });

  it('is NOT warm for a cold jid with no signal', () => {
    expect(store.isWarm('15550009999@s.whatsapp.net', '15550009999')).toBe(false);
  });
});

describe('SqliteIdentityStore.isApprovedGroup (QR-038)', () => {
  it('is FALSE for a bare groups membership — membership is not approval', () => {
    // A `groups` row is auto-created when the bot joins/discovers a group; that alone
    // must NOT authorize egress, else an attacker who adds the bot to a group gets a
    // path through the anti-exfil cold floor.
    db.raw.prepare('INSERT INTO groups (jid) VALUES (?)').run('111111100000000001@g.us');
    expect(store.isApprovedGroup('111111100000000001@g.us')).toBe(false);
  });

  it("is TRUE only when the group is access_list 'allowed' (parity with auto-respond)", () => {
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('group', ?, 'allowed')").run('111111100000000001@g.us');
    expect(store.isApprovedGroup('111111100000000001@g.us')).toBe(true);
  });

  it("is FALSE for a 'blocked' or 'pending' group entry", () => {
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('group', ?, 'blocked')").run('111111100000002222@g.us');
    expect(store.isApprovedGroup('111111100000002222@g.us')).toBe(false);
    db.raw.prepare("INSERT INTO access_list (subject_type, subject_id, status) VALUES ('group', ?, 'pending')").run('111111100000003333@g.us');
    expect(store.isApprovedGroup('111111100000003333@g.us')).toBe(false);
  });

  it('is FALSE for an unknown group jid', () => {
    expect(store.isApprovedGroup('111111100000009999@g.us')).toBe(false);
  });
});
