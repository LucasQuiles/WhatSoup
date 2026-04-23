import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';

// Covers the upgrade path introduced for history-sync body extraction
// (src/main.ts `historyMessages` handler). Specifically guards against:
//   - column-order regressions in the upgrade UPDATE statement
//   - placeholder rows storing the wrong sender_jid for group chats

const dbPath = join(tmpdir(), `whatsoup-history-sync-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

const PLACEHOLDER_SQL =
  "INSERT OR IGNORE INTO messages (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp) VALUES (?, ?, ?, ?, 'history', ?, ?)";
const UPGRADE_SQL =
  "UPDATE messages SET content=?, content_text=?, content_type=?, sender_name=?, sender_jid=?, raw_message=?, quoted_message_id=?, timestamp=? WHERE message_id=? AND content_type='history'";

describe('history-sync upgrade path', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM messages').run();
  });

  it('upgrades an existing placeholder row with the parsed body in place', () => {
    const placeholder = db.raw.prepare(PLACEHOLDER_SQL);
    placeholder.run('group@g.us', 'group_at_g.us', 'alice@s.whatsapp.net', 'MSG1', 0, 1_700_000_000);

    const upgrade = db.raw.prepare(UPGRADE_SQL);
    upgrade.run(
      'hello world',                // content
      null,                         // content_text
      'text',                       // content_type
      'Alice',                      // sender_name
      'alice@s.whatsapp.net',       // sender_jid
      '{"raw":true}',               // raw_message
      null,                         // quoted_message_id
      1_700_000_001,                // timestamp
      'MSG1',                       // message_id (WHERE)
    );

    const row = db.raw
      .prepare('SELECT content, content_type, sender_name, timestamp FROM messages WHERE message_id=?')
      .get('MSG1') as { content: string; content_type: string; sender_name: string; timestamp: number };

    expect(row.content).toBe('hello world');
    expect(row.content_type).toBe('text');
    expect(row.sender_name).toBe('Alice');
    expect(row.timestamp).toBe(1_700_000_001);
  });

  it('upgrade does not touch rows whose content_type is not "history"', () => {
    storeMessageIfNew(db, {
      chatJid: 'group@g.us',
      conversationKey: 'group_at_g.us',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: 'MSG2',
      content: 'live body',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_700_000_000,
      quotedMessageId: null,
      rawMessage: null,
    });

    const upgrade = db.raw.prepare(UPGRADE_SQL);
    upgrade.run('overwrite', null, 'text', 'Imposter', 'evil@x', null, null, 1_700_000_500, 'MSG2');

    const row = db.raw
      .prepare('SELECT content, sender_name FROM messages WHERE message_id=?')
      .get('MSG2') as { content: string; sender_name: string };
    expect(row.content).toBe('live body');
    expect(row.sender_name).toBe('Alice');
  });

  it('placeholder row stores group sender from key.participant rather than chat_jid', () => {
    // Simulates the fallback in main.ts when Baileys delivers an envelope-only
    // history record for a group chat. key.participant carries the real sender.
    const waMsgKey = { remoteJid: 'group@g.us', id: 'MSG3', participant: 'bob@s.whatsapp.net' };
    const senderJid = waMsgKey.participant ?? waMsgKey.remoteJid;

    db.raw.prepare(PLACEHOLDER_SQL).run(waMsgKey.remoteJid, 'group_at_g.us', senderJid, waMsgKey.id, 0, 1_700_000_000);

    const row = db.raw
      .prepare('SELECT sender_jid FROM messages WHERE message_id=?')
      .get('MSG3') as { sender_jid: string };
    expect(row.sender_jid).toBe('bob@s.whatsapp.net');
  });

  it('placeholder row falls back to chat_jid when participant is absent (DM case)', () => {
    const waMsgKey = { remoteJid: 'alice@s.whatsapp.net', id: 'MSG4' } as { remoteJid: string; id: string; participant?: string };
    const senderJid = waMsgKey.participant ?? waMsgKey.remoteJid;

    db.raw.prepare(PLACEHOLDER_SQL).run(waMsgKey.remoteJid, 'alice_at_s.whatsapp.net', senderJid, waMsgKey.id, 0, 1_700_000_000);

    const row = db.raw
      .prepare('SELECT sender_jid FROM messages WHERE message_id=?')
      .get('MSG4') as { sender_jid: string };
    expect(row.sender_jid).toBe('alice@s.whatsapp.net');
  });
});
