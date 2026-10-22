// Migration 66 — append-only continuity-gap closures.
//
// A recorded continuity gap (continuity-gap-ledger.ts) is a recorder-owned
// recovery plan with exactly one `started` run. Readers reject any other run
// shape, so a closure cannot be expressed by completing that run. It is a
// separate row keyed to the deterministic plan ID and the original receipt
// fingerprint instead; the plan and run stay byte-identical.
//
// Constraints mirror the closure contract (docs/runbook.md, "Close a continuity
// gap"): one closure per plan, digest shapes, disposition ↔ proof shape, and an
// insert trigger that re-derives the parent from the plan's own evidence. No
// row may be updated or deleted; a correction needs a future supersession
// contract, not an edit.
//
// linked_inbound_seq and terminal_record_id deliberately carry no foreign key:
// database retention prunes completed inbound events and terminal records, and
// a RESTRICT reference from a permanent closure row would abort that sweep.
// The closure is a historical attestation made when the proof was verified.
//
// Rollback: once this migration is recorded, a binary whose ceiling is 65
// refuses the file as `future_schema` (database-compatibility.ts), so a
// binary-only rollback is unavailable without a separately proven restore.
import type { DatabaseSync } from 'node:sqlite';

const HEX64 = (column: string): string =>
  `(length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;
const OPTIONAL_HEX64 = (column: string): string =>
  `(${column} IS NULL OR ${HEX64(column)})`;
const UTC_INSTANT = (column: string): string =>
  `(${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`
  + ` AND length(${column}) <= 30 AND julianday(${column}) IS NOT NULL)`;
const BOUNDED_TEXT = (column: string, maxBytes: number): string =>
  `(${column} = trim(${column}) AND length(${column}) > 0`
  + ` AND length(CAST(${column} AS BLOB)) <= ${maxBytes})`;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS continuity_gap_closures (
    plan_id TEXT PRIMARY KEY NOT NULL
      REFERENCES recovery_plans(plan_id) ON DELETE RESTRICT,
    contract_version TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    receipt_fingerprint TEXT NOT NULL,
    original_classification TEXT NOT NULL,
    original_content_type TEXT NOT NULL,
    disposition TEXT NOT NULL,
    proof_kind TEXT NOT NULL,
    evidence_manifest_sha256 TEXT NOT NULL,
    original_manifest_sha256 TEXT NOT NULL,
    proof_set_sha256 TEXT NOT NULL,
    linked_inbound_seq INTEGER NOT NULL,
    linked_message_sha256 TEXT NOT NULL,
    terminal_record_id INTEGER,
    audio_media_sha256 TEXT,
    audio_transcript_sha256 TEXT,
    ambiguity_resolution_sha256 TEXT,
    decision_record_sha256 TEXT,
    decision_source TEXT,
    policy_sha256 TEXT,
    policy_version TEXT,
    actor TEXT NOT NULL,
    authority TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (length(plan_id) = 82 AND substr(plan_id, 1, 18) = 'continuity-gap:v1:'
      AND substr(plan_id, 19) NOT GLOB '*[^0-9a-f]*'),
    CHECK (contract_version = 'continuity-gap-closure.v1'),
    CHECK ${HEX64('operation_id')},
    CHECK ${HEX64('receipt_fingerprint')},
    CHECK (original_classification IN ('absent', 'observed_not_admitted', 'ambiguous')),
    CHECK (length(original_content_type) BETWEEN 1 AND 64
      AND original_content_type GLOB '[a-z]*'
      AND original_content_type NOT GLOB '*[^a-z0-9_-]*'),
    CHECK (disposition IN ('addressed', 'declined')),
    CHECK ${HEX64('evidence_manifest_sha256')},
    CHECK ${HEX64('original_manifest_sha256')},
    CHECK ${HEX64('proof_set_sha256')},
    CHECK (typeof(linked_inbound_seq) = 'integer' AND linked_inbound_seq > 0),
    CHECK ${HEX64('linked_message_sha256')},
    CHECK (terminal_record_id IS NULL
      OR (typeof(terminal_record_id) = 'integer' AND terminal_record_id > 0)),
    CHECK ${OPTIONAL_HEX64('audio_media_sha256')},
    CHECK ${OPTIONAL_HEX64('audio_transcript_sha256')},
    CHECK ${OPTIONAL_HEX64('ambiguity_resolution_sha256')},
    CHECK ${OPTIONAL_HEX64('decision_record_sha256')},
    CHECK ${OPTIONAL_HEX64('policy_sha256')},
    CHECK (decision_source IS NULL OR decision_source IN (
      'original_sender_inbound@1', 'owner_inbound@1'
    )),
    CHECK (policy_version IS NULL OR ${BOUNDED_TEXT('policy_version', 128)}),
    CHECK ((policy_sha256 IS NULL) = (policy_version IS NULL)),
    CHECK ${BOUNDED_TEXT('actor', 256)},
    CHECK ${BOUNDED_TEXT('authority', 512)},
    CHECK ${UTC_INSTANT('observed_at')},
    CHECK ${UTC_INSTANT('decided_at')},
    CHECK (julianday(decided_at) <= julianday(observed_at)),
    CHECK ((original_classification = 'ambiguous') = (ambiguity_resolution_sha256 IS NOT NULL)),
    CHECK (
      (
        disposition = 'addressed'
        AND proof_kind = 'live_reissue'
        AND terminal_record_id IS NOT NULL
        AND decision_record_sha256 IS NULL
        AND decision_source IS NULL
        AND (
          (original_content_type = 'audio'
            AND audio_media_sha256 IS NOT NULL AND audio_transcript_sha256 IS NOT NULL)
          OR (original_content_type <> 'audio'
            AND audio_media_sha256 IS NULL AND audio_transcript_sha256 IS NULL)
        )
      )
      OR (
        disposition = 'declined'
        AND proof_kind IN ('sender_declined', 'owner_declined')
        AND terminal_record_id IS NULL
        AND decision_record_sha256 IS NOT NULL
        AND decision_source IS CASE proof_kind
          WHEN 'sender_declined' THEN 'original_sender_inbound@1'
          ELSE 'owner_inbound@1'
        END
        AND policy_sha256 IS NOT NULL
        AND audio_transcript_sha256 IS NULL
        AND (original_content_type = 'audio' OR audio_media_sha256 IS NULL)
      )
    )
  )
`;

// The parent must still be the recorder's open gap for this exact receipt and
// classification: the evidence_ref prefix embeds the receipt fingerprint.
const CREATE_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS continuity_gap_closures_validate_insert
  BEFORE INSERT ON continuity_gap_closures
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_plans plans
    JOIN recovery_runs runs ON runs.recovery_plan_id = plans.plan_id
    WHERE plans.plan_id = NEW.plan_id
      AND plans.origin = 'operator'
      AND plans.actor = 'continuity_manifest_recorder'
      AND substr(plans.evidence_ref, 1, 91)
        = 'continuity-gap:v1;receipt=' || NEW.receipt_fingerprint || ';'
      AND runs.trigger = 'continuity_gap_' || NEW.original_classification
      AND runs.status = 'started'
      AND runs.completed_at IS NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'continuity_gap_closures: parent is not an open continuity gap');
  END;

  CREATE TRIGGER IF NOT EXISTS continuity_gap_closures_append_only_update
  BEFORE UPDATE ON continuity_gap_closures
  BEGIN
    SELECT RAISE(ABORT, 'continuity_gap_closures: append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS continuity_gap_closures_append_only_delete
  BEFORE DELETE ON continuity_gap_closures
  BEGIN
    SELECT RAISE(ABORT, 'continuity_gap_closures: append-only');
  END;
`;

export function runMigration66(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_66');
  try {
    db.exec(CREATE_TABLE);
    db.exec(CREATE_TRIGGERS);
    db.exec('RELEASE migration_66');
  } catch (err) {
    db.exec('ROLLBACK TO migration_66');
    db.exec('RELEASE migration_66');
    throw err;
  }
}
