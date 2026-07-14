import type { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = [
  'inbound_events',
  'outbound_ops',
  'turn_terminal_records',
  'turn_recovery_jobs',
  'recovery_plans',
  'inbound_disposition_links',
  'turn_delivery_corroboration',
] as const;

const ECMASCRIPT_TRIM_CODEPOINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288, 65279,
] as const;
const SQLITE_ECMASCRIPT_TRIM_CHARS = `char(${ECMASCRIPT_TRIM_CODEPOINTS.join(',')})`;

function sqlEcmascriptTrim(expression: string): string {
  return `trim(${expression}, ${SQLITE_ECMASCRIPT_TRIM_CHARS})`;
}

const DELIVERY_PROOF_CANDIDATES_SELECT = `
  SELECT
    target.seq AS target_seq,
    target.conversation_key,
    target.chat_jid,
    terminal.id AS terminal_record_id,
    selected.id AS selected_op_id,
    NULL AS recovery_job_id,
    NULL AS completion_proof_id,
    CASE
      WHEN terminal.delivery_kind = 'echoed' AND selected.status = 'echoed'
        THEN 'selected_echoed'
      ELSE 'selected_corroborated'
    END AS evidence_basis
  FROM inbound_events target
  JOIN turn_terminal_records terminal
    ON terminal.inbound_seq = target.seq
   AND terminal.inbound_seq_key = target.seq
   AND terminal.conversation_key = target.conversation_key
   AND terminal.delivery_jid = target.chat_jid
  JOIN outbound_ops selected
    ON selected.id = terminal.delivery_op_id
   AND selected.source_inbound_seq = target.seq
   AND selected.conversation_key = target.conversation_key
   AND selected.chat_jid = target.chat_jid
   AND selected.is_terminal = 1
  WHERE target.processing_status = 'complete'
    AND target.completed_at IS NOT NULL
    AND terminal.inbound_disposition = 'finalized_replied'
    AND (
      (terminal.delivery_kind = 'echoed' AND selected.status = 'echoed')
      OR (
        terminal.delivery_kind = 'delivery_unknown'
        AND EXISTS (
          SELECT 1
          FROM turn_delivery_corroboration proof
          JOIN outbound_ops corroborating
            ON corroborating.id = proof.corroborating_op_id
          WHERE proof.terminal_record_id = terminal.id
            AND selected.source_inbound_seq IS NOT NULL
            AND corroborating.source_inbound_seq = selected.source_inbound_seq
            AND corroborating.conversation_key = selected.conversation_key
            AND corroborating.chat_jid = selected.chat_jid
            AND corroborating.status = 'echoed'
            AND corroborating.id > selected.id
        )
      )
    )

  UNION ALL

  SELECT
    target.seq AS target_seq,
    target.conversation_key,
    target.chat_jid,
    terminal.id AS terminal_record_id,
    selected.id AS selected_op_id,
    recovery.id AS recovery_job_id,
    recovery.completion_proof_id,
    'selected_echoed_recovery' AS evidence_basis
  FROM inbound_events target
  JOIN turn_terminal_records terminal
    ON terminal.inbound_seq = target.seq
   AND terminal.inbound_seq_key = target.seq
   AND terminal.conversation_key = target.conversation_key
   AND terminal.delivery_jid = target.chat_jid
  JOIN outbound_ops selected
    ON selected.id = terminal.delivery_op_id
   AND selected.source_inbound_seq = target.seq
   AND selected.conversation_key = target.conversation_key
   AND selected.chat_jid = target.chat_jid
   AND selected.is_terminal = 1
   AND selected.status = 'echoed'
  JOIN turn_recovery_jobs recovery
    ON recovery.terminal_record_id = terminal.id
   AND recovery.scope = terminal.scope
   AND recovery.conversation_key = target.conversation_key
   AND recovery.delivery_jid = target.chat_jid
   AND recovery.source_inbound_seq = target.seq
   AND recovery.source_inbound_seq_key = target.seq
   AND recovery.source_logical_turn_id = terminal.logical_turn_id
   AND recovery.source_manager_id = terminal.manager_id
   AND recovery.source_generation = terminal.generation
   AND recovery.source_message_id = target.message_id
   AND recovery.owner_logical_turn_id = terminal.recovery_owner_logical_turn_id
   AND recovery.owner_manager_id = terminal.recovery_owner_manager_id
   AND recovery.owner_generation = terminal.recovery_owner_generation
  WHERE target.processing_status = 'complete'
    AND target.completed_at IS NOT NULL
    AND target.terminal_reason = 'response_echoed'
    AND terminal.inbound_disposition = 'transferred_to_recovery_owner'
    AND terminal.delivery_kind IN ('enqueued', 'flushed', 'delivery_unknown')
    AND selected.submitted_at IS NOT NULL
    AND selected.echoed_at IS NOT NULL
    AND selected.wa_message_id IS NOT NULL
    AND length(${sqlEcmascriptTrim('selected.wa_message_id')}) > 0
    AND recovery.state = 'completed'
    AND recovery.completed_at IS NOT NULL
    AND recovery.completion_kind = 'echo'
    AND recovery.completion_proof_id = 'outbound-op:' || CAST(selected.id AS TEXT)
    AND recovery.claim_token = 'echo-delivery:' || CAST(selected.id AS TEXT)
    AND recovery.echo_conflict_at IS NULL
    AND recovery.echo_conflict_reason IS NULL
    AND julianday(target.received_at) IS NOT NULL
    AND julianday(target.completed_at) IS NOT NULL
    AND julianday(selected.created_at) IS NOT NULL
    AND julianday(selected.submitted_at) IS NOT NULL
    AND julianday(selected.echoed_at) IS NOT NULL
    AND julianday(terminal.created_at) IS NOT NULL
    AND julianday(recovery.created_at) IS NOT NULL
    AND julianday(recovery.claimed_at) IS NOT NULL
    AND julianday(recovery.claim_expires_at) IS NOT NULL
    AND julianday(recovery.completed_at) IS NOT NULL
    AND julianday(target.received_at) <= julianday(target.completed_at)
    AND julianday(target.received_at) <= julianday(selected.created_at)
    AND julianday(selected.created_at) <= julianday(selected.submitted_at)
    AND julianday(selected.submitted_at) <= julianday(selected.echoed_at)
    AND julianday(selected.echoed_at) <= julianday(target.completed_at)
    AND julianday(selected.created_at) <= julianday(terminal.created_at)
    AND julianday(terminal.created_at) <= julianday(recovery.created_at)
    AND julianday(recovery.created_at) <= julianday(selected.echoed_at)
    AND julianday(recovery.created_at) <= julianday(target.completed_at)
    AND julianday(target.completed_at) <= julianday(recovery.completed_at)
    AND julianday(recovery.created_at) <= julianday(recovery.claimed_at)
    AND julianday(recovery.claimed_at) <= julianday(recovery.completed_at)
    AND julianday(recovery.completed_at) <= julianday(recovery.claim_expires_at)
`;

function assertRequiredTables(db: DatabaseSync): void {
  const presentTables = new Set(
    (db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (
          'inbound_events', 'outbound_ops', 'turn_terminal_records',
          'turn_recovery_jobs', 'recovery_plans', 'inbound_disposition_links',
          'turn_delivery_corroboration'
        )
    `).all() as Array<{ name: string }>).map((row) => row.name),
  );
  const missingTables = REQUIRED_TABLES.filter((table) => !presentTables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`migration 43 missing required tables: ${missingTables.join(', ')}`);
  }
}

function assertSchema42ClosuresCanUpgrade(db: DatabaseSync): void {
  const duplicate = db.prepare(`
    SELECT inbound_seq, recovery_plan_id, COUNT(*) AS count
    FROM inbound_disposition_links
    WHERE disposition = 'superseded_by_operator_catchup'
      AND superseded_by_seq IS NOT NULL
    GROUP BY inbound_seq, recovery_plan_id
    HAVING COUNT(*) > 1
    ORDER BY inbound_seq, recovery_plan_id
    LIMIT 1
  `).get() as {
    inbound_seq: number;
    recovery_plan_id: string;
    count: number;
  } | undefined;
  if (duplicate) {
    throw new Error(
      'migration 43 duplicate operator catch-up closures for inbound '
        + `${duplicate.inbound_seq} in recovery plan ${duplicate.recovery_plan_id}`,
    );
  }

  const inconsistentGroup = db.prepare(`
    SELECT closure.recovery_plan_id, source.conversation_key
    FROM inbound_disposition_links closure
    LEFT JOIN inbound_events source ON source.seq = closure.inbound_seq
    WHERE closure.disposition = 'superseded_by_operator_catchup'
    GROUP BY closure.recovery_plan_id, source.conversation_key
    HAVING COUNT(DISTINCT closure.superseded_by_seq) <> 1
       OR COUNT(DISTINCT closure.actor) <> 1
       OR COUNT(DISTINCT closure.evidence_ref) <> 1
       OR SUM(CASE WHEN closure.recovery_plan_id IS NOT
                          ${sqlEcmascriptTrim('closure.recovery_plan_id')}
                    OR source.conversation_key IS NOT
                          ${sqlEcmascriptTrim('source.conversation_key')}
                    OR closure.actor IS NOT ${sqlEcmascriptTrim('closure.actor')}
                    OR closure.evidence_ref IS NOT
                          ${sqlEcmascriptTrim('closure.evidence_ref')}
                    OR length(CAST(closure.recovery_plan_id AS BLOB)) > 2048
                    OR length(CAST(source.conversation_key AS BLOB)) > 2048
                    OR length(CAST(closure.actor AS BLOB)) > 2048
                    OR length(CAST(closure.evidence_ref AS BLOB)) > 8192
                   THEN 1 ELSE 0 END) > 0
       OR SUM(CASE WHEN length(${sqlEcmascriptTrim('closure.actor')}) = 0
                   THEN 1 ELSE 0 END) > 0
       OR SUM(CASE WHEN length(${sqlEcmascriptTrim('source.conversation_key')}) = 0
                   THEN 1 ELSE 0 END) > 0
       OR SUM(CASE WHEN closure.evidence_ref IS NULL
                    OR length(${sqlEcmascriptTrim('closure.evidence_ref')}) = 0
                   THEN 1 ELSE 0 END) > 0
    ORDER BY closure.recovery_plan_id, source.conversation_key
    LIMIT 1
  `).get() as { recovery_plan_id: string; conversation_key: string } | undefined;
  if (inconsistentGroup) {
    throw new Error(
      'migration 43 pre-existing operator catch-up closure metadata is not reconstructable for '
        + `${inconsistentGroup.recovery_plan_id}/${inconsistentGroup.conversation_key}`,
    );
  }

  const incompleteGroup = db.prepare(`
    SELECT closure.recovery_plan_id, source.conversation_key
    FROM inbound_disposition_links closure
    JOIN inbound_events source ON source.seq = closure.inbound_seq
    WHERE closure.disposition = 'superseded_by_operator_catchup'
      AND EXISTS (
        SELECT 1
        FROM inbound_disposition_links pending
        JOIN inbound_events pending_source ON pending_source.seq = pending.inbound_seq
        WHERE pending.recovery_plan_id = closure.recovery_plan_id
          AND pending.disposition = 'recovery_pending_operator_catchup'
          AND pending.superseded_by_seq IS NULL
          AND pending_source.conversation_key = source.conversation_key
          AND NOT EXISTS (
            SELECT 1
            FROM inbound_disposition_links matched_closure
            WHERE matched_closure.inbound_seq = pending.inbound_seq
              AND matched_closure.recovery_plan_id = pending.recovery_plan_id
              AND matched_closure.disposition = 'superseded_by_operator_catchup'
              AND matched_closure.superseded_by_seq IS NOT NULL
          )
      )
    ORDER BY closure.recovery_plan_id, source.conversation_key
    LIMIT 1
  `).get() as { recovery_plan_id: string; conversation_key: string } | undefined;
  if (incompleteGroup) {
    throw new Error(
      'migration 43 pre-existing operator catch-up closure does not cover its exact pending set for '
        + `${incompleteGroup.recovery_plan_id}/${incompleteGroup.conversation_key}`,
    );
  }

  const invalidProof = db.prepare(`
    WITH proof_candidates AS (
      ${DELIVERY_PROOF_CANDIDATES_SELECT}
    ), proof_counts AS (
      SELECT target_seq, conversation_key, chat_jid, COUNT(*) AS count
      FROM proof_candidates
      GROUP BY target_seq, conversation_key, chat_jid
    )
    SELECT closure.id
    FROM inbound_disposition_links closure
    LEFT JOIN inbound_events source ON source.seq = closure.inbound_seq
    LEFT JOIN inbound_events target ON target.seq = closure.superseded_by_seq
    LEFT JOIN proof_counts proof
      ON proof.target_seq = target.seq
     AND proof.conversation_key = target.conversation_key
     AND proof.chat_jid = target.chat_jid
    WHERE closure.disposition = 'superseded_by_operator_catchup'
      AND (
        source.seq IS NULL
        OR target.seq IS NULL
        OR target.seq <= source.seq
        OR target.conversation_key IS NOT source.conversation_key
        OR target.chat_jid IS NOT source.chat_jid
        OR COALESCE(proof.count, 0) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM inbound_disposition_links pending
          WHERE pending.inbound_seq = closure.inbound_seq
            AND pending.recovery_plan_id = closure.recovery_plan_id
            AND pending.disposition = 'recovery_pending_operator_catchup'
            AND pending.superseded_by_seq IS NULL
        )
      )
    ORDER BY closure.id
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (invalidProof) {
    throw new Error(
      `migration 43 pre-existing operator catch-up closure lacks exactly one valid proof: ${invalidProof.id}`,
    );
  }
}

function hardenedWitnessTablePresent(db: DatabaseSync): boolean {
  return db.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'operator_catchup_closure_witnesses'
  `).get() !== undefined;
}

function assertHardenedSchema42CanAdvance(db: DatabaseSync): void {
  const requiredObjects = [
    ['view', 'operator_catchup_delivery_proof_candidates'],
    ['view', 'operator_catchup_delivery_proofs'],
    ['index', 'idx_inbound_disposition_closure_unique'],
    ['index', 'idx_operator_catchup_witness_terminal'],
    ['index', 'idx_operator_catchup_witness_selected_op'],
    ['index', 'idx_operator_catchup_witness_recovery_job'],
    ['trigger', 'operator_catchup_closure_witness_append_only_update'],
    ['trigger', 'operator_catchup_closure_witness_append_only_delete'],
    ['trigger', 'inbound_disposition_closure_validate_insert'],
    ['trigger', 'operator_catchup_closure_materialize_witness'],
    ['trigger', 'operator_catchup_closed_group_reject_pending'],
    ['trigger', 'operator_catchup_terminal_proof_immutable'],
    ['trigger', 'operator_catchup_terminal_proof_retain'],
    ['trigger', 'operator_catchup_selected_outbound_proof_immutable'],
    ['trigger', 'operator_catchup_selected_outbound_proof_retain'],
    ['trigger', 'operator_catchup_recovery_job_proof_immutable'],
    ['trigger', 'operator_catchup_recovery_job_proof_retain'],
  ] as const;
  const selectObject = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?
  `);
  const missingObjects = requiredObjects
    .filter(([type, name]) => selectObject.get(type, name) === undefined)
    .map(([, name]) => name);
  if (missingObjects.length > 0) {
    throw new Error(
      `migration 43 hardened schema 42 is missing required objects: ${missingObjects.join(', ')}`,
    );
  }

  const uncoveredClosure = db.prepare(`
    SELECT closure.id
    FROM inbound_disposition_links closure
    LEFT JOIN inbound_events source ON source.seq = closure.inbound_seq
    LEFT JOIN operator_catchup_closure_witnesses witness
      ON witness.recovery_plan_id = closure.recovery_plan_id
     AND witness.conversation_key = source.conversation_key
     AND witness.target_seq = closure.superseded_by_seq
     AND witness.actor = closure.actor
     AND witness.evidence_ref = closure.evidence_ref
    WHERE closure.disposition = 'superseded_by_operator_catchup'
      AND witness.recovery_plan_id IS NULL
    ORDER BY closure.id
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (uncoveredClosure) {
    throw new Error(
      `migration 43 hardened schema 42 has an unwitnessed closure: ${uncoveredClosure.id}`,
    );
  }

  const orphanWitness = db.prepare(`
    SELECT witness.recovery_plan_id, witness.conversation_key
    FROM operator_catchup_closure_witnesses witness
    LEFT JOIN turn_terminal_records terminal ON terminal.id = witness.terminal_record_id
    LEFT JOIN outbound_ops selected ON selected.id = witness.selected_op_id
    LEFT JOIN turn_recovery_jobs recovery ON recovery.id = witness.recovery_job_id
    WHERE terminal.id IS NULL
       OR selected.id IS NULL
       OR (witness.evidence_basis = 'selected_echoed_recovery' AND recovery.id IS NULL)
       OR NOT EXISTS (
         SELECT 1
         FROM inbound_disposition_links closure
         JOIN inbound_events source ON source.seq = closure.inbound_seq
         WHERE closure.recovery_plan_id = witness.recovery_plan_id
           AND source.conversation_key = witness.conversation_key
           AND closure.disposition = 'superseded_by_operator_catchup'
           AND closure.superseded_by_seq = witness.target_seq
           AND closure.actor = witness.actor
           AND closure.evidence_ref = witness.evidence_ref
       )
    LIMIT 1
  `).get() as { recovery_plan_id: string; conversation_key: string } | undefined;
  if (orphanWitness) {
    throw new Error(
      'migration 43 hardened schema 42 has an orphaned closure witness for '
        + `${orphanWitness.recovery_plan_id}/${orphanWitness.conversation_key}`,
    );
  }
}

function assertClosureWitnessCoverage(db: DatabaseSync): void {
  const missingWitness = db.prepare(`
    SELECT closure.id
    FROM inbound_disposition_links closure
    LEFT JOIN inbound_events source ON source.seq = closure.inbound_seq
    LEFT JOIN inbound_events target ON target.seq = closure.superseded_by_seq
    LEFT JOIN operator_catchup_delivery_proofs proof
      ON proof.target_seq = target.seq
     AND proof.conversation_key = target.conversation_key
     AND proof.chat_jid = target.chat_jid
    LEFT JOIN operator_catchup_closure_witnesses witness
      ON witness.recovery_plan_id = closure.recovery_plan_id
     AND witness.conversation_key = source.conversation_key
     AND witness.target_seq = closure.superseded_by_seq
     AND witness.actor = closure.actor
     AND witness.evidence_ref = closure.evidence_ref
     AND witness.evidence_basis = proof.evidence_basis
     AND witness.terminal_record_id = proof.terminal_record_id
     AND witness.selected_op_id = proof.selected_op_id
     AND witness.recovery_job_id IS proof.recovery_job_id
     AND witness.completion_proof_id IS proof.completion_proof_id
    WHERE closure.disposition = 'superseded_by_operator_catchup'
      AND witness.recovery_plan_id IS NULL
    ORDER BY closure.id
    LIMIT 1
  `).get() as { id: number } | undefined;
  if (missingWitness) {
    throw new Error(
      `migration 43 closure witness backfill incomplete for closure ${missingWitness.id}`,
    );
  }
}

/**
 * Harden operator catch-up closure around the durability engine's transferred
 * echo settlement and materialize an immutable witness for every closure.
 * The Database migration runner owns the transaction around this function.
 */
export function runMigration43(db: DatabaseSync): void {
  assertRequiredTables(db);
  if (hardenedWitnessTablePresent(db)) {
    assertHardenedSchema42CanAdvance(db);
    return;
  }
  assertSchema42ClosuresCanUpgrade(db);

  db.exec(`
    DROP TRIGGER IF EXISTS inbound_disposition_closure_validate_insert;
    DROP TRIGGER IF EXISTS operator_catchup_closure_materialize_witness;
    DROP TRIGGER IF EXISTS operator_catchup_closed_group_reject_pending;
    DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_retain;
    DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_retain;
    DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_immutable;
    DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_retain;
    DROP TRIGGER IF EXISTS operator_catchup_closure_witness_append_only_update;
    DROP TRIGGER IF EXISTS operator_catchup_closure_witness_append_only_delete;
    DROP VIEW IF EXISTS operator_catchup_delivery_proofs;
    DROP VIEW IF EXISTS operator_catchup_delivery_proof_candidates;

    DROP INDEX IF EXISTS idx_inbound_disposition_closure_unique;
    DROP INDEX IF EXISTS idx_operator_catchup_witness_terminal;
    DROP INDEX IF EXISTS idx_operator_catchup_witness_selected_op;
    DROP INDEX IF EXISTS idx_operator_catchup_witness_recovery_job;
    CREATE UNIQUE INDEX idx_inbound_disposition_closure_unique
      ON inbound_disposition_links(inbound_seq, recovery_plan_id)
      WHERE disposition = 'superseded_by_operator_catchup'
        AND superseded_by_seq IS NOT NULL;

    CREATE VIEW operator_catchup_delivery_proof_candidates AS
    ${DELIVERY_PROOF_CANDIDATES_SELECT};

    CREATE VIEW operator_catchup_delivery_proofs AS
    SELECT
      target_seq,
      conversation_key,
      chat_jid,
      terminal_record_id,
      selected_op_id,
      recovery_job_id,
      completion_proof_id,
      evidence_basis
    FROM operator_catchup_delivery_proof_candidates
    GROUP BY target_seq, conversation_key, chat_jid
    HAVING COUNT(*) = 1;

    CREATE TABLE IF NOT EXISTS operator_catchup_closure_witnesses (
      recovery_plan_id TEXT NOT NULL
        REFERENCES recovery_plans(plan_id) ON DELETE RESTRICT,
      conversation_key TEXT NOT NULL,
      target_seq INTEGER NOT NULL
        REFERENCES inbound_events(seq) ON DELETE RESTRICT,
      actor TEXT NOT NULL,
      evidence_ref TEXT NOT NULL,
      evidence_basis TEXT NOT NULL CHECK (
        evidence_basis IN (
          'selected_echoed', 'selected_corroborated', 'selected_echoed_recovery'
        )
      ),
      terminal_record_id INTEGER NOT NULL
        REFERENCES turn_terminal_records(id) ON DELETE RESTRICT,
      selected_op_id INTEGER NOT NULL
        REFERENCES outbound_ops(id) ON DELETE RESTRICT,
      recovery_job_id INTEGER
        REFERENCES turn_recovery_jobs(id) ON DELETE RESTRICT,
      completion_proof_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (recovery_plan_id, conversation_key),
      CHECK (recovery_plan_id = ${sqlEcmascriptTrim('recovery_plan_id')}
        AND length(${sqlEcmascriptTrim('recovery_plan_id')}) > 0
        AND length(CAST(recovery_plan_id AS BLOB)) <= 2048),
      CHECK (conversation_key = ${sqlEcmascriptTrim('conversation_key')}
        AND length(${sqlEcmascriptTrim('conversation_key')}) > 0
        AND length(CAST(conversation_key AS BLOB)) <= 2048),
      CHECK (actor = ${sqlEcmascriptTrim('actor')}
        AND length(${sqlEcmascriptTrim('actor')}) > 0
        AND length(CAST(actor AS BLOB)) <= 2048),
      CHECK (evidence_ref = ${sqlEcmascriptTrim('evidence_ref')}
        AND length(${sqlEcmascriptTrim('evidence_ref')}) > 0
        AND length(CAST(evidence_ref AS BLOB)) <= 8192),
      CHECK (
        (
          evidence_basis = 'selected_echoed_recovery'
          AND recovery_job_id IS NOT NULL
          AND completion_proof_id IS NOT NULL
          AND length(trim(completion_proof_id)) > 0
        )
        OR (
          evidence_basis IN ('selected_echoed', 'selected_corroborated')
          AND recovery_job_id IS NULL
          AND completion_proof_id IS NULL
        )
      )
    );

    CREATE INDEX idx_operator_catchup_witness_terminal
      ON operator_catchup_closure_witnesses(terminal_record_id);
    CREATE INDEX idx_operator_catchup_witness_selected_op
      ON operator_catchup_closure_witnesses(selected_op_id);
    CREATE INDEX idx_operator_catchup_witness_recovery_job
      ON operator_catchup_closure_witnesses(recovery_job_id)
      WHERE recovery_job_id IS NOT NULL;

    INSERT INTO operator_catchup_closure_witnesses (
      recovery_plan_id, conversation_key, target_seq, actor, evidence_ref,
      evidence_basis, terminal_record_id, selected_op_id, recovery_job_id,
      completion_proof_id
    )
    SELECT
      closure.recovery_plan_id,
      source.conversation_key,
      closure.superseded_by_seq,
      closure.actor,
      closure.evidence_ref,
      proof.evidence_basis,
      proof.terminal_record_id,
      proof.selected_op_id,
      proof.recovery_job_id,
      proof.completion_proof_id
    FROM inbound_disposition_links closure
    JOIN inbound_events source ON source.seq = closure.inbound_seq
    JOIN inbound_events target ON target.seq = closure.superseded_by_seq
    JOIN operator_catchup_delivery_proofs proof
      ON proof.target_seq = target.seq
     AND proof.conversation_key = target.conversation_key
     AND proof.chat_jid = target.chat_jid
    WHERE closure.disposition = 'superseded_by_operator_catchup'
    GROUP BY closure.recovery_plan_id, source.conversation_key
    ON CONFLICT(recovery_plan_id, conversation_key) DO NOTHING;

    CREATE TRIGGER operator_catchup_closure_witness_append_only_update
    BEFORE UPDATE ON operator_catchup_closure_witnesses
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up closure witness is append-only');
    END;

    CREATE TRIGGER operator_catchup_closure_witness_append_only_delete
    BEFORE DELETE ON operator_catchup_closure_witnesses
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up closure witness is append-only');
    END;

    CREATE TRIGGER inbound_disposition_closure_validate_insert
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup'
      AND NEW.superseded_by_seq IS NOT NULL
      AND (
        NEW.evidence_ref IS NULL
        OR length(${sqlEcmascriptTrim('NEW.evidence_ref')}) = 0
        OR NEW.evidence_ref IS NOT ${sqlEcmascriptTrim('NEW.evidence_ref')}
        OR length(CAST(NEW.evidence_ref AS BLOB)) > 8192
        OR length(${sqlEcmascriptTrim('NEW.actor')}) = 0
        OR NEW.actor IS NOT ${sqlEcmascriptTrim('NEW.actor')}
        OR length(CAST(NEW.actor AS BLOB)) > 2048
        OR length(${sqlEcmascriptTrim('NEW.recovery_plan_id')}) = 0
        OR NEW.recovery_plan_id IS NOT ${sqlEcmascriptTrim('NEW.recovery_plan_id')}
        OR length(CAST(NEW.recovery_plan_id AS BLOB)) > 2048
        OR NOT EXISTS (
        SELECT 1
        FROM inbound_disposition_links pending
        JOIN inbound_events source ON source.seq = NEW.inbound_seq
        JOIN inbound_events target ON target.seq = NEW.superseded_by_seq
        JOIN operator_catchup_delivery_proofs proof
          ON proof.target_seq = target.seq
         AND proof.conversation_key = target.conversation_key
         AND proof.chat_jid = target.chat_jid
        WHERE pending.inbound_seq = NEW.inbound_seq
          AND pending.recovery_plan_id = NEW.recovery_plan_id
          AND pending.disposition = 'recovery_pending_operator_catchup'
          AND pending.superseded_by_seq IS NULL
          AND target.seq > source.seq
          AND target.conversation_key = source.conversation_key
          AND target.chat_jid = source.chat_jid
          AND length(${sqlEcmascriptTrim('source.conversation_key')}) > 0
          AND source.conversation_key = ${sqlEcmascriptTrim('source.conversation_key')}
          AND length(CAST(source.conversation_key AS BLOB)) <= 2048
          AND (
            NOT EXISTS (
              SELECT 1
              FROM operator_catchup_closure_witnesses witness
              WHERE witness.recovery_plan_id = NEW.recovery_plan_id
                AND witness.conversation_key = source.conversation_key
            )
            OR EXISTS (
              SELECT 1
              FROM operator_catchup_closure_witnesses witness
              WHERE witness.recovery_plan_id = NEW.recovery_plan_id
                AND witness.conversation_key = source.conversation_key
                AND witness.target_seq = NEW.superseded_by_seq
                AND witness.actor = NEW.actor
                AND witness.evidence_ref = NEW.evidence_ref
                AND witness.evidence_basis = proof.evidence_basis
                AND witness.terminal_record_id = proof.terminal_record_id
                AND witness.selected_op_id = proof.selected_op_id
                AND witness.recovery_job_id IS proof.recovery_job_id
                AND witness.completion_proof_id IS proof.completion_proof_id
            )
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid operator catch-up closure');
    END;

    CREATE TRIGGER operator_catchup_closure_materialize_witness
    AFTER INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'superseded_by_operator_catchup'
      AND NEW.superseded_by_seq IS NOT NULL
    BEGIN
      INSERT INTO operator_catchup_closure_witnesses (
        recovery_plan_id, conversation_key, target_seq, actor, evidence_ref,
        evidence_basis, terminal_record_id, selected_op_id, recovery_job_id,
        completion_proof_id
      )
      SELECT
        NEW.recovery_plan_id,
        source.conversation_key,
        NEW.superseded_by_seq,
        NEW.actor,
        NEW.evidence_ref,
        proof.evidence_basis,
        proof.terminal_record_id,
        proof.selected_op_id,
        proof.recovery_job_id,
        proof.completion_proof_id
      FROM inbound_events source
      JOIN inbound_events target ON target.seq = NEW.superseded_by_seq
      JOIN operator_catchup_delivery_proofs proof
        ON proof.target_seq = target.seq
       AND proof.conversation_key = target.conversation_key
       AND proof.chat_jid = target.chat_jid
      WHERE source.seq = NEW.inbound_seq
      ON CONFLICT(recovery_plan_id, conversation_key) DO NOTHING;
    END;

    CREATE TRIGGER operator_catchup_closed_group_reject_pending
    BEFORE INSERT ON inbound_disposition_links
    WHEN NEW.disposition = 'recovery_pending_operator_catchup'
      AND NEW.superseded_by_seq IS NULL
      AND EXISTS (
        SELECT 1
        FROM inbound_events source
        JOIN operator_catchup_closure_witnesses witness
          ON witness.recovery_plan_id = NEW.recovery_plan_id
         AND witness.conversation_key = source.conversation_key
        WHERE source.seq = NEW.inbound_seq
      )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up recovery group is already closed');
    END;

    CREATE TRIGGER operator_catchup_terminal_proof_immutable
    BEFORE UPDATE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.terminal_record_id = OLD.id
    ) AND (
      NEW.id IS NOT OLD.id
      OR NEW.scope IS NOT OLD.scope
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.delivery_jid IS NOT OLD.delivery_jid
      OR NEW.inbound_seq IS NOT OLD.inbound_seq
      OR NEW.inbound_seq_key IS NOT OLD.inbound_seq_key
      OR NEW.logical_turn_id IS NOT OLD.logical_turn_id
      OR NEW.manager_id IS NOT OLD.manager_id
      OR NEW.generation IS NOT OLD.generation
      OR NEW.attempt_kind IS NOT OLD.attempt_kind
      OR NEW.attempt_failure_class IS NOT OLD.attempt_failure_class
      OR NEW.inbound_disposition IS NOT OLD.inbound_disposition
      OR NEW.delivery_kind IS NOT OLD.delivery_kind
      OR NEW.delivery_op_id IS NOT OLD.delivery_op_id
      OR NEW.recovery_owner_logical_turn_id IS NOT OLD.recovery_owner_logical_turn_id
      OR NEW.recovery_owner_manager_id IS NOT OLD.recovery_owner_manager_id
      OR NEW.recovery_owner_generation IS NOT OLD.recovery_owner_generation
      OR NEW.reply_guarantee_disarmed IS NOT OLD.reply_guarantee_disarmed
      OR NEW.created_at IS NOT OLD.created_at
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up terminal proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_terminal_proof_retain
    BEFORE DELETE ON turn_terminal_records
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.terminal_record_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up terminal proof must be retained');
    END;

    CREATE TRIGGER operator_catchup_selected_outbound_proof_immutable
    BEFORE UPDATE ON outbound_ops
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.selected_op_id = OLD.id
    ) AND (
      NEW.id IS NOT OLD.id
      OR NEW.conversation_key IS NOT OLD.conversation_key
      OR NEW.chat_jid IS NOT OLD.chat_jid
      OR NEW.op_type IS NOT OLD.op_type
      OR NEW.payload IS NOT OLD.payload
      OR NEW.payload_hash IS NOT OLD.payload_hash
      OR NEW.status IS NOT OLD.status
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.submitted_at IS NOT OLD.submitted_at
      OR NEW.echoed_at IS NOT OLD.echoed_at
      OR NEW.wa_message_id IS NOT OLD.wa_message_id
      OR NEW.error IS NOT OLD.error
      OR NEW.source_inbound_seq IS NOT OLD.source_inbound_seq
      OR NEW.retry_count IS NOT OLD.retry_count
      OR NEW.is_terminal IS NOT OLD.is_terminal
      OR NEW.replay_policy IS NOT OLD.replay_policy
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up selected outbound proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_selected_outbound_proof_retain
    BEFORE DELETE ON outbound_ops
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.selected_op_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up selected outbound proof must be retained');
    END;

    CREATE TRIGGER operator_catchup_recovery_job_proof_immutable
    BEFORE UPDATE ON turn_recovery_jobs
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.recovery_job_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up recovery job proof is immutable');
    END;

    CREATE TRIGGER operator_catchup_recovery_job_proof_retain
    BEFORE DELETE ON turn_recovery_jobs
    WHEN EXISTS (
      SELECT 1 FROM operator_catchup_closure_witnesses witness
      WHERE witness.recovery_job_id = OLD.id
    )
    BEGIN
      SELECT RAISE(ABORT, 'operator catch-up recovery job proof must be retained');
    END;
  `);
  assertClosureWitnessCoverage(db);
}
