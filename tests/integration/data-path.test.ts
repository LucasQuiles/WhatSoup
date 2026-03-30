/**
 * Integration: Event write → Tool read data-path tests
 *
 * Each test exercises the FULL path: event handler writes to DB → tool reads
 * from DB and returns correct data. These are the integration seams where bugs
 * hide between independently-tested unit layers.
 *
 * Pattern:
 *   1. Call the event handler directly (handleReaction, handleChatsUpsert, etc.)
 *   2. Call the MCP tool via registry.call() exactly as a real client would
 *   3. Assert the tool return value reflects what the handler wrote
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerChatOperationTools } from '../../src/mcp/tools/chat-operations.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import {
  handleReaction,
  handleReceipt,
  handleChatsUpsert,
  handleChatsUpdate,
  handleChatsDelete,
} from '../../src/core/chat-sync.ts';
import {
  handleLabelsEdit,
  handleLabelsAssociation,
  cleanupOrphanedAssociations,
} from '../../src/core/label-sync.ts';
import {
  handleBlocklistSet,
  handleBlocklistUpdate,
} from '../../src/core/blocklist-sync.ts';
import type { SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

/** Insert a minimal message row so list_chats (which LEFT JOINs from messages) can find the chat. */
function seedMessage(
  db: Database,
  chatJid: string,
  conversationKey: string,
  messageId: string,
  timestamp = 1000,
): void {
  db.raw
    .prepare(
      `INSERT INTO messages
         (chat_jid, conversation_key, sender_jid, sender_name, message_id,
          content, content_type, is_from_me, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chatJid, conversationKey, chatJid, 'Tester', messageId, 'hello', 'text', 0, timestamp);
}

/** Parse JSON text from a ToolCallResult */
function parseResult<T = Record<string, unknown>>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('data-path integration: event write → tool read', () => {
  let db: Database;
  let registry: ToolRegistry;

  beforeEach(() => {
    db = makeDb();
    registry = new ToolRegistry();
    // Register read-only tools that query the DB; socket tools are not under test here
    registerChatOperationTools(db, () => null, (tool) => registry.register(tool));
    registerChatManagementTools(db, () => null, (tool) => registry.register(tool));
  });

  afterEach(() => {
    db.close();
  });

  // ─── Scenario 1: Reaction write → read path ────────────────────────────────

  describe('scenario 1: reaction write → get_reactions read', () => {
    it('returns the stored reaction after handleReaction', async () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'alice@s.whatsapp.net',
        reaction: '👍',
      });

      const result = await registry.call('get_reactions', { message_id: 'msg1' }, globalSession());
      expect(result.isError).toBeUndefined();

      const data = parseResult<{ reactions: Array<{ sender_jid: string; reaction: string }>; count: number }>(result);
      expect(data.count).toBe(1);
      expect(data.reactions[0].sender_jid).toBe('alice@s.whatsapp.net');
      expect(data.reactions[0].reaction).toBe('👍');
    });
  });

  // ─── Scenario 2: Reaction update → read path ──────────────────────────────

  describe('scenario 2: reaction update → only latest emoji returned', () => {
    it('returns only the updated reaction, not the original', async () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'alice@s.whatsapp.net',
        reaction: '👍',
      });
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'alice@s.whatsapp.net',
        reaction: '❤️',
      });

      const result = await registry.call('get_reactions', { message_id: 'msg1' }, globalSession());
      const data = parseResult<{ reactions: Array<{ reaction: string }>; count: number }>(result);

      expect(data.count).toBe(1);
      expect(data.reactions[0].reaction).toBe('❤️');
    });
  });

  // ─── Scenario 3: Reaction remove → empty result ───────────────────────────

  describe('scenario 3: reaction remove → get_reactions returns empty', () => {
    it('returns empty reactions after removal via empty string', async () => {
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'alice@s.whatsapp.net',
        reaction: '👍',
      });
      handleReaction(db, {
        messageId: 'msg1',
        conversationKey: 'conv1',
        senderJid: 'alice@s.whatsapp.net',
        reaction: '',
      });

      const result = await registry.call('get_reactions', { message_id: 'msg1' }, globalSession());
      const data = parseResult<{ reactions: unknown[]; count: number }>(result);

      expect(data.count).toBe(0);
      expect(data.reactions).toHaveLength(0);
    });
  });

  // ─── Scenario 4: Receipt write → read path ────────────────────────────────

  describe('scenario 4: receipt write → get_message_receipts read', () => {
    it('returns the stored receipt after handleReceipt', async () => {
      handleReceipt(db, {
        messageId: 'msg1',
        recipientJid: 'bob@s.whatsapp.net',
        type: 'delivery',
      });

      const result = await registry.call(
        'get_message_receipts',
        { message_id: 'msg1' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();

      const data = parseResult<{
        receipts: Array<{ recipient_jid: string; type: string }>;
        count: number;
      }>(result);

      expect(data.count).toBe(1);
      expect(data.receipts[0].recipient_jid).toBe('bob@s.whatsapp.net');
      expect(data.receipts[0].type).toBe('delivery');
    });
  });

  // ─── Scenario 5: Chat upsert → list_chats reads name and unreadCount ──────

  describe('scenario 5: chat upsert → list_chats returns metadata', () => {
    it('returns name and unreadCount from the chats table', async () => {
      // list_chats LEFT JOINs from messages, so a message row is required
      seedMessage(db, '111@s.whatsapp.net', '111', 'seed-msg-1');

      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', name: 'Test Chat', unreadCount: 5 },
      ]);

      const result = await registry.call('list_chats', {}, globalSession());
      expect(result.isError).toBeUndefined();

      const data = parseResult<{
        chats: Array<{ conversationKey: string; name?: string; unreadCount?: number }>;
        count: number;
      }>(result);

      expect(data.count).toBeGreaterThanOrEqual(1);
      const chat = data.chats.find((c) => c.conversationKey === '111');
      expect(chat).toBeDefined();
      expect(chat!.name).toBe('Test Chat');
      expect(chat!.unreadCount).toBe(5);
    });
  });

  // ─── Scenario 6: Chat update → list_chats reflects updated unreadCount ────

  describe('scenario 6: chat update → list_chats reflects new unreadCount', () => {
    it('unreadCount is 0 after handleChatsUpdate clears it', async () => {
      seedMessage(db, '111@s.whatsapp.net', '111', 'seed-msg-2');

      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', name: 'Test Chat', unreadCount: 5 },
      ]);
      handleChatsUpdate(db, [{ id: '111@s.whatsapp.net', unreadCount: 0 }]);

      const result = await registry.call('list_chats', {}, globalSession());
      const data = parseResult<{
        chats: Array<{ conversationKey: string; unreadCount?: number }>;
      }>(result);

      const chat = data.chats.find((c) => c.conversationKey === '111');
      expect(chat).toBeDefined();
      // unreadCount 0 maps to undefined in the tool response (falsy coercion)
      // The tool does: unreadCount: r.unread_count ?? undefined
      // 0 is not null/undefined so it should be 0, not undefined.
      // This is a probe: we verify the actual value returned.
      expect(chat!.unreadCount).toBe(0);
    });
  });

  // ─── Scenario 7: Chat delete → list_chats still shows chat from messages ──

  describe('scenario 7: chat delete → list_chats still shows chat (messages remain)', () => {
    it('chat appears in list_chats without metadata after chats row is deleted', async () => {
      seedMessage(db, '111@s.whatsapp.net', '111', 'seed-msg-3');

      handleChatsUpsert(db, [
        { id: '111@s.whatsapp.net', name: 'Test Chat', unreadCount: 2 },
      ]);
      handleChatsDelete(db, ['111@s.whatsapp.net']);

      const result = await registry.call('list_chats', {}, globalSession());
      const data = parseResult<{
        chats: Array<{ conversationKey: string; name?: string; unreadCount?: number }>;
        count: number;
      }>(result);

      // Chat still appears because messages exist (LEFT JOIN)
      const chat = data.chats.find((c) => c.conversationKey === '111');
      expect(chat).toBeDefined();
      // After delete, name and unreadCount come from LEFT JOIN null → undefined
      expect(chat!.name).toBeUndefined();
      expect(chat!.unreadCount).toBeUndefined();
    });
  });

  // ─── Scenario 8: Label write → DB rows exist ──────────────────────────────

  describe('scenario 8: label write → DB rows exist', () => {
    it('handleLabelsEdit stores a label row', () => {
      handleLabelsEdit(db, [{ id: 'L1', name: 'Hot Lead', color: 1 }]);

      const row = db.raw.prepare('SELECT * FROM labels WHERE id = ?').get('L1') as
        | { id: string; name: string; color: number }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.name).toBe('Hot Lead');
      expect(row!.color).toBe(1);
    });

    it('handleLabelsAssociation stores an association row', () => {
      handleLabelsEdit(db, [{ id: 'L1', name: 'Hot Lead', color: 1 }]);
      handleLabelsAssociation(db, {
        labelId: 'L1',
        type: 'chat',
        chatJid: '111@g.us',
        operation: 'add',
      });

      const row = db.raw
        .prepare('SELECT * FROM label_associations WHERE label_id = ? AND type = ?')
        .get('L1', 'chat') as { label_id: string; chat_jid: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.chat_jid).toBe('111@g.us');
    });
  });

  // ─── Scenario 9: Blocklist write / update → DB row counts ─────────────────

  describe('scenario 9: blocklist write/update → DB reflects correct rows', () => {
    it('handleBlocklistSet replaces all rows', () => {
      handleBlocklistSet(db, ['bad1@s.whatsapp.net', 'bad2@s.whatsapp.net']);

      const rows = db.raw.prepare('SELECT jid FROM blocklist').all() as Array<{ jid: string }>;
      expect(rows).toHaveLength(2);
      const jids = rows.map((r) => r.jid);
      expect(jids).toContain('bad1@s.whatsapp.net');
      expect(jids).toContain('bad2@s.whatsapp.net');
    });

    it('handleBlocklistUpdate add increases count', () => {
      handleBlocklistSet(db, ['bad1@s.whatsapp.net', 'bad2@s.whatsapp.net']);
      handleBlocklistUpdate(db, { blocklist: ['bad3@s.whatsapp.net'], type: 'add' });

      const count = (
        db.raw.prepare('SELECT COUNT(*) AS n FROM blocklist').get() as { n: number }
      ).n;
      expect(count).toBe(3);
    });

    it('handleBlocklistUpdate remove decreases count and removes correct entry', () => {
      handleBlocklistSet(db, ['bad1@s.whatsapp.net', 'bad2@s.whatsapp.net']);
      handleBlocklistUpdate(db, { blocklist: ['bad3@s.whatsapp.net'], type: 'add' });
      handleBlocklistUpdate(db, { blocklist: ['bad1@s.whatsapp.net'], type: 'remove' });

      const rows = db.raw.prepare('SELECT jid FROM blocklist').all() as Array<{ jid: string }>;
      expect(rows).toHaveLength(2);
      const jids = rows.map((r) => r.jid);
      expect(jids).toContain('bad2@s.whatsapp.net');
      expect(jids).toContain('bad3@s.whatsapp.net');
      expect(jids).not.toContain('bad1@s.whatsapp.net');
    });
  });

  // ─── Scenario 10: Orphan cleanup path ─────────────────────────────────────

  describe('scenario 10: orphan association cleanup', () => {
    it('cleanupOrphanedAssociations removes rows whose label no longer exists', () => {
      // Insert an association for a label that does NOT exist in the labels table
      handleLabelsAssociation(db, {
        labelId: 'GONE',
        type: 'chat',
        chatJid: '111@g.us',
        operation: 'add',
      });

      // Verify the row was actually inserted
      const before = db.raw
        .prepare('SELECT * FROM label_associations WHERE label_id = ?')
        .all('GONE') as unknown[];
      expect(before).toHaveLength(1);

      // Cleanup should delete the orphan
      const deleted = cleanupOrphanedAssociations(db);
      expect(deleted).toBe(1);

      const after = db.raw
        .prepare('SELECT * FROM label_associations WHERE label_id = ?')
        .all('GONE') as unknown[];
      expect(after).toHaveLength(0);
    });

    it('cleanupOrphanedAssociations leaves associations whose label exists', () => {
      handleLabelsEdit(db, [{ id: 'L2', name: 'Keeper', color: 2 }]);
      handleLabelsAssociation(db, {
        labelId: 'L2',
        type: 'chat',
        chatJid: '222@g.us',
        operation: 'add',
      });

      const deleted = cleanupOrphanedAssociations(db);
      expect(deleted).toBe(0);

      const after = db.raw
        .prepare('SELECT * FROM label_associations WHERE label_id = ?')
        .all('L2') as unknown[];
      expect(after).toHaveLength(1);
    });
  });
});
