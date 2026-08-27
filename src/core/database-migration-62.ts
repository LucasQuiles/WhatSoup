import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 62 — durable `deferred_turn_obligations` lane (#3295 slice S1).
 *
 * A journaled follower turn blocked SOLELY by active same-scope durable turn
 * recovery currently terminalizes as an admission-rejected failure with
 * `automatic_replay=false` — the user must resend. This table gives such
 * followers a durable, non-terminal deferred owner: the bounded immutable
 * replay envelope plus exact source/scope identity, WITHOUT reusing
 * `turn_recovery_jobs` (issue #3295 explicitly forbids generalizing it).
 *
 * Lifecycle (enforced by CHECK + the store's fenced transitions):
 *   pending -> claimed -> dispatched_commit -> terminal_completed
 *   claimed -> pending                (fenced requeue, pre-commit only)
 *   claimed -> terminal_quarantined  (undispatchable envelope)
 *   any non-terminal -> terminal_operator (explicit operator remediation)
 * `dispatched_commit` is the requirement-4 point of no return: once provider
 * dispatch is durably marked, automatic input replay is permanently vetoed.
 *
 * One obligation per (scope, inbound_seq) — enforced by a unique index; the
 * drain supervisor (slice S3) claims strictly by lowest inbound_seq per scope.
 *
 * Fail-closed properties: idempotent via IF NOT EXISTS on a brand-new table
 * (no rebuild, no data movement); SAVEPOINT-wrapped so a partial DDL error
 * rolls back untouched.
 */
export function runMigration62(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_62');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS deferred_turn_obligations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        delivery_jid TEXT NOT NULL,
        inbound_seq INTEGER NOT NULL
          CHECK (typeof(inbound_seq) = 'integer' AND inbound_seq > 0),
        source_message_id TEXT NOT NULL,
        received_at_unix INTEGER NOT NULL
          CHECK (typeof(received_at_unix) = 'integer' AND received_at_unix > 0),
        replay_safe INTEGER NOT NULL CHECK (replay_safe = 1),
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        replay_text TEXT NOT NULL,
        is_group INTEGER NOT NULL CHECK (is_group IN (0, 1)),
        group_name TEXT,
        content_type TEXT NOT NULL,
        tool_scope_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN (
            'pending', 'claimed', 'dispatched_commit',
            'terminal_completed', 'terminal_quarantined', 'terminal_operator'
          )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        claim_token TEXT,
        claim_epoch INTEGER NOT NULL DEFAULT 0,
        claimed_at TEXT,
        claim_expires_at TEXT,
        last_error_class TEXT,
        terminal_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS deferred_turn_obligations_source
        ON deferred_turn_obligations (scope, inbound_seq)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS deferred_turn_obligations_drain
        ON deferred_turn_obligations (scope, status, inbound_seq)
    `);
    db.exec('RELEASE migration_62');
  } catch (err) {
    db.exec('ROLLBACK TO migration_62');
    db.exec('RELEASE migration_62');
    throw err;
  }
}
