// Black-box tests for scripts/turn-recovery-operator.ts (#2155 part B).
// A real on-disk migrated instance DB is seeded with blocked_unsafe recovery
// jobs through the SAME durability transfer path production uses; the CLI is
// then driven as a child process, so argument handling, redaction, dry-run
// semantics, the newer-activity gate, and audit receipts are all proven at
// the operator's actual surface.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type RecoveryOwnerIdentity,
  type TurnRecoveryReplayEnvelope,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'scripts/turn-recovery-operator.ts');

const OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-1',
  managerId: 'manager-recovery',
  generation: 4,
};

const CONVERSATION_KEY = '15550100001';
const DELIVERY_JID = '15550100001:7@s.whatsapp.net';

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('turn-recovery-operator CLI (#2155)', () => {
  let dbPath: string;
  let auditPath: string;

  function seedBlockedJob(db: Database, durability: DurabilityEngine, suffix: string): number {
    const inboundSeq = durability.journalInbound(
      `wamid-${suffix}`, CONVERSATION_KEY, DELIVERY_JID, 'agent',
    );
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq,
        logicalTurnId: `turn-source-${suffix}`,
        managerId: 'manager-source',
        generation: 3,
      },
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId: 0 },
    };
    const deliveryOpId = durability.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: `selected delivery ${suffix}` }),
      sourceInboundSeq: inboundSeq,
      replayPolicy: 'unsafe',
    });
    const finalResult: TurnTerminalResult = {
      ...result,
      deliveryEvidence: { kind: 'enqueued', opId: deliveryOpId },
    };
    const envelope: TurnRecoveryReplayEnvelope = {
      sourceMessageId: `wamid-${suffix}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: false,
      senderJid: '15550100002:9@s.whatsapp.net',
      senderName: 'Exact Sender',
      text: `[voice transcript ${suffix}]\nexact transformed text`,
      isGroup: true,
      groupName: 'Exact Group',
    };
    const receipt = durability.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(finalResult, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(finalResult, OWNER, envelope),
    });
    return receipt.recoveryJob!.jobId;
  }

  beforeEach(() => {
    dbPath = path.join(tmpdir(), `tro-cli-${randomBytes(6).toString('hex')}.db`);
    auditPath = path.join(tmpdir(), `tro-audit-${randomBytes(6).toString('hex')}.jsonl`);
  });

  afterEach(() => {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, auditPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  function seedOne(): number {
    const db = new Database(dbPath);
    db.open();
    const jobId = seedBlockedJob(db, new DurabilityEngine(db), 'one');
    db.close();
    return jobId;
  }

  it('list prints a redacted blocked page and never leaks identifiers or replay text', () => {
    const jobId = seedOne();
    const res = run(['list', '--db', dbPath]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as { blocked: Array<{ id: number; state: string }> };
    expect(parsed.blocked).toHaveLength(1);
    expect(parsed.blocked[0]).toMatchObject({ id: jobId, state: 'blocked_unsafe', replay_safe: 0, has_proof: false });
    for (const leak of [CONVERSATION_KEY, DELIVERY_JID, 'Exact Sender', 'Exact Group', 'exact transformed', 'wamid-']) {
      expect(res.stdout).not.toContain(leak);
    }
  });

  it('promote dry-run previews without mutating, and --apply promotes exactly once with an audit trail', () => {
    const jobId = seedOne();
    const evidence = ['--evidence-type', 'operator-verified-no-delivery', '--evidence-ref', 'runbook/INC-2155-check'];

    const dry = run(['promote', '--db', dbPath, '--job', String(jobId), ...evidence, '--audit-file', auditPath]);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true });

    const applied = run(['promote', '--db', dbPath, '--job', String(jobId), ...evidence, '--apply', '--audit-file', auditPath]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      applied: true,
      job: { state: 'pending', replay_safe: 0, has_proof: true },
    });

    // Idempotent retry: same evidence again is a no-op, not an error.
    const retry = run(['promote', '--db', dbPath, '--job', String(jobId), ...evidence, '--apply', '--audit-file', auditPath]);
    expect(retry.status).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({ applied: false, alreadyPromoted: true });

    // A DIFFERENT proof against the promoted job is rejected with no mutation.
    const conflict = run(['promote', '--db', dbPath, '--job', String(jobId), '--evidence-type', 'provider-receipt', '--evidence-ref', 'SM-conflicting-1', '--apply', '--audit-file', auditPath]);
    expect(conflict.status).toBe(1);

    const receipts = readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(receipts.map((r) => r.outcome)).toEqual(['previewed', 'applied', 'not-applied:already-promoted']);
    for (const r of receipts) {
      expect(JSON.stringify(r)).not.toContain(CONVERSATION_KEY);
      expect(JSON.stringify(r)).not.toContain('runbook/INC-2155-check');
    }
  });

  it('refuses promotion when the conversation has newer journaled activity', () => {
    const jobId = seedOne();
    const db = new Database(dbPath);
    db.open();
    new DurabilityEngine(db).journalInbound('wamid-newer', CONVERSATION_KEY, DELIVERY_JID, 'agent');
    db.close();

    const res = run(['promote', '--db', dbPath, '--job', String(jobId), '--evidence-type', 'provider-receipt', '--evidence-ref', 'SM-receipt-99', '--apply', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('newer journaled activity');
    expect(res.stderr).not.toContain(CONVERSATION_KEY);

    const verify = run(['show', '--db', dbPath, '--job', String(jobId)]);
    expect(JSON.parse(verify.stdout)).toMatchObject({ job: { state: 'blocked_unsafe' } });
  });

  it('rejects unknown evidence types and under-specified references with no mutation', () => {
    const jobId = seedOne();
    const badType = run(['promote', '--db', dbPath, '--job', String(jobId), '--evidence-type', 'vibes', '--evidence-ref', 'long-enough-ref', '--apply', '--audit-file', auditPath]);
    expect(badType.status).toBe(1);
    const shortRef = run(['promote', '--db', dbPath, '--job', String(jobId), '--evidence-type', 'provider-receipt', '--evidence-ref', 'x', '--apply', '--audit-file', auditPath]);
    expect(shortRef.status).toBe(1);
    const verify = run(['show', '--db', dbPath, '--job', String(jobId)]);
    expect(JSON.parse(verify.stdout)).toMatchObject({ job: { state: 'blocked_unsafe', has_proof: false } });
  });

  it('reassign preserves blocked_unsafe and bumps the assignment fence', () => {
    const jobId = seedOne();
    const dry = run(['reassign', '--db', dbPath, '--job', String(jobId), '--audit-file', auditPath]);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true });

    const applied = run(['reassign', '--db', dbPath, '--job', String(jobId), '--apply', '--audit-file', auditPath]);
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      applied: true,
      job: { state: 'blocked_unsafe', assignment_epoch: 1 },
    });
  });
});
