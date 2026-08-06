/**
 * QR-027/037/043 - canonical conversation_key derivation.
 *
 * The bug cluster: live ingest resolves a LID DM to its phone-based
 * conversation_key, but sibling write paths keyed the same chat by the raw LID
 * number via bare `toConversationKey`, splitting one person's thread across two
 * keys.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { canonicalConversationKey } from '../../src/core/access-list.ts';
import { toConversationKey } from '../../src/core/conversation-key.ts';
import { processHistoryBatch } from '../../src/core/history-sync.ts';
import { handleChatsUpsert } from '../../src/core/chat-sync.ts';

const LID = '81536414179557';
const PHONE = '15555551234';
const PHONE_JID = `${PHONE}@s.whatsapp.net`;
const LID_JID = `${LID}@lid`;

function freshDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function mapLid(db: Database, lid: string, phoneJid: string): void {
  db.raw
    .prepare("INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))")
    .run(lid, phoneJid);
}

describe('canonicalConversationKey - shared derivation', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('resolves a LID DM to its phone-based key', () => {
    mapLid(db, LID, PHONE_JID);
    expect(canonicalConversationKey(LID_JID, db)).toBe(PHONE);
  });

  it('falls back to the normalized LID number when the mapping is unknown', () => {
    expect(canonicalConversationKey(`${LID}:9@lid`, db)).toBe(LID);
  });

  it('keeps a personal JID identical to toConversationKey', () => {
    expect(canonicalConversationKey(PHONE_JID, db)).toBe(toConversationKey(PHONE_JID));
    expect(canonicalConversationKey(PHONE_JID, db)).toBe(PHONE);
  });

  it('keeps a group JID identical to toConversationKey', () => {
    const group = '120363555555555000@g.us';
    expect(canonicalConversationKey(group, db)).toBe(toConversationKey(group));
    expect(canonicalConversationKey(group, db)).toBe('120363555555555000_at_g.us');
  });

  it('keeps an SMS JID in its _at_sms form, not the bare phone digits', () => {
    const sms = '+15555550100@sms';
    expect(canonicalConversationKey(sms, db)).toBe(toConversationKey(sms));
    expect(canonicalConversationKey(sms, db)).not.toBe('15555550100');
  });
});

describe('QR-037 - history-sync keys a LID DM by the resolved phone', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('stores a LID-DM history message under the phone conversation_key', () => {
    mapLid(db, LID, PHONE_JID);

    processHistoryBatch(db, [
      { key: { id: 'HMSG1', remoteJid: LID_JID } },
    ]);

    const row = db.raw
      .prepare('SELECT conversation_key FROM messages WHERE message_id = ?')
      .get('HMSG1') as { conversation_key: string } | undefined;
    expect(row?.conversation_key).toBe(PHONE);
  });
});

describe('QR-043 - chat-sync keys a LID DM chat by the resolved phone', () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(() => { db.close(); });

  it('upserts chats.conversation_key as the phone for a LID DM', () => {
    mapLid(db, LID, PHONE_JID);

    handleChatsUpsert(db, [{ id: LID_JID, name: 'Someone' }]);

    const row = db.raw
      .prepare('SELECT conversation_key FROM chats WHERE jid = ?')
      .get(LID_JID) as { conversation_key: string } | undefined;
    expect(row?.conversation_key).toBe(PHONE);
  });

  it('self-heals an existing LID-keyed chat row once the mapping is known', () => {
    handleChatsUpsert(db, [{ id: LID_JID, name: 'Someone' }]);
    let row = db.raw
      .prepare('SELECT conversation_key FROM chats WHERE jid = ?')
      .get(LID_JID) as { conversation_key: string };
    expect(row.conversation_key).toBe(LID);

    mapLid(db, LID, PHONE_JID);
    handleChatsUpsert(db, [{ id: LID_JID, name: 'Someone' }]);

    row = db.raw
      .prepare('SELECT conversation_key FROM chats WHERE jid = ?')
      .get(LID_JID) as { conversation_key: string };
    expect(row.conversation_key).toBe(PHONE);
  });
});
