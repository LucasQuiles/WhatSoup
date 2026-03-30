import { createChildLogger } from '../logger.ts';
import { toConversationKey } from './conversation-key.ts';
import type { Database } from './database.ts';

const log = createChildLogger('chat-sync');

// ─── Reactions ──────────────────────────────────────────────────────────────

interface ReactionInput {
  messageId: string;
  conversationKey: string;
  senderJid: string;
  reaction: string;
}

export function handleReaction(db: Database, input: ReactionInput): void {
  if (input.reaction === '') {
    // Empty reaction = remove
    db.raw
      .prepare('DELETE FROM reactions WHERE message_id = ? AND sender_jid = ?')
      .run(input.messageId, input.senderJid);
    log.debug({ messageId: input.messageId, senderJid: input.senderJid }, 'reaction removed');
    return;
  }

  db.raw
    .prepare(`
      INSERT INTO reactions (message_id, conversation_key, sender_jid, reaction)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id, sender_jid) DO UPDATE SET
        reaction = excluded.reaction,
        timestamp = datetime('now')
    `)
    .run(input.messageId, input.conversationKey, input.senderJid, input.reaction);
  log.debug({ messageId: input.messageId, reaction: input.reaction }, 'reaction stored');
}

// ─── Receipts ───────────────────────────────────────────────────────────────

interface ReceiptInput {
  messageId: string;
  recipientJid: string;
  type: string; // 'server' | 'delivery' | 'read' | 'played'
}

export function handleReceipt(db: Database, input: ReceiptInput): void {
  db.raw
    .prepare(`
      INSERT INTO receipts (message_id, recipient_jid, type)
      VALUES (?, ?, ?)
      ON CONFLICT(message_id, recipient_jid, type) DO UPDATE SET
        timestamp = datetime('now')
    `)
    .run(input.messageId, input.recipientJid, input.type);
  log.debug({ messageId: input.messageId, type: input.type }, 'receipt stored');
}

// ─── Chats ──────────────────────────────────────────────────────────────────

interface BaileysChat {
  id: string;
  conversationTimestamp?: number;
  name?: string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: number;
  muteEndTime?: number;
  ephemeralExpiration?: number;
}

export function handleChatsUpsert(db: Database, chats: BaileysChat[]): void {
  if (!Array.isArray(chats) || chats.length === 0) return;
  const stmt = db.raw.prepare(`
    INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived, is_pinned, mute_until, ephemeral_duration, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      unread_count = COALESCE(excluded.unread_count, unread_count),
      is_archived = COALESCE(excluded.is_archived, is_archived),
      is_pinned = COALESCE(excluded.is_pinned, is_pinned),
      mute_until = COALESCE(excluded.mute_until, mute_until),
      ephemeral_duration = COALESCE(excluded.ephemeral_duration, ephemeral_duration),
      updated_at = datetime('now')
  `);

  for (const c of chats) {
    const conversationKey = toConversationKey(c.id);
    const muteUntil = c.muteEndTime ? new Date(c.muteEndTime * 1000).toISOString() : null;
    stmt.run(
      c.id,
      conversationKey,
      c.name ?? null,
      c.unreadCount ?? 0,
      c.archived ? 1 : 0,
      c.pinned ? 1 : 0,
      muteUntil,
      c.ephemeralExpiration ?? null,
    );
  }
  log.debug({ count: chats.length }, 'chats upserted');
}

export function handleChatsUpdate(
  db: Database,
  updates: Array<{ id: string; [key: string]: unknown }>,
): void {
  if (!Array.isArray(updates) || updates.length === 0) return;
  for (const u of updates) {
    // SAFETY: sets[] is built from hardcoded column names only — no user input in SQL fragments.
    // Values are always parameterized via ? placeholders.
    const sets: string[] = [];
    const values: unknown[] = [];

    if (u.name !== undefined) {
      sets.push('name = ?');
      values.push(u.name);
    }
    if (u.unreadCount !== undefined) {
      sets.push('unread_count = ?');
      values.push(u.unreadCount);
    }
    if (u.archived !== undefined) {
      sets.push('is_archived = ?');
      values.push(u.archived ? 1 : 0);
    }
    if (u.pinned !== undefined) {
      sets.push('is_pinned = ?');
      values.push(u.pinned ? 1 : 0);
    }
    if (u.muteEndTime !== undefined) {
      const val = u.muteEndTime as number;
      sets.push('mute_until = ?');
      values.push(val ? new Date(val * 1000).toISOString() : null);
    }
    if (u.ephemeralExpiration !== undefined) {
      sets.push('ephemeral_duration = ?');
      values.push(u.ephemeralExpiration);
    }

    if (sets.length === 0) {
      log.debug({ jid: u.id }, 'chat update: no recognized fields to update');
      continue;
    }

    sets.push("updated_at = datetime('now')");
    values.push(u.id);

    db.raw
      .prepare(`UPDATE chats SET ${sets.join(', ')} WHERE jid = ?`)
      .run(...(values as Array<string | number | null>));
  }
  log.debug({ count: updates.length }, 'chats updated');
}

export function handleChatsDelete(db: Database, jids: string[]): void {
  if (!Array.isArray(jids) || jids.length === 0) return;
  const stmt = db.raw.prepare('DELETE FROM chats WHERE jid = ?');
  for (const jid of jids) {
    stmt.run(jid);
  }
  log.debug({ count: jids.length }, 'chats deleted');
}
