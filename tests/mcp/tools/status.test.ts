import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerStatusTools } from '../../../src/mcp/tools/status.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

const STATUS_JID = 'status@broadcast';
const ALICE_JID = 'alice-status@s.whatsapp.net';
const BOB_JID = 'bob-status@s.whatsapp.net';
const CARA_JID = 'cara-status@s.whatsapp.net';
const GROUP_JID = 'status-group@g.us';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function globalSession(allowedRoot?: string): SessionContext {
  return { tier: 'global', allowedRoot };
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

function insertContact(db: Database, jid: string, displayName: string): void {
  db.raw.prepare(
    'INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)',
  ).run(jid, jid.split('@')[0], displayName, displayName);
}

function statusKey(messageId: string, participant: string, fromMe = false): string {
  return JSON.stringify({
    key: {
      remoteJid: STATUS_JID,
      id: messageId,
      fromMe,
      participant,
    },
  });
}

function insertStatus(
  db: Database,
  overrides: {
    messageId?: string;
    senderJid?: string;
    senderName?: string | null;
    content?: string;
    contentType?: string;
    isFromMe?: boolean;
    timestamp?: number;
    contentText?: string | null;
    rawMessage?: string | null;
  } = {},
): string {
  const messageId = overrides.messageId ?? `status-${randomBytes(3).toString('hex')}`;
  const senderJid = overrides.senderJid ?? ALICE_JID;
  const rawMessage = overrides.rawMessage === undefined
    ? statusKey(messageId, senderJid, overrides.isFromMe ?? false)
    : overrides.rawMessage;

  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, sender_name, message_id, content,
      content_type, is_from_me, timestamp, content_text, raw_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    STATUS_JID,
    STATUS_JID,
    senderJid,
    overrides.senderName === undefined ? 'Alice' : overrides.senderName,
    messageId,
    overrides.content ?? 'status body',
    overrides.contentType ?? 'text',
    overrides.isFromMe ? 1 : 0,
    overrides.timestamp ?? 1_700_000_000,
    overrides.contentText ?? null,
    rawMessage,
  );

  return messageId;
}

describe('status tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let mockSock: WhatsAppSocket;
  let connectedSock: WhatsAppSocket | null;
  let scratchDir: string;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    mockSock = makeMockSock();
    connectedSock = mockSock;
    registerStatusTools(registry, { db, getSock: () => connectedSock });
    scratchDir = tempDir();
  });

  afterEach(() => {
    db.raw.close();
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('post_status and list_statuses are global-only', async () => {
    const tools = registry.listTools(chatSession('status-chat'));
    expect(tools.find((tool) => tool.name === 'post_status')).toBeUndefined();
    expect(tools.find((tool) => tool.name === 'list_statuses')).toBeUndefined();

    const postResult = await registry.call('post_status', { text: 'hello' }, chatSession('status-chat'));
    expect(postResult.isError).toBe(true);

    const listResult = await registry.call('list_statuses', {}, chatSession('status-chat'));
    expect(listResult.isError).toBe(true);
  });

  it('post_status sends a text status to status@broadcast using contacts from the DB', async () => {
    insertContact(db, ALICE_JID, 'Alice');
    insertContact(db, BOB_JID, 'Bob');
    insertContact(db, GROUP_JID, 'Group');

    const result = await registry.call(
      'post_status',
      { text: 'hello story', backgroundColor: '#112233', font: 3 },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      STATUS_JID,
      { text: 'hello story' },
      expect.objectContaining({
        statusJidList: [ALICE_JID, BOB_JID],
        backgroundColor: '#112233',
        font: 3,
      }),
    );

    const body = JSON.parse(result.content[0].text) as { sent: boolean; recipientCount: number; statusType: string };
    expect(body.sent).toBe(true);
    expect(body.recipientCount).toBe(2);
    expect(body.statusType).toBe('text');
  });

  it('post_status sends text without optional presentation fields', async () => {
    insertContact(db, ALICE_JID, 'Alice');

    await registry.call('post_status', { text: 'plain story' }, globalSession(scratchDir));

    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      STATUS_JID,
      { text: 'plain story' },
      { statusJidList: [ALICE_JID] },
    );
  });

  it('post_status sends image statuses from a local file', async () => {
    insertContact(db, CARA_JID, 'Cara');

    const filePath = join(scratchDir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const result = await registry.call(
      'post_status',
      { filePath, caption: 'look at this' },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      STATUS_JID,
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: 'look at this',
        mimetype: 'image/jpeg',
      }),
      expect.objectContaining({
        statusJidList: [CARA_JID],
      }),
    );
  });

  it('post_status sends video statuses with text as caption fallback and null message IDs', async () => {
    insertContact(db, CARA_JID, 'Cara');
    vi.mocked(mockSock.sendMessage).mockResolvedValueOnce(undefined as never);

    const filePath = join(scratchDir, 'clip.mp4');
    writeFileSync(filePath, Buffer.from('fake-video'));

    const result = await registry.call(
      'post_status',
      { filePath, text: 'video caption' },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      STATUS_JID,
      expect.objectContaining({
        video: expect.any(Buffer),
        caption: 'video caption',
        mimetype: 'video/mp4',
      }),
      expect.objectContaining({
        statusJidList: [CARA_JID],
      }),
    );
    const body = JSON.parse(result.content[0].text) as {
      sent: boolean;
      statusType: string;
      recipientCount: number;
      messageId: string | null;
    };
    expect(body).toEqual({
      sent: true,
      statusType: 'video',
      recipientCount: 1,
      messageId: null,
    });
  });

  it('post_status retries once when Baileys encrypted tmp media upload vanishes', async () => {
    insertContact(db, CARA_JID, 'Cara');
    const tmpErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/image123-enc'),
      { code: 'ENOENT', path: '/tmp/image123-enc' },
    );
    vi.mocked(mockSock.sendMessage)
      .mockRejectedValueOnce(tmpErr)
      .mockResolvedValueOnce({ key: { id: 'status-msg-2' } });

    const filePath = join(scratchDir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const result = await registry.call(
      'post_status',
      { filePath, caption: 'look at this' },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);
    const body = JSON.parse(result.content[0].text) as { messageId: string | null };
    expect(body.messageId).toBe('status-msg-2');
  });

  it('post_status does not retry text or generic media send failures', async () => {
    insertContact(db, ALICE_JID, 'Alice');
    vi.mocked(mockSock.sendMessage).mockRejectedValueOnce(new Error('socket hang up'));

    const textResult = await registry.call('post_status', { text: 'will fail' }, globalSession(scratchDir));
    expect(textResult.isError).toBe(true);
    expect(textResult.content[0].text).toContain('connection error');
    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);

    vi.mocked(mockSock.sendMessage).mockClear();
    vi.mocked(mockSock.sendMessage).mockRejectedValueOnce(new Error('permission denied'));
    const filePath = join(scratchDir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const mediaResult = await registry.call('post_status', { filePath }, globalSession(scratchDir));
    expect(mediaResult.isError).toBe(true);
    expect(mediaResult.content[0].text).toContain('permission denied');
    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('post_status validates required content, connection state, and file boundaries', async () => {
    const missingContent = await registry.call('post_status', {}, globalSession(scratchDir));
    expect(missingContent.isError).toBe(true);
    expect(missingContent.content[0].text).toMatch(/Provide text/);

    const noRecipients = await registry.call('post_status', { text: 'no recipients' }, globalSession(scratchDir));
    expect(noRecipients.isError).toBe(true);
    expect(noRecipients.content[0].text).toMatch(/no status recipients/i);

    insertContact(db, ALICE_JID, 'Alice');
    connectedSock = null;
    const disconnected = await registry.call('post_status', { text: 'offline' }, globalSession(scratchDir));
    expect(disconnected.isError).toBe(true);
    expect(disconnected.content[0].text).toMatch(/not connected/i);
    connectedSock = mockSock;

    const missingFile = await registry.call(
      'post_status',
      { filePath: join(scratchDir, 'missing.jpg') },
      globalSession(scratchDir),
    );
    expect(missingFile.isError).toBe(true);
    expect(missingFile.content[0].text).toMatch(/File not found/);

    const outsideDir = tempDir();
    try {
      const outsidePath = join(outsideDir, 'photo.jpg');
      writeFileSync(outsidePath, Buffer.from('outside'));
      const outside = await registry.call(
        'post_status',
        { filePath: outsidePath },
        globalSession(scratchDir),
      );
      expect(outside.isError).toBe(true);
      expect(outside.content[0].text).toMatch(/outside workspace/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    const unsupportedPath = join(scratchDir, 'note.txt');
    writeFileSync(unsupportedPath, 'not media');
    const unsupported = await registry.call('post_status', { filePath: unsupportedPath }, globalSession(scratchDir));
    expect(unsupported.isError).toBe(true);
    expect(unsupported.content[0].text).toMatch(/Unsupported status media extension/);

    const largePath = join(scratchDir, 'huge.mov');
    writeFileSync(largePath, '');
    truncateSync(largePath, 50 * 1024 * 1024 + 1);
    const tooLarge = await registry.call('post_status', { filePath: largePath }, globalSession(scratchDir));
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.content[0].text).toMatch(/File too large/);
  });

  it('post_status rejects file paths when the session has no allowedRoot (fail-closed, #1094)', async () => {
    insertContact(db, ALICE_JID, 'Alice');
    const filePath = join(scratchDir, 'photo.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));
    // No allowedRoot -> isPathWithinAllowedRoot fails closed; even a real, readable
    // file must be rejected so a rootless global session cannot exfiltrate host files.
    const result = await registry.call('post_status', { filePath, caption: 'x' }, globalSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside workspace/);
  });

  it('list_statuses groups stored status messages by sender', async () => {
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: 'Alice',
      messageId: 'status-1',
      content: 'first story',
      timestamp: 1_700_000_000,
    });
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: 'Alice',
      messageId: 'status-2',
      content: 'second story',
      timestamp: 1_700_000_001,
    });
    insertStatus(db, {
      senderJid: BOB_JID,
      senderName: 'Bob',
      messageId: 'status-3',
      content: 'photo story',
      contentType: 'image',
      timestamp: 1_700_000_002,
      contentText: 'photo story',
    });

    const result = await registry.call('list_statuses', {}, globalSession(scratchDir));
    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text) as {
      count: number;
      senders: Array<{ senderJid: string; senderName: string | null; count: number; statuses: Array<{ messageId: string }> }>;
    };

    expect(body.count).toBe(3);
    expect(body.senders).toHaveLength(2);
    expect(body.senders[0]).toMatchObject({
      senderJid: BOB_JID,
      senderName: 'Bob',
      count: 1,
    });
    expect(body.senders[1]).toMatchObject({
      senderJid: ALICE_JID,
      senderName: 'Alice',
      count: 2,
    });
    expect(body.senders[1].statuses.map((status) => status.messageId)).toEqual(['status-2', 'status-1']);
  });

  it('list_statuses can filter by sender and mark fallback keys as read', async () => {
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: null,
      messageId: 'status-fallback-key',
      content: 'fallback key',
      isFromMe: true,
      timestamp: 1_700_000_003,
      rawMessage: null,
    });
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: null,
      messageId: 'status-malformed-key',
      content: 'malformed key',
      timestamp: 1_700_000_004,
      rawMessage: '{not-json',
    });
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: null,
      messageId: 'status-empty-key',
      content: 'empty key',
      timestamp: 1_700_000_005,
      rawMessage: JSON.stringify({ key: {} }),
    });
    insertStatus(db, {
      senderJid: BOB_JID,
      senderName: 'Bob',
      messageId: 'status-filtered-out',
      content: 'not alice',
      timestamp: 1_700_000_006,
    });

    const result = await registry.call(
      'list_statuses',
      { sender_jid: ALICE_JID, mark_read: true, limit: 3 },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as {
      count: number;
      markedRead: number;
      senders: Array<{
        senderJid: string;
        senderName: string | null;
        count: number;
        statuses: Array<{ messageId: string }>;
      }>;
    };
    expect(body.count).toBe(3);
    expect(body.markedRead).toBe(3);
    expect(body.senders).toHaveLength(1);
    expect(body.senders[0]).toMatchObject({ senderJid: ALICE_JID, senderName: null, count: 3 });
    expect(body.senders[0].statuses.map((status) => status.messageId))
      .toEqual(['status-empty-key', 'status-malformed-key', 'status-fallback-key']);
    expect(mockSock.readMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        remoteJid: STATUS_JID,
        id: 'status-empty-key',
        fromMe: false,
        participant: ALICE_JID,
      }),
      expect.objectContaining({
        remoteJid: STATUS_JID,
        id: 'status-malformed-key',
        fromMe: false,
        participant: ALICE_JID,
      }),
      expect.objectContaining({
        remoteJid: STATUS_JID,
        id: 'status-fallback-key',
        fromMe: true,
        participant: ALICE_JID,
      }),
    ]);
  });

  it('list_statuses reports empty mark-read results without touching the socket', async () => {
    const result = await registry.call(
      'list_statuses',
      { sender_jid: CARA_JID, mark_read: true },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as { count: number; markedRead: number; senders: unknown[] };
    expect(body).toEqual({ count: 0, markedRead: 0, senders: [] });
    expect(mockSock.readMessages).not.toHaveBeenCalled();
  });

  it('list_statuses requires a connection before marking returned statuses as read', async () => {
    insertStatus(db, {
      senderJid: ALICE_JID,
      senderName: 'Alice',
      messageId: 'status-read-offline',
      content: 'mark read',
      timestamp: 1_700_000_006,
    });
    connectedSock = null;

    const result = await registry.call('list_statuses', { mark_read: true }, globalSession(scratchDir));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not connected/i);
  });

  it('post_status errors when there are no eligible contacts', async () => {
    const result = await registry.call('post_status', { text: 'no recipients' }, globalSession(scratchDir));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no status recipients/i);
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

    const result = await registry.call('list_statuses', { mark_read: true }, globalSession(scratchDir));
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
