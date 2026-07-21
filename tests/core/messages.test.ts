import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import {
  storeMessageIfNew,
  getRecentMessages,
  getUnprocessedMessages,
  markMessagesProcessed,
  getMessageCount,
  deleteOldMessages,
  markMessagesWithError,
  getMessagesBySender,
  updateMediaPath,
  updateTranscription,
  rowToMessage,
  getMessagesSince,
  getUnprocessedCount,
  incrementEnrichmentRetries,
  resetEnrichmentErrors,
  hasFromMeReplyAfter,
  getMessagePkById,
  type StoreMessageInput,
  type MessageRow,
} from '../../src/core/messages.ts';

function tempDbPath(): string {
  return join(tmpdir(), `whatsoup-test-${randomBytes(4).toString('hex')}.db`);
}

// Shared DB for the whole suite — cleared between tests for speed
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

describe('messages', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM messages').run();
    db.raw.prepare('DELETE FROM receipts').run();
  });

  // --- helpers ---

  const BASE_TS = 1_700_000_000; // 2023-11-14

  function makeMsg(overrides: Partial<StoreMessageInput> = {}): StoreMessageInput {
    return {
      chatJid: 'group1@g.us',
      conversationKey: 'group1_at_g.us',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: `msg-${randomBytes(4).toString('hex')}`,
      content: 'hello',
      contentType: 'text',
      isFromMe: false,
      timestamp: BASE_TS,
      ...overrides,
    };
  }

  // --- positive tests ---

  it('storeMessageIfNew + getRecentMessages round-trips correctly', () => {
    const msg = makeMsg({ content: 'round trip test' });
    storeMessageIfNew(db, msg);
    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    const stored = results[0];
    expect(stored.chatJid).toBe(msg.chatJid);
    expect(stored.conversationKey).toBe('group1_at_g.us');
    expect(stored.senderJid).toBe(msg.senderJid);
    expect(stored.senderName).toBe('Alice');
    expect(stored.messageId).toBe(msg.messageId);
    expect(stored.content).toBe('round trip test');
    expect(stored.isFromMe).toBe(false);
    expect(stored.timestamp).toBe(BASE_TS);
  });

  it('QR-076: getRecentMessages excludes soft-deleted (deleted_at) messages', () => {
    storeMessageIfNew(db, makeMsg({ content: 'keep me', timestamp: BASE_TS }));
    storeMessageIfNew(db, makeMsg({ content: 'revoked secret', timestamp: BASE_TS + 1 }));
    // Soft-delete the whole conversation (the wired chatCleared path).
    db.clearChat('group1_at_g.us');

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    // RED before fix: both rows returned (no deleted_at filter) → revoked
    // content leaks into the recalled LLM context.
    expect(results).toHaveLength(0);
    expect(results.map((r) => r.content).join()).not.toContain('revoked secret');
  });

  it('QR-076: getRecentMessages still returns a live message when a sibling is soft-deleted', () => {
    storeMessageIfNew(db, makeMsg({ messageId: 'gone', content: 'deleted one', timestamp: BASE_TS }));
    storeMessageIfNew(db, makeMsg({ messageId: 'live', content: 'kept one', timestamp: BASE_TS + 1 }));
    // Soft-delete only the first message (mirrors a single-message revoke once wired).
    db.raw.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE message_id = ?").run('gone');

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('kept one');
  });

  it('QR-076: getMessagesSince excludes soft-deleted messages', () => {
    storeMessageIfNew(db, makeMsg({ content: 'after-since but deleted', timestamp: BASE_TS + 5 }));
    db.clearChat('group1_at_g.us');

    const results = getMessagesSince(db, 'group1_at_g.us', BASE_TS, 30);
    expect(results).toHaveLength(0);
  });

  it('normalizes millisecond timestamps before writing messages', () => {
    const msg = makeMsg({ content: 'millisecond timestamp', timestamp: 1_777_824_570_676 });
    storeMessageIfNew(db, msg);

    const row = db.raw
      .prepare('SELECT timestamp FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { timestamp: number };
    expect(row.timestamp).toBe(1_777_824_570);
  });

  it('INSERT OR IGNORE: duplicate message_id is ignored', () => {
    const id = `msg-${randomBytes(4).toString('hex')}`;
    const inserted1 = storeMessageIfNew(db, makeMsg({ messageId: id, content: 'original' }));
    const inserted2 = storeMessageIfNew(db, makeMsg({ messageId: id, content: 'updated' }));

    expect(inserted1).toBe(true);
    expect(inserted2).toBe(false); // Second insert is ignored

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('original'); // Content remains unchanged
  });

  it('resolves a newly stored message primary key by transport message id', () => {
    const msg = makeMsg();

    expect(getMessagePkById(db, msg.messageId)).toBeNull();
    expect(storeMessageIfNew(db, msg)).toBe(true);

    const messagePk = getMessagePkById(db, msg.messageId);
    expect(messagePk).toEqual(expect.any(Number));
    expect(messagePk).toBeGreaterThan(0);
  });

  it('storeMessageIfNew upgrades a history placeholder when the live body arrives', () => {
    const id = `msg-${randomBytes(4).toString('hex')}`;
    db.raw.prepare(`
      INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, message_id, content_type, is_from_me, timestamp)
      VALUES
        (@chat_jid, @conversation_key, @sender_jid, @message_id, 'history', 0, @timestamp)
    `).run({
      chat_jid: 'old-group@g.us',
      conversation_key: 'old-group_at_g.us',
      sender_jid: 'old-sender@s.whatsapp.net',
      message_id: id,
      timestamp: BASE_TS - 10,
    });

    const placeholderPk = (db.raw.prepare(
      'SELECT pk FROM messages WHERE message_id = ?',
    ).get(id) as { pk: number }).pk;
    const upgraded = storeMessageIfNew(db, makeMsg({
      chatJid: 'group1@g.us',
      conversationKey: 'group1_at_g.us',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: id,
      content: 'live body',
      contentText: 'Live body summary',
      contentType: 'text',
      timestamp: BASE_TS,
      rawMessage: '{"message":"live"}',
    }));

    expect(upgraded).toBe(true);
    const upgradedPk = (db.raw.prepare(
      'SELECT pk FROM messages WHERE message_id = ?',
    ).get(id) as { pk: number }).pk;
    expect(upgradedPk).toBe(placeholderPk);
    const row = db.raw.prepare(`
      SELECT chat_jid, conversation_key, sender_jid, sender_name, content, content_text,
             content_type, timestamp, raw_message
      FROM messages
      WHERE message_id = ?
    `).get(id) as {
      chat_jid: string;
      conversation_key: string;
      sender_jid: string;
      sender_name: string | null;
      content: string | null;
      content_text: string | null;
      content_type: string;
      timestamp: number;
      raw_message: string | null;
    };

    expect(row).toEqual({
      chat_jid: 'group1@g.us',
      conversation_key: 'group1_at_g.us',
      sender_jid: 'alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'live body',
      content_text: 'Live body summary',
      content_type: 'text',
      timestamp: BASE_TS,
      raw_message: '{"message":"live"}',
    });
  });

  it('getRecentMessages returns messages in chronological ASC order', () => {
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 2, content: 'third' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 0, content: 'first' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 1, content: 'second' }));

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results.map((r) => r.content)).toEqual(['first', 'second', 'third']);
  });

  it('getRecentMessages is scoped to the specified conversationKey', () => {
    storeMessageIfNew(db, makeMsg({ chatJid: 'group1@g.us', conversationKey: 'group1_at_g.us', content: 'group1 msg' }));
    storeMessageIfNew(db, makeMsg({ chatJid: 'group2@g.us', conversationKey: 'group2_at_g.us', content: 'group2 msg' }));

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('group1 msg');
  });

  it('getUnprocessedMessages returns only messages with NULL enrichment_processed_at', () => {
    storeMessageIfNew(db, makeMsg({ content: 'unprocessed' }));
    const msg2 = makeMsg({ content: 'processed' });
    storeMessageIfNew(db, msg2);
    const all = getRecentMessages(db, 'group1_at_g.us', 10);
    const pk2 = all.find((m) => m.content === 'processed')!.pk;
    markMessagesProcessed(db, [pk2]);

    const unprocessed = getUnprocessedMessages(db, 100);
    expect(unprocessed.map((m) => m.content)).toEqual(['unprocessed']);
  });

  it('markMessagesProcessed sets enrichment_processed_at', () => {
    storeMessageIfNew(db, makeMsg({ content: 'to process' }));
    const [msg] = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(msg.enrichmentProcessedAt).toBeNull();

    markMessagesProcessed(db, [msg.pk]);

    const [updated] = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(updated.enrichmentProcessedAt).not.toBeNull();
  });

  it('getMessageCount returns the accurate total', () => {
    expect(getMessageCount(db)).toBe(0);
    storeMessageIfNew(db, makeMsg());
    storeMessageIfNew(db, makeMsg());
    storeMessageIfNew(db, makeMsg());
    expect(getMessageCount(db)).toBe(3);
  });

  it('getMessagesBySender returns inbound messages ordered ASC by timestamp', () => {
    const jid = 'bob@s.whatsapp.net';
    storeMessageIfNew(db, makeMsg({ senderJid: jid, timestamp: BASE_TS + 10, content: 'late' }));
    storeMessageIfNew(db, makeMsg({ senderJid: jid, timestamp: BASE_TS + 0, content: 'early' }));
    // Another sender — should not appear
    storeMessageIfNew(db, makeMsg({ senderJid: 'carol@s.whatsapp.net', content: 'carol' }));

    const results = getMessagesBySender(db, jid);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('early');
    expect(results[1].content).toBe('late');
  });

  // --- negative / edge-case tests ---

  it('getUnprocessedMessages excludes bot messages (is_from_me=1)', () => {
    storeMessageIfNew(db, makeMsg({ isFromMe: false, content: 'inbound' }));
    storeMessageIfNew(db, makeMsg({ isFromMe: true, content: 'bot reply' }));

    const results = getUnprocessedMessages(db, 100);
    expect(results.map((m) => m.content)).toContain('inbound');
    // Bot messages are excluded from enrichment to avoid extracting false facts
    // and wasting tokens (N-3: enrichment bot-message filter)
    expect(results.map((m) => m.content)).not.toContain('bot reply');
  });

  it('markMessagesProcessed with empty array is a no-op without error', () => {
    storeMessageIfNew(db, makeMsg({ content: 'should stay unprocessed' }));
    expect(() => markMessagesProcessed(db, [])).not.toThrow();
    const unprocessed = getUnprocessedMessages(db, 100);
    expect(unprocessed).toHaveLength(1);
  });

  it('markMessagesProcessed handles >999 PKs without hitting SQLite param limit', () => {
    // Insert 1500 messages and mark them all processed — exceeds the 999-param limit
    // so the chunking path (CHUNK_SIZE=500) must be exercised.
    const COUNT = 1500;
    for (let i = 0; i < COUNT; i++) {
      storeMessageIfNew(db, makeMsg({
        messageId: `bulk-param-limit-${i}`,
        timestamp: BASE_TS + i,
        isFromMe: false,
      }));
    }
    const all = getUnprocessedMessages(db, COUNT + 10);
    expect(all.length).toBe(COUNT);

    const pks = all.map((m) => m.pk);
    expect(() => markMessagesProcessed(db, pks)).not.toThrow();

    const remaining = getUnprocessedMessages(db, COUNT + 10);
    expect(remaining).toHaveLength(0);
  });

  it('deleteOldMessages removes messages older than retentionDays', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTs = nowSec - 31 * 86400; // 31 days ago
    storeMessageIfNew(db, makeMsg({ timestamp: oldTs, content: 'old message' }));
    storeMessageIfNew(db, makeMsg({ timestamp: nowSec, content: 'recent message' }));

    const deleted = deleteOldMessages(db, 30);
    expect(deleted).toBe(1);
    const remaining = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(remaining.map((m) => m.content)).toEqual(['recent message']);
  });

  it('deleteOldMessages preserves messages within retention window', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recentTs = nowSec - 10 * 86400; // 10 days ago
    storeMessageIfNew(db, makeMsg({ timestamp: recentTs, content: 'recent' }));

    const deleted = deleteOldMessages(db, 30);
    expect(deleted).toBe(0);
    expect(getMessageCount(db)).toBe(1);
  });

  // --- #1772: receipts orphan-key prune (co-located with message retention) ---

  function receiptCountFor(messageId: string): number {
    const row = db.raw
      .prepare('SELECT COUNT(*) AS cnt FROM receipts WHERE message_id = ?')
      .get(messageId) as { cnt: number };
    return row.cnt;
  }

  function insertReceipt(messageId: string, recipientJid = 'bob@s.whatsapp.net', type = 'delivery'): void {
    db.raw
      .prepare('INSERT INTO receipts (message_id, recipient_jid, type) VALUES (?, ?, ?)')
      .run(messageId, recipientJid, type);
  }

  it('deleteOldMessages prunes receipts whose message was aged out by the same run', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTs = nowSec - 31 * 86400; // 31 days ago — beyond a 30-day retention window
    const agedMsg = makeMsg({ timestamp: oldTs, content: 'aged out' });
    storeMessageIfNew(db, agedMsg);
    insertReceipt(agedMsg.messageId);
    expect(receiptCountFor(agedMsg.messageId)).toBe(1);

    deleteOldMessages(db, 30);

    expect(receiptCountFor(agedMsg.messageId)).toBe(0);
  });

  it('deleteOldMessages preserves receipts of LIVE messages regardless of the receipt row age', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const liveMsg = makeMsg({ timestamp: nowSec, content: 'still live' });
    storeMessageIfNew(db, liveMsg);
    insertReceipt(liveMsg.messageId);
    // Backdate the receipt itself far past the retention window — the prune
    // is keyed on the *message's* existence, not the receipt's own age, so
    // this must survive even though its timestamp alone looks ancient.
    db.raw
      .prepare("UPDATE receipts SET timestamp = datetime('now', '-400 days') WHERE message_id = ?")
      .run(liveMsg.messageId);

    deleteOldMessages(db, 30);

    expect(receiptCountFor(liveMsg.messageId)).toBe(1);
  });

  it('deleteOldMessages receipts prune is idempotent — a second run deletes zero more', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTs = nowSec - 31 * 86400;
    const agedMsg = makeMsg({ timestamp: oldTs, content: 'aged out again' });
    storeMessageIfNew(db, agedMsg);
    insertReceipt(agedMsg.messageId);

    deleteOldMessages(db, 30);
    expect(receiptCountFor(agedMsg.messageId)).toBe(0);

    const before = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM receipts').get() as { cnt: number }).cnt;
    deleteOldMessages(db, 30);
    const after = (db.raw.prepare('SELECT COUNT(*) AS cnt FROM receipts').get() as { cnt: number }).cnt;

    expect(after).toBe(before);
  });

  it('markMessagesWithError sets enrichment_error column', () => {
    storeMessageIfNew(db, makeMsg({ content: 'will error' }));
    const [msg] = getRecentMessages(db, 'group1_at_g.us', 10);

    markMessagesWithError(db, [msg.pk], 'timeout');

    const row = db.raw
      .prepare('SELECT enrichment_error, enrichment_processed_at FROM messages WHERE pk = ?')
      .get(msg.pk) as { enrichment_error: string; enrichment_processed_at: string };
    expect(row.enrichment_error).toBe('timeout');
    expect(row.enrichment_processed_at).not.toBeNull();
  });

  // --- Task 2: media_path in rowToMessage ---

  it('rowToMessage exposes media_path as mediaPath', () => {
    const msg = makeMsg({ content: 'photo caption' });
    storeMessageIfNew(db, msg);

    // Manually set media_path
    db.raw.prepare('UPDATE messages SET media_path = ? WHERE message_id = ?')
      .run('/tmp/whatsoup-media/abc123.jpg', msg.messageId);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.mediaPath).toBe('/tmp/whatsoup-media/abc123.jpg');
  });

  it('rowToMessage returns null mediaPath when column is NULL', () => {
    const msg = makeMsg({ content: 'text only' });
    storeMessageIfNew(db, msg);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped).toMatchObject({
      messageId: msg.messageId,
      chatJid: msg.chatJid,
      conversationKey: msg.conversationKey,
      content: 'text only',
      contentType: 'text',
      mediaPath: null,
      contentText: 'text only',
    });
  });

  // --- Task 3: updateMediaPath helper ---

  it('updateMediaPath sets the media_path column', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessageIfNew(db, msg);

    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/a1b2c3d4.jpg');

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { media_path: string | null };
    expect(row.media_path).toBe('/tmp/whatsoup-media/a1b2c3d4.jpg');
  });

  it('updateMediaPath overwrites an existing media_path', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessageIfNew(db, msg);

    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/old.jpg');
    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/new.jpg');

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { media_path: string | null };
    expect(row.media_path).toBe('/tmp/whatsoup-media/new.jpg');
  });

  it('updateMediaPath is a no-op for unknown message_id', () => {
    // Should not throw
    expect(() => updateMediaPath(db, 'nonexistent-id', '/tmp/x.jpg')).not.toThrow();
  });

  // --- Task 2 (SP2): content_text in rowToMessage and StoreMessageInput ---

  it('rowToMessage exposes content_text as contentText', () => {
    const msg = makeMsg({ content: '{"type":"location","latitude":40.7}', contentType: 'location' });
    storeMessageIfNew(db, msg);

    // Manually set content_text
    db.raw.prepare('UPDATE messages SET content_text = ? WHERE message_id = ?')
      .run('Location: shared (40.7, -74.0)', msg.messageId);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.contentText).toBe('Location: shared (40.7, -74.0)');
  });

  it('rowToMessage returns content as contentText fallback for text messages', () => {
    const msg = makeMsg({ content: 'hello world', contentType: 'text' });
    storeMessageIfNew(db, msg);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.contentText).toBe('hello world');
  });

  it('storeMessageIfNew persists content_text when provided', () => {
    const msg = makeMsg({
      content: '{"type":"contact","displayName":"Bob"}',
      contentType: 'contact',
      contentText: 'Contact: Bob',
    });

    const { storeMessageIfNew } = require('../../src/core/messages.ts');
    storeMessageIfNew(db, msg);

    const row = db.raw
      .prepare('SELECT content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content_text: string | null };
    expect(row.content_text).toBe('Contact: Bob');
  });

  // --- Task 3 (SP2): updateTranscription helper ---

  it('updateTranscription persists transcription to content and content_text', () => {
    const msg = makeMsg({
      content: JSON.stringify({ type: 'audio', duration: 12, ptt: true, transcription: null }),
      contentType: 'audio',
    });
    storeMessageIfNew(db, msg);

    updateTranscription(db, msg.messageId, 'Hello, this is a test');

    const row = db.raw
      .prepare('SELECT content, content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string; content_text: string };

    const parsed = JSON.parse(row.content);
    expect(parsed.transcription).toBe('Hello, this is a test');
    expect(row.content_text).toBe('Hello, this is a test');
  });

  it('updateTranscription handles non-JSON content gracefully', () => {
    const msg = makeMsg({
      content: null,
      contentType: 'audio',
    });
    storeMessageIfNew(db, msg);

    updateTranscription(db, msg.messageId, 'Transcribed text');

    const row = db.raw
      .prepare('SELECT content, content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string; content_text: string };

    const parsed = JSON.parse(row.content);
    expect(parsed.transcription).toBe('Transcribed text');
    expect(row.content_text).toBe('Transcribed text');
  });

  it('updateTranscription is indexed by FTS after MIGRATION_13', () => {
    const msg = makeMsg({
      content: JSON.stringify({ type: 'audio', duration: 5, ptt: true, transcription: null }),
      contentType: 'audio',
      contentText: null,
    });
    storeMessageIfNew(db, msg);

    updateTranscription(db, msg.messageId, 'searchable transcription');

    const ftsResults = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'searchable'")
      .all() as Array<{ rowid: number }>;
    expect(ftsResults.length).toBeGreaterThan(0);
  });

  // --- QR-063: markMessageEdited (WhatsApp message-edit consumer) ---

  it('markMessageEdited updates content + content_text and stamps edited_at', () => {
    const msg = makeMsg({ messageId: 'edit-1', content: 'original text', contentText: 'original text' });
    storeMessageIfNew(db, msg);

    const before = db.raw
      .prepare('SELECT edited_at FROM messages WHERE message_id = ?')
      .get('edit-1') as { edited_at: string | null };
    expect(before.edited_at).toBeNull();

    const changed = db.markMessageEdited('edit-1', 'corrected text');
    expect(changed).toBe(1);

    const row = db.raw
      .prepare('SELECT content, content_text, edited_at FROM messages WHERE message_id = ?')
      .get('edit-1') as { content: string; content_text: string; edited_at: string | null };
    expect(row.content).toBe('corrected text');
    expect(row.content_text).toBe('corrected text');
    expect(row.edited_at).not.toBeNull();
  });

  it('markMessageEdited re-indexes FTS: new text searchable, old text not (MIGRATION_13)', () => {
    const msg = makeMsg({ messageId: 'edit-fts', content: 'zebrastripe original', contentText: 'zebrastripe original' });
    storeMessageIfNew(db, msg);

    // old text is searchable before the edit
    const pre = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'zebrastripe'")
      .all() as Array<{ rowid: number }>;
    expect(pre.length).toBeGreaterThan(0);

    db.markMessageEdited('edit-fts', 'giraffespot corrected');

    const oldHits = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'zebrastripe'")
      .all() as Array<{ rowid: number }>;
    const newHits = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'giraffespot'")
      .all() as Array<{ rowid: number }>;
    expect(oldHits.length).toBe(0);
    expect(newHits.length).toBeGreaterThan(0);
  });

  it('markMessageEdited does NOT edit a soft-deleted (revoked) message', () => {
    // content-only seed (no content_text) so the shared FTS index is untouched by
    // the soft-delete → the assertion isolates markMessageEdited's deleted_at guard.
    const msg = makeMsg({ messageId: 'edit-revoked', content: 'revoked body' });
    storeMessageIfNew(db, msg);
    db.markMessagesDeleted(['edit-revoked']);

    const changed = db.markMessageEdited('edit-revoked', 'attacker edit');
    expect(changed).toBe(0);

    const row = db.raw
      .prepare('SELECT content, edited_at, deleted_at FROM messages WHERE message_id = ?')
      .get('edit-revoked') as { content: string; edited_at: string | null; deleted_at: string | null };
    expect(row.content).toBe('revoked body');
    expect(row.edited_at).toBeNull();
    expect(row.deleted_at).not.toBeNull();
  });

  it('markMessageEdited is a no-op (0 rows) for an unknown message_id', () => {
    expect(db.markMessageEdited('does-not-exist', 'nope')).toBe(0);
  });

});

// === Additional edge-case coverage (cheap-fleet drafted, wave-3) ===
describe('messages — additional edge cases', () => {
  const GROUP_JID = '111111100000000001@g.us';
  const GROUP_KEY = '111111100000000001_at_g.us';
  const SENDER_JID = '15550000001@s.whatsapp.net';
  const BASE_TS = 1_700_000_000;

  beforeEach(() => {
    db.raw.prepare('DELETE FROM messages').run();
  });

  function makeMsg(overrides: Partial<StoreMessageInput> = {}): StoreMessageInput {
    return {
      chatJid: GROUP_JID,
      conversationKey: GROUP_KEY,
      senderJid: SENDER_JID,
      senderName: 'Alice',
      messageId: `msg-${randomBytes(4).toString('hex')}`,
      content: 'hello',
      contentType: 'text',
      isFromMe: false,
      timestamp: BASE_TS,
      ...overrides,
    };
  }

  // --- getMessagesSince ---

  it('getMessagesSince returns messages strictly after since, ordered ASC', () => {
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 0, content: 'at' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 1, content: 'after' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 2, content: 'later' }));

    const results = getMessagesSince(db, GROUP_KEY, BASE_TS, 10);
    expect(results.map((m) => m.content)).toEqual(['after', 'later']);
  });

  it('getMessagesSince excludes messages whose timestamp equals since (strict >)', () => {
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS, content: 'exactly-at-since' }));

    const results = getMessagesSince(db, GROUP_KEY, BASE_TS, 10);
    expect(results).toHaveLength(0);
  });

  it('getMessagesSince applies a default limit of 30 when omitted', () => {
    const COUNT = 35;
    for (let i = 0; i < COUNT; i++) {
      storeMessageIfNew(db, makeMsg({
        messageId: `since-default-limit-${i}`,
        timestamp: BASE_TS + 1 + i,
      }));
    }
    const results = getMessagesSince(db, GROUP_KEY, BASE_TS);
    expect(results).toHaveLength(30);
  });

  it('getMessagesSince respects an explicit limit smaller than available rows', () => {
    for (let i = 0; i < 5; i++) {
      storeMessageIfNew(db, makeMsg({
        messageId: `since-lim-${i}`,
        timestamp: BASE_TS + 1 + i,
        content: `m${i}`,
      }));
    }
    const results = getMessagesSince(db, GROUP_KEY, BASE_TS, 2);
    expect(results).toHaveLength(2);
    expect(results.map((m) => m.content)).toEqual(['m0', 'm1']);
  });

  it('getMessagesSince is scoped to conversationKey and empty when no matches', () => {
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 1, content: 'in-group' }));
    storeMessageIfNew(db, makeMsg({
      chatJid: '111111100000000099@g.us',
      conversationKey: '111111100000000099_at_g.us',
      timestamp: BASE_TS + 1,
      content: 'other-group',
    }));

    const own = getMessagesSince(db, GROUP_KEY, BASE_TS, 10);
    expect(own.map((m) => m.content)).toEqual(['in-group']);

    const empty = getMessagesSince(db, 'nonexistent_at_g.us', BASE_TS, 10);
    expect(empty).toEqual([]);
  });

  // --- getUnprocessedCount / getUnprocessedMessages ordering ---

  it('getUnprocessedCount counts only unprocessed inbound (is_from_me=0) messages', () => {
    expect(getUnprocessedCount(db)).toBe(0);
    storeMessageIfNew(db, makeMsg({ content: 'inbound-1' }));
    storeMessageIfNew(db, makeMsg({ content: 'inbound-2' }));
    storeMessageIfNew(db, makeMsg({ isFromMe: true, content: 'bot' }));
    expect(getUnprocessedCount(db)).toBe(2);

    const all = getRecentMessages(db, GROUP_KEY, 10);
    const target = all.find((m) => m.content === 'inbound-1')!;
    markMessagesProcessed(db, [target.pk]);
    expect(getUnprocessedCount(db)).toBe(1);
  });

  it('getUnprocessedMessages orders inbound messages by timestamp ASC then pk ASC', () => {
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 5, content: 'late', messageId: 'uo-late' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 1, content: 'early', messageId: 'uo-early' }));
    storeMessageIfNew(db, makeMsg({ timestamp: BASE_TS + 1, content: 'tied', messageId: 'uo-tied' }));

    const results = getUnprocessedMessages(db, 100);
    expect(results.map((m) => m.content)).toEqual(['early', 'tied', 'late']);
  });

  // --- incrementEnrichmentRetries ---

  it('incrementEnrichmentRetries increments enrichment_retries and accumulates across calls', () => {
    storeMessageIfNew(db, makeMsg({ content: 'retry-me' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);
    expect(msg.enrichmentRetries).toBe(0);

    incrementEnrichmentRetries(db, [msg.pk]);
    incrementEnrichmentRetries(db, [msg.pk]);
    incrementEnrichmentRetries(db, [msg.pk]);

    const [updated] = getRecentMessages(db, GROUP_KEY, 10);
    expect(updated.enrichmentRetries).toBe(3);
  });

  it('incrementEnrichmentRetries with an empty array is a no-op', () => {
    storeMessageIfNew(db, makeMsg({ content: 'untouched' }));
    expect(() => incrementEnrichmentRetries(db, [])).not.toThrow();
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);
    expect(msg.enrichmentRetries).toBe(0);
  });

  it('incrementEnrichmentRetries ignores unknown primary keys without error', () => {
    expect(() => incrementEnrichmentRetries(db, [999999, 999998])).not.toThrow();
  });

  it('incrementEnrichmentRetries batches multiple primary keys in one call', () => {
    storeMessageIfNew(db, makeMsg({ messageId: 'batch-a', content: 'a' }));
    storeMessageIfNew(db, makeMsg({ messageId: 'batch-b', content: 'b' }));
    storeMessageIfNew(db, makeMsg({ messageId: 'batch-c', content: 'c' }));

    const all = getRecentMessages(db, GROUP_KEY, 10);
    const pks = all.map((m) => m.pk);
    incrementEnrichmentRetries(db, pks);

    const after = getRecentMessages(db, GROUP_KEY, 10);
    expect(after.every((m) => m.enrichmentRetries === 1)).toBe(true);
  });

  // --- markMessagesWithError edge ---

  it('markMessagesWithError with an empty array is a no-op without error', () => {
    storeMessageIfNew(db, makeMsg({ content: 'clean' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);

    expect(() => markMessagesWithError(db, [], 'oops')).not.toThrow();

    const row = db.raw
      .prepare('SELECT enrichment_error, enrichment_processed_at FROM messages WHERE pk = ?')
      .get(msg.pk) as { enrichment_error: string | null; enrichment_processed_at: string | null };
    expect(row.enrichment_error).toBeNull();
    expect(row.enrichment_processed_at).toBeNull();
    expect(getMessageCount(db)).toBe(1);
  });

  // --- resetEnrichmentErrors ---

  it('resetEnrichmentErrors returns 0 and resets nothing for an empty pk array', () => {
    storeMessageIfNew(db, makeMsg({ content: 'errored' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);
    markMessagesWithError(db, [msg.pk], 'fail');

    const result = resetEnrichmentErrors(db, []);
    expect(result).toBe(0);

    const row = db.raw
      .prepare('SELECT enrichment_error FROM messages WHERE pk = ?')
      .get(msg.pk) as { enrichment_error: string };
    expect(row.enrichment_error).toBe('fail');
  });

  it('resetEnrichmentErrors resets only the specified errored messages and returns the count', () => {
    storeMessageIfNew(db, makeMsg({ messageId: 'r-a', content: 'a' }));
    storeMessageIfNew(db, makeMsg({ messageId: 'r-b', content: 'b' }));
    const all = getRecentMessages(db, GROUP_KEY, 10);
    const a = all.find((m) => m.content === 'a')!;
    const b = all.find((m) => m.content === 'b')!;
    markMessagesWithError(db, [a.pk, b.pk], 'timeout');
    incrementEnrichmentRetries(db, [a.pk, b.pk]);

    const reset = resetEnrichmentErrors(db, [a.pk]);
    expect(reset).toBe(1);

    const aRow = db.raw
      .prepare('SELECT enrichment_error, enrichment_processed_at, enrichment_retries FROM messages WHERE pk = ?')
      .get(a.pk) as { enrichment_error: string | null; enrichment_processed_at: string | null; enrichment_retries: number };
    expect(aRow.enrichment_error).toBeNull();
    expect(aRow.enrichment_processed_at).toBeNull();
    expect(aRow.enrichment_retries).toBe(0);

    const bRow = db.raw
      .prepare('SELECT enrichment_error, enrichment_processed_at, enrichment_retries FROM messages WHERE pk = ?')
      .get(b.pk) as { enrichment_error: string | null; enrichment_processed_at: string | null; enrichment_retries: number };
    expect(bRow.enrichment_error).toBe('timeout');
    expect(bRow.enrichment_processed_at).not.toBeNull();
    expect(bRow.enrichment_retries).toBe(1);
  });

  it('resetEnrichmentErrors by pk returns 0 when the target has no enrichment_error', () => {
    storeMessageIfNew(db, makeMsg({ content: 'never-errored' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);

    const reset = resetEnrichmentErrors(db, [msg.pk]);
    expect(reset).toBe(0);
  });

  it('resetEnrichmentErrors without pks resets all messages that have an enrichment_error', () => {
    storeMessageIfNew(db, makeMsg({ messageId: 'all-a', content: 'a' }));
    storeMessageIfNew(db, makeMsg({ messageId: 'all-b', content: 'b' }));
    const all = getRecentMessages(db, GROUP_KEY, 10);
    const a = all.find((m) => m.content === 'a')!;
    const b = all.find((m) => m.content === 'b')!;
    markMessagesWithError(db, [a.pk, b.pk], 'boom');
    incrementEnrichmentRetries(db, [a.pk, b.pk]);

    const reset = resetEnrichmentErrors(db);
    expect(reset).toBe(2);

    for (const pk of [a.pk, b.pk]) {
      const row = db.raw
        .prepare('SELECT enrichment_error, enrichment_processed_at, enrichment_retries FROM messages WHERE pk = ?')
        .get(pk) as { enrichment_error: string | null; enrichment_processed_at: string | null; enrichment_retries: number };
      expect(row.enrichment_error).toBeNull();
      expect(row.enrichment_processed_at).toBeNull();
      expect(row.enrichment_retries).toBe(0);
    }
  });

  it('resetEnrichmentErrors clears enrichment_processed_at so messages re-enter the unprocessed queue', () => {
    storeMessageIfNew(db, makeMsg({ content: 'will-fail-then-reset' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);
    markMessagesWithError(db, [msg.pk], 'transient');
    expect(getUnprocessedMessages(db, 100)).toHaveLength(0);

    resetEnrichmentErrors(db);

    const unprocessed = getUnprocessedMessages(db, 100);
    expect(unprocessed).toHaveLength(1);
    expect(unprocessed[0].enrichmentProcessedAt).toBeNull();
    expect(unprocessed[0].enrichmentRetries).toBe(0);
  });

  // --- storeMessageIfNew defaults ---

  it('storeMessageIfNew writes NULL/defaults for omitted optional fields (content_type defaults to text)', () => {
    const minimal: StoreMessageInput = {
      chatJid: GROUP_JID,
      conversationKey: GROUP_KEY,
      senderJid: SENDER_JID,
      messageId: `min-${randomBytes(4).toString('hex')}`,
      isFromMe: false,
      timestamp: BASE_TS,
    };
    expect(storeMessageIfNew(db, minimal)).toBe(true);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(minimal.messageId) as unknown as MessageRow[];
    const mapped = rowToMessage(rows[0]);

    expect(mapped.senderName).toBeNull();
    expect(mapped.content).toBeNull();
    expect(mapped.contentType).toBe('text');
    expect(mapped.quotedMessageId).toBeNull();
    expect(mapped.mediaPath).toBeNull();
    expect(mapped.contentText).toBeNull();
    expect(mapped.timestamp).toBe(BASE_TS);
  });

  it('rowToMessage maps NULL nullable columns to null and coerces is_from_me to a boolean', () => {
    storeMessageIfNew(db, makeMsg({ isFromMe: true, content: 'x' }));
    const [inserted] = getRecentMessages(db, GROUP_KEY, 10);
    db.raw.prepare(
      `UPDATE messages
         SET sender_name = NULL, content = NULL, quoted_message_id = NULL, media_path = NULL
       WHERE pk = ?`,
    ).run(inserted.pk);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE pk = ?')
      .all(inserted.pk) as unknown as MessageRow[];
    const mapped = rowToMessage(rows[0]);

    expect(mapped.pk).toBe(inserted.pk);
    expect(mapped.isFromMe).toBe(true);
    expect(mapped.senderName).toBeNull();
    expect(mapped.content).toBeNull();
    expect(mapped.quotedMessageId).toBeNull();
    expect(mapped.mediaPath).toBeNull();
    expect(mapped.contentText).toBeNull();
    expect(mapped.timestamp).toBe(BASE_TS);
  });

  it('getRecentMessages maps contentText to content when content_text is NULL (rowToStoredMessage fallback)', () => {
    storeMessageIfNew(db, makeMsg({ content: 'fallback body', contentText: undefined }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);
    expect(msg.content).toBe('fallback body');
    expect(msg.contentText).toBe('fallback body');
  });

  // --- getMessagesBySender edge ---

  it('getMessagesBySender excludes is_from_me=1 messages for the same sender JID', () => {
    const jid = '15550000002@s.whatsapp.net';
    storeMessageIfNew(db, makeMsg({ senderJid: jid, content: 'in' }));
    storeMessageIfNew(db, makeMsg({ senderJid: jid, isFromMe: true, content: 'out' }));

    const results = getMessagesBySender(db, jid);
    expect(results.map((m) => m.content)).toEqual(['in']);
  });

  it('getMessagesBySender applies the default limit of 50 when omitted', () => {
    const jid = '15550000003@s.whatsapp.net';
    for (let i = 0; i < 60; i++) {
      storeMessageIfNew(db, makeMsg({
        senderJid: jid,
        messageId: `sender-limit-${i}`,
        timestamp: BASE_TS + i,
      }));
    }
    const results = getMessagesBySender(db, jid);
    expect(results).toHaveLength(50);
  });

  // --- updateTranscription edge ---

  it('updateTranscription is a no-op without error for an unknown message_id', () => {
    expect(() => updateTranscription(db, 'does-not-exist', 'nope')).not.toThrow();
    const row = db.raw
      .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE message_id = ?')
      .get('does-not-exist') as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('updateTranscription replaces malformed (non-JSON) content with a fresh transcription object', () => {
    storeMessageIfNew(db, makeMsg({ content: 'definitely not json {{', contentType: 'audio' }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);

    updateTranscription(db, msg.messageId, 'recovered text');

    const row = db.raw
      .prepare('SELECT content, content_text FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string; content_text: string };
    const parsed = JSON.parse(row.content);
    expect(parsed).toEqual({ transcription: 'recovered text' });
    expect(row.content_text).toBe('recovered text');
  });

  it('updateTranscription preserves existing JSON keys when adding transcription', () => {
    storeMessageIfNew(db, makeMsg({
      content: JSON.stringify({ type: 'audio', duration: 7 }),
      contentType: 'audio',
    }));
    const [msg] = getRecentMessages(db, GROUP_KEY, 10);

    updateTranscription(db, msg.messageId, 'preserved');

    const row = db.raw
      .prepare('SELECT content FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { content: string };
    expect(JSON.parse(row.content)).toEqual({ type: 'audio', duration: 7, transcription: 'preserved' });
  });

  // --- hasFromMeReplyAfter (origin-chat reply evidence for the egress gate) ---

  describe('hasFromMeReplyAfter', () => {
    it('returns true when a from-me message follows the inbound in the same conversation', () => {
      storeMessageIfNew(db, makeMsg({ messageId: 'inbound-1' }));
      storeMessageIfNew(db, makeMsg({
        messageId: 'reply-1',
        isFromMe: true,
        senderJid: 'me@s.whatsapp.net',
        timestamp: BASE_TS + 5,
      }));
      expect(hasFromMeReplyAfter(db, 'inbound-1')).toBe(true);
    });

    it('returns false when the only from-me send after the inbound went to a DIFFERENT conversation', () => {
      storeMessageIfNew(db, makeMsg({ messageId: 'inbound-2' }));
      storeMessageIfNew(db, makeMsg({
        messageId: 'cross-chat-send',
        isFromMe: true,
        senderJid: 'me@s.whatsapp.net',
        chatJid: 'othergroup@g.us',
        conversationKey: 'othergroup_at_g.us',
        timestamp: BASE_TS + 5,
      }));
      expect(hasFromMeReplyAfter(db, 'inbound-2')).toBe(false);
    });

    it('returns false when the turn produced no from-me message at all', () => {
      storeMessageIfNew(db, makeMsg({ messageId: 'inbound-3' }));
      expect(hasFromMeReplyAfter(db, 'inbound-3')).toBe(false);
    });

    it('returns false when the only from-me message predates the inbound (stale earlier reply)', () => {
      storeMessageIfNew(db, makeMsg({
        messageId: 'old-reply',
        isFromMe: true,
        senderJid: 'me@s.whatsapp.net',
        timestamp: BASE_TS - 100,
      }));
      storeMessageIfNew(db, makeMsg({ messageId: 'inbound-4', timestamp: BASE_TS }));
      expect(hasFromMeReplyAfter(db, 'inbound-4')).toBe(false);
    });

    it('fails closed (false) when the inbound message id is unknown', () => {
      expect(hasFromMeReplyAfter(db, 'never-stored')).toBe(false);
    });

    it('ignores soft-deleted from-me messages', () => {
      storeMessageIfNew(db, makeMsg({ messageId: 'inbound-5' }));
      storeMessageIfNew(db, makeMsg({
        messageId: 'deleted-reply',
        isFromMe: true,
        senderJid: 'me@s.whatsapp.net',
        timestamp: BASE_TS + 5,
      }));
      db.raw.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'deleted-reply'").run();
      expect(hasFromMeReplyAfter(db, 'inbound-5')).toBe(false);
    });
  });
});
