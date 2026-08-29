// src/core/chats-resolver.ts
// Chat alias resolver — maps a chat reference to a raw chatJid via a
// per-instance SQLite alias table.
//
// Per docs/tools.md#send_message and src/core/send-pipeline.ts:
//   - Aliases live in a per-instance chat_aliases table; line identity is
//     implicit-per-DB (a given line's resolver consults only its own DB).
//   - resolve() takes a target object that must contain exactly one of
//     { chatJid } or { to }. Mutually exclusive; both -> MutuallyExclusiveError.
//     Empty values count as not-provided -> MissingTargetError. Unknown alias
//     -> AliasNotFoundError.
//   - Naming follows lid-resolver.ts peer convention.
//
// Contract tests at tests/core/chats-resolver.test.ts lock the surface.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isNonEmptyString } from '../lib/type-guards.ts';
import { isPnJid, toLidJid } from './jid-constants.ts';
import { resolveLidsForPhone } from './lid-resolver.ts';
import type { Database } from './database.ts';

// ── Errors ──────────────────────────────────────────────────────────────────

/** Thrown when a `to` alias is not found in the chat_aliases table. */
export class AliasNotFoundError extends Error {
  constructor(alias: string) {
    super(`alias not found: ${alias}`);
    this.name = 'AliasNotFoundError';
  }
}

/** Thrown when both `chatJid` and `to` are provided. Caller must commit to one. */
export class MutuallyExclusiveError extends Error {
  constructor() {
    super('chatJid and to are mutually exclusive; provide exactly one');
    this.name = 'MutuallyExclusiveError';
  }
}

/** Thrown when neither `chatJid` nor `to` is provided (incl. empty strings). */
export class MissingTargetError extends Error {
  constructor() {
    super('target must contain a non-empty chatJid or to');
    this.name = 'MissingTargetError';
  }
}

// ── Public types ────────────────────────────────────────────────────────────

/** A chat reference: exactly one of `chatJid` (raw JID) or `to` (alias). */
export interface ChatTarget {
  chatJid?: string;
  to?: string;
}

/** Per-instance resolver. Constructed from a single DatabaseSync; line identity
 *  is implicit in which DB you pass. */
export interface ChatResolver {
  /**
   * Resolve a target to a raw chatJid.
   *
   * - `{ chatJid: 'x@g.us' }` returns `'x@g.us'` unchanged (no DB lookup).
   * - `{ to: 'kio' }` looks up the alias in `chat_aliases`; returns `chat_jid`.
   * - Both set -> MutuallyExclusiveError.
   * - Neither set, or both empty -> MissingTargetError.
   * - Alias not found -> AliasNotFoundError.
   * - Issue 3150: when the resolver was built with `dbWrapper`, a resolved
   *   phone JID whose conversation lives under a mapped `@lid` JID (per
   *   lid_mappings + an existing thread) canonicalizes onto that `@lid` JID;
   *   otherwise it is returned as given (fail-open).
   */
  resolve(target: ChatTarget): string;
}

export type ChatAliasSeeds = Record<string, string>;

export interface ChatResolverDeps {
  db: DatabaseSync;
  /**
   * Issue 3150: optional Database wrapper over the SAME instance DB. When
   * present, resolve() canonicalizes a resolved phone JID
   * (`<E.164>@s.whatsapp.net`) onto the EXISTING `@lid` conversation via this
   * instance's lid_mappings, so an outbound send lands in the established
   * thread instead of opening a second, parallel one. Fail-open: no wrapper,
   * no mapping, or no existing `@lid` thread -> the JID is returned as given.
   * (`resolveLidsForPhone` needs the wrapper; the raw handle above cannot
   * serve it — same split as MessagingDeps.dbWrapper.)
   */
  dbWrapper?: Database;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a per-instance chat alias resolver. The resolver caches its
 * lookup statement against the passed db; a different db means a different
 * resolver instance with no shared state.
 */
export function createChatResolver(deps: ChatResolverDeps): ChatResolver {
  const { db, dbWrapper } = deps;

  // Prepared once per resolver. The statement is bound to this db; a resolver
  // constructed from a different db has its own statement and its own table.
  const lookupStmt = db.prepare(
    'SELECT chat_jid FROM chat_aliases WHERE alias = ?',
  );

  // ── LID canonicalization (issue 3150) ────────────────────────────────────
  // Existence probes are prepared lazily; a FAILED prepare (absent table —
  // e.g. a minimal test schema) is memoized as a permanent miss so degraded
  // handles never re-prepare, matching the resolveLidsForPhone contract in
  // lid-resolver.ts. `undefined` = not yet attempted; `null` = permanent miss.
  let chatProbe: StatementSync | null | undefined;
  let messageProbe: StatementSync | null | undefined;

  function lidConversationExists(lidJid: string): boolean {
    if (chatProbe === undefined) {
      try {
        chatProbe = db.prepare('SELECT 1 FROM chats WHERE jid = ?');
      } catch {
        chatProbe = null;
      }
    }
    if (chatProbe !== null && chatProbe.get(lidJid) !== undefined) return true;

    // Fallback: a DM thread can hold messages before chat sync records a
    // chats row — probe messages by chat_jid (indexed: idx_messages_chat_jid).
    if (messageProbe === undefined) {
      try {
        messageProbe = db.prepare('SELECT 1 FROM messages WHERE chat_jid = ? LIMIT 1');
      } catch {
        messageProbe = null;
      }
    }
    return messageProbe !== null && messageProbe.get(lidJid) !== undefined;
  }

  /**
   * Issue 3150: canonicalize a resolved phone JID onto the EXISTING `@lid`
   * conversation. Reuses resolveLidsForPhone (most recently updated mapping
   * first); the first mapped LID whose thread actually exists wins. NEVER
   * throws — any failure means "send to the JID as given" (fail-open per the
   * issue's ask). Group and `@lid` targets pass through untouched.
   */
  function canonicalizeToLidConversation(chatJid: string): string {
    if (!dbWrapper || !isPnJid(chatJid)) return chatJid;
    try {
      for (const lid of resolveLidsForPhone(dbWrapper, chatJid)) {
        const lidJid = toLidJid(lid);
        if (lidConversationExists(lidJid)) return lidJid;
      }
    } catch {
      // fail-open: degraded probe -> original JID
    }
    return chatJid;
  }

  return {
    resolve(target: ChatTarget): string {
      const hasChatJid = isNonEmptyString(target.chatJid);
      const hasTo = isNonEmptyString(target.to);

      // Mutual-exclusion check first: if both are set, even an empty value on
      // one side wouldn't matter — but only count "set" as "non-empty value
      // present" so empty strings on both sides correctly fall through to
      // MissingTargetError, matching contract test "empty / null target".
      if (hasChatJid && hasTo) {
        throw new MutuallyExclusiveError();
      }
      if (!hasChatJid && !hasTo) {
        throw new MissingTargetError();
      }

      if (hasChatJid) {
        return canonicalizeToLidConversation(target.chatJid as string);
      }

      // hasTo === true here; target.to is a non-empty string.
      const alias = target.to as string;
      const row = lookupStmt.get(alias) as { chat_jid: string } | undefined;
      if (!row) {
        throw new AliasNotFoundError(alias);
      }
      return canonicalizeToLidConversation(row.chat_jid);
    },
  };
}

export function seedChatAliases(db: DatabaseSync, aliases: ChatAliasSeeds): number {
  const upsert = db.prepare(`
    INSERT INTO chat_aliases (alias, chat_jid)
    VALUES (?, ?)
    ON CONFLICT(alias) DO UPDATE SET
      chat_jid = excluded.chat_jid,
      updated_at = datetime('now')
    WHERE chat_aliases.chat_jid != excluded.chat_jid
  `);

  let changes = 0;
  for (const [alias, chatJid] of Object.entries(aliases)) {
    const result = upsert.run(alias, chatJid) as { changes?: number };
    changes += result.changes ?? 0;
  }
  return changes;
}
