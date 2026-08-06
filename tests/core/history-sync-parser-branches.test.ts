import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/core/database.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';
import type { HistoryInput } from '../../src/core/history-sync.ts';

function makeDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `whatsoup-history-sync-parser-${randomBytes(4).toString('hex')}.db`);
  const db = new Database(path);
  db.open();
  return { db, path };
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = path + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
}

function bodyMsg(id: string, chat = 'alice@s.whatsapp.net'): HistoryInput {
  return {
    key: { id, remoteJid: chat },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'body' },
  };
}

describe('processHistoryBatch parser boundary handling', () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    const made = makeDb();
    db = made.db;
    path = made.path;
  });

  afterEach(() => {
    db.close();
    cleanup(path);
    vi.doUnmock('../../src/core/message-parser.ts');
    vi.resetModules();
  });

  it('skips a body-bearing message when the parser returns null without writing a placeholder', async () => {
    vi.doMock('../../src/core/message-parser.ts', () => ({
      parseIncomingMessage: vi.fn(() => null),
    }));
    const { processHistoryBatch } = await import('../../src/core/history-sync.ts');
    const log = { debug: vi.fn() };

    const stats = processHistoryBatch(db, [bodyMsg('PARSE_NULL')], log as any);

    expect(stats).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 1 });
    expect(log.debug).toHaveBeenCalledWith(
      { msgId: 'PARSE_NULL' },
      'historyMessages: parseIncomingMessage returned null for message with body',
    );
    const count = (db.raw
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE message_id=?')
      .get('PARSE_NULL') as { count: number }).count;
    expect(count).toBe(0);
  });

  it('does not claim an upgrade or clobber a live row when parser id diverges from placeholder id', async () => {
    vi.doMock('../../src/core/message-parser.ts', () => ({
      parseIncomingMessage: vi.fn(() => ({
        messageId: 'LIVE_ROW',
        chatJid: 'alice@s.whatsapp.net',
        senderJid: 'alice@s.whatsapp.net',
        senderName: null,
        content: 'parsed body',
        contentText: null,
        contentType: 'text',
        isFromMe: false,
        timestamp: 1_700_000_000,
        quotedMessageId: null,
      })),
    }));
    const { processHistoryBatch } = await import('../../src/core/history-sync.ts');
    const log = { warn: vi.fn() };

    processHistoryBatch(db, [{ key: { id: 'PLACEHOLDER_ID', remoteJid: 'alice@s.whatsapp.net' }, messageTimestamp: 1 }]);
    storeMessageIfNew(db, {
      chatJid: 'alice@s.whatsapp.net',
      conversationKey: 'alice',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: 'LIVE_ROW',
      content: 'live body',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_700_000_100,
      quotedMessageId: null,
      rawMessage: null,
    });

    const stats = processHistoryBatch(db, [bodyMsg('PLACEHOLDER_ID')], log as any);

    expect(stats).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      { msgId: 'PLACEHOLDER_ID', parsedMessageId: 'LIVE_ROW' },
      'historyMessages: placeholder upgrade unexpectedly did not fire',
    );
    const rows = db.raw
      .prepare("SELECT message_id, content, content_type FROM messages WHERE message_id IN ('PLACEHOLDER_ID', 'LIVE_ROW') ORDER BY message_id")
      .all() as Array<{ message_id: string; content: string | null; content_type: string }>;
    expect(rows).toEqual([
      { message_id: 'LIVE_ROW', content: 'live body', content_type: 'text' },
      { message_id: 'PLACEHOLDER_ID', content: null, content_type: 'history' },
    ]);
  });
});
