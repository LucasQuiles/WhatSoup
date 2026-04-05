import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerStatusTools } from '../../../src/mcp/tools/status.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

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
  const dir = join(tmpdir(), `whatsoup-status-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockSock(): WhatsAppSocket {
  return {
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'status-msg-1' } }),
    readMessages: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('status tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let mockSock: WhatsAppSocket;
  let scratchDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    mockSock = makeMockSock();
    registerStatusTools(registry, { db, getSock: () => mockSock });
    scratchDir = tempDir();
  });

  afterEach(() => {
    db.raw.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('post_status and list_statuses are global-only', async () => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((tool) => tool.name === 'post_status')).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'list_statuses')).toBeUndefined();

    const postResult = await registry.call('post_status', { text: 'hello' }, chatSession('111'));
    expect(postResult.isError).toBe(true);

    const listResult = await registry.call('list_statuses', {}, chatSession('111'));
    expect(listResult.isError).toBe(true);
  });

  it('post_status sends a text status to status@broadcast using contacts from the DB', async () => {
    db.raw.prepare(
      'INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)',
    ).run('111@s.whatsapp.net', '111', 'Alice', 'Alice');
    db.raw.prepare(
      'INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)',
    ).run('222@s.whatsapp.net', '222', 'Bob', 'Bob');
    db.raw.prepare(
      'INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)',
    ).run('group-1@g.us', 'group-1', 'Group', 'Group');

    const result = await registry.call(
      'post_status',
      { text: 'hello story', backgroundColor: '#112233', font: 3 },
      globalSession(),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      { text: 'hello story' },
      expect.objectContaining({
        statusJidList: ['111@s.whatsapp.net', '222@s.whatsapp.net'],
        backgroundColor: '#112233',
        font: 3,
      }),
    );

    const body = JSON.parse(result.content[0].text) as { sent: boolean; recipientCount: number; statusType: string };
    expect(body.sent).toBe(true);
    expect(body.recipientCount).toBe(2);
    expect(body.statusType).toBe('text');
  });

  it('post_status sends image statuses from a local file', async () => {
    db.raw.prepare(
      'INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)',
    ).run('333@s.whatsapp.net', '333', 'Cara', 'Cara');

    const filePath = join(scratchDir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const result = await registry.call(
      'post_status',
      { filePath, caption: 'look at this' },
      globalSession(),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: 'look at this',
        mimetype: 'image/jpeg',
      }),
      expect.objectContaining({
        statusJidList: ['333@s.whatsapp.net'],
      }),
    );
  });

  it('post_status errors when there are no eligible contacts', async () => {
    const result = await registry.call('post_status', { text: 'no recipients' }, globalSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no status recipients/i);
  });

  it('list_statuses groups stored status messages by sender', async () => {
    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, sender_name, message_id, content,
        content_type, is_from_me, timestamp, content_text, raw_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'status@broadcast',
      'status@broadcast',
      '111@s.whatsapp.net',
      'Alice',
      'status-1',
      'first story',
      'text',
      0,
      1700000000,
      null,
      JSON.stringify({ key: { remoteJid: 'status@broadcast', id: 'status-1', fromMe: false, participant: '111@s.whatsapp.net' } }),
    );
    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, sender_name, message_id, content,
        content_type, is_from_me, timestamp, content_text, raw_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'status@broadcast',
      'status@broadcast',
      '111@s.whatsapp.net',
      'Alice',
      'status-2',
      'second story',
      'text',
      0,
      1700000001,
      null,
      JSON.stringify({ key: { remoteJid: 'status@broadcast', id: 'status-2', fromMe: false, participant: '111@s.whatsapp.net' } }),
    );
    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, sender_name, message_id, content,
        content_type, is_from_me, timestamp, content_text, raw_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'status@broadcast',
      'status@broadcast',
      '222@s.whatsapp.net',
      'Bob',
      'status-3',
      'photo story',
      'image',
      0,
      1700000002,
      'photo story',
      JSON.stringify({ key: { remoteJid: 'status@broadcast', id: 'status-3', fromMe: false, participant: '222@s.whatsapp.net' } }),
    );

    const result = await registry.call('list_statuses', {}, globalSession());
    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text) as {
      count: number;
      senders: Array<{ senderJid: string; senderName: string | null; count: number; statuses: Array<{ messageId: string }> }>;
    };

    expect(body.count).toBe(3);
    expect(body.senders).toHaveLength(2);
    expect(body.senders[0]).toMatchObject({
      senderJid: '222@s.whatsapp.net',
      senderName: 'Bob',
      count: 1,
    });
    expect(body.senders[1]).toMatchObject({
      senderJid: '111@s.whatsapp.net',
      senderName: 'Alice',
      count: 2,
    });
    expect(body.senders[1].statuses.map((status) => status.messageId)).toEqual(['status-2', 'status-1']);
  });

  it('list_statuses can mark returned statuses as read', async () => {
    db.raw.prepare(`
      INSERT INTO messages (
        chat_jid, conversation_key, sender_jid, sender_name, message_id, content,
        content_type, is_from_me, timestamp, content_text, raw_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'status@broadcast',
      'status@broadcast',
      '111@s.whatsapp.net',
      'Alice',
      'status-4',
      'mark read',
      'text',
      0,
      1700000003,
      null,
      JSON.stringify({ key: { remoteJid: 'status@broadcast', id: 'status-4', fromMe: false, participant: '111@s.whatsapp.net' } }),
    );

    const result = await registry.call('list_statuses', { mark_read: true }, globalSession());
    expect(result.isError).toBeUndefined();
    expect(mockSock.readMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        remoteJid: 'status@broadcast',
        id: 'status-4',
        fromMe: false,
        participant: '111@s.whatsapp.net',
      }),
    ]);
  });
});
