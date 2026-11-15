import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalConversationKey } from '../../../src/core/access-list.ts';
import { Database } from '../../../src/core/database.ts';
import { fakeClock } from '../../../src/lib/clock.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerChatManagementTools } from '../../../src/mcp/tools/chat-management.ts';
import { registerSchedulingTools } from '../../../src/mcp/tools/scheduling.ts';
import { PerChatMcpSocketManager } from '../../../src/runtimes/agent/per-chat-mcp-socket-manager.ts';
import { sendJsonRpc } from '../../helpers/socket-rpc.ts';

describe('canonical identity on a conversation-bound actor socket', () => {
  it.each(['', '::scheduled-agent-job'])(
    'reads its phone-keyed messages when delivery uses a different LID (%s)',
    async (suffix) => {
      const root = mkdtempSync(join(tmpdir(), 'actor-canonical-'));
      const db = new Database(':memory:');
      db.open();
      const registry = new ToolRegistry();
      registerChatManagementTools(db, () => null, (tool) => registry.register(tool));
      db.raw.exec(`
        INSERT INTO messages
          (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
        VALUES
          ('15550009999@lid', '15550001111', '15550009999@lid', 'own', 'own message', 1000),
          ('15550002222@s.whatsapp.net', '15550002222', '15550002222@s.whatsapp.net', 'other', 'private other message', 1001)
      `);
      const identity = `15550001111@s.whatsapp.net${suffix}`;
      const manager = new PerChatMcpSocketManager({
        stateRoot: root,
        registry,
        allowedRoot: root,
        conversationBound: true,
        resolveExecutingSession: () => ({
          actorJid: '15550009999@lid',
          purpose: undefined,
          conversationKey: '15550001111',
        }),
      });
      try {
        const lease = manager.acquire(identity, '15550009999@lid');
        await lease.ready;
        const read = async (key: string) => {
          const response = await sendJsonRpc(lease.socketPath, {
            jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: { name: 'list_messages', arguments: { conversation_key: key, limit: 10 } },
          }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
          return response.result;
        };
        for (const key of ['15550001111', '15550001111@s.whatsapp.net']) {
          const own = await read(key);
          expect(own.isError).toBeFalsy();
          const page = JSON.parse(own.content[0]!.text);
          expect(page.count).toBe(1);
          expect(page.messages[0].messageId).toBe('own');
        }
        for (const key of ['15550002222', '15550009999', '123456@g.us']) {
          const other = await read(key);
          expect(other.isError).toBe(true);
          expect(other.content[0]!.text).toContain('not available to this conversation-bound session');
          expect(JSON.stringify(other)).not.toContain('private other message');
        }
      } finally {
        manager.release(identity);
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('scheduled messages on a conversation-bound actor socket', () => {
  const LID = '15550009999@lid';
  const PHONE = '15550001111@s.whatsapp.net';
  const FOREIGN_PHONE = '15550002222@s.whatsapp.net';
  const FOREIGN_LID = '15550008888@lid';
  const UNMAPPED_LID = '15550007777@lid';
  const GROUP = '123456@g.us';
  const FOREIGN_GROUP = '654321@g.us';
  const NOW_MS = 1_700_000_000_000;
  const LATER = NOW_MS / 1000 + 3600;

  type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

  async function openSocket(identity: string, deliveryJid: string, conversationKey: string) {
    const root = mkdtempSync(join(tmpdir(), 'actor-sched-'));
    const db = new Database(':memory:');
    db.open();
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run('15550009999', PHONE);
    db.raw.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)').run('15550008888', FOREIGN_PHONE);
    const registry = new ToolRegistry();
    registerSchedulingTools(registry, { db }, fakeClock(NOW_MS));
    // The production fold registerMessagingTools installs on the same registry.
    registry.setCanonicalConversationKeyResolver((jid) => canonicalConversationKey(jid, db));
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry,
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: () => ({ actorJid: deliveryJid, purpose: undefined, conversationKey }),
    });
    const lease = manager.acquire(identity, deliveryJid);
    await lease.ready;
    let nextId = 1;
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const response = await sendJsonRpc(lease.socketPath, {
        jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args },
      }) as { result: ToolResult };
      return response.result;
    };
    const seed = (chatJid: string, text: string): number => Number(db.raw.prepare(
      `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status) VALUES (?, 'text', ?, ?, 'pending')`,
    ).run(chatJid, JSON.stringify({ text }), LATER).lastInsertRowid);
    const row = (id: number) => db.raw.prepare('SELECT chat_jid, payload, status FROM scheduled_messages WHERE id = ?')
      .get(id) as { chat_jid: string; payload: string; status: string };
    const close = () => {
      manager.release(identity);
      db.close();
      rmSync(root, { recursive: true, force: true });
    };
    return { call, seed, row, close, db };
  }

  async function expectOwnRoundTrip(socket: Awaited<ReturnType<typeof openSocket>>, deliveryJid: string): Promise<number> {
    const scheduled = await socket.call('schedule_message', { scheduled_at: LATER, text: 'own reminder' });
    expect(scheduled.isError).toBeFalsy();
    const { id } = socket.db.raw.prepare('SELECT id FROM scheduled_messages ORDER BY id DESC LIMIT 1').get() as { id: number };
    // The row keeps the delivery JID: it is the outbound address.
    expect(socket.row(id).chat_jid).toBe(deliveryJid);

    const listed = await socket.call('list_scheduled', {});
    expect(listed.isError).toBeFalsy();
    expect((JSON.parse(listed.content[0]!.text) as { messages: Array<{ id: number }> }).messages.map((m) => m.id)).toContain(id);
    const got = await socket.call('get_scheduled', { id });
    expect(got.isError).toBeFalsy();
    expect(got.content[0]!.text).toContain('own reminder');
    const updated = await socket.call('update_scheduled', { id, text: 'moved reminder' });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse(socket.row(id).payload)).toEqual({ text: 'moved reminder' });
    const cancelled = await socket.call('cancel_scheduled', { id });
    expect(cancelled.isError).toBeFalsy();
    expect(socket.row(id).status).toBe('cancelled');
    return id;
  }

  async function expectForeignDenied(socket: Awaited<ReturnType<typeof openSocket>>, foreignJids: string[]): Promise<void> {
    const ids = foreignJids.map((jid) => socket.seed(jid, `private row for ${jid}`));
    const listed = await socket.call('list_scheduled', {});
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0]!.text).not.toContain('private row');
    for (const id of ids) {
      for (const [name, args] of [
        ['get_scheduled', { id }], ['update_scheduled', { id, text: 'hijacked' }], ['cancel_scheduled', { id }],
      ] as const) {
        const result = await socket.call(name, args);
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toContain('belongs to a different conversation');
        expect(JSON.stringify(result)).not.toContain('private row');
      }
      expect(socket.row(id).status).toBe('pending');
      expect(socket.row(id).payload).toContain('private row');
    }
  }

  it('a LID-delivered DM schedules, lists, gets, updates and cancels its own row', async () => {
    const socket = await openSocket(PHONE, LID, '15550001111');
    try {
      await expectOwnRoundTrip(socket, LID);
    } finally {
      socket.close();
    }
  });

  it('control: a LID-delivered DM is denied a foreign phone, a LID mapped to a foreign phone, an unmapped LID and a group', async () => {
    const socket = await openSocket(PHONE, LID, '15550001111');
    try {
      await expectForeignDenied(socket, [FOREIGN_PHONE, FOREIGN_LID, UNMAPPED_LID, GROUP]);
    } finally {
      socket.close();
    }
  });

  it('control: a group keeps its own round trip and is denied a foreign group and a DM', async () => {
    const socket = await openSocket(GROUP, GROUP, '123456_at_g.us');
    try {
      await expectOwnRoundTrip(socket, GROUP);
      await expectForeignDenied(socket, [FOREIGN_GROUP, PHONE, LID]);
    } finally {
      socket.close();
    }
  });
});
