import type { DatabaseSync } from 'node:sqlite';

/**
 * Durable background work: Work Ledger + Results Outbox (PR1a — schema only).
 *
 * PROBLEM (evidence, 2026-07-24): in-session background workers — agent-spawned
 * subagents, background bash, CI babysitters — exist only inside the provider
 * child's process tree. They have no registration row, their results ride the
 * parent's stdout/memory, and delivery rides the parent's turn. When the parent
 * dies (the 30-min hard-watchdog SIGKILL wave observed in production, 07-22→23, plus the
 * exit-143 class), the whole tree dies with it and finished work is stranded:
 * pushed branches with no chat notice, completed analyses never delivered,
 * "the chat just stops". PR #2226's liveness gate stops the *false-positive*
 * kills; it does not make surviving work durable. This migration is the
 * durability half.
 *
 * TWO TABLES, ONE CONTRACT:
 *   `background_work` — the ledger. A sanctioned worker is REGISTERED at spawn,
 *     binding it to a `conversation_key` (canonical, alias-stable chat identity)
 *     rather than to its parent session's lifetime. A lease + parent pid make
 *     "is the parent still alive?" a deterministic query instead of an inference.
 *   `work_results` — the outbox. Workers MUST write results here (durable summary
 *     + artifact ref), never only to parent stdout. An independent delivery daemon
 *     (PR1b) drains it, so delivery no longer depends on any session being alive.
 *
 * DELIVERY HONESTY (why `recovered` and `produced_at` are first-class columns):
 * this repo has a verified findings class about stale delivery arriving as a
 * false current-state claim — reachability alerts not revalidated at delivery,
 * digest retries not episode-fenced, a clear-before-open leaving an incident
 * falsely open. A result produced by an orphaned worker and delivered hours
 * later, after its parent died, is exactly that failure shape. So the schema
 * records whether the producing worker was orphaned (`recovered`) and when the
 * result was actually produced (`produced_at`), which lets the delivery layer
 * mark the message and state its age instead of presenting stale output as
 * current. These are columns, not a formatting concern, because retrofitting
 * them into a delivery contract later is far more expensive than carrying them
 * from the start.
 *
 * SCOPE OF `worker_kind` (PR1): 'agent_subagent' only. Operator-side scripts
 * (babysitters) join later via a CLI shim; the CHECK constraint is the explicit
 * gate so an unsanctioned kind fails loudly at write time rather than silently
 * creating an unmanaged class.
 *
 * NOT append-only: unlike `recovery_plans` / `inbound_disposition_links`, these
 * rows are working state that legitimately transitions (registered→running→
 * completed, pending→delivered). Immutability is enforced where it matters
 * instead — `delivery_dedupe_key` is UNIQUE, which is what makes at-least-once
 * delivery safe to retry (the bot-errors dispatcher discipline).
 *
 * NUMBERING: 46 is the next contiguous number after 45 on main;
 * `tests/core/migration-safety.test.ts` enforces gap-free N, N+1, ... .
 */

const BACKGROUND_WORK_STATES = "('registered', 'running', 'completed', 'failed', 'orphaned')";
const RESULT_OUTCOMES = "('completed', 'failed')";
const DELIVERY_STATES = "('pending', 'delivering', 'delivered', 'failed')";

/** Epoch-millisecond bound shared with turn_recovery_jobs' integer guards. */
const EPOCH_MS_CHECK = (col: string): string =>
  `(typeof(${col}) = 'integer' AND ${col} BETWEEN 1 AND 9007199254740991)`;

export function runMigration46(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_work (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL UNIQUE,
      parent_session_id TEXT NOT NULL,
      parent_pid INTEGER
        CHECK (parent_pid IS NULL OR (typeof(parent_pid) = 'integer' AND parent_pid > 0)),
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      worker_kind TEXT NOT NULL CHECK (worker_kind IN ('agent_subagent')),
      spec_digest TEXT NOT NULL,
      summary_label TEXT,
      state TEXT NOT NULL DEFAULT 'registered'
        CHECK (state IN ${BACKGROUND_WORK_STATES}),
      lease_expires_at INTEGER
        CHECK (lease_expires_at IS NULL OR ${EPOCH_MS_CHECK('lease_expires_at')}),
      created_at INTEGER NOT NULL CHECK ${EPOCH_MS_CHECK('created_at')},
      updated_at INTEGER NOT NULL CHECK ${EPOCH_MS_CHECK('updated_at')},
      completed_at INTEGER
        CHECK (completed_at IS NULL OR ${EPOCH_MS_CHECK('completed_at')})
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id TEXT NOT NULL
        REFERENCES background_work(work_id) ON DELETE RESTRICT,
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ${RESULT_OUTCOMES}),
      summary TEXT NOT NULL,
      artifact_path TEXT,
      recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
      produced_at INTEGER NOT NULL CHECK ${EPOCH_MS_CHECK('produced_at')},
      delivery_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (delivery_state IN ${DELIVERY_STATES}),
      delivery_dedupe_key TEXT NOT NULL UNIQUE,
      delivery_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(delivery_attempts) = 'integer' AND delivery_attempts >= 0),
      delivered_at INTEGER
        CHECK (delivered_at IS NULL OR ${EPOCH_MS_CHECK('delivered_at')})
    )
  `);

  // Orphan sweep: find running work whose lease has expired (parent presumed dead).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_background_work_state_lease
      ON background_work(state, lease_expires_at)
  `);

  // Parent-death fan-out: mark every live row owned by a session that just died.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_background_work_parent_session
      ON background_work(parent_session_id, state)
  `);

  // Delivery daemon claim path: oldest undelivered result first.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_results_delivery
      ON work_results(delivery_state, produced_at)
  `);
}
