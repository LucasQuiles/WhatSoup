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

describe('SqliteIdentityStore.isKnownGroup', () => {
  it('is true when a groups row exists', () => {
    db.raw.prepare('INSERT INTO groups (jid) VALUES (?)').run('111111100000000001@g.us');
    expect(store.isKnownGroup('111111100000000001@g.us')).toBe(true);
  });

  it('is false for an unknown group jid', () => {
    expect(store.isKnownGroup('111111100000009999@g.us')).toBe(false);
  });
});
