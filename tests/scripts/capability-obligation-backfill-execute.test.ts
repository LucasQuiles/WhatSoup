/**
 * Backfill EXECUTOR (owner-gated) — appends historical obligations from an
 * APPROVED manifest through the guarded store, ONLY after recomputing and
 * verifying the manifest digest (F1), and ONLY for inbounds the reviewer
 * classified `confirmed_unfulfilled` whose EXACT named recovery job agrees and
 * is completed+echo with no sibling worker-fulfilment (F2). Media is
 * hash/retain/reverified; creation is idempotent and atomic (all-row
 * transaction); the original recovery rows are proven untouched; and the real
 * recovery job id is persisted as origin_recovery_job_id. The owner-gated CLI
 * enforces schema/quiescence/backup/expect-existing/confirm-token (F3).
 * Real SQLite + real media files.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCapabilityContract } from '../../src/core/capability-contract.ts';
import { Database } from '../../src/core/database.ts';
import {
  generateBackfillManifest,
  type BackfillReadDb,
} from '../../scripts/capability-obligation-backfill-manifest.ts';
import { executeBackfill, runBackfillExecuteCli } from '../../scripts/capability-obligation-backfill-execute.ts';

let db: Database;
let work: string;

const CONTRACT = parseCapabilityContract({
  version: 'test-instance/1',
  rules: [
    { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    { id: 'watch-video', kind: 'media_class', mediaClass: 'video', capability: 'child_process_tools' },
  ],
});

const CONFIRMED = 'confirmed_unfulfilled' as const;

function seedInbound(handle: Database, seq: number, messageId: string, chatJid: string): void {
  handle.raw
    .prepare(`INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to, processing_status) VALUES (?, ?, ?, ?, 'agent', 'complete')`)
    .run(seq, messageId, `conv-${seq}`, chatJid);
}

function seedMessage(handle: Database, messageId: string, chatJid: string, content: string | null, mediaPath: string | null): void {
  handle.raw
    .prepare(
      `INSERT INTO messages (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, media_path, is_from_me, timestamp)
       VALUES (?, ?, 'test-sender@s.whatsapp.net', 'Test Sender', ?, ?, ?, 0, 1000)`,
    )
    .run(chatJid, `conv-x`, messageId, content, mediaPath);
}

let seedCounter = 0;

/** Seed a completed recovery job (echo by default) and return its id. A per-call
 *  `variant` keeps the terminal-record identity unique across several jobs for
 *  the SAME inbound. */
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
           claim_token = 'backfill-setup-claim', claimed_at = datetime('now'),
           claim_expires_at = datetime('now'), completed_at = datetime('now'),
           completion_kind = ?, completion_proof_id = ?
       WHERE id = ?`,
    )
    .run(completionKind, `${completionKind}:${seq}`, jobId);
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
  work = mkdtempSync(join(tmpdir(), 'backfill-exec-'));
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

function manifest(confirmed: Parameters<typeof generateBackfillManifest>[1]['confirmed']) {
  return generateBackfillManifest(db.raw as unknown as BackfillReadDb, { manifestId: 'MANIFEST-1', contract: CONTRACT, confirmed });
}

const exec = (m: ReturnType<typeof manifest>, opts?: { approvedDigest?: string; dryRun?: boolean }) =>
  executeBackfill(db, {
    manifestId: 'MANIFEST-1',
    approvedDigest: opts?.approvedDigest ?? m.manifestDigest,
    eligible: m.entries.filter((e) => e.eligible),
    mediaRoot: join(work, 'retained'),
    retentionPolicyVersion: 'policy/1',
    skillName: 'watch',
    mediaClassFor: (d) => (d.mediaSha256 != null ? 'video' : null),
    dryRun: opts?.dryRun ?? false,
  });

describe('executeBackfill', () => {
  it('creates obligations for echo-unfulfilled URL + media + reviewer-audio, persists the real recovery job id, and is idempotent', async () => {
    seedInbound(db, 7761, 'MW-7761', 'test-dm@lid');
    seedMessage(db, 'MW-7761', 'test-dm@lid', 'check https://youtu.be/abc', null);
    const j7761 = seedRecoveryJob(db, 7761, 'MW-7761', 'test-dm@lid');

    seedInbound(db, 7799, 'GRP-7799', 'test-group@g.us');
    seedMessage(db, 'GRP-7799', 'test-group@g.us', 'clip', mediaFile('clip.webm', 'VIDEO-BYTES'));
    const j7799 = seedRecoveryJob(db, 7799, 'GRP-7799', 'test-group@g.us');

    seedInbound(db, 7795, 'GRP-7795', 'test-group2@g.us');
    seedMessage(db, 'GRP-7795', 'test-group2@g.us', '', mediaFile('voice.ogg', 'AUDIO-BYTES'));
    const j7795 = seedRecoveryJob(db, 7795, 'GRP-7795', 'test-group2@g.us');

    const m = manifest([
      { sourceInboundSeq: 7761, sourceMessageId: 'MW-7761', recoveryJobId: j7761, fulfillmentClassification: CONFIRMED },
      { sourceInboundSeq: 7799, sourceMessageId: 'GRP-7799', recoveryJobId: j7799, fulfillmentClassification: CONFIRMED, mediaClass: 'video' },
      { sourceInboundSeq: 7795, sourceMessageId: 'GRP-7795', recoveryJobId: j7795, fulfillmentClassification: CONFIRMED, reviewerCapability: 'child_process_tools' },
    ]);
    expect(m.eligibleCount).toBe(3);

    const r1 = await exec(m);
    expect(r1.digestVerified).toBe(true);
    expect(r1.created).toHaveLength(3);
    expect(r1.skipped).toEqual([]);
    expect(r1.recoveryRowsUnchanged).toBe(true);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM capability_obligations WHERE creation_reason = 'reviewed_backfill:MANIFEST-1'").get() as { c: number }).c).toBe(3);
    // F2 — the real recovery job id is persisted (never null).
    const jobIds = (db.raw.prepare('SELECT origin_recovery_job_id AS j FROM capability_obligations ORDER BY origin_recovery_job_id').all() as Array<{ j: number | null }>).map((x) => x.j);
    expect(jobIds).toEqual([j7761, j7799, j7795].sort((a, b) => a - b));

    // Idempotent: a second run creates nothing.
    const r2 = await exec(m);
    expect(r2.created).toEqual([]);
    expect(r2.alreadyExisted).toHaveLength(3);
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(3);
  });

  it('FALSIFIER: refuses the WHOLE run when a descriptor was altered after approval (digest mismatch)', async () => {
    seedInbound(db, 1, 'A', 'test-dm@lid');
    seedMessage(db, 'A', 'test-dm@lid', 'https://youtu.be/a', null);
    const job = seedRecoveryJob(db, 1, 'A', 'test-dm@lid');
    const m = manifest([{ sourceInboundSeq: 1, sourceMessageId: 'A', recoveryJobId: job, fulfillmentClassification: CONFIRMED }]);
    const approvedDigest = m.manifestDigest;
    // Tamper the eligible descriptor's destination after approval.
    m.entries.find((e) => e.eligible)!.deliveryJid = 'test-attacker@lid';
    const r = await executeBackfill(db, {
      manifestId: 'MANIFEST-1', approvedDigest, eligible: m.entries.filter((e) => e.eligible),
      mediaRoot: join(work, 'retained'), retentionPolicyVersion: 'policy/1', skillName: 'watch',
    });
    expect(r.digestVerified).toBe(false);
    expect(r.created).toEqual([]);
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(0);
  });

  it('SKIPS at execution time an inbound that gained a sibling worker fulfilment after approval (executor re-checks)', async () => {
    seedInbound(db, 1, 'W1', 'test-dm@lid');
    seedMessage(db, 'W1', 'test-dm@lid', 'https://youtu.be/x', null);
    const echoJob = seedRecoveryJob(db, 1, 'W1', 'test-dm@lid');
    const m = manifest([{ sourceInboundSeq: 1, sourceMessageId: 'W1', recoveryJobId: echoJob, fulfillmentClassification: CONFIRMED }]);
    expect(m.eligibleCount).toBe(1);
    // Between approval and execution, the request is actually fulfilled by a worker.
    seedRecoveryJob(db, 1, 'W1', 'test-dm@lid', 'worker');
    const r = await exec(m);
    expect(r.digestVerified).toBe(true);
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([{ sourceInboundSeq: 1, reason: 'later_fulfillment_found' }]);
  });

  it('SKIPS a media entry whose bytes changed after approval (reverify fails)', async () => {
    seedInbound(db, 2, 'M2', 'test-dm@lid');
    const p = mediaFile('m.webm', 'ORIGINAL-VIDEO');
    seedMessage(db, 'M2', 'test-dm@lid', 'clip', p);
    const job = seedRecoveryJob(db, 2, 'M2', 'test-dm@lid');
    const m = manifest([{ sourceInboundSeq: 2, sourceMessageId: 'M2', recoveryJobId: job, fulfillmentClassification: CONFIRMED, mediaClass: 'video' }]);
    expect(m.entries[0]!.mediaSha256).toBe(createHash('sha256').update('ORIGINAL-VIDEO').digest('hex'));
    writeFileSync(p, 'TAMPERED-VIDEO-BYTES');
    const r = await exec(m);
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([{ sourceInboundSeq: 2, reason: 'media_reverify_failed' }]);
  });

  it('dry-run runs the checks but creates nothing and retains no media', async () => {
    seedInbound(db, 1, 'A', 'test-dm@lid');
    seedMessage(db, 'A', 'test-dm@lid', 'https://youtu.be/a', null);
    const job = seedRecoveryJob(db, 1, 'A', 'test-dm@lid');
    const m = manifest([{ sourceInboundSeq: 1, sourceMessageId: 'A', recoveryJobId: job, fulfillmentClassification: CONFIRMED }]);
    const r = await exec(m, { dryRun: true });
    expect(r.digestVerified).toBe(true);
    expect(r.created).toEqual([]);
    expect(r.wouldCreate).toEqual([1]);
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(0);
  });
});

describe('runBackfillExecuteCli (owner-gated F3)', () => {
  let dir: string;
  let dbFile: string;
  let backupFile: string;
  let manifestFile: string;
  let approvedDigest: string;

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
  }

  function currentSchemaSqlite(path: string): void {
    const h = new Database(path);
    h.open();
    h.close();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backfill-cli-'));
    dbFile = join(dir, 'live.db');
    backupFile = join(dir, 'backup.db');
    manifestFile = join(dir, 'manifest.json');
    // Build a live DB with one echo-unfulfilled URL inbound, then write the manifest.
    const live = new Database(dbFile);
    live.open();
    seedInbound(live, 1, 'A', 'test-dm@lid');
    seedMessage(live, 'A', 'test-dm@lid', 'https://youtu.be/a', null);
    const job = seedRecoveryJob(live, 1, 'A', 'test-dm@lid');
    const m = generateBackfillManifest(live.raw as unknown as BackfillReadDb, {
      manifestId: 'MANIFEST-CLI', contract: CONTRACT,
      confirmed: [{ sourceInboundSeq: 1, sourceMessageId: 'A', recoveryJobId: job, fulfillmentClassification: CONFIRMED }],
    });
    approvedDigest = m.manifestDigest;
    writeFileSync(manifestFile, JSON.stringify(m));
    live.close();
    currentSchemaSqlite(backupFile);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const baseArgs = () => [
    '--db', dbFile, '--manifest', manifestFile, '--media-root', join(dir, 'retained'),
    '--retention-policy-version', 'policy/1', '--skill', 'watch', '--run-id', 'RUN-1', '--expect-existing', '0',
  ];

  it('dry-run (no --confirm) creates nothing and exits 0', async () => {
    const cap = capture();
    const code = await runBackfillExecuteCli(baseArgs(), cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('DRY-RUN');
    const h = new DatabaseSync(dbFile, { readOnly: true });
    expect((h.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(0);
    h.close();
  });

  it('--confirm with the approved digest + valid backup APPLIES and exits 0', async () => {
    const cap = capture();
    const code = await runBackfillExecuteCli([...baseArgs(), '--backup-path', backupFile, '--confirm', approvedDigest], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('APPLIED');
    const h = new DatabaseSync(dbFile, { readOnly: true });
    expect((h.prepare('SELECT COUNT(*) AS c FROM capability_obligations').get() as { c: number }).c).toBe(1);
    h.close();
  });

  it('refuses a --confirm token that is not the manifest digest', async () => {
    const cap = capture();
    const code = await runBackfillExecuteCli([...baseArgs(), '--backup-path', backupFile, '--confirm', 'deadbeef'], cap.io);
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('does not equal the manifest digest');
  });

  it('refuses when --backup-path is absent on apply', async () => {
    const cap = capture();
    const code = await runBackfillExecuteCli([...baseArgs(), '--confirm', approvedDigest], cap.io);
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('--backup-path is required');
  });

  it('refuses when --expect-existing does not match the current backfill count', async () => {
    const cap = capture();
    const code = await runBackfillExecuteCli(
      ['--db', dbFile, '--manifest', manifestFile, '--media-root', join(dir, 'retained'),
        '--retention-policy-version', 'policy/1', '--skill', 'watch', '--run-id', 'RUN-1', '--expect-existing', '5',
        '--backup-path', backupFile, '--confirm', approvedDigest],
      cap.io,
    );
    expect(code).toBe(2);
    expect(cap.err.join('\n')).toContain('expected 5 existing backfill obligations');
  });

  it('refuses when the DB is busy (a held write lock == the bot is running)', async () => {
    const holder = new DatabaseSync(dbFile);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec("INSERT INTO inbound_events (seq, message_id, conversation_key, chat_jid, routed_to) VALUES (9999, 'LOCK', 'c', 'test-dm@lid', 'agent')");
    try {
      const cap = capture();
      let threw = false;
      let code = -1;
      try {
        code = await runBackfillExecuteCli([...baseArgs(), '--backup-path', backupFile, '--confirm', approvedDigest], cap.io);
      } catch (e) {
        threw = true;
        expect(String(e)).toMatch(/busy|locked/i);
      }
      // Either a thrown busy error or a non-zero refusal is acceptable; a silent apply is not.
      expect(threw || code !== 0).toBe(true);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});
