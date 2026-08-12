/**
 * Backfill EXECUTOR (owner-gated) — appends historical obligations from an
 * approved manifest through the guarded store, ONLY for inbounds proven
 * non-fulfilled (a completed recovery job settled completion_kind='echo'),
 * with media hash/retain/reverify, idempotently, leaving the original recovery
 * rows untouched. Reviewer-classified audio (incident-7795 shape) drains too.
 * Real SQLite + real media files.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityContract } from '../../src/core/capability-contract.ts';
import { Database } from '../../src/core/database.ts';
import {
  generateBackfillManifest,
  type BackfillReadDb,
} from '../../scripts/capability-obligation-backfill-manifest.ts';
import { executeBackfill } from '../../scripts/capability-obligation-backfill-execute.ts';

let db: Database;
let work: string;

const CONTRACT = parseCapabilityContract({
  version: 'test-instance/1',
  rules: [
    { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
});

function seedInbound(seq: number, messageId: string, chatJid: string): void {
  db.raw
    .prepare(`INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to, processing_status) VALUES (?, ?, ?, ?, 'agent', 'complete')`)
    .run(seq, messageId, `conv-${seq}`, chatJid);
}

function seedMessage(messageId: string, chatJid: string, content: string | null, mediaPath: string | null): void {
  db.raw
    .prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, media_path, is_from_me, timestamp)
       VALUES (?, ?, 'test-sender@s.whatsapp.net', 'Test Sender', ?, ?, ?, 0, 1000)`,
    )
    .run(chatJid, `conv-x`, messageId, content, mediaPath);
}

/**
 * Seed a completed recovery job settled by `completionKind` for `seq`, driving
 * the real transfer lifecycle (op 'pending' + 'enqueued' transfer), then setting
 * the terminal state the way the codebase's own migration-40 test does — by
 * dropping the two completion-requires triggers for the setup UPDATE. The
 * executor only READS these rows.
 */
function seedEchoRecoveryJob(seq: number, messageId: string, chatJid: string, completionKind: 'echo' | 'worker' = 'echo'): void {
  const opId = Number(
    db.raw
      .prepare(
        `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, source_inbound_seq, replay_policy)
         VALUES (?, ?, 'text', '{"text":"echo"}', 'pending', ?, 'unsafe')`,
      )
      .run(`conv-${seq}`, chatJid, seq).lastInsertRowid,
  );
  const terminalId = Number(
    db.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
           inbound_disposition, delivery_kind, delivery_op_id,
           recovery_owner_logical_turn_id, recovery_owner_manager_id, recovery_owner_generation, reply_guarantee_disarmed
         ) VALUES (?, ?, ?, ?, ?, ?, 'mgr', 1, 'failed', 'unknown_terminal',
                   'transferred_to_recovery_owner', 'enqueued', ?, ?, 'rec-mgr', 2, 0)`,
      )
      .run(`per_chat`, `conv-${seq}`, chatJid, seq, seq, `turn-${seq}`, opId, `rec-turn-${seq}`).lastInsertRowid,
  );
  const jobId = Number(
    db.raw
      .prepare(
        `INSERT INTO turn_recovery_jobs (
           terminal_record_id, scope, conversation_key, delivery_jid,
           source_inbound_seq, source_inbound_seq_key,
           source_logical_turn_id, source_manager_id, source_generation, source_message_id,
           owner_logical_turn_id, owner_manager_id, owner_generation,
           assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
           replay_safe, sender_jid, replay_text, is_group, state
         ) VALUES (?, 'per_chat', ?, ?, ?, ?, ?, 'mgr', 1, ?, 'rec-turn', 'rec-mgr', 2, 'rec-turn', 'rec-mgr', 2,
                   1, 'test-sender@s.whatsapp.net', 'proof', ?, 'pending')`,
      )
      .run(terminalId, `conv-${seq}`, chatJid, seq, seq, `turn-${seq}`, messageId, chatJid.endsWith('@g.us') ? 1 : 0)
      .lastInsertRowid,
  );
  db.raw.exec(`
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery;
  `);
  db.raw
    .prepare(
      `UPDATE turn_recovery_jobs
       SET state = 'completed', attempt_count = 1, claim_epoch = 1,
           claim_token = 'backfill-setup-claim', claimed_at = datetime('now'),
           claim_expires_at = datetime('now'), completed_at = datetime('now'),
           completion_kind = ?, completion_proof_id = ?
       WHERE id = ?`,
    )
    .run(completionKind, `echo:${seq}`, jobId);
}

function mediaFile(name: string, bytes: string): string {
  const p = join(work, name);
  writeFileSync(p, bytes);
  return p;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  work = mkdtempSync(join(tmpdir(), 'backfill-exec-'));
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

function manifestEligible(confirmed: Parameters<typeof generateBackfillManifest>[1]['confirmed']) {
  const m = generateBackfillManifest(db.raw as unknown as BackfillReadDb, { manifestId: 'MANIFEST-1', contract: CONTRACT, confirmed });
  return m.entries.filter((e) => e.eligible);
}

const exec = (eligible: ReturnType<typeof manifestEligible>) =>
  executeBackfill(db, {
    manifestId: 'MANIFEST-1',
    eligible,
    mediaRoot: join(work, 'retained'),
    retentionPolicyVersion: 'policy/1',
    skillName: 'watch',
    mediaClassFor: (d) => (d.mediaSha256 != null ? 'video' : null),
  });

describe('executeBackfill', () => {
  it('creates obligations for echo-unfulfilled URL + media + reviewer-audio, and is idempotent', async () => {
    seedInbound(7761, 'MW-7761', 'test-dm@lid');
    seedMessage('MW-7761', 'test-dm@lid', 'check https://youtu.be/abc', null);
    seedEchoRecoveryJob(7761, 'MW-7761', 'test-dm@lid');

    seedInbound(7799, 'GRP-7799', 'test-group@g.us');
    seedMessage('GRP-7799', 'test-group@g.us', 'clip', mediaFile('clip.webm', 'VIDEO-BYTES'));
    seedEchoRecoveryJob(7799, 'GRP-7799', 'test-group@g.us');

    seedInbound(7795, 'GRP-7795', 'test-group2@g.us');
    seedMessage('GRP-7795', 'test-group2@g.us', '', mediaFile('voice.ogg', 'AUDIO-BYTES'));
    seedEchoRecoveryJob(7795, 'GRP-7795', 'test-group2@g.us');

    const eligible = manifestEligible([
      { sourceInboundSeq: 7761, sourceMessageId: 'MW-7761' },
      { sourceInboundSeq: 7799, sourceMessageId: 'GRP-7799', mediaClass: 'video' },
      { sourceInboundSeq: 7795, sourceMessageId: 'GRP-7795', reviewerCapability: 'child_process_tools' },
    ]);
    expect(eligible).toHaveLength(3);

    const r1 = await exec(eligible);
    expect(r1.created).toHaveLength(3);
    expect(r1.skipped).toEqual([]);
    expect(r1.recoveryRowsUnchanged).toBe(true);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM capability_obligations WHERE creation_reason = 'reviewed_backfill:MANIFEST-1'").get() as { c: number }).c).toBe(3);

    // Idempotent: a second run creates nothing.
    const r2 = await exec(eligible);
    expect(r2.created).toEqual([]);
    expect(r2.alreadyExisted).toHaveLength(3);
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(3);
  });

  it('SKIPS an inbound whose recovery job is not echo-settled (prior non-fulfillment unproven)', async () => {
    seedInbound(1, 'W1', 'test-dm@lid');
    seedMessage('W1', 'test-dm@lid', 'https://youtu.be/x', null);
    seedEchoRecoveryJob(1, 'W1', 'test-dm@lid', 'worker'); // fulfilled by a worker, not echo
    const r = await exec(manifestEligible([{ sourceInboundSeq: 1, sourceMessageId: 'W1' }]));
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([{ sourceInboundSeq: 1, reason: 'not_proven_echo_unfulfilled' }]);
  });

  it('SKIPS a media entry whose bytes changed after approval (reverify fails)', async () => {
    seedInbound(2, 'M2', 'test-dm@lid');
    const p = mediaFile('m.webm', 'ORIGINAL-VIDEO');
    seedMessage('M2', 'test-dm@lid', 'clip', p);
    seedEchoRecoveryJob(2, 'M2', 'test-dm@lid');
    const eligible = manifestEligible([{ sourceInboundSeq: 2, sourceMessageId: 'M2', mediaClass: 'video' }]);
    expect(eligible[0]!.mediaSha256).toBe(createHash('sha256').update('ORIGINAL-VIDEO').digest('hex'));
    // The media file is tampered between approval and execution.
    writeFileSync(p, 'TAMPERED-VIDEO-BYTES');
    const r = await exec(eligible);
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([{ sourceInboundSeq: 2, reason: 'media_reverify_failed' }]);
  });
});
