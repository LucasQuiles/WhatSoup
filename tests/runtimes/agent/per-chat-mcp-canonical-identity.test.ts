import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerChatManagementTools } from '../../../src/mcp/tools/chat-management.ts';
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
          resolved: true,
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
