import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertCanonicalSchema43 } from './database-migration-43.ts';
import { assertOperatorCatchupResolutionSchema } from './database-migration-70.ts';
import { withoutOperatorCatchupResolutionSql } from './open-recoveries-sql.ts';

// Applied migration 43 is frozen. Runtime attestation retains its proof checks,
// while schema 70 permits a pending group member to have a direct resolution.
const HARDENED_SCHEMA_42_OBJECTS = [
  ['table', 'operator_catchup_closure_witnesses', 'afd9c7cf0ec3647f721f517abb17865e4c8885544bddcf06bb9977de7c4583b4'],
  ['view', 'operator_catchup_delivery_proof_candidates', 'f8f6d3c57c03bbd39c51f88710e4edb401c8a55291ea36b16adbb0bb213d4b2f'],
  ['view', 'operator_catchup_delivery_proofs', '1a13cae21a186d8f58c65339fb751c43daa8c8a7cb161cda398151791f57c8e2'],
  ['index', 'idx_inbound_disposition_closure_unique', '03fbba479036a6f115e13bcad8d56d26405115051a8e608e566f8f247af6f8a8'],
  ['index', 'idx_operator_catchup_witness_terminal', '68814636bd2d292ef47a22df7dc07e1e272b547598c6aff14785532224164f0a'],
  ['index', 'idx_operator_catchup_witness_selected_op', 'b46d6e250c7ff09a1923a269d7d8c833442b49acc9a3dd75e3f40080bc3bfb5f'],
  ['index', 'idx_operator_catchup_witness_recovery_job', '9ca81a17513b65617f28ac51a6d3ef683f61955f29715193351bb83882e3b86b'],
  ['trigger', 'operator_catchup_closure_witness_append_only_update', '0c7e3d13b9ee86930da093bf473a9bf5f281b015c6163c3d1b51fa281ecb5fd5'],
  ['trigger', 'operator_catchup_closure_witness_append_only_delete', '0cbbb8a8f4319d8c634aac2e65839b6b3dbf8b784f0fb956893739c79448c2fb'],
  ['trigger', 'inbound_disposition_closure_validate_insert', 'd68b783a0b75ae5d0306cfc0c24a022d8d08113662cc0d437de0fa1a52e605fe'],
  ['trigger', 'operator_catchup_closure_materialize_witness', 'ad31e9416ddd567481cc5cec4e28b7e578b998df895917ff0e40d866b01acdd9'],
  ['trigger', 'operator_catchup_closed_group_reject_pending', '00234b77f7941787fe37ae5c36a104a0dac8836ce701c82f8852edf0bcd6f093'],
  ['trigger', 'operator_catchup_terminal_proof_immutable', '223c469f70414f1c131ca2361c6ee5e7d0be5c3b47e1598aec92b232cab1b88b'],
  ['trigger', 'operator_catchup_terminal_proof_retain', '4c32a90667b09de0d304bf58ccf871bab37cbc0602ebefa084dd8a7e94172428'],
  ['trigger', 'operator_catchup_selected_outbound_proof_immutable', '846d787797c8ae5741433340aaf662e8bec19e5b95b75ea00f3dac4e16db5690'],
  ['trigger', 'operator_catchup_selected_outbound_proof_retain', '38ba7bddc5c2a8151deb907d8f545d79fc73f03189b9066a445b8cf8a5fea81b'],
  ['trigger', 'operator_catchup_recovery_job_proof_immutable', '77813b7d85e0722559701e002cd0344360a90f1558c82f4ddffa0849a3faf994'],
  ['trigger', 'operator_catchup_recovery_job_proof_retain', '769bd45111efe8975e0a4138dadbca13f742187892c2bfa2dffaec26e5e48d8e'],
] as const;
const CANONICAL_SCHEMA_43_PROOF_VIEW_HASH =
  'fc06288e9bdb4515b227ad32c0775b69d4525afa523d008e6345aaf4f3bead99';

function schemaSqlHash(sql: string): string {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

function assertHardenedSchema42CanAdvance(db: DatabaseSync): void {
  const selectObject = db.prepare(`
    SELECT type, sql FROM sqlite_master WHERE name = ?
  `);
  const observedObjects = HARDENED_SCHEMA_42_OBJECTS.map(([type, name, expectedHash]) => ({
    type,
    name,
    expectedHash,
    row: selectObject.get(name) as { type: string; sql: string | null } | undefined,
  }));
  const missingObjects = observedObjects
    .filter(({ row }) => row === undefined)
    .map(({ name }) => name);
  if (missingObjects.length > 0) {
    throw new Error(
      `migration 43 hardened schema 42 is missing required objects: ${missingObjects.join(', ')}`,
    );
  }
  const driftedObjects = observedObjects
    .filter(({ type, name, expectedHash, row }) => {
      if (row?.type !== type || row.sql === null) return true;
      const allowedHashes = name === 'operator_catchup_delivery_proofs'
        ? [expectedHash, CANONICAL_SCHEMA_43_PROOF_VIEW_HASH]
        : [expectedHash];
      return !allowedHashes.includes(schemaSqlHash(row.sql));
    })
    .map(({ name }) => name);
  if (driftedObjects.length > 0) {
    throw new Error(
      `migration 43 hardened schema 42 has drifted required objects: ${driftedObjects.join(', ')}`,
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
          AND ${withoutOperatorCatchupResolutionSql(db, 'pending')}
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
      'migration 43 hardened schema 42 closure does not cover its exact pending set for '
        + `${incompleteGroup.recovery_plan_id}/${incompleteGroup.conversation_key}`,
    );
  }

  const invalidClosure = db.prepare(`
    SELECT closure.id
    FROM inbound_disposition_links closure
    LEFT JOIN inbound_events source ON source.seq = closure.inbound_seq
    LEFT JOIN inbound_events target ON target.seq = closure.superseded_by_seq
    WHERE closure.disposition = 'superseded_by_operator_catchup'
      AND (
        source.seq IS NULL
        OR target.seq IS NULL
        OR target.seq <= source.seq
        OR target.conversation_key IS NOT source.conversation_key
        OR target.chat_jid IS NOT source.chat_jid
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
  if (invalidClosure) {
    throw new Error(
      `migration 43 hardened schema 42 has an invalid closure owner: ${invalidClosure.id}`,
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

  const invalidWitnessAnchors = db.prepare(`
    SELECT witness.recovery_plan_id, witness.conversation_key
    FROM operator_catchup_closure_witnesses witness
    WHERE NOT EXISTS (
      SELECT 1
      FROM operator_catchup_delivery_proof_candidates proof
      WHERE proof.target_seq = witness.target_seq
        AND proof.conversation_key = witness.conversation_key
        AND proof.evidence_basis = witness.evidence_basis
        AND proof.terminal_record_id = witness.terminal_record_id
        AND proof.selected_op_id = witness.selected_op_id
        AND proof.recovery_job_id IS witness.recovery_job_id
        AND proof.completion_proof_id IS witness.completion_proof_id
    )
    ORDER BY witness.recovery_plan_id, witness.conversation_key
    LIMIT 1
  `).get() as { recovery_plan_id: string; conversation_key: string } | undefined;
  if (invalidWitnessAnchors) {
    throw new Error(
      'migration 43 hardened schema 42 has invalid durable proof anchors for '
        + `${invalidWitnessAnchors.recovery_plan_id}/${invalidWitnessAnchors.conversation_key}`,
    );
  }
}

function assertClosureWitnessCoverage(db: DatabaseSync): void {
  const missingWitness = db.prepare(`
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
  if (missingWitness) {
    throw new Error(
      `migration 43 closure witness backfill incomplete for closure ${missingWitness.id}`,
    );
  }

  const invalidWitness = db.prepare(`
    SELECT witness.recovery_plan_id, witness.conversation_key
    FROM operator_catchup_closure_witnesses witness
    WHERE NOT EXISTS (
      SELECT 1
      FROM operator_catchup_delivery_proof_candidates proof
      WHERE proof.target_seq = witness.target_seq
        AND proof.conversation_key = witness.conversation_key
        AND proof.evidence_basis = witness.evidence_basis
        AND proof.terminal_record_id = witness.terminal_record_id
        AND proof.selected_op_id = witness.selected_op_id
        AND proof.recovery_job_id IS witness.recovery_job_id
        AND proof.completion_proof_id IS witness.completion_proof_id
    )
    ORDER BY witness.recovery_plan_id, witness.conversation_key
    LIMIT 1
  `).get() as { recovery_plan_id: string; conversation_key: string } | undefined;
  if (invalidWitness) {
    throw new Error(
      'migration 43 closure witness has invalid durable proof anchors for '
        + `${invalidWitness.recovery_plan_id}/${invalidWitness.conversation_key}`,
    );
  }
}

/**
 * Read-only attestation for operational tooling. A schema receipt is necessary
 * but not sufficient: every proof object and the persisted closure graph must
 * still match the canonical schema-43 contract.
 */
export function assertRecoveryCatchupSchema(db: DatabaseSync): void {
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 70').get()) {
    assertCanonicalSchema43(db);
    return;
  }
  assertOperatorCatchupResolutionSchema(db);
  const receipt = db.prepare(`
    SELECT version FROM schema_migrations WHERE version = 43
  `).get() as { version: number } | undefined;
  if (receipt?.version !== 43) throw new Error('canonical schema 43 receipt is missing');

  const selectObject = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?');
  const invalidObjects = HARDENED_SCHEMA_42_OBJECTS.filter(([type, name, legacyHash]) => {
    const expectedHash = name === 'operator_catchup_delivery_proofs'
      ? CANONICAL_SCHEMA_43_PROOF_VIEW_HASH
      : legacyHash;
    const row = selectObject.get(name) as { type: string; sql: string | null } | undefined;
    return row?.type !== type
      || row.sql === null
      || schemaSqlHash(row.sql) !== expectedHash;
  }).map(([, name]) => name);
  if (invalidObjects.length > 0) {
    throw new Error(
      `canonical schema 43 objects are missing or drifted: ${invalidObjects.join(', ')}`,
    );
  }

  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as {
    foreign_keys: number;
  } | undefined;
  if (foreignKeys?.foreign_keys !== 1) {
    throw new Error('canonical schema 43 validation requires foreign_keys=ON');
  }
  const quickCheck = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new Error('canonical schema 43 quick_check failed');
  }
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new Error('canonical schema 43 foreign_key_check failed');
  }

  assertHardenedSchema42CanAdvance(db);
  assertClosureWitnessCoverage(db);
}

