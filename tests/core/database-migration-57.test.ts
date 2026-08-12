/**
 * Migration 57 — capability-obligation replay schema (D3/D4/D5/D6/D7).
 *
 * Append-only capability-debt lifecycle: obligations with a guarded state
 * machine, append-only audit events, immutable exact-bound attestations,
 * destination-specific drain approvals, and typed execution receipts. Completed
 * delivery evidence (turn_recovery_jobs) is never touched by this schema; rows
 * here are never deleted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigration57 } from '../../src/core/database-migration-57.ts';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
});

afterEach(() => {
  db.raw.close();
});

const OBLIGATION = {
  source_inbound_seq: 1001,
  source_message_id: 'TESTMSG-DM-0001',
  conversation_key: 'conv-mw',
  delivery_jid: 'test-dm-target@lid',
  sender_jid: 'test-sender@s.whatsapp.net',
  sender_name: 'Test Sender',
  is_group: 0,
  scope: 'per_chat',
  replay_text: 'https://youtu.be/abc',
  content_type_hint: 'text',
  contract_version: 'test-instance/1',
  required_capability: 'child_process_tools',
  capability_params: '{"skill":"watch"}',
  input_digest: 'ab'.repeat(32),
  source_digest: 'cd'.repeat(32),
  source_token: 'https://youtu.be/abc',
  state: 'waiting_capability',
  creation_reason: 'typed_deferral_signal',
};

function insertObligation(over: Partial<Record<string, unknown>> = {}): number {
  const row = { ...OBLIGATION, ...over };
  const cols = Object.keys(row);
  const stmt = db.raw.prepare(
    `INSERT INTO capability_obligations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  const res = stmt.run(...cols.map((c) => row[c as keyof typeof row] as never));
  return Number(res.lastInsertRowid);
}

describe('migration 57 — registration and idempotency', () => {
  it('is applied by Database.open() and matches CURRENT_SCHEMA_MIGRATION', () => {
    expect(CURRENT_SCHEMA_MIGRATION).toBe(57);
    const applied = db.raw
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(applied.v).toBe(57);
    for (const table of [
      'capability_obligations',
      'capability_obligation_events',
      'capability_attestations',
      'capability_drain_approvals',
      'capability_execution_receipts',
    ]) {
      const found = db.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table);
      expect(found, `missing table ${table}`).toBeTruthy();
    }
  });

  it('re-running the migration function on an already-migrated db is safe', () => {
    expect(() => runMigration57(db.raw)).not.toThrow();
  });
});

describe('capability_obligations — creation gates', () => {
  it('inserts a DM obligation in waiting_capability', () => {
    const id = insertObligation();
    const row = db.raw.prepare('SELECT state, claim_epoch, attempt_count FROM capability_obligations WHERE id=?').get(id) as Record<string, unknown>;
    expect(row.state).toBe('waiting_capability');
    expect(row.claim_epoch).toBe(0);
    expect(row.attempt_count).toBe(0);
  });

  it('rejects a group obligation created in any state other than waiting_approval', () => {
    expect(() =>
      insertObligation({ is_group: 1, group_name: 'g', delivery_jid: 'test-group-alpha@g.us', state: 'waiting_capability' }),
    ).toThrow(/group obligations must be created waiting_approval/i);
    expect(() =>
      insertObligation({ is_group: 1, group_name: 'g', delivery_jid: 'test-group-alpha@g.us', state: 'waiting_approval' }),
    ).not.toThrow();
  });

  it('enforces the dedup unique key', () => {
    insertObligation();
    expect(() => insertObligation()).toThrow(/UNIQUE/i);
    // A different contract version is a distinct obligation.
    expect(() => insertObligation({ contract_version: 'test-instance/2' })).not.toThrow();
  });

  it('rejects unknown states and creation reasons', () => {
    expect(() => insertObligation({ state: 'sneaky' })).toThrow();
    expect(() => insertObligation({ creation_reason: 'improvised' })).toThrow();
    expect(() => insertObligation({ creation_reason: 'reviewed_backfill:MANIFEST-1', source_inbound_seq: 1002 })).not.toThrow();
  });

  it('requires media identity columns to be all-present or all-absent', () => {
    expect(() =>
      insertObligation({ source_inbound_seq: 1003, source_token: null, retained_media_path: '/x/y', media_sha256: null, media_bytes: null }),
    ).toThrow();
    expect(() =>
      insertObligation({
        source_inbound_seq: 1003,
        source_token: null,
        retained_media_path: '/x/y',
        media_sha256: 'ab'.repeat(32),
        media_bytes: 10,
        retention_policy_version: 'p1',
      }),
    ).not.toThrow();
  });

  it('requires EXACTLY ONE execution source (source_token XOR retained media)', () => {
    // neither → rejected
    expect(() => insertObligation({ source_inbound_seq: 1004, source_token: null })).toThrow(/constraint/i);
    // both → rejected
    expect(() =>
      insertObligation({
        source_inbound_seq: 1005,
        source_token: 'https://youtu.be/abc',
        retained_media_path: '/x/y',
        media_sha256: 'ab'.repeat(32),
        media_bytes: 10,
        retention_policy_version: 'p1',
      }),
    ).toThrow(/constraint/i);
    // token only → ok
    expect(() => insertObligation({ source_inbound_seq: 1006 })).not.toThrow();
    // media only → ok
    expect(() =>
      insertObligation({
        source_inbound_seq: 1007,
        source_token: null,
        retained_media_path: '/x/z',
        media_sha256: 'ef'.repeat(32),
        media_bytes: 12,
        retention_policy_version: 'p1',
      }),
    ).not.toThrow();
  });
});

describe('capability_obligations — immutability and transition whitelist', () => {
  it('aborts updates to source-identity and contract columns', () => {
    const id = insertObligation();
    for (const [col, val] of [
      ['source_inbound_seq', 1],
      ['source_message_id', 'other'],
      ['conversation_key', 'other'],
      ['delivery_jid', 'other@lid'],
      ['sender_jid', 'other@s.whatsapp.net'],
      ['is_group', 1],
      ['replay_text', 'changed'],
      ['contract_version', 'x/9'],
      ['required_capability', 'other_cap'],
      ['capability_params', '{}'],
      ['input_digest', 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'],
      ['source_digest', 'abababababababababababababababababababababababababababababababab'],
      ['creation_reason', 'typed_deferral_signal'],
      ['retained_media_path', '/tmp/evil'],
      ['media_sha256', 'cd'.repeat(32)],
    ] as const) {
      expect(
        () => db.raw.prepare(`UPDATE capability_obligations SET ${col} = ? WHERE id = ?`).run(val as never, id),
        `${col} must be immutable`,
      ).toThrow(/immutable/i);
    }
  });

  it('allows the legal lifecycle path and blocks illegal jumps', () => {
    const id = insertObligation();
    const setState = (s: string) =>
      db.raw.prepare('UPDATE capability_obligations SET state=? WHERE id=?').run(s, id);
    // waiting_capability -> claimed -> waiting_capability (requeue) -> claimed -> blocked_ambiguous -> waiting_capability -> claimed
    expect(() => setState('claimed')).not.toThrow();
    expect(() => setState('waiting_capability')).not.toThrow();
    expect(() => setState('claimed')).not.toThrow();
    expect(() => setState('blocked_ambiguous')).not.toThrow();
    expect(() => setState('waiting_capability')).not.toThrow();
    expect(() => setState('claimed')).not.toThrow();
    // claimed -> completed requires receipt + proof (separate test) — here exhaust instead
    expect(() => setState('exhausted')).not.toThrow();
    // exhausted is terminal
    expect(() => setState('claimed')).toThrow(/transition/i);
    expect(() => setState('cancelled')).toThrow(/transition/i);
  });

  it('waiting_capability cannot jump directly to completed', () => {
    const id = insertObligation();
    expect(() =>
      db.raw.prepare('UPDATE capability_obligations SET state=? WHERE id=?').run('completed', id),
    ).toThrow(/transition/i);
  });

  it('completed requires a BOUND execution receipt and completion proof', () => {
    const id = insertObligation();
    db.raw
      .prepare('UPDATE capability_obligations SET state=?, claim_epoch=1, attempt_count=1 WHERE id=?')
      .run('claimed', id);
    expect(() =>
      db.raw.prepare('UPDATE capability_obligations SET state=? WHERE id=?').run('completed', id),
    ).toThrow(/receipt|proof/i);
    // Minted-turn terminal chain the completed gate additionally requires.
    const seq = Number(
      db.raw
        .prepare(
          `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
           VALUES (?, 'conv-mw', 'test-dm-target@lid', 'agent')`,
        )
        .run(`obl:${id}:1`).lastInsertRowid,
    );
    db.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind,
           inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
         ) VALUES ('per_chat', 'conv-mw', 'test-dm-target@lid', ?, ?, 'turn-1', 'mgr-1', 1,
                   'replied', 'completed', 'echoed', 424242, 0)`,
      )
      .run(seq, seq);
    // A receipt for the wrong attempt does not satisfy the gate.
    const staleReceiptId = Number(
      db.raw
        .prepare(
          `INSERT INTO capability_execution_receipts
             (obligation_id, logical_turn_id, tool_use_id, skill_name, contract_version, input_digest, source_digest, result_status, claim_epoch, attempt_number)
           VALUES (?, 'turn-0', 'tu-0', 'watch', 'test-instance/1', ?, ?, 'ok', 9, 9)`,
        )
        .run(id, OBLIGATION.input_digest, OBLIGATION.source_digest).lastInsertRowid,
    );
    const terminalId = Number(
      (db.raw.prepare('SELECT id FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { id: number }).id,
    );
    expect(() =>
      db.raw
        .prepare(
          'UPDATE capability_obligations SET state=?, capability_execution_receipt_id=?, completion_proof_id=? WHERE id=?',
        )
        .run('completed', staleReceiptId, `ttr:${terminalId}`, id),
    ).toThrow(/bound|receipt/i);
    const receiptId = Number(
      db.raw
        .prepare(
          `INSERT INTO capability_execution_receipts
             (obligation_id, logical_turn_id, tool_use_id, skill_name, contract_version, input_digest, source_digest, result_status, claim_epoch, attempt_number)
           VALUES (?, 'turn-1', 'tu-1', 'watch', 'test-instance/1', ?, ?, 'ok', 1, 1)`,
        )
        .run(id, OBLIGATION.input_digest, OBLIGATION.source_digest).lastInsertRowid,
    );
    // A completion proof that does not name the exact terminal record aborts.
    expect(() =>
      db.raw
        .prepare(
          'UPDATE capability_obligations SET state=?, capability_execution_receipt_id=?, completion_proof_id=? WHERE id=?',
        )
        .run('completed', receiptId, 'terminal-proof-arbitrary', id),
    ).toThrow(/bound|receipt/i);
    expect(() =>
      db.raw
        .prepare(
          'UPDATE capability_obligations SET state=?, capability_execution_receipt_id=?, completion_proof_id=? WHERE id=?',
        )
        .run('completed', receiptId, `ttr:${terminalId}`, id),
    ).not.toThrow();
    // completed is terminal
    expect(() =>
      db.raw.prepare('UPDATE capability_obligations SET state=? WHERE id=?').run('claimed', id),
    ).toThrow(/transition/i);
  });

  it('rows can never be deleted', () => {
    const id = insertObligation();
    expect(() => db.raw.prepare('DELETE FROM capability_obligations WHERE id=?').run(id)).toThrow(/append-only|never deleted/i);
  });
});

describe('group approval gate (D7)', () => {
  const groupObligation = () =>
    insertObligation({
      is_group: 1,
      group_name: 'Test Group',
      delivery_jid: 'test-group-alpha@g.us',
      state: 'waiting_approval',
      source_inbound_seq: 1002,
      source_message_id: 'TESTMSG-GROUP-0001',
    });

  const approve = (obligationId: number, scope: string, jid: string, expires = '2099-01-01T00:00:00Z') =>
    Number(
      db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest, manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, ?, ?, 'relsha', 'attdig', 'mdigest', 'RUN-1', 'owner', datetime('now'), ?)`,
        )
        .run(obligationId, jid, scope, expires).lastInsertRowid,
    );

  // Raw unlock carrying the SAME drain facts the approval records — the gate
  // additionally requires them to be present and equal on the NEW row.
  const unlock = (id: number, approvalId: number | null, facts?: Partial<Record<string, string | null>>) =>
    db.raw
      .prepare(
        `UPDATE capability_obligations
         SET state=?, drain_approval_id=?, drain_release_sha=?, drain_manifest_digest=?,
             drain_run_id=?, drain_attestation_digest=?
         WHERE id=?`,
      )
      .run(
        'waiting_capability',
        approvalId,
        (facts?.releaseSha as string | null) ?? 'relsha',
        (facts?.manifestDigest as string | null) ?? 'mdigest',
        (facts?.drainRunId as string | null) ?? 'RUN-1',
        (facts?.attestationDigest as string | null) ?? 'attdig',
        id,
      );

  it('blocks leaving waiting_approval without naming a consumed approval', () => {
    const id = groupObligation();
    approve(id, 'group', 'test-group-alpha@g.us');
    // Even with a valid approval on file, the transition must reference it.
    expect(() =>
      db.raw.prepare('UPDATE capability_obligations SET state=? WHERE id=?').run('waiting_capability', id),
    ).toThrow(/approval/i);
  });

  it('a DM-scope approval cannot unlock a group obligation', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'dm', 'test-group-alpha@g.us');
    expect(() => unlock(id, approvalId)).toThrow(/approval/i);
  });

  it('an expired approval does not unlock', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'group', 'test-group-alpha@g.us', '2000-01-01T00:00:00Z');
    expect(() => unlock(id, approvalId)).toThrow(/approval/i);
  });

  it('a matching group approval consumed by id with matching drain facts unlocks', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'group', 'test-group-alpha@g.us');
    expect(() => unlock(id, approvalId)).not.toThrow();
  });

  it('the consumed reference alone is NOT enough — absent drain facts abort', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'group', 'test-group-alpha@g.us');
    expect(() =>
      db.raw
        .prepare('UPDATE capability_obligations SET state=?, drain_approval_id=? WHERE id=?')
        .run('waiting_capability', approvalId, id),
    ).toThrow(/approval/i);
  });

  it('drain facts that differ from the consumed approval abort (per-field)', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'group', 'test-group-alpha@g.us');
    for (const wrong of [
      { releaseSha: 'rel-forged' },
      { manifestDigest: 'md-forged' },
      { drainRunId: 'RUN-forged' },
      { attestationDigest: 'att-forged' },
    ]) {
      expect(() => unlock(id, approvalId, wrong)).toThrow(/approval/i);
    }
  });

  it('an approval bound to a different destination does not unlock', () => {
    const id = groupObligation();
    const approvalId = approve(id, 'group', 'test-group-beta@g.us');
    expect(() => unlock(id, approvalId)).toThrow(/approval/i);
  });

  it('an approval recorded for a DIFFERENT obligation does not unlock this one', () => {
    const id = groupObligation();
    const otherId = insertObligation({
      is_group: 1,
      group_name: 'Test Group B',
      delivery_jid: 'test-group-alpha@g.us',
      state: 'waiting_approval',
      source_inbound_seq: 1099,
      source_message_id: 'TESTMSG-GROUP-0099',
    });
    const foreignApproval = approve(otherId, 'group', 'test-group-alpha@g.us');
    expect(() => unlock(id, foreignApproval)).toThrow(/approval/i);
  });

  it('a group approval without an attestation digest is unrepresentable', () => {
    const id = groupObligation();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest, manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, 'test-group-alpha@g.us', 'group', 'relsha', NULL, 'mdigest', 'RUN-1', 'owner', datetime('now'), '2099-01-01T00:00:00Z')`,
        )
        .run(id),
    ).toThrow();
  });
});

describe('append-only companions', () => {
  it('obligation events cannot be updated or deleted', () => {
    const id = insertObligation();
    const evId = Number(
      db.raw
        .prepare(
          `INSERT INTO capability_obligation_events (obligation_id, action, actor_type, reason_code)
           VALUES (?, 'obligation.create', 'runtime', 'conclusive_no_effect')`,
        )
        .run(id).lastInsertRowid,
    );
    expect(() =>
      db.raw.prepare('UPDATE capability_obligation_events SET reason_code=? WHERE id=?').run('edited', evId),
    ).toThrow(/append-only/i);
    expect(() => db.raw.prepare('DELETE FROM capability_obligation_events WHERE id=?').run(evId)).toThrow(/append-only/i);
  });

  it('not_created decisions may be recorded without an obligation id', () => {
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO capability_obligation_events (obligation_id, action, actor_type, reason_code)
           VALUES (NULL, 'obligation.not_created', 'runtime', 'not_created_side_effect_uncertain')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('rejects unknown event actions and actor types', () => {
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO capability_obligation_events (obligation_id, action, actor_type)
           VALUES (NULL, 'obligation.invent', 'runtime')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO capability_obligation_events (obligation_id, action, actor_type)
           VALUES (NULL, 'obligation.create', 'martian')`,
        )
        .run(),
    ).toThrow();
  });

  it('execution receipts are append-only and unique per (obligation, tool_use)', () => {
    const id = insertObligation();
    const ins = () =>
      db.raw
        .prepare(
          `INSERT INTO capability_execution_receipts
             (obligation_id, logical_turn_id, tool_use_id, skill_name, contract_version, input_digest, result_status, claim_epoch, attempt_number)
           VALUES (?, 'turn-1', 'tu-1', 'watch', 'v', 'aa', 'ok', 1, 1)`,
        )
        .run(id);
    ins();
    expect(ins).toThrow(/UNIQUE/i);
    expect(() =>
      db.raw.prepare('UPDATE capability_execution_receipts SET result_status=? WHERE obligation_id=?').run('error', id),
    ).toThrow(/append-only/i);
  });
});

describe('capability_attestations — immutable except revocation', () => {
  const insertAttestation = () =>
    Number(
      db.raw
        .prepare(
          `INSERT INTO capability_attestations
             (host_id, runtime_user, release_sha, schema_version, provider_id, harness_type,
              contract_version, capability, skill_name, skill_digest, dependency_versions,
              media_root, canary_id, canary_result, probe_version, nonce, attested_at, expires_at)
           VALUES ('test-host', 'test-user', 'relsha', 57, 'claude-cli', 'persistent_session',
                   'test-instance/1', 'child_process_tools', 'watch', 'deadbeef', '{}',
                   '/var/media', 'canary-1', 'pass', 'probe/1', 'nonce-1', datetime('now'),
                   datetime('now', '+1 hour'))`,
        )
        .run().lastInsertRowid,
    );

  it('inserts and forbids field mutation', () => {
    const id = insertAttestation();
    expect(() =>
      db.raw.prepare('UPDATE capability_attestations SET release_sha=? WHERE id=?').run('other', id),
    ).toThrow(/immutable/i);
    expect(() => db.raw.prepare('DELETE FROM capability_attestations WHERE id=?').run(id)).toThrow(/append-only|immutable/i);
  });

  it('allows one-way revocation only', () => {
    const id = insertAttestation();
    expect(() =>
      db.raw.prepare('UPDATE capability_attestations SET revoked_at=datetime(\'now\') WHERE id=?').run(id),
    ).not.toThrow();
    expect(() =>
      db.raw.prepare('UPDATE capability_attestations SET revoked_at=NULL WHERE id=?').run(id),
    ).toThrow(/immutable|revocation/i);
  });

  it('enforces nonce uniqueness', () => {
    insertAttestation();
    expect(insertAttestation).toThrow(/UNIQUE/i);
  });
});
