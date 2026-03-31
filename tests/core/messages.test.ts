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
  type StoreMessageInput,
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

});
