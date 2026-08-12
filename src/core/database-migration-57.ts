import type { DatabaseSync } from 'node:sqlite';

/**
 * Migration 57 — capability-obligation replay schema (D3/D4/D5/D6/D7).
 *
 * Separate append-only capability-debt lifecycle. Completed delivery evidence
 * (turn_terminal_records / turn_recovery_jobs) is never reopened; obligations are
 * their own ledger:
 *
 *   capability_obligations        — one row per obligation; guarded state machine;
 *                                   source identity / contract / retained-media
 *                                   columns immutable after insert; rows never
 *                                   deleted. Group obligations are BORN
 *                                   `waiting_approval` and can only leave it
 *                                   toward `waiting_capability` when a current,
 *                                   destination-specific `scope='group'` approval
 *                                   row exists (D7).
 *   capability_obligation_events  — append-only audit (creation, non-creation
 *                                   decisions incl. not_created_side_effect_uncertain,
 *                                   transitions, operator actions).
 *   capability_attestations       — immutable exact-bound readiness records; only
 *                                   one-way revocation is writable (D5).
 *   capability_drain_approvals    — append-only destination-specific approvals;
 *                                   a DM-scope approval can never unlock a group
 *                                   obligation (D7).
 *   capability_execution_receipts — typed fulfillment evidence correlated by
 *                                   tool-use id (D6); append-only.
 *
 * Trigger style follows database-migrations-37-40.ts: identity immutability via
 * unconditional `BEFORE UPDATE OF <col…>` RAISEs (fires even on same-value SETs),
 * a state-transition whitelist, and RAISE-guarded DELETEs. Everything here is
 * additive and idempotent (IF NOT EXISTS throughout); the old-release schema
 * ceiling (database-compatibility.ts) makes binary-only rollback invalid by
 * design — rollback is the coupled binary+DB restore documented in the feature
 * runbook.
 */
export function runMigration57(db: DatabaseSync): void {
  // AS-04 turn correlation (spec §3.2b): tool_calls rows name the exact turn
  // they belong to, populated at the single writer (registry.call). Additive
  // and idempotent — NULL on rows written before this migration or by paths
  // without a live turn, which the effect fold treats as enumeration-incomplete.
  const toolCallColumns = new Set(
    (db.prepare('PRAGMA table_info(tool_calls)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  // An empty set = the table itself is absent (legacy/partial fixtures the
  // late-migration path must no-op on); such DBs carry no tool rows to correlate.
  if (toolCallColumns.size > 0) {
    if (!toolCallColumns.has('logical_turn_id')) {
      db.exec('ALTER TABLE tool_calls ADD COLUMN logical_turn_id TEXT');
    }
    if (!toolCallColumns.has('source_inbound_seq')) {
      db.exec('ALTER TABLE tool_calls ADD COLUMN source_inbound_seq INTEGER');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_obligations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- source identity (immutable after insert)
      source_inbound_seq INTEGER NOT NULL,
      source_message_id TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      delivery_jid TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      is_group INTEGER NOT NULL CHECK (is_group IN (0, 1)),
      group_name TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('per_chat')),
      origin_recovery_job_id INTEGER,
      replay_text TEXT NOT NULL CHECK (length(replay_text) > 0),
      content_type_hint TEXT,
      -- capability contract (immutable)
      contract_version TEXT NOT NULL,
      required_capability TEXT NOT NULL,
      capability_params TEXT NOT NULL CHECK (json_valid(capability_params)),
      input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
      -- D6: the digest execution evidence must reproduce (media sha256, or
      -- sha256 of the canonical source token) — derived at creation.
      source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
      -- The canonical execution source STRING the replayed agent must pass to
      -- execute_capability (its sha256 is source_digest). Exactly one of
      -- {source_token, retained_media_path} is set (enforced below): the URL /
      -- command remainder for token obligations, NULL for media obligations
      -- (retained_media_path is the source there).
      source_token TEXT,
      creation_evidence_event_id INTEGER,
      -- retained-media identity (immutable; all-or-none; D3)
      retained_media_path TEXT,
      media_sha256 TEXT CHECK (media_sha256 IS NULL OR length(media_sha256) = 64),
      media_bytes INTEGER CHECK (media_bytes IS NULL OR media_bytes >= 0),
      retention_policy_version TEXT,
      -- lifecycle (mutable only through the guarded machine below)
      state TEXT NOT NULL CHECK (state IN (
        'waiting_capability', 'waiting_approval', 'claimed', 'completed',
        'exhausted', 'blocked_media', 'blocked_ambiguous', 'cancelled'
      )),
      claim_token TEXT,
      claim_epoch INTEGER NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TEXT,
      completion_proof_id TEXT,
      capability_execution_receipt_id INTEGER,
      drain_approval_id INTEGER,
      -- D7: the LIVE drain facts recorded at approval consumption; the
      -- group-approval gate requires them to equal the consumed approval's.
      drain_release_sha TEXT,
      drain_manifest_digest TEXT,
      drain_run_id TEXT,
      drain_attestation_digest TEXT,
      creation_reason TEXT NOT NULL CHECK (
        creation_reason = 'typed_deferral_signal'
        OR creation_reason LIKE 'reviewed_backfill:%'
      ),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_inbound_seq, source_message_id, contract_version, required_capability),
      CHECK (
        (retained_media_path IS NULL AND media_sha256 IS NULL
          AND media_bytes IS NULL AND retention_policy_version IS NULL)
        OR (retained_media_path IS NOT NULL AND media_sha256 IS NOT NULL
          AND media_bytes IS NOT NULL AND retention_policy_version IS NOT NULL)
      ),
      -- Exactly one execution source: a token obligation carries source_token
      -- and no media; a media obligation carries retained_media_path and no
      -- token. Neither-both is unrepresentable.
      CHECK (
        (retained_media_path IS NULL AND source_token IS NOT NULL)
        OR (retained_media_path IS NOT NULL AND source_token IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_capability_obligations_state
      ON capability_obligations (state, next_attempt_at);

    CREATE TABLE IF NOT EXISTS capability_obligation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER,
      action TEXT NOT NULL CHECK (action IN (
        'obligation.create', 'obligation.not_created', 'obligation.claim',
        'obligation.requeue', 'obligation.dispatch', 'obligation.settle',
        'obligation.block', 'obligation.cancel', 'obligation.re_arm',
        'obligation.migrate', 'approval.record', 'attestation.record'
      )),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('runtime', 'supervisor', 'operator')),
      actor_id TEXT,
      reason_code TEXT,
      source_hash TEXT,
      claim_epoch INTEGER,
      detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_capability_obligation_events_obligation
      ON capability_obligation_events (obligation_id);

    CREATE TABLE IF NOT EXISTS capability_attestations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      runtime_user TEXT NOT NULL,
      release_sha TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      harness_type TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      capability TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_version TEXT,
      skill_digest TEXT NOT NULL,
      resolver_digest TEXT,
      dependency_versions TEXT NOT NULL CHECK (json_valid(dependency_versions)),
      media_root TEXT NOT NULL,
      canary_id TEXT NOT NULL,
      canary_result TEXT NOT NULL CHECK (canary_result IN ('pass', 'fail')),
      probe_version TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      attested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_capability_attestations_lookup
      ON capability_attestations (capability, contract_version, expires_at);

    CREATE TABLE IF NOT EXISTS capability_drain_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER NOT NULL,
      destination_jid TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('dm', 'group')),
      release_sha TEXT NOT NULL,
      attestation_digest TEXT,
      manifest_digest TEXT NOT NULL,
      drain_run_id TEXT NOT NULL,
      approver TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- D7: a group approval without an attestation digest is unrepresentable.
      CHECK (scope <> 'group' OR attestation_digest IS NOT NULL)
    );

    CREATE INDEX IF NOT EXISTS idx_capability_drain_approvals_obligation
      ON capability_drain_approvals (obligation_id);

    CREATE TABLE IF NOT EXISTS capability_execution_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      obligation_id INTEGER NOT NULL,
      logical_turn_id TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      media_digest TEXT,
      result_status TEXT NOT NULL CHECK (result_status IN ('ok', 'error')),
      output_evidence TEXT CHECK (output_evidence IS NULL OR json_valid(output_evidence)),
      -- D6: the receipt names the exact claim/attempt it proves.
      claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
      attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
      -- D6: DERIVED from the resolver's structured evidence (never copied);
      -- NULL = evidence absent/underivable, which can never complete.
      source_digest TEXT CHECK (source_digest IS NULL OR length(source_digest) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (obligation_id, tool_use_id)
    );

    -- ── capability_obligations guards ────────────────────────────────────────

    CREATE TRIGGER IF NOT EXISTS capability_obligations_insert_state_gate
    BEFORE INSERT ON capability_obligations
    WHEN NEW.state NOT IN ('waiting_capability', 'waiting_approval')
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: rows are created in an initial state only');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligations_group_insert_gate
    BEFORE INSERT ON capability_obligations
    WHEN NEW.is_group = 1 AND NEW.state <> 'waiting_approval'
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: group obligations must be created waiting_approval');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligations_identity_immutable
    BEFORE UPDATE OF
      source_inbound_seq, source_message_id, conversation_key, delivery_jid,
      sender_jid, sender_name, is_group, group_name, scope,
      origin_recovery_job_id, replay_text, content_type_hint,
      contract_version, required_capability, capability_params, input_digest,
      source_digest, source_token,
      creation_evidence_event_id, retained_media_path, media_sha256,
      media_bytes, retention_policy_version, creation_reason, created_at
    ON capability_obligations
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: identity/contract/media columns are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligations_state_whitelist
    BEFORE UPDATE OF state ON capability_obligations
    WHEN NEW.state <> OLD.state AND NOT (
      (OLD.state = 'waiting_approval' AND NEW.state IN ('waiting_capability', 'cancelled'))
      OR (OLD.state = 'waiting_capability' AND NEW.state IN ('claimed', 'blocked_media', 'cancelled'))
      OR (OLD.state = 'claimed' AND NEW.state IN (
        'completed', 'waiting_capability', 'exhausted', 'blocked_media', 'blocked_ambiguous'
      ))
      OR (OLD.state = 'blocked_media' AND NEW.state IN ('waiting_capability', 'cancelled'))
      OR (OLD.state = 'blocked_ambiguous' AND NEW.state IN ('waiting_capability', 'cancelled'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: illegal state transition');
    END;

    -- D7: leaving waiting_approval must name the exact approval being consumed
    -- (NEW.drain_approval_id) AND record the live drain facts on the row
    -- (NEW.drain_*); the gate requires the consumed approval to bind THIS
    -- obligation and destination, carry an attestation digest, be unrevoked and
    -- unexpired, and match every recorded drain fact. The sanctioned caller
    -- (consumeGroupDrainApproval) writes the drain facts from LIVE values it
    -- verified; a raw transition that omits or forges them aborts here.
    CREATE TRIGGER IF NOT EXISTS capability_obligations_group_approval_gate
    BEFORE UPDATE OF state ON capability_obligations
    WHEN OLD.is_group = 1
      AND OLD.state = 'waiting_approval'
      AND NEW.state = 'waiting_capability'
      AND (
        NEW.drain_approval_id IS NULL
        OR NEW.drain_release_sha IS NULL
        OR NEW.drain_manifest_digest IS NULL
        OR NEW.drain_run_id IS NULL
        OR NEW.drain_attestation_digest IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM capability_drain_approvals a
          WHERE a.id = NEW.drain_approval_id
            AND a.obligation_id = OLD.id
            AND a.scope = 'group'
            AND a.destination_jid = OLD.delivery_jid
            AND a.attestation_digest IS NOT NULL
            AND a.release_sha = NEW.drain_release_sha
            AND a.manifest_digest = NEW.drain_manifest_digest
            AND a.drain_run_id = NEW.drain_run_id
            AND a.attestation_digest = NEW.drain_attestation_digest
            AND a.revoked_at IS NULL
            AND datetime(a.expires_at) > datetime('now')
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: group drain requires consuming a current destination-specific approval');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligations_completed_requires_proofs
    BEFORE UPDATE OF state ON capability_obligations
    WHEN NEW.state = 'completed'
      AND OLD.state = 'claimed'
      AND (
        NEW.completion_proof_id IS NULL
        OR NEW.capability_execution_receipt_id IS NULL
        -- D6: the named receipt must prove THIS obligation's CURRENT attempt —
        -- same obligation, same claim epoch, same attempt, non-error result,
        -- same contract version, same input digest, and the retained-media
        -- digest where the obligation carries media.
        OR NOT EXISTS (
          SELECT 1 FROM capability_execution_receipts r
          WHERE r.id = NEW.capability_execution_receipt_id
            AND r.obligation_id = NEW.id
            AND r.claim_epoch = OLD.claim_epoch
            AND r.attempt_number = NEW.attempt_count
            AND r.result_status = 'ok'
            AND r.contract_version = NEW.contract_version
            AND r.input_digest = NEW.input_digest
            AND r.source_digest = NEW.source_digest
            AND (NEW.media_sha256 IS NULL OR r.media_digest = NEW.media_sha256)
            -- The receipt's turn must be the MINTED turn that terminalized,
            -- with PROVEN echoed delivery, and the completion proof must name
            -- that exact terminal record.
            AND EXISTS (
              SELECT 1 FROM turn_terminal_records t
              JOIN inbound_events ie ON ie.seq = t.inbound_seq
              WHERE ie.message_id = 'obl:' || NEW.id || ':' || NEW.attempt_count
                AND t.logical_turn_id = r.logical_turn_id
                AND t.delivery_kind = 'echoed'
                AND t.delivery_op_id IS NOT NULL
                AND NEW.completion_proof_id = 'ttr:' || t.id
            )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: completed requires a bound execution receipt and a completion proof');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligations_no_delete
    BEFORE DELETE ON capability_obligations
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligations: rows are never deleted (append-only ledger)');
    END;

    -- ── capability_obligation_events guards (strict append-only) ─────────────

    CREATE TRIGGER IF NOT EXISTS capability_obligation_events_no_update
    BEFORE UPDATE ON capability_obligation_events
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligation_events: append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_obligation_events_no_delete
    BEFORE DELETE ON capability_obligation_events
    BEGIN
      SELECT RAISE(ABORT, 'capability_obligation_events: append-only');
    END;

    -- ── capability_attestations guards (immutable + one-way revocation) ──────

    CREATE TRIGGER IF NOT EXISTS capability_attestations_immutable
    BEFORE UPDATE OF
      host_id, runtime_user, release_sha, schema_version, provider_id,
      harness_type, contract_version, capability, skill_name, skill_version,
      skill_digest, resolver_digest, dependency_versions, media_root,
      canary_id, canary_result, probe_version, nonce, attested_at,
      expires_at, created_at
    ON capability_attestations
    BEGIN
      SELECT RAISE(ABORT, 'capability_attestations: attestation fields are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_attestations_revocation_one_way
    BEFORE UPDATE OF revoked_at ON capability_attestations
    WHEN OLD.revoked_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'capability_attestations: revocation is one-way (immutable once set)');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_attestations_no_delete
    BEFORE DELETE ON capability_attestations
    BEGIN
      SELECT RAISE(ABORT, 'capability_attestations: append-only');
    END;

    -- ── capability_drain_approvals guards (append-only + one-way revocation) ─

    CREATE TRIGGER IF NOT EXISTS capability_drain_approvals_immutable
    BEFORE UPDATE OF
      obligation_id, destination_jid, scope, release_sha, attestation_digest,
      manifest_digest, drain_run_id, approver, approved_at, expires_at, created_at
    ON capability_drain_approvals
    BEGIN
      SELECT RAISE(ABORT, 'capability_drain_approvals: approval fields are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_drain_approvals_revocation_one_way
    BEFORE UPDATE OF revoked_at ON capability_drain_approvals
    WHEN OLD.revoked_at IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'capability_drain_approvals: revocation is one-way (immutable once set)');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_drain_approvals_no_delete
    BEFORE DELETE ON capability_drain_approvals
    BEGIN
      SELECT RAISE(ABORT, 'capability_drain_approvals: append-only');
    END;

    -- ── capability_execution_receipts guards (strict append-only) ────────────

    CREATE TRIGGER IF NOT EXISTS capability_execution_receipts_no_update
    BEFORE UPDATE ON capability_execution_receipts
    BEGIN
      SELECT RAISE(ABORT, 'capability_execution_receipts: append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS capability_execution_receipts_no_delete
    BEFORE DELETE ON capability_execution_receipts
    BEGIN
      SELECT RAISE(ABORT, 'capability_execution_receipts: append-only');
    END;
  `);
}
