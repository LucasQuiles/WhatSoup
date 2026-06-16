/**
 * Crash-safe standby-notice latch for the consolidated one-message handoff.
 *
 * When a fallback schedules a stand-in replay, the structured status line is not
 * sent on its own — it is stashed here and prepended (once) to the stand-in's
 * first visible reply, so the user sees ONE message instead of a notice plus an
 * answer. The design review required this latch to be SQLite-persisted, not an
 * in-memory flag: a process crash between stashing and consuming an in-memory
 * latch yields either a 0-message outcome (stash lost) or a 2-message outcome
 * (standalone flush on restart + the replayed answer). Persisting it makes the
 * pending notice survive a restart and flush exactly once.
 *
 * One pending notice per conversation. Consume is atomic select-and-delete under
 * BEGIN IMMEDIATE (the convention in durability.ts), so concurrent consumers and
 * a crash-before-consume both resolve to exactly-once delivery.
 */

import type { Database } from '../../core/database.ts';

const STANDBY_NOTICE_DDL = `
CREATE TABLE IF NOT EXISTS standby_notice (
  conversation_key TEXT PRIMARY KEY,
  message_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** Create the standby-notice table if absent. Idempotent. */
export function ensureStandbyNoticeSchema(db: Database): void {
  db.raw.exec(STANDBY_NOTICE_DDL);
}

/**
 * Stash (or replace) the pending notice for a conversation. A newer stash
 * supersedes an unconsumed one — the latest status is what should reach the
 * user. Requires {@link ensureStandbyNoticeSchema} to have run.
 */
export function stashStandbyNotice(db: Database, conversationKey: string, messageText: string, now: number): void {
  db.raw
    .prepare(`
      INSERT INTO standby_notice (conversation_key, message_text, created_at)
      VALUES (@conversation_key, @message_text, @created_at)
      ON CONFLICT(conversation_key) DO UPDATE SET
        message_text = excluded.message_text,
        created_at = excluded.created_at
    `)
    .run({ conversation_key: conversationKey, message_text: messageText, created_at: now });
}

/**
 * Atomically read and remove the pending notice. Returns the text exactly once;
 * a second consume (or a consume with none pending) returns null. The
 * select-and-delete runs under BEGIN IMMEDIATE so two concurrent consumers
 * cannot both observe the row.
 */
export function consumeStandbyNotice(db: Database, conversationKey: string): string | null {
  let inTransaction = false;
  try {
    db.raw.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    const row = db.raw
      .prepare('SELECT message_text FROM standby_notice WHERE conversation_key = ?')
      .get(conversationKey) as { message_text: string } | undefined;
    if (row) {
      db.raw.prepare('DELETE FROM standby_notice WHERE conversation_key = ?').run(conversationKey);
    }
    db.raw.exec('COMMIT');
    inTransaction = false;
    return row ? row.message_text : null;
  } catch (err) {
    if (inTransaction) {
      try {
        db.raw.exec('ROLLBACK');
      } catch {
        /* rollback best-effort */
      }
    }
    throw err;
  }
}

/** Read the pending notice without consuming it (observability / tests). */
export function peekStandbyNotice(db: Database, conversationKey: string): string | null {
  const row = db.raw
    .prepare('SELECT message_text FROM standby_notice WHERE conversation_key = ?')
    .get(conversationKey) as { message_text: string } | undefined;
  return row ? row.message_text : null;
}

/** Drop any pending notice (e.g. on /new or when the turn is abandoned). Idempotent. */
export function clearStandbyNotice(db: Database, conversationKey: string): void {
  db.raw.prepare('DELETE FROM standby_notice WHERE conversation_key = ?').run(conversationKey);
}
