import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

function makeDb(): Database { const db = new Database(':memory:'); db.open(); return db; }
function globalSession(): SessionContext { return { tier: 'global' }; }

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
      ).run('123@s.whatsapp.net', 'Test', 'text', '{"text":"hi"}', 1700000000, 'pending');

      const result = await registry.call('get_scheduled', { id: 1 }, globalSession());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.id).toBe(1);
      expect(body.chatJid).toBe('123@s.whatsapp.net');
      expect(body.chatName).toBe('Test');
    });

    it('does not mark failed scheduled-message rows as tool errors', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, chat_name, content_type, payload, scheduled_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'Test', 'text', '{"text":"hi"}', 1700000000, 'failed', 'send failed');

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
  });

  describe('update_scheduled', () => {
    it('updates scheduled_at on a pending message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending');

      const newTime = future + 3600;
      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: newTime }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT scheduled_at FROM scheduled_messages WHERE id = 1').get() as { scheduled_at: number };
      expect(row.scheduled_at).toBe(newTime);
    });

    it('rejects update on a sent message', async () => {
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', 1700000000, 'sent');

      const result = await registry.call('update_scheduled', { id: 1, scheduled_at: 1800000000 }, globalSession());
      expect(result.isError).toBe(true);
    });

    it('can add recurrence to an existing one-shot message', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, recurrence: '0 9 * * *' }, globalSession());
      expect(result.isError).toBeUndefined();

      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * *');
      expect(row.next_run_at).toBeGreaterThan(0);
    });

    it('syncs next_run_at when scheduled_at changes on a recurring row', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, recurrence, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending', '0 9 * * *', future);

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
        { chatJid: '123@s.whatsapp.net', scheduled_at: scheduledAt, text: 'bad', recurrence: 'not a cron' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('rejects invalid cron expression on update', async () => {
      const future = Math.floor(Date.now() / 1000) + 7200;
      db.raw.prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('123@s.whatsapp.net', 'text', '{"text":"hi"}', future, 'pending');

      const result = await registry.call('update_scheduled', { id: 1, recurrence: '99 99 99 99 99' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  describe('schedule_message with recurrence', () => {
    it('creates a recurring scheduled message with next_run_at', async () => {
      const scheduledAt = Math.floor(Date.now() / 1000) + 3600;
      const result = await registry.call(
        'schedule_message',
        { chatJid: '123@s.whatsapp.net', scheduled_at: scheduledAt, text: 'weekly', recurrence: '0 9 * * 1' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      const row = db.raw.prepare('SELECT recurrence, next_run_at FROM scheduled_messages WHERE id = 1').get() as { recurrence: string; next_run_at: number };
      expect(row.recurrence).toBe('0 9 * * 1');
      expect(row.next_run_at).toBe(scheduledAt);
    });
  });
});
