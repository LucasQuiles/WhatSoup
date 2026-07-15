import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

const CHAT_ALPHA_KEY = 'alpha-chat';
const CHAT_ALPHA_JID = `${CHAT_ALPHA_KEY}@s.whatsapp.net`;
const CHAT_BETA_KEY = 'beta-chat';
const CHAT_BETA_JID = `${CHAT_BETA_KEY}@s.whatsapp.net`;
const CHAT_GAMMA_KEY = 'gamma-chat';

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
      chatSession(CHAT_ALPHA_KEY),
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

    expect(row.chat_jid).toBe(CHAT_ALPHA_JID);
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
      globalSession(scratchDir),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires chatJid/i);
  });

  it('schedule_message stores an IANA timezone for a recurring message (#1067)', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const result = await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt,
        text: 'daily standup',
        recurrence: '0 9 * * *',
        timezone: 'America/New_York',
      },
      globalSession(scratchDir),
    );
    expect(result.isError).toBeUndefined();
    const row = db.raw
      .prepare('SELECT timezone, recurrence FROM scheduled_messages WHERE id = 1')
      .get() as { timezone: string | null; recurrence: string | null };
    expect(row.timezone).toBe('America/New_York');
    expect(row.recurrence).toBe('0 9 * * *');
  });

  it('schedule_message rejects an invalid timezone (#1067)', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const result = await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt,
        text: 'bad tz',
        recurrence: '0 9 * * *',
        timezone: 'Not/AZone',
      },
      globalSession(scratchDir),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timezone/i);
  });

  it('schedule_message can schedule image media from a local file', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const filePath = join(scratchDir, 'poster.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));

    const result = await registry.call(
      'schedule_message',
      { chatJid: CHAT_BETA_JID, scheduled_at: scheduledAt, filePath, caption: 'launch poster' },
      globalSession(scratchDir),
    );

    expect(result.isError).toBeUndefined();
    const row = db.raw.prepare(
      'SELECT chat_jid, content_type, payload FROM scheduled_messages WHERE id = 1',
    ).get() as {
      chat_jid: string;
      content_type: string;
      payload: string;
    };

    expect(row.chat_jid).toBe(CHAT_BETA_JID);
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
      chatSession(CHAT_GAMMA_KEY),
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

  it('schedule_message rejects past times and empty content', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const pastResult = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: past, text: 'too late' },
      globalSession(scratchDir),
    );
    expect(pastResult.isError).toBe(true);
    expect(pastResult.content[0].text).toMatch(/future UTC unix timestamp/);

    const emptyResult = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: Math.floor(Date.now() / 1000) + 3600 },
      globalSession(scratchDir),
    );
    expect(emptyResult.isError).toBe(true);
    expect(emptyResult.content[0].text).toMatch(/Provide text/);
  });

  it('schedule_message validates local media paths and size', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const missing = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: scheduledAt, filePath: join(scratchDir, 'missing.png') },
      globalSession(scratchDir),
    );
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/File not found/);

    const unsupportedPath = join(scratchDir, 'payload.exe');
    writeFileSync(unsupportedPath, 'bin');
    const unsupported = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: scheduledAt, filePath: unsupportedPath },
      globalSession(scratchDir),
    );
    expect(unsupported.isError).toBe(true);
    expect(unsupported.content[0].text).toMatch(/Unsupported file extension/);

    const largePath = join(scratchDir, 'large.pdf');
    writeFileSync(largePath, '');
    truncateSync(largePath, 26 * 1024 * 1024);
    const large = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: scheduledAt, filePath: largePath },
      globalSession(scratchDir),
    );
    expect(large.isError).toBe(true);
    expect(large.content[0].text).toMatch(/File too large/);
  });

  it('schedule_message enforces allowedRoot for media paths', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const outsideDir = tempDir();
    try {
      const outsidePath = join(outsideDir, 'outside.png');
      writeFileSync(outsidePath, 'image');
      const result = await registry.call(
        'schedule_message',
        { chatJid: CHAT_ALPHA_JID, scheduled_at: scheduledAt, filePath: outsidePath },
        { ...globalSession(scratchDir), allowedRoot: scratchDir },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Path outside workspace/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('schedule_message rejects media paths when the session has no allowedRoot (fail-closed, #1094)', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const filePath = join(scratchDir, 'poster.jpg');
    writeFileSync(filePath, Buffer.from('fake-image'));
    // No allowedRoot -> fail closed: a rootless global session cannot read host files.
    const result = await registry.call(
      'schedule_message',
      { chatJid: CHAT_ALPHA_JID, scheduled_at: scheduledAt, filePath, caption: 'x' },
      globalSession(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Path outside workspace/);
  });

  it('schedule_message stores document, audio, video, and sticker media payloads', async () => {
    const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
    const docPath = join(scratchDir, 'report.pdf');
    const audioPath = join(scratchDir, 'voice.ogg');
    const videoPath = join(scratchDir, 'clip.mp4');
    const stickerPath = join(scratchDir, 'sticker.webp');
    writeFileSync(docPath, 'doc');
    writeFileSync(audioPath, 'audio');
    writeFileSync(videoPath, 'video');
    writeFileSync(stickerPath, 'sticker');

    await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt,
        filePath: docPath,
        filename: 'custom.pdf',
        text: 'doc fallback caption',
      },
      globalSession(scratchDir),
    );
    await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt + 1,
        filePath: audioPath,
        ptt: true,
        seconds: 9,
      },
      globalSession(scratchDir),
    );
    await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt + 2,
        filePath: videoPath,
        text: 'video caption',
        ptv: true,
        gifPlayback: true,
        viewOnce: true,
      },
      globalSession(scratchDir),
    );
    await registry.call(
      'schedule_message',
      {
        chatJid: CHAT_ALPHA_JID,
        scheduled_at: scheduledAt + 3,
        filePath: stickerPath,
        isAnimated: true,
      },
      globalSession(scratchDir),
    );

    const rows = db.raw.prepare(
      'SELECT content_type, payload FROM scheduled_messages ORDER BY id ASC',
    ).all() as Array<{ content_type: string; payload: string }>;
    expect(rows.map((row) => row.content_type)).toEqual(['document', 'audio', 'video', 'sticker']);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      type: 'document',
      filename: 'custom.pdf',
      caption: 'doc fallback caption',
      mimetype: 'application/pdf',
    });
    expect(JSON.parse(rows[1].payload)).toMatchObject({
      type: 'audio',
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
      seconds: 9,
    });
    expect(JSON.parse(rows[2].payload)).toMatchObject({
      type: 'video',
      caption: 'video caption',
      mimetype: 'video/mp4',
      ptv: true,
      gifPlayback: true,
      viewOnce: true,
    });
    expect(JSON.parse(rows[3].payload)).toMatchObject({
      type: 'sticker',
      mimetype: 'image/webp',
      isAnimated: true,
    });
  });

  it('list_scheduled shows pending and processing rows for the current chat only', async () => {
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'a' }), 1700000100, 'pending');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'b' }), 1700000200, 'processing');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'c' }), 1700000300, 'sent');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_BETA_JID, 'text', JSON.stringify({ text: 'd' }), 1700000400, 'pending');

    const result = await registry.call('list_scheduled', {}, chatSession(CHAT_ALPHA_KEY));
    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text) as {
      count: number;
      messages: Array<{ id: number; chatJid: string; status: string }>;
    };

    expect(body.count).toBe(2);
    expect(body.messages.map((msg) => msg.status)).toEqual(['pending', 'processing']);
    expect(body.messages.every((msg) => msg.chatJid === CHAT_ALPHA_JID)).toBe(true);
  });

  it('list_scheduled filters by status and requested chat while ignoring invalid row targets', async () => {
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'failed alpha' }), 1700000100, 'failed');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_BETA_JID, 'text', JSON.stringify({ text: 'failed beta' }), 1700000200, 'failed');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run('invalid-target', 'text', JSON.stringify({ text: 'bad' }), 1700000300, 'failed');

    const result = await registry.call(
      'list_scheduled',
      { chatJid: CHAT_ALPHA_JID, status: 'failed', limit: 10 },
      globalSession(scratchDir),
    );
    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text) as {
      count: number;
      messages: Array<{ chatJid: string; status: string; payload: { text: string } }>;
    };
    expect(body.count).toBe(1);
    expect(body.messages).toEqual([
      {
        id: 1,
        chatJid: CHAT_ALPHA_JID,
        chatName: null,
        contentType: 'text',
        payload: { text: 'failed alpha' },
        scheduledAt: 1700000100,
        recurrence: null,
        timezone: null,
        nextRunAt: null,
        runCount: 0,
        status: 'failed',
        createdAt: expect.any(Number),
        sentAt: null,
        error: null,
        retryCount: 0,
      },
    ]);
  });

  it('cancel_scheduled cancels a pending row and blocks cross-chat cancellation', async () => {
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'mine' }), 1700000100, 'pending');
    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_BETA_JID, 'text', JSON.stringify({ text: 'theirs' }), 1700000200, 'pending');

    const blocked = await registry.call('cancel_scheduled', { id: 2 }, chatSession(CHAT_ALPHA_KEY));
    expect(blocked.isError).toBe(true);

    const result = await registry.call('cancel_scheduled', { id: 1 }, chatSession(CHAT_ALPHA_KEY));
    expect(result.isError).toBeUndefined();

    const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 1').get() as { status: string };
    expect(row.status).toBe('cancelled');
  });

  it('cancel_scheduled reports missing and non-pending rows', async () => {
    const missing = await registry.call('cancel_scheduled', { id: 99 }, globalSession(scratchDir));
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/Scheduled message 99 not found/);

    db.raw.prepare(
      'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'sent' }), 1700000100, 'sent');
    const sent = await registry.call('cancel_scheduled', { id: 1 }, globalSession(scratchDir));
    expect(sent.isError).toBe(true);
    expect(sent.content[0].text).toMatch(/is sent and cannot be cancelled/);
  });

  describe('conversation-bound session confinement', () => {
    // The handler-local assertSessionAccess used to key on tier ===
    // 'chat-scoped' only, so a conversation-bound session (tier:'global' +
    // binding) bypassed it entirely — cross-conversation scheduled-message
    // access from a bound per-chat socket. It must enforce the binding.
    const boundSession = (): SessionContext => ({
      tier: 'global',
      conversationKey: CHAT_ALPHA_KEY,
      deliveryJid: CHAT_ALPHA_JID,
      binding: Object.freeze({
        kind: 'conversation-bound' as const,
        conversationKey: CHAT_ALPHA_KEY,
        deliveryJid: CHAT_ALPHA_JID,
      }),
    });

    beforeEach(() => {
      db.raw.prepare(
        'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      ).run(CHAT_ALPHA_JID, 'text', JSON.stringify({ text: 'mine' }), 1700000100, 'pending');
      db.raw.prepare(
        'INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      ).run(CHAT_BETA_JID, 'text', JSON.stringify({ text: 'theirs' }), 1700000200, 'pending');
    });

    it('list_scheduled only shows the bound conversation', async () => {
      const result = await registry.call('list_scheduled', {}, boundSession());
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { count: number; messages: Array<{ chatJid: string }> };
      expect(data.count).toBe(1);
      expect(data.messages[0].chatJid).toBe(CHAT_ALPHA_JID);
    });

    it('get_scheduled and cancel_scheduled DENY another conversation\'s row', async () => {
      const got = await registry.call('get_scheduled', { id: 2 }, boundSession());
      expect(got.isError).toBe(true);
      expect(got.content[0].text).not.toContain('theirs');

      const cancelled = await registry.call('cancel_scheduled', { id: 2 }, boundSession());
      expect(cancelled.isError).toBe(true);
      const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 2').get() as { status: string };
      expect(row.status).toBe('pending');
    });

    it('cancel_scheduled still works for the bound conversation\'s own row', async () => {
      const result = await registry.call('cancel_scheduled', { id: 1 }, boundSession());
      expect(result.isError).toBeUndefined();
      const row = db.raw.prepare('SELECT status FROM scheduled_messages WHERE id = 1').get() as { status: string };
      expect(row.status).toBe('cancelled');
    });

    it('an unbound global session with a turn-pinned conversationKey keeps full visibility (operator non-regression)', async () => {
      const result = await registry.call(
        'list_scheduled',
        {},
        { tier: 'global', conversationKey: CHAT_ALPHA_KEY }, // turn-pinned, NOT bound
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { count: number };
      expect(data.count).toBe(2);
    });
  });
});
