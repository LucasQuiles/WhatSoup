import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigration41 } from '../../src/core/database-migration-41.ts';
import { runMigration42 } from '../../src/core/database-migration-42.ts';
import { Database } from '../../src/core/database.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

interface DirectClosureFixture {
  planId: string;
  conversationKey: string;
  chatJid: string;
  sourceSeq: number;
  targetSeq: number;
  terminalRecordId: number;
  selectedOpId: number;
  actor: string;
  evidenceRef: string;
}

describe('migration 43 upgrade from historical schema 42', () => {
  const tmp = trackTmpDirs('');

  it('upgrades an empty historical schema 42 with intact integrity and one migration receipt', () => {
    const path = schema42Path(true);
    for (let openAttempt = 0; openAttempt < 2; openAttempt += 1) {
      const db = new Database(path);
      db.open();
      try {
        expect(db.raw.prepare(
          'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 43',
        ).get()).toEqual({ count: 1 });
        expect(db.raw.prepare(
          'SELECT COUNT(*) AS count FROM operator_catchup_closure_witnesses',
        ).get()).toEqual({ count: 0 });
        expect(db.raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
        expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });

  it('normalizes the old closure index, backfills a witness, and replays from it after ambiguity', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'valid-upgrade');
    raw.close();

    const db = new Database(path);
    db.open();
    try {
      const index = db.raw.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_inbound_disposition_closure_unique'
      `).get() as { sql: string };
      expect(index.sql).toContain('(inbound_seq, recovery_plan_id)');
      expect(index.sql).not.toContain('superseded_by_seq)');
      expect(db.raw.prepare(`
        SELECT target_seq, evidence_basis, terminal_record_id, selected_op_id,
               recovery_job_id, completion_proof_id
        FROM operator_catchup_closure_witnesses
        WHERE recovery_plan_id = ? AND conversation_key = ?
      `).get(fixture.planId, fixture.conversationKey)).toEqual({
        target_seq: fixture.targetSeq,
        evidence_basis: 'selected_echoed',
        terminal_record_id: fixture.terminalRecordId,
        selected_op_id: fixture.selectedOpId,
        recovery_job_id: null,
        completion_proof_id: null,
      });

      installSecondDirectProof(db.raw, fixture);
      expect(db.raw.prepare(`
        SELECT COUNT(*) AS count FROM operator_catchup_delivery_proofs
        WHERE target_seq = ?
      `).get(fixture.targetSeq)).toEqual({ count: 0 });
      expect(closeOperatorCatchupRecovery(db, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: [fixture.sourceSeq],
        catchupSeq: fixture.targetSeq,
        actor: fixture.actor,
        evidenceRef: fixture.evidenceRef,
      })).toMatchObject({
        evidenceBasis: 'selected_echoed',
        terminalRecordId: fixture.terminalRecordId,
        selectedOpId: fixture.selectedOpId,
        recoveryJobId: null,
        completionProofId: null,
        inserted: 0,
        idempotent: true,
      });
    } finally {
      db.close();
    }
  });

  it('grandfathers a historical corroboration closure without admitting it as new proof', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installCorroboratedClosure(raw, 'legacy-corroborated');
    raw.close();

    const db = new Database(path);
    db.open();
    try {
      expect(db.raw.prepare(`
        SELECT evidence_basis
        FROM operator_catchup_delivery_proof_candidates
        WHERE target_seq = ?
      `).get(fixture.targetSeq)).toEqual({ evidence_basis: 'selected_corroborated' });
      expect(db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM operator_catchup_delivery_proofs
        WHERE target_seq = ?
      `).get(fixture.targetSeq)).toEqual({ count: 0 });
      expect(db.raw.prepare(`
        SELECT evidence_basis, terminal_record_id, selected_op_id
        FROM operator_catchup_closure_witnesses
        WHERE recovery_plan_id = ? AND conversation_key = ?
      `).get(fixture.planId, fixture.conversationKey)).toEqual({
        evidence_basis: 'selected_corroborated',
        terminal_record_id: fixture.terminalRecordId,
        selected_op_id: fixture.selectedOpId,
      });
      expect(closeOperatorCatchupRecovery(db, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: [fixture.sourceSeq],
        catchupSeq: fixture.targetSeq,
        actor: fixture.actor,
        evidenceRef: fixture.evidenceRef,
      })).toMatchObject({
        evidenceBasis: 'selected_corroborated',
        inserted: 0,
        idempotent: true,
      });
    } finally {
      db.close();
    }
  });

  it('converges exact and legacy-hardened schema 42 to identical canonical proof objects', () => {
    const exactPath = schema42Path(true);
    const exact = new Database(exactPath);
    exact.open();
    exact.close();

    const hardenedPath = currentSchemaPath();
    const seedHardened = new Database(hardenedPath);
    seedHardened.open();
    seedHardened.close();
    const legacy = new DatabaseSync(hardenedPath);
    rewindToLegacyHardenedSchema42(legacy);
    expect(schemaObjectHash(legacy, 'view', 'operator_catchup_delivery_proofs')).toBe(
      '1a13cae21a186d8f58c65339fb751c43daa8c8a7cb161cda398151791f57c8e2',
    );
    legacy.close();
    const upgradeHardened = new Database(hardenedPath);
    upgradeHardened.open();
    upgradeHardened.close();

    const exactObjects = canonicalObjectHashes(exactPath);
    const hardenedObjects = canonicalObjectHashes(hardenedPath);
    expect(hardenedObjects).toEqual(exactObjects);
    expect(exactObjects['view:operator_catchup_delivery_proofs']).toBe(
      'fc06288e9bdb4515b227ad32c0775b69d4525afa523d008e6345aaf4f3bead99',
    );
  });

  it('advances an already-hardened schema 42 from its witness after live proof becomes ambiguous', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    const fixture = installDirectClosure(db.raw, 'hardened-in-place');
    const originalWitness = db.raw.prepare(`
      SELECT target_seq, evidence_basis, terminal_record_id, selected_op_id,
             recovery_job_id, completion_proof_id
      FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).get(fixture.planId, fixture.conversationKey);
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    rewindToLegacyHardenedSchema42(raw);
    installSecondDirectProof(raw, fixture);
    expect(raw.prepare(`
      SELECT COUNT(*) AS count FROM operator_catchup_delivery_proofs
      WHERE target_seq = ?
    `).get(fixture.targetSeq)).toEqual({ count: 0 });
    raw.close();

    const upgraded = new Database(path);
    upgraded.open();
    try {
      expect(upgraded.raw.prepare(
        'SELECT version FROM schema_migrations WHERE version = 43',
      ).get()).toEqual({ version: 43 });
      expect((upgraded.raw.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'view' AND name = 'operator_catchup_delivery_proofs'
      `).get() as { sql: string }).sql).toContain(
        "WHERE evidence_basis <> 'selected_corroborated'",
      );
      expect(upgraded.raw.prepare(`
        SELECT target_seq, evidence_basis, terminal_record_id, selected_op_id,
               recovery_job_id, completion_proof_id
        FROM operator_catchup_closure_witnesses
        WHERE recovery_plan_id = ? AND conversation_key = ?
      `).get(fixture.planId, fixture.conversationKey)).toEqual(originalWitness);
      expect(closeOperatorCatchupRecovery(upgraded, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: [fixture.sourceSeq],
        catchupSeq: fixture.targetSeq,
        actor: fixture.actor,
        evidenceRef: fixture.evidenceRef,
      })).toMatchObject({
        evidenceBasis: 'selected_echoed',
        terminalRecordId: fixture.terminalRecordId,
        selectedOpId: fixture.selectedOpId,
        inserted: 0,
        idempotent: true,
      });
    } finally {
      upgraded.close();
    }
  });

  it('rejects an already-hardened schema 42 when a required proof object is missing', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    db.close();

    const raw = new DatabaseSync(path);
    rewindToLegacyHardenedSchema42(raw);
    raw.exec('DROP TRIGGER operator_catchup_closed_group_reject_pending');
    raw.close();

    expectMigrationFailure(path, 'hardened schema 42 is missing required objects');
    expectHardenedSchema42Remains(path);
  });

  it('rejects a same-name no-op replacement for a required hardened proof trigger', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    db.close();

    const raw = new DatabaseSync(path);
    rewindToLegacyHardenedSchema42(raw);
    raw.exec(`
      DROP TRIGGER operator_catchup_closed_group_reject_pending;
      CREATE TRIGGER operator_catchup_closed_group_reject_pending
      BEFORE INSERT ON inbound_disposition_links
      BEGIN
        SELECT 1;
      END;
    `);
    raw.close();

    expectMigrationFailure(
      path,
      'hardened schema 42 has drifted required objects: '
        + 'operator_catchup_closed_group_reject_pending',
    );
    expectHardenedSchema42Remains(path);
  });

  it('rejects an already-hardened schema 42 with a partially closed pending group', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    const planId = 'plan-hardened-partial';
    const conversationKey = 'conversation-hardened-partial';
    const chatJid = 'hardened-partial@g.us';
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', 'operator:test', 'partial hardened closure')
    `).run(planId);
    const insertSource = db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `);
    const sourceOne = Number(insertSource.run(
      'hardened-partial-source-one', conversationKey, chatJid,
    ).lastInsertRowid);
    const sourceTwo = Number(insertSource.run(
      'hardened-partial-source-two', conversationKey, chatJid,
    ).lastInsertRowid);
    const insertPending = db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', 'test://hardened-partial', 'operator:test')
    `);
    insertPending.run(sourceOne, planId);
    insertPending.run(sourceTwo, planId);
    const target = installDirectTarget(
      db.raw,
      { conversationKey, chatJid },
      'hardened-partial',
    );
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'partial closure', 'test://hardened-partial', 'operator:test')
    `).run(sourceOne, planId, target.targetSeq);
    db.close();

    const raw = new DatabaseSync(path);
    rewindToLegacyHardenedSchema42(raw);
    raw.close();

    expectMigrationFailure(path, 'closure does not cover its exact pending set');
    expectHardenedSchema42Remains(path);
  });

  it('rejects an already-hardened schema 42 with an unwitnessed closure', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    const fixture = installDirectClosure(db.raw, 'hardened-unwitnessed');
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    rewindToLegacyHardenedSchema42(raw);
    const deleteTrigger = raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'operator_catchup_closure_witness_append_only_delete'
    `).get() as { sql: string };
    raw.exec('DROP TRIGGER operator_catchup_closure_witness_append_only_delete');
    raw.prepare(`
      DELETE FROM operator_catchup_closure_witnesses
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).run(fixture.planId, fixture.conversationKey);
    raw.exec(deleteTrigger.sql);
    raw.close();

    expectMigrationFailure(path, 'hardened schema 42 has an unwitnessed closure');
    expectHardenedSchema42Remains(path);
  });

  it('rejects an already-hardened schema 42 with an orphaned closure witness', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    const fixture = installDirectClosure(db.raw, 'hardened-orphan-witness');
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    rewindToLegacyHardenedSchema42(raw);
    const deleteTrigger = raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'inbound_disposition_links_append_only_delete'
    `).get() as { sql: string };
    raw.exec('DROP TRIGGER inbound_disposition_links_append_only_delete');
    raw.prepare(`
      DELETE FROM inbound_disposition_links
      WHERE inbound_seq = ?
        AND recovery_plan_id = ?
        AND disposition = 'superseded_by_operator_catchup'
    `).run(fixture.sourceSeq, fixture.planId);
    raw.exec(deleteTrigger.sql);
    raw.close();

    expectMigrationFailure(path, 'hardened schema 42 has an orphaned closure witness');
    expectHardenedSchema42Remains(path);
  });

  it('rejects an already-hardened witness whose proof anchors belong to another target', () => {
    const path = currentSchemaPath();
    const db = new Database(path);
    db.open();
    const fixture = installDirectClosure(db.raw, 'hardened-mismatched-anchors');
    const unrelated = installDirectTarget(db.raw, {
      conversationKey: fixture.conversationKey,
      chatJid: fixture.chatJid,
    }, 'hardened-unrelated-anchors');
    db.close();

    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    rewindToLegacyHardenedSchema42(raw);
    const updateTrigger = raw.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'operator_catchup_closure_witness_append_only_update'
    `).get() as { sql: string };
    raw.exec('DROP TRIGGER operator_catchup_closure_witness_append_only_update');
    raw.prepare(`
      UPDATE operator_catchup_closure_witnesses
      SET terminal_record_id = ?, selected_op_id = ?
      WHERE recovery_plan_id = ? AND conversation_key = ?
    `).run(
      unrelated.terminalRecordId,
      unrelated.selectedOpId,
      fixture.planId,
      fixture.conversationKey,
    );
    raw.exec(updateTrigger.sql);
    raw.close();

    expectMigrationFailure(path, 'has invalid durable proof anchors');
    expectHardenedSchema42Remains(path);
  });

  it('aborts transactionally when an existing closure no longer has a valid proof', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'invalid-upgrade');
    raw.exec('DROP TRIGGER operator_catchup_selected_outbound_proof_immutable');
    raw.prepare("UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?")
      .run(fixture.selectedOpId);
    raw.close();

    expectMigrationFailure(path, 'pre-existing operator catch-up closure lacks exactly one valid proof');
    expectRolledBackSchema42(path);
  });

  it('aborts transactionally when an existing target has multiple valid proofs', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'ambiguous-upgrade');
    installSecondDirectProof(raw, fixture);
    raw.close();

    expectMigrationFailure(path, 'pre-existing operator catch-up closure lacks exactly one valid proof');
    expectRolledBackSchema42(path);
  });

  it('rejects duplicate closures admitted by the superseded schema 42 index before rebuilding it', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'duplicate-upgrade');
    const second = installDirectTarget(raw, fixture, 'duplicate-second');
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?, 'second closure', ?, ?)
    `).run(
      fixture.sourceSeq,
      fixture.planId,
      second.targetSeq,
      fixture.evidenceRef,
      fixture.actor,
    );
    raw.close();

    expectMigrationFailure(path, 'duplicate operator catch-up closures');
    expectRolledBackSchema42(path);
  });

  it('rejects an orphaned historical closure source instead of silently skipping its witness', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'orphan-source-upgrade');
    raw.exec(`
      DROP TRIGGER disposition_inbound_proof_retain;
      PRAGMA foreign_keys = OFF;
    `);
    raw.prepare('DELETE FROM inbound_events WHERE seq = ?').run(fixture.sourceSeq);
    raw.close();

    expectMigrationFailure(path, 'pre-existing operator catch-up closure lacks exactly one valid proof');
    expectRolledBackSchema42(path);
  });

  it('replays a migrated witness with a schema-valid evidence reference above 2048 bytes', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const evidenceRef = `test://${'e'.repeat(2_100)}`;
    const fixture = installDirectClosure(raw, 'long-evidence-upgrade', { evidenceRef });
    raw.close();

    const db = new Database(path);
    db.open();
    try {
      expect(closeOperatorCatchupRecovery(db, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: [fixture.sourceSeq],
        catchupSeq: fixture.targetSeq,
        actor: fixture.actor,
        evidenceRef,
      })).toMatchObject({ inserted: 0, idempotent: true, evidenceRef });
    } finally {
      db.close();
    }
  });

  it.each([
    ['actor', { actor: ' operator:test ' }],
    ['evidence reference', { evidenceRef: ' test://whitespace-upgrade ' }],
    ['TAB-suffixed actor', { actor: 'operator:test\t' }],
    ['NBSP-prefixed evidence reference', {
      evidenceRef: '\u00a0test://whitespace-upgrade',
    }],
    ['recovery plan ID', { planId: ' plan-whitespace-upgrade ' }],
    ['conversation key', { conversationKey: ' conversation-whitespace-upgrade ' }],
    ['blank conversation key', { conversationKey: '' }],
  ])('rejects noncanonical historical closure %s bytes', (_field, options) => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    installDirectClosure(raw, `noncanonical-${_field}`, options);
    raw.close();

    expectMigrationFailure(path, 'closure metadata is not reconstructable');
    expectRolledBackSchema42(path);
  });

  it('rejects a historical closure group that covers only part of its pending set', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const planId = 'plan-partial-upgrade';
    const conversationKey = 'conversation-partial-upgrade';
    const chatJid = 'partial-upgrade@g.us';
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', 'operator:test', 'partial schema 42 closure')
    `).run(planId);
    const insertSource = raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `);
    const sourceOne = Number(insertSource.run(
      'partial-source-one', conversationKey, chatJid,
    ).lastInsertRowid);
    const sourceTwo = Number(insertSource.run(
      'partial-source-two', conversationKey, chatJid,
    ).lastInsertRowid);
    const insertPending = raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', 'test://partial-upgrade', 'operator:test')
    `);
    insertPending.run(sourceOne, planId);
    insertPending.run(sourceTwo, planId);
    const target = installDirectTarget(raw, { conversationKey, chatJid }, 'partial-upgrade');
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'partial closure', 'test://partial-upgrade', 'operator:test')
    `).run(sourceOne, planId, target.targetSeq);
    raw.close();

    expectMigrationFailure(path, 'closure does not cover its exact pending set');
    expectRolledBackSchema42(path);
  });

  it('rejects a historical closure that has no matching pending source link', () => {
    const path = schema42Path(true);
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    const fixture = installDirectClosure(raw, 'missing-pending-upgrade');
    raw.exec('DROP TRIGGER inbound_disposition_links_append_only_delete');
    raw.prepare(`
      DELETE FROM inbound_disposition_links
      WHERE inbound_seq = ?
        AND recovery_plan_id = ?
        AND disposition = 'recovery_pending_operator_catchup'
    `).run(fixture.sourceSeq, fixture.planId);
    raw.close();

    expectMigrationFailure(path, 'closure lacks exactly one valid proof');
    expectRolledBackSchema42(path);
  });

  function schema42Path(historicalIndex: boolean): string {
    const dir = tmp.make('whatsoup-migration-43-upgrade');
    const path = join(dir, 'bot.db');
    const current = new Database(path);
    current.open();
    current.close();

    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      DELETE FROM schema_migrations WHERE version = 43;
      DROP TRIGGER IF EXISTS inbound_disposition_closure_validate_insert;
      DROP TRIGGER IF EXISTS operator_catchup_closure_materialize_witness;
      DROP TRIGGER IF EXISTS operator_catchup_closed_group_reject_pending;
      DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_immutable;
      DROP TRIGGER IF EXISTS operator_catchup_terminal_proof_retain;
      DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_immutable;
      DROP TRIGGER IF EXISTS operator_catchup_selected_outbound_proof_retain;
      DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_immutable;
      DROP TRIGGER IF EXISTS operator_catchup_recovery_job_proof_retain;
      DROP VIEW IF EXISTS operator_catchup_delivery_proofs;
      DROP VIEW IF EXISTS operator_catchup_delivery_proof_candidates;
      DROP TABLE IF EXISTS operator_catchup_closure_witnesses;
      DROP INDEX IF EXISTS idx_inbound_disposition_closure_unique;
    `);
    runMigration41(raw);
    runMigration42(raw);
    if (historicalIndex) {
      raw.exec(`
        DROP INDEX idx_inbound_disposition_closure_unique;
        CREATE UNIQUE INDEX idx_inbound_disposition_closure_unique
          ON inbound_disposition_links(
            inbound_seq, recovery_plan_id, disposition, superseded_by_seq
          )
          WHERE disposition = 'superseded_by_operator_catchup'
            AND superseded_by_seq IS NOT NULL;
      `);
    }
    raw.close();
    return path;
  }

  function currentSchemaPath(): string {
    const dir = tmp.make('whatsoup-migration-43-hardened');
    return join(dir, 'bot.db');
  }

  function rewindToLegacyHardenedSchema42(raw: DatabaseSync): void {
    raw.prepare('DELETE FROM schema_migrations WHERE version = 43').run();
    raw.exec(`
      DROP VIEW operator_catchup_delivery_proofs;
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
    `);
  }

  function canonicalObjectHashes(path: string): Record<string, string> {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      return Object.fromEntries([
        ['table', 'operator_catchup_closure_witnesses'],
        ['view', 'operator_catchup_delivery_proof_candidates'],
        ['view', 'operator_catchup_delivery_proofs'],
        ['index', 'idx_inbound_disposition_closure_unique'],
        ['index', 'idx_operator_catchup_witness_terminal'],
        ['index', 'idx_operator_catchup_witness_selected_op'],
        ['index', 'idx_operator_catchup_witness_recovery_job'],
        ['trigger', 'inbound_disposition_closure_validate_insert'],
        ['trigger', 'operator_catchup_closure_materialize_witness'],
        ['trigger', 'operator_catchup_closed_group_reject_pending'],
        ['trigger', 'operator_catchup_terminal_proof_immutable'],
        ['trigger', 'operator_catchup_terminal_proof_retain'],
        ['trigger', 'operator_catchup_selected_outbound_proof_immutable'],
        ['trigger', 'operator_catchup_selected_outbound_proof_retain'],
        ['trigger', 'operator_catchup_recovery_job_proof_immutable'],
        ['trigger', 'operator_catchup_recovery_job_proof_retain'],
        ['trigger', 'operator_catchup_closure_witness_append_only_update'],
        ['trigger', 'operator_catchup_closure_witness_append_only_delete'],
      ].map(([type, name]) => [
        `${type}:${name}`,
        schemaObjectHash(raw, type, name),
      ]));
    } finally {
      raw.close();
    }
  }

  function schemaObjectHash(raw: DatabaseSync, type: string, name: string): string {
    const row = raw.prepare(`
      SELECT sql FROM sqlite_master WHERE type = ? AND name = ?
    `).get(type, name) as { sql: string } | undefined;
    if (!row) throw new Error(`Missing ${type} ${name}`);
    return createHash('sha256')
      .update(row.sql.replace(/\s+/g, ' ').trim())
      .digest('hex');
  }

  function installDirectClosure(
    raw: DatabaseSync,
    suffix: string,
    options: {
      actor?: string;
      conversationKey?: string;
      evidenceRef?: string;
      planId?: string;
    } = {},
  ): DirectClosureFixture {
    const planId = options.planId ?? `plan-${suffix}`;
    const conversationKey = options.conversationKey ?? `conversation-${suffix}`;
    const chatJid = `${suffix}@g.us`;
    const actor = options.actor ?? 'operator:test';
    const evidenceRef = options.evidenceRef ?? `test://${suffix}`;
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', ?, 'schema 42 upgrade fixture')
    `).run(planId, actor);
    const sourceSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`source-${suffix}`, conversationKey, chatJid).lastInsertRowid);
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', ?, ?)
    `).run(sourceSeq, planId, evidenceRef, actor);
    const target = installDirectTarget(raw, {
      conversationKey,
      chatJid,
    }, suffix);
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'operator catch-up completed with echoed reply', ?, ?)
    `).run(sourceSeq, planId, target.targetSeq, evidenceRef, actor);
    return {
      planId,
      conversationKey,
      chatJid,
      sourceSeq,
      actor,
      evidenceRef,
      ...target,
    };
  }

  function installCorroboratedClosure(
    raw: DatabaseSync,
    suffix: string,
  ): DirectClosureFixture {
    const planId = `plan-${suffix}`;
    const conversationKey = `conversation-${suffix}`;
    const chatJid = `${suffix}@g.us`;
    const actor = 'operator:test';
    const evidenceRef = `test://${suffix}`;
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES (?, 'operator', ?, 'historical corroboration fixture')
    `).run(planId, actor);
    const sourceSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason, failure_class
      ) VALUES (?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(`source-${suffix}`, conversationKey, chatJid).lastInsertRowid);
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', ?, ?)
    `).run(sourceSeq, planId, evidenceRef, actor);
    const targetSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_sent')
    `).run(`target-${suffix}`, conversationKey, chatJid).lastInsertRowid);
    const selectedOpId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{"text":"SELECTED"}', 'maybe_sent', ?, 1, 'unsafe')
    `).run(conversationKey, chatJid, targetSeq).lastInsertRowid);
    const terminalRecordId = Number(raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, ?, 1, 'replied',
                'finalized_replied', 'delivery_unknown', ?, 0)
    `).run(
      conversationKey,
      chatJid,
      targetSeq,
      targetSeq,
      `turn-${suffix}`,
      `manager-${suffix}`,
      selectedOpId,
    ).lastInsertRowid);
    const corroboratingOpId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, echoed_at,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{"text":"DIFFERENT"}', 'echoed', datetime('now'),
                ?, 0, 'unsafe')
    `).run(conversationKey, chatJid, targetSeq).lastInsertRowid);
    raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor, evidence_ref
      ) VALUES (?, ?, 'same_source_later_echoed_op', ?, ?)
    `).run(terminalRecordId, corroboratingOpId, actor, evidenceRef);
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'superseded_by_operator_catchup', ?,
                'historical corroborated closure', ?, ?)
    `).run(sourceSeq, planId, targetSeq, evidenceRef, actor);
    return {
      planId,
      conversationKey,
      chatJid,
      sourceSeq,
      targetSeq,
      terminalRecordId,
      selectedOpId,
      actor,
      evidenceRef,
    };
  }

  function installDirectTarget(
    raw: DatabaseSync,
    fixture: Pick<DirectClosureFixture, 'conversationKey' | 'chatJid'>,
    suffix: string,
  ): Pick<DirectClosureFixture, 'targetSeq' | 'terminalRecordId' | 'selectedOpId'> {
    const targetSeq = Number(raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, processing_status,
        completed_at, terminal_reason
      ) VALUES (?, ?, ?, 'complete', datetime('now'), 'response_echoed')
    `).run(`target-${suffix}`, fixture.conversationKey, fixture.chatJid).lastInsertRowid);
    const selectedOpId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, submitted_at,
        echoed_at, wa_message_id, source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{"text":"ACK"}', 'echoed', datetime('now'),
                datetime('now'), ?, ?, 1, 'unsafe')
    `).run(
      fixture.conversationKey,
      fixture.chatJid,
      `wa-${suffix}`,
      targetSeq,
    ).lastInsertRowid);
    const terminalRecordId = Number(raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, ?, 1, 'replied',
                'finalized_replied', 'echoed', ?, 1)
    `).run(
      fixture.conversationKey,
      fixture.chatJid,
      targetSeq,
      targetSeq,
      `turn-${suffix}`,
      `manager-${suffix}`,
      selectedOpId,
    ).lastInsertRowid);
    return { targetSeq, terminalRecordId, selectedOpId };
  }

  function installSecondDirectProof(raw: DatabaseSync, fixture: DirectClosureFixture): void {
    const suffix = `second-${fixture.planId}`;
    const selectedOpId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, submitted_at,
        echoed_at, wa_message_id, source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{"text":"second ACK"}', 'echoed', datetime('now'),
                datetime('now'), ?, ?, 1, 'unsafe')
    `).run(
      fixture.conversationKey,
      fixture.chatJid,
      `wa-${suffix}`,
      fixture.targetSeq,
    ).lastInsertRowid);
    raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, ?, 1, 'replied',
                'finalized_replied', 'echoed', ?, 1)
    `).run(
      fixture.conversationKey,
      fixture.chatJid,
      fixture.targetSeq,
      fixture.targetSeq,
      `turn-${suffix}`,
      `manager-${suffix}`,
      selectedOpId,
    );
  }

  function expectMigrationFailure(path: string, message: string): void {
    const db = new Database(path);
    try {
      let thrown: unknown;
      try {
        db.open();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        message: 'Migration 43 failed',
        cause: expect.objectContaining({ message: expect.stringContaining(message) }),
      });
    } finally {
      db.close();
    }
  }

  function expectRolledBackSchema42(path: string): void {
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT version FROM schema_migrations WHERE version = 43').get())
        .toBeUndefined();
      expect(raw.prepare('SELECT version FROM schema_migrations WHERE version = 42').get())
        .toEqual({ version: 42 });
      expect(raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'operator_catchup_closure_witnesses'
      `).get()).toBeUndefined();
      const index = raw.prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_inbound_disposition_closure_unique'
      `).get() as { sql: string };
      expect(index.sql).toContain('superseded_by_seq');
    } finally {
      raw.close();
    }
  }

  function expectHardenedSchema42Remains(path: string): void {
    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare('SELECT version FROM schema_migrations WHERE version = 43').get())
        .toBeUndefined();
      expect(raw.prepare('SELECT version FROM schema_migrations WHERE version = 42').get())
        .toEqual({ version: 42 });
      expect(raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'operator_catchup_closure_witnesses'
      `).get()).toEqual({ name: 'operator_catchup_closure_witnesses' });
      expect(raw.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      raw.close();
    }
  }
});
