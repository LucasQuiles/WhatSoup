/**
 * Backfill manifest generator — READ-ONLY approval artifact. The digest binds
 * DESTINATION (conversationKey/deliveryJid/isGroup) + SOURCE identity
 * (sourceDigest + token/media hash) + the EXACT reviewer-classified recovery job
 * + the reviewer's fulfilment classification, so an approval can never be reused
 * for a different destination, a swapped source, a different job, or a changed
 * classification. Only a reviewer `confirmed_unfulfilled` whose persisted job
 * agrees and is completed+echo (with no sibling worker-fulfilment) is eligible;
 * every ineligible entry is reported with a reason. A reviewer capability
 * override makes historical audio (incident-7795 shape, excluded from the
 * contract by construction) eligible. Real SQLite + real media files.
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
  type BackfillConfirmedEntry,
  type BackfillReadDb,
} from '../../scripts/capability-obligation-backfill-manifest.ts';

let db: Database;
let work: string;
let seedCounter = 0;

const CONTRACT = parseCapabilityContract({
  version: 'test-instance/1',
  rules: [
    { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
});

function seedInbound(handle: Database, seq: number, messageId: string, chatJid: string): void {
  handle.raw
    .prepare(`INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to) VALUES (?, ?, ?, ?, 'agent')`)
    .run(seq, messageId, `conv-${seq}`, chatJid);
}

function seedMessage(handle: Database, messageId: string, chatJid: string, content: string | null, mediaPath: string | null, fromMe = 0): void {
  handle.raw
    .prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, media_path, is_from_me, timestamp)
       VALUES (?, ?, 'test-sender@s.whatsapp.net', ?, ?, ?, ?, 1000)`,
    )
    .run(chatJid, `conv-x`, messageId, content, mediaPath, fromMe);
}

/**
 * Seed a completed recovery job settled by `completionKind` for `seq`, driving
 * the real transfer lifecycle then setting the terminal state the way the
 * codebase's own migration-40 test does (dropping the two completion-requires
 * triggers for the setup UPDATE). Returns the job id so a confirmed entry can
 * name the EXACT job. A per-call `variant` keeps the terminal-record identity
 * unique when several jobs are seeded for the SAME inbound.
 */
function seedRecoveryJob(handle: Database, seq: number, messageId: string, chatJid: string, completionKind: 'echo' | 'worker' = 'echo'): number {
  const variant = ++seedCounter;
  const turnId = `turn-${seq}-${variant}`;
  const opId = Number(
    handle.raw
      .prepare(
        `INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, source_inbound_seq, replay_policy)
         VALUES (?, ?, 'text', '{"text":"echo"}', 'pending', ?, 'unsafe')`,
      )
      .run(`conv-${seq}`, chatJid, seq).lastInsertRowid,
  );
  const terminalId = Number(
    handle.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
           inbound_disposition, delivery_kind, delivery_op_id,
           recovery_owner_logical_turn_id, recovery_owner_manager_id, recovery_owner_generation, reply_guarantee_disarmed
         ) VALUES (?, ?, ?, ?, ?, ?, 'mgr', 1, 'failed', 'unknown_terminal',
                   'transferred_to_recovery_owner', 'enqueued', ?, ?, 'rec-mgr', 2, 0)`,
      )
      .run(`per_chat`, `conv-${seq}`, chatJid, seq, seq, turnId, opId, `rec-turn-${variant}`).lastInsertRowid,
  );
  const jobId = Number(
    handle.raw
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
      .run(terminalId, `conv-${seq}`, chatJid, seq, seq, turnId, messageId, chatJid.endsWith('@g.us') ? 1 : 0)
      .lastInsertRowid,
  );
  handle.raw.exec(`
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_source;
    DROP TRIGGER IF EXISTS turn_recovery_completion_requires_terminal_delivery;
  `);
  handle.raw
    .prepare(
      `UPDATE turn_recovery_jobs
       SET state = 'completed', attempt_count = 1, claim_epoch = 1,
           claim_token = 'setup-claim', claimed_at = datetime('now'),
           claim_expires_at = datetime('now'), completed_at = datetime('now'),
           completion_kind = ?, completion_proof_id = ?
       WHERE id = ?`,
    )
    .run(completionKind, `${completionKind}:${variant}`, jobId);
  return jobId;
}

function mediaFile(name: string, bytes: string): string {
  const p = join(work, name);
  writeFileSync(p, bytes);
  return p;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  work = mkdtempSync(join(tmpdir(), 'backfill-'));
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

/** Confirmed entry with `evidenceMatrixDigest` optional — the helper supplies a
 *  stable per-entry default so eligibility tests stay terse. */
type ConfirmedInput = Omit<BackfillConfirmedEntry, 'evidenceMatrixDigest'> & { evidenceMatrixDigest?: string };
function withEvidence(confirmed: ConfirmedInput[]): BackfillConfirmedEntry[] {
  return confirmed.map((c) => ({ evidenceMatrixDigest: `ev-${c.sourceInboundSeq}-${c.sourceMessageId}`, ...c }));
}
function runOn(handle: Database, confirmed: ConfirmedInput[], manifestId = 'MANIFEST-1') {
  return generateBackfillManifest(handle.raw as unknown as BackfillReadDb, { manifestId, contract: CONTRACT, confirmed: withEvidence(confirmed) });
}
function run(confirmed: ConfirmedInput[], manifestId = 'MANIFEST-1') {
  return runOn(db, confirmed, manifestId);
}

/** The confirmed-unfulfilled classification most tests use. */
const CONFIRMED = 'confirmed_unfulfilled' as const;

describe('generateBackfillManifest — eligibility', () => {
  it('URL (contract), media video (contract), and audio (reviewer override) are all eligible', () => {
    seedInbound(db, 7761, 'MW-7761', 'test-dm@lid');
    seedMessage(db, 'MW-7761', 'test-dm@lid', 'check this https://youtu.be/abc', null);
    const j7761 = seedRecoveryJob(db, 7761, 'MW-7761', 'test-dm@lid');

    const videoBytes = 'VIDEO-BYTES-xyz';
    seedInbound(db, 7799, 'GRP-7799', 'test-group@g.us');
    seedMessage(db, 'GRP-7799', 'test-group@g.us', 'Weekly clip', mediaFile('clip.webm', videoBytes));
    const j7799 = seedRecoveryJob(db, 7799, 'GRP-7799', 'test-group@g.us');

    const audioBytes = 'AUDIO-OGG-BYTES';
    seedInbound(db, 7795, 'GRP-7795', 'test-group2@g.us');
    seedMessage(db, 'GRP-7795', 'test-group2@g.us', '', mediaFile('voice.ogg', audioBytes));
    const j7795 = seedRecoveryJob(db, 7795, 'GRP-7795', 'test-group2@g.us');

    const m = run([
      { sourceInboundSeq: 7761, sourceMessageId: 'MW-7761', recoveryJobId: j7761, fulfillmentClassification: CONFIRMED },
      { sourceInboundSeq: 7799, sourceMessageId: 'GRP-7799', recoveryJobId: j7799, fulfillmentClassification: CONFIRMED, mediaClass: 'video' },
      // audio: contract cannot classify it — reviewer supplies the capability.
      { sourceInboundSeq: 7795, sourceMessageId: 'GRP-7795', recoveryJobId: j7795, fulfillmentClassification: CONFIRMED, reviewerCapability: 'child_process_tools' },
    ]);
    expect(m.eligibleCount).toBe(3);
    const url = m.entries.find((e) => e.sourceInboundSeq === 7761)!;
    expect(url).toMatchObject({ eligible: true, classifiedBy: 'contract', sourceToken: 'https://youtu.be/abc', mediaSha256: null, recoveryJobId: j7761, fulfillmentClassification: CONFIRMED });
    expect(url.sourceDigest).toBe(createHash('sha256').update('https://youtu.be/abc').digest('hex'));
    const video = m.entries.find((e) => e.sourceInboundSeq === 7799)!;
    expect(video).toMatchObject({ eligible: true, classifiedBy: 'contract', isGroup: true, recoveryJobId: j7799 });
    expect(video.sourceDigest).toBe(createHash('sha256').update(videoBytes).digest('hex'));
    const audio = m.entries.find((e) => e.sourceInboundSeq === 7795)!;
    expect(audio).toMatchObject({ eligible: true, classifiedBy: 'reviewer', requiredCapability: 'child_process_tools', isGroup: true, recoveryJobId: j7795 });
    expect(audio.sourceDigest).toBe(createHash('sha256').update(audioBytes).digest('hex'));
  });

  it('audio WITHOUT a reviewer override is contract_no_match (excluded by construction)', () => {
    seedInbound(db, 1, 'A1', 'test-group@g.us');
    seedMessage(db, 'A1', 'test-group@g.us', '', mediaFile('voice.ogg', 'x'));
    const m = run([{ sourceInboundSeq: 1, sourceMessageId: 'A1', recoveryJobId: 999, fulfillmentClassification: CONFIRMED, mediaClass: 'audio' }]);
    expect(m.entries[0]).toMatchObject({ eligible: false, reason: 'contract_no_match' });
  });

  it('reports ineligible entries with reasons (outbound, missing, mismatch, media-unavailable, override-needs-media)', () => {
    seedInbound(db, 1, 'M1', 'test-dm@lid');
    seedMessage(db, 'M1', 'test-dm@lid', 'https://youtu.be/x', null, /* fromMe */ 1);
    seedInbound(db, 2, 'M2', 'test-dm@lid'); // message absent
    seedInbound(db, 3, 'M3', 'test-dm@lid');
    seedMessage(db, 'M3', 'test-dm@lid', 'clip', '/nonexistent/path.webm'); // media file missing
    seedInbound(db, 4, 'M4', 'test-dm@lid');
    seedMessage(db, 'M4', 'test-dm@lid', 'plain text no media', null); // reviewer override but no media

    const m = run([
      { sourceInboundSeq: 1, sourceMessageId: 'M1', recoveryJobId: 1, fulfillmentClassification: CONFIRMED },
      { sourceInboundSeq: 2, sourceMessageId: 'M2', recoveryJobId: 2, fulfillmentClassification: CONFIRMED },
      { sourceInboundSeq: 3, sourceMessageId: 'M3', recoveryJobId: 3, fulfillmentClassification: CONFIRMED, mediaClass: 'video' },
      { sourceInboundSeq: 4, sourceMessageId: 'M4', recoveryJobId: 4, fulfillmentClassification: CONFIRMED, reviewerCapability: 'child_process_tools' },
      { sourceInboundSeq: 999, sourceMessageId: 'X', recoveryJobId: 5, fulfillmentClassification: CONFIRMED },
    ]);
    const r = Object.fromEntries(m.entries.map((e) => [e.sourceInboundSeq, e.reason]));
    expect(r[1]).toBe('message_is_outbound');
    expect(r[2]).toBe('message_not_found');
    expect(r[3]).toBe('media_unavailable');
    expect(r[4]).toBe('reviewer_override_requires_media');
    expect(r[999]).toBe('inbound_not_found');
    expect(m.entries).toHaveLength(5); // nothing dropped
  });
});

describe('generateBackfillManifest — recovery-job binding (F2)', () => {
  function seedEligibleUrl(seq: number, messageId: string, chatJid = 'test-dm@lid'): void {
    seedInbound(db, seq, messageId, chatJid);
    seedMessage(db, messageId, chatJid, 'https://youtu.be/a', null);
  }

  it('a confirmed entry whose recovery job does not exist is recovery_job_not_found', () => {
    seedEligibleUrl(10, 'A');
    const m = run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: 4242, fulfillmentClassification: CONFIRMED }]);
    expect(m.entries[0]).toMatchObject({ eligible: false, reason: 'recovery_job_not_found' });
  });

  it('a job belonging to a different inbound is recovery_job_binding_mismatch', () => {
    seedEligibleUrl(10, 'A');
    seedEligibleUrl(11, 'B');
    const jobForOther = seedRecoveryJob(db, 11, 'B', 'test-dm@lid'); // real job, wrong inbound
    const m = run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: jobForOther, fulfillmentClassification: CONFIRMED }]);
    expect(m.entries[0]).toMatchObject({ eligible: false, reason: 'recovery_job_binding_mismatch' });
  });

  it('a non-confirmed classification is fulfillment_not_confirmed', () => {
    seedEligibleUrl(10, 'A');
    const job = seedRecoveryJob(db, 10, 'A', 'test-dm@lid');
    for (const klass of ['conflicting', 'inconclusive'] as const) {
      const m = run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: job, fulfillmentClassification: klass }]);
      expect(m.entries[0]).toMatchObject({ eligible: false, reason: 'fulfillment_not_confirmed' });
    }
  });

  it('a worker-settled job is recovery_job_not_echo_settled, and a sibling worker fulfilment is later_fulfillment_found', () => {
    seedEligibleUrl(10, 'A');
    const workerJob = seedRecoveryJob(db, 10, 'A', 'test-dm@lid', 'worker');
    expect(run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: workerJob, fulfillmentClassification: CONFIRMED }]).entries[0])
      .toMatchObject({ eligible: false, reason: 'recovery_job_not_echo_settled' });

    // Now also add an echo job for the same inbound: the sibling worker fulfilment vetoes it.
    const echoJob = seedRecoveryJob(db, 10, 'A', 'test-dm@lid', 'echo');
    expect(run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: echoJob, fulfillmentClassification: CONFIRMED }]).entries[0])
      .toMatchObject({ eligible: false, reason: 'later_fulfillment_found' });
  });
});

describe('generateBackfillManifest — digest binding', () => {
  it('FALSIFIER: changing an eligible destination from DM to group CHANGES the digest', () => {
    // Same source (seq/message/token), differing only in destination. Seeded in
    // two DBs because an inbound with an outstanding recovery proof cannot be
    // deleted in place.
    seedInbound(db, 10, 'A', 'test-dm@lid');
    seedMessage(db, 'A', 'test-dm@lid', 'https://youtu.be/a', null);
    const jDm = seedRecoveryJob(db, 10, 'A', 'test-dm@lid');
    const dmDigest = run([{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: jDm, fulfillmentClassification: CONFIRMED }]).manifestDigest;

    const gdb = new Database(':memory:');
    gdb.open();
    try {
      seedInbound(gdb, 10, 'A', 'test-group@g.us');
      seedMessage(gdb, 'A', 'test-group@g.us', 'https://youtu.be/a', null);
      const jGroup = seedRecoveryJob(gdb, 10, 'A', 'test-group@g.us');
      const groupDigest = runOn(gdb, [{ sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: jGroup, fulfillmentClassification: CONFIRMED }]).manifestDigest;
      expect(groupDigest).not.toBe(dmDigest);
    } finally {
      gdb.close();
    }
  });

  it('FALSIFIER: editing the message text CHANGES the digest even when the source token is identical (F3 inputDigest bind)', () => {
    seedInbound(db, 20, 'C', 'test-dm@lid');
    seedMessage(db, 'C', 'test-dm@lid', 'https://youtu.be/a', null);
    const j = seedRecoveryJob(db, 20, 'C', 'test-dm@lid');
    const before = run([{ sourceInboundSeq: 20, sourceMessageId: 'C', recoveryJobId: j, fulfillmentClassification: CONFIRMED }]);
    // Edit the text around the SAME url — sourceToken/sourceDigest unchanged, inputDigest changes.
    db.raw.prepare("UPDATE messages SET content = 'please watch https://youtu.be/a' WHERE message_id = 'C'").run();
    const after = run([{ sourceInboundSeq: 20, sourceMessageId: 'C', recoveryJobId: j, fulfillmentClassification: CONFIRMED }]);
    expect(after.entries[0]!.sourceDigest).toBe(before.entries[0]!.sourceDigest); // token unchanged
    expect(after.entries[0]!.inputDigest).not.toBe(before.entries[0]!.inputDigest); // payload changed
    expect(after.manifestDigest).not.toBe(before.manifestDigest);
  });

  it('FALSIFIER: a different reviewer evidence-matrix digest CHANGES the manifest digest (F6)', () => {
    seedInbound(db, 21, 'D', 'test-dm@lid');
    seedMessage(db, 'D', 'test-dm@lid', 'https://youtu.be/a', null);
    const j = seedRecoveryJob(db, 21, 'D', 'test-dm@lid');
    const a = run([{ sourceInboundSeq: 21, sourceMessageId: 'D', recoveryJobId: j, fulfillmentClassification: CONFIRMED, evidenceMatrixDigest: 'evidence-A' }]);
    const b = run([{ sourceInboundSeq: 21, sourceMessageId: 'D', recoveryJobId: j, fulfillmentClassification: CONFIRMED, evidenceMatrixDigest: 'evidence-B' }]);
    expect(a.manifestDigest).not.toBe(b.manifestDigest);
  });

  it('is order-independent over eligible entries and binds the manifest id', () => {
    seedInbound(db, 10, 'A', 'test-dm@lid');
    seedMessage(db, 'A', 'test-dm@lid', 'https://youtu.be/a', null);
    const jA = seedRecoveryJob(db, 10, 'A', 'test-dm@lid');
    seedInbound(db, 11, 'B', 'test-dm@lid');
    seedMessage(db, 'B', 'test-dm@lid', 'https://youtu.be/b', null);
    const jB = seedRecoveryJob(db, 11, 'B', 'test-dm@lid');
    const eA = { sourceInboundSeq: 10, sourceMessageId: 'A', recoveryJobId: jA, fulfillmentClassification: CONFIRMED };
    const eB = { sourceInboundSeq: 11, sourceMessageId: 'B', recoveryJobId: jB, fulfillmentClassification: CONFIRMED };
    const d1 = run([eA, eB]).manifestDigest;
    const d2 = run([eB, eA]).manifestDigest;
    expect(d2).toBe(d1);
    const other = run([eA, eB], 'MANIFEST-2').manifestDigest;
    expect(other).not.toBe(d1);
  });
});
