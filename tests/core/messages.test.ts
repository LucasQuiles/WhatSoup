import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import {
  storeMessage,
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

  it('storeMessage + getRecentMessages round-trips correctly', () => {
    const msg = makeMsg({ content: 'round trip test' });
    storeMessage(db, msg);
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

  it('upsert on conflict: same message_id updates content', () => {
    const id = `msg-${randomBytes(4).toString('hex')}`;
    storeMessage(db, makeMsg({ messageId: id, content: 'original' }));
    storeMessage(db, makeMsg({ messageId: id, content: 'updated' }));

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('updated');
  });

  it('getRecentMessages returns messages in chronological ASC order', () => {
    storeMessage(db, makeMsg({ timestamp: BASE_TS + 2, content: 'third' }));
    storeMessage(db, makeMsg({ timestamp: BASE_TS + 0, content: 'first' }));
    storeMessage(db, makeMsg({ timestamp: BASE_TS + 1, content: 'second' }));

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results.map((r) => r.content)).toEqual(['first', 'second', 'third']);
  });

  it('getRecentMessages is scoped to the specified conversationKey', () => {
    storeMessage(db, makeMsg({ chatJid: 'group1@g.us', conversationKey: 'group1_at_g.us', content: 'group1 msg' }));
    storeMessage(db, makeMsg({ chatJid: 'group2@g.us', conversationKey: 'group2_at_g.us', content: 'group2 msg' }));

    const results = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('group1 msg');
  });

  it('getUnprocessedMessages returns only messages with NULL enrichment_processed_at', () => {
    storeMessage(db, makeMsg({ content: 'unprocessed' }));
    const msg2 = makeMsg({ content: 'processed' });
    storeMessage(db, msg2);
    const all = getRecentMessages(db, 'group1_at_g.us', 10);
    const pk2 = all.find((m) => m.content === 'processed')!.pk;
    markMessagesProcessed(db, [pk2]);

    const unprocessed = getUnprocessedMessages(db, 100);
    expect(unprocessed.map((m) => m.content)).toEqual(['unprocessed']);
  });

  it('markMessagesProcessed sets enrichment_processed_at', () => {
    storeMessage(db, makeMsg({ content: 'to process' }));
    const [msg] = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(msg.enrichmentProcessedAt).toBeNull();

    markMessagesProcessed(db, [msg.pk]);

    const [updated] = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(updated.enrichmentProcessedAt).not.toBeNull();
  });

  it('getMessageCount returns the accurate total', () => {
    expect(getMessageCount(db)).toBe(0);
    storeMessage(db, makeMsg());
    storeMessage(db, makeMsg());
    storeMessage(db, makeMsg());
    expect(getMessageCount(db)).toBe(3);
  });

  it('getMessagesBySender returns inbound messages ordered ASC by timestamp', () => {
    const jid = 'bob@s.whatsapp.net';
    storeMessage(db, makeMsg({ senderJid: jid, timestamp: BASE_TS + 10, content: 'late' }));
    storeMessage(db, makeMsg({ senderJid: jid, timestamp: BASE_TS + 0, content: 'early' }));
    // Another sender — should not appear
    storeMessage(db, makeMsg({ senderJid: 'carol@s.whatsapp.net', content: 'carol' }));

    const results = getMessagesBySender(db, jid);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('early');
    expect(results[1].content).toBe('late');
  });

  // --- negative / edge-case tests ---

  it('getUnprocessedMessages excludes bot messages (is_from_me=1)', () => {
    storeMessage(db, makeMsg({ isFromMe: false, content: 'inbound' }));
    storeMessage(db, makeMsg({ isFromMe: true, content: 'bot reply' }));

    const results = getUnprocessedMessages(db, 100);
    expect(results.map((m) => m.content)).toContain('inbound');
    // Bot messages are excluded from enrichment to avoid extracting false facts
    // and wasting tokens (N-3: enrichment bot-message filter)
    expect(results.map((m) => m.content)).not.toContain('bot reply');
  });

  it('markMessagesProcessed with empty array is a no-op without error', () => {
    storeMessage(db, makeMsg({ content: 'should stay unprocessed' }));
    expect(() => markMessagesProcessed(db, [])).not.toThrow();
    const unprocessed = getUnprocessedMessages(db, 100);
    expect(unprocessed).toHaveLength(1);
  });

  it('markMessagesProcessed handles >999 PKs without hitting SQLite param limit', () => {
    // Insert 1500 messages and mark them all processed — exceeds the 999-param limit
    // so the chunking path (CHUNK_SIZE=500) must be exercised.
    const COUNT = 1500;
    for (let i = 0; i < COUNT; i++) {
      storeMessage(db, makeMsg({ timestamp: BASE_TS + i, isFromMe: false }));
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
    storeMessage(db, makeMsg({ timestamp: oldTs, content: 'old message' }));
    storeMessage(db, makeMsg({ timestamp: nowSec, content: 'recent message' }));

    const deleted = deleteOldMessages(db, 30);
    expect(deleted).toBe(1);
    const remaining = getRecentMessages(db, 'group1_at_g.us', 10);
    expect(remaining.map((m) => m.content)).toEqual(['recent message']);
  });

  it('deleteOldMessages preserves messages within retention window', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const recentTs = nowSec - 10 * 86400; // 10 days ago
    storeMessage(db, makeMsg({ timestamp: recentTs, content: 'recent' }));

    const deleted = deleteOldMessages(db, 30);
    expect(deleted).toBe(0);
    expect(getMessageCount(db)).toBe(1);
  });

  it('markMessagesWithError sets enrichment_error column', () => {
    storeMessage(db, makeMsg({ content: 'will error' }));
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
    storeMessage(db, msg);

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
    storeMessage(db, msg);

    const rows = db.raw
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .all(msg.messageId) as unknown as MessageRow[];

    const mapped = rowToMessage(rows[0]);
    expect(mapped.mediaPath).toBeNull();
  });

  // --- Task 3: updateMediaPath helper ---

  it('updateMediaPath sets the media_path column', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessage(db, msg);

    updateMediaPath(db, msg.messageId, '/tmp/whatsoup-media/a1b2c3d4.jpg');

    const row = db.raw
      .prepare('SELECT media_path FROM messages WHERE message_id = ?')
      .get(msg.messageId) as { media_path: string | null };
    expect(row.media_path).toBe('/tmp/whatsoup-media/a1b2c3d4.jpg');
  });

  it('updateMediaPath overwrites an existing media_path', () => {
    const msg = makeMsg({ content: 'image caption' });
    storeMessage(db, msg);

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
    storeMessage(db, msg);

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
    storeMessage(db, msg);

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
    storeMessage(db, msg);

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
    storeMessage(db, msg);

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
    storeMessage(db, msg);

    updateTranscription(db, msg.messageId, 'searchable transcription');

    const ftsResults = db.raw
      .prepare("SELECT rowid FROM messages_fts WHERE content MATCH 'searchable'")
      .all() as Array<{ rowid: number }>;
    expect(ftsResults.length).toBeGreaterThan(0);
  });

});
