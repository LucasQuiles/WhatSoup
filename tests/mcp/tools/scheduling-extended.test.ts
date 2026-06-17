import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

const SCHEDULE_CHAT_KEY = 'schedule-chat';
const SCHEDULE_CHAT_JID = `${SCHEDULE_CHAT_KEY}@s.whatsapp.net`;
const OTHER_CHAT_KEY = 'other-schedule-chat';
const OTHER_CHAT_JID = `${OTHER_CHAT_KEY}@s.whatsapp.net`;

function makeDb(): Database { const db = new Database(':memory:'); db.open(); return db; }
function globalSession(): SessionContext { return { tier: 'global' }; }
function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

describe('extended scheduling tools', () => {
  let registry: ToolRegistry;
  let db: Database;

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    registerSchedulingTools(registry, { db });
  });

  afterEach(() => { db.raw.close(); });

  describe('get_scheduled', () => {
    it('returns a single scheduled message by ID', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'Test', 'text', '{"text":"hi"}', 1700000000, 'pending');

      const result = await registry.call('get_scheduled', { id: 1 }, globalSession());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.id).toBe(1);
      expect(body.chatJid).toBe(SCHEDULE_CHAT_JID);
      expect(body.chatName).toBe('Test');
    });

    it('does not mark failed scheduled-message rows as tool errors', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'Test', 'text', '{"text":"hi"}', 1700000000, 'failed', 'send failed');

      const result = await registry.call('get_scheduled', { id: 1 }, globalSession());

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.status).toBe('failed');
      expect(body.error).toBe('send failed');
    });

    it('returns error for non-existent ID', async () => {
      const result = await registry.call('get_scheduled', { id: 999 }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('rejects chat-scoped reads with no conversation key', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', 1700000000, 'pending');

      const result = await registry.call(
        'get_scheduled',
        { id: 1 },
        { tier: 'chat-scoped' } as SessionContext,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/no conversation key/);
    });

    it('rejects chat-scoped reads for invalid or different chat targets', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('invalid-target', 'text', '{"text":"bad"}', 1700000000, 'pending');
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(OTHER_CHAT_JID, 'text', '{"text":"other"}', 1700000100, 'pending');

      const invalid = await registry.call('get_scheduled', { id: 1 }, chatSession(SCHEDULE_CHAT_KEY));
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0].text).toMatch(/invalid chat target/);

      const denied = await registry.call('get_scheduled', { id: 2 }, chatSession(SCHEDULE_CHAT_KEY));
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toMatch(/different conversation/);
    });
  });

  describe('update_scheduled', () => {
    it('updates scheduled_at on a pending message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const newTime = future + 3600;
      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: newTime }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT scheduled_at FROM scheduled_messages WHERE id = 1').get() as { scheduled_at: number };
      expect(row.scheduled_at).toBe(newTime);
    });

    it('returns error for non-existent scheduled messages', async () => {
      const result = await registry.call('update_scheduled', { id: 999, text: 'missing' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Scheduled message 999 not found/);
    });

    it('rejects past scheduled_at updates', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call(
        'update_scheduled',
        { id: 1, scheduled_at: Math.floor(Date.now() / 1000) - 60 },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/future UTC unix timestamp/);
    });

    it('updates text payload and content type on a pending message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'image', '{"type":"image"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, text: 'new text' }, globalSession());
      expect(result.isError).toBeUndefined();

      const body = JSON.parse(result.content[0].text);
      expect(body.contentType).toBe('text');
      expect(body.payload).toEqual({ text: 'new text' });
    });

    it('rejects no-op updates', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1 }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No fields to update/);
    });

    it('rejects update on a sent message', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', 1700000000, 'sent');

      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: 1800000000 }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('can add recurrence to an existing one-shot message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, recurrence: '0 9 * * *' }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * *');
      expect(row.next_run_at).toBeGreaterThan(0);
    });

    it('uses the supplied scheduled_at as the recurrence base when both change', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const newTime = future + 86400;
      const result = await registry.call(
        'update_scheduled',
        { id: 1, scheduled_at: newTime, recurrence: '0 9 * * *' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT scheduled_at, recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as {
        scheduled_at: number;
        recurrence: string;
        next_run_at: number;
      };
      expect(row.scheduled_at).toBe(newTime);
      expect(row.recurrence).toBe('0 9 * * *');
      expect(row.next_run_at).toBeGreaterThanOrEqual(newTime);
    });

    it('syncs next_run_at when scheduled_at changes on a recurring row', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, recurrence, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending', '0 9 * * *', future);

      const oldRow = db.raw.prepare('SELECT next_run_at FROM scheduled_messages WHERE id = 1').get() as { next_run_at: number };
      expect(oldRow.next_run_at).toBe(future);

      const newTime = future + 86400; // +1 day
      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: newTime }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT scheduled_at, next_run_at FROM scheduled_messages WHERE id = 1').get() as { scheduled_at: number; next_run_at: number };
      expect(row.scheduled_at).toBe(newTime);
      expect(row.next_run_at).not.toBe(future); // must have moved
      expect(row.next_run_at).toBeGreaterThan(newTime - 120); // anchored near new scheduled_at
    });

    it('rejects invalid cron expression on create', async () => {
      const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
      const result = await registry.call(
        'schedule_message',
        { chatJid: SCHEDULE_CHAT_JID, scheduled_at: scheduledAt, text: 'bad', recurrence: 'not a cron' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('rejects invalid cron expression on update', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, recurrence: '99 99 99 99 99' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  describe('schedule_message with recurrence', () => {
    it('creates a recurring scheduled message with next_run_at', async () => {
      const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
      const result = await registry.call(
        'schedule_message',
        { chatJid: SCHEDULE_CHAT_JID, scheduled_at: scheduledAt, text: 'weekly', recurrence: '0 9 * * 1' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * 1');
      expect(row.next_run_at).toBe(scheduledAt);
    });
  });

  describe('corrupt payload resilience', () => {
    // One corrupt persisted payload must not brick the read tools for ALL
    // rows — list/get/update map every row through the payload parse.
    it('list_scheduled returns every row even when one payload is corrupt', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{broken json', 1700000000, 'pending');
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', '{"text":"fine"}', 1700000100, 'pending');

      const result = await registry.call('list_scheduled', {}, globalSession());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.count).toBe(2);
      const corrupt = body.messages.find((m: { id: number }) => m.id === 1);
      const healthy = body.messages.find((m: { id: number }) => m.id === 2);
      expect(corrupt.payload).toEqual({ corrupt: true });
      expect(healthy.payload).toEqual({ text: 'fine' });
    });

    it('get_scheduled on a corrupt row returns the placeholder payload instead of failing', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(SCHEDULE_CHAT_JID, 'text', 'not json at all', 1700000000, 'pending');

      const result = await registry.call('get_scheduled', { id: 1 }, globalSession());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.id).toBe(1);
      expect(body.payload).toEqual({ corrupt: true });
      expect(body.status).toBe('pending');
    });
  });
});
