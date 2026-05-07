import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function tempDir(): string {
  const dir = join(tmpdir(), `whatsoup-scheduling-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('scheduling tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let scratchDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    registerSchedulingTools(registry, { db });
    scratchDir = tempDir();
  });

  afterEach(() => {
    db.raw.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('schedule_message inserts a pending text message for the current chat', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;

    const result = await registry.call(
      'schedule_message',
      { scheduled_at: scheduledAt, text: 'later tonight' },
      chatSession('111'),
    );

    expect(result.isError).toBeUndefined();
    const row = db.raw.prepare(
      'SELECT chat_jid, content_type, payload, scheduled_at, status, retry_count FROM scheduled_messages WHERE id = 1',
    ).get() as {
      chat_jid: string;
      content_type: string;
      payload: string;
      scheduled_at: number;
      status: string;
      retry_count: number;
    };

    expect(row.chat_jid).toBe('111@s.whatsapp.net');
    expect(row.content_type).toBe('text');
    expect(JSON.parse(row.payload)).toEqual({ text: 'later tonight' });
    expect(row.scheduled_at).toBe(scheduledAt);
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
  });

  it('schedule_message requires chatJid in a global session', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 60;
    const result = await registry.call(
      'schedule_message',
      { scheduled_at: scheduledAt, text: 'missing target' },
      globalSession(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires chatJid/i);
  });

  it('schedule_message can schedule image media from a local file', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const filePath = join(scratchDir, 'poster.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const result = await registry.call(
      'schedule_message',
      { chatJid: '222@s.whatsapp.net', scheduled_at: scheduledAt, filePath, caption: 'launch poster' },
      globalSession(),
    );

    expect(result.isError).toBeUndefined();
    const row = db.raw.prepare(
      'SELECT chat_jid, content_type, payload FROM scheduled_messages WHERE id = 1',
    ).get() as {
      chat_jid: string;
      content_type: string;
      payload: string;
    };

    expect(row.chat_jid).toBe('222@s.whatsapp.net');
    expect(row.content_type).toBe('image');
    const payload = JSON.parse(row.payload) as { type: string; caption: string; mimetype: string };
    expect(payload.type).toBe('image');
    expect(payload.caption).toBe('launch poster');
    expect(payload.mimetype).toBe('image/jpeg');
    // SP9: buffer should NOT be in the JSON payload
    expect(payload).not.toHaveProperty('buffer');

    // SP9: media_blob should be stored as a BLOB column
    const blobRow = db.raw.prepare(
      'SELECT media_blob FROM scheduled_messages WHERE id = 1',
    ).get() as { media_blob: Uint8Array | null };
    expect(blobRow.media_blob).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(blobRow.media_blob!).toString()).toBe('fake-image');
  });

  it('schedule_message stores null media_blob for text messages', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    await registry.call(
      'schedule_message',
      { scheduled_at: scheduledAt, text: 'just text' },
      chatSession('333'),
    );

    const row = db.raw.prepare(
      'SELECT content_type, payload, media_blob FROM scheduled_messages WHERE id = 1',
    ).get() as { content_type: string; payload: string; media_blob: Uint8Array | null };
    expect(row).toEqual({
      content_type: 'text',
      payload: JSON.stringify({ text: 'just text' }),
      media_blob: null,
    });
  });

  it('list_scheduled shows pending and processing rows for the current chat only', async () => {
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('111@s.whatsapp.net', 'text', JSON.stringify({ text: 'a' }), 1700000100, 'pending');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('111@s.whatsapp.net', 'text', JSON.stringify({ text: 'b' }), 1700000200, 'processing');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('111@s.whatsapp.net', 'text', JSON.stringify({ text: 'c' }), 1700000300, 'sent');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('222@s.whatsapp.net', 'text', JSON.stringify({ text: 'd' }), 1700000400, 'pending');

    const result = await registry.call('list_scheduled', {}, chatSession('111'));
    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text) as {
      count: number;
      messages: Array<{ id: number; chatJid: string; status: string }>;
    };

    expect(body.count).toBe(2);
    expect(body.messages.map((msg) => msg.status)).toEqual(['pending', 'processing']);
    expect(body.messages.every((msg) => msg.chatJid === '111@s.whatsapp.net')).toBe(true);
  });

  it('cancel_scheduled cancels a pending row and blocks cross-chat cancellation', async () => {
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('111@s.whatsapp.net', 'text', JSON.stringify({ text: 'mine' }), 1700000100, 'pending');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('222@s.whatsapp.net', 'text', JSON.stringify({ text: 'theirs' }), 1700000200, 'pending');

    const blocked = await registry.call('cancel_scheduled', { id: 2 }, chatSession('111'));
    expect(blocked.isError).toBe(true);

    const result = await registry.call('cancel_scheduled', { id: 1 }, chatSession('111'));
    expect(result.isError).toBeUndefined();

    const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 1').get() as { status: string };
    expect(row.status).toBe('cancelled');
  });
});
