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

import type { DatabaseSync } from 'node:sqlite';
import { isNonEmptyString } from '../lib/type-guards.ts';

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
   */
  resolve(target: ChatTarget): string;
}

export type ChatAliasSeeds = Record<string, string>;

export interface ChatResolverDeps {
  db: DatabaseSync;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a per-instance chat alias resolver. The resolver caches its
 * lookup statement against the passed db; a different db means a different
 * resolver instance with no shared state.
 */
export function createChatResolver(deps: ChatResolverDeps): ChatResolver {
  const { db } = deps;

  // Prepared once per resolver. The statement is bound to this db; a resolver
  // constructed from a different db has its own statement and its own table.
  const lookupStmt = db.prepare(
    'SELECT chat_jid FROM chat_aliases WHERE alias = ?',
  );

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
        return target.chatJid as string;
      }

      // hasTo === true here; target.to is a non-empty string.
      const alias = target.to as string;
      const row = lookupStmt.get(alias) as { chat_jid: string } | undefined;
      if (!row) {
        throw new AliasNotFoundError(alias);
      }
      return row.chat_jid;
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
