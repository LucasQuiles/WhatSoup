// Black-box tests for `turn-recovery-operator close-inbound`: the operator
// close for ONE open inbound left behind a final terminal record. A real
// on-disk migrated DB is seeded through the production finalize path, then the
// inbound is reopened (the state an older release left). The CLI is driven as
// a child process so dry-run default, refusals, idempotency, redaction, and
// audit receipts are proven at the operator's actual surface.
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
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'scripts/turn-recovery-operator.ts');
const CONVERSATION_KEY = '15550106666';
const DELIVERY_JID = '15550106666@s.whatsapp.net';
const MESSAGE_ID_PREFIX = 'wamid-close-cli';

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface InboundState {
  processing_status: string;
  terminal_reason: string | null;
  failure_class: string | null;
}

describe('turn-recovery-operator close-inbound', () => {
  let dbPath: string;
  let auditPath: string;
  let db: Database;
  let engine: DurabilityEngine;

  beforeEach(() => {
    dbPath = path.join(tmpdir(), `tro-close-${randomBytes(6).toString('hex')}.db`);
    auditPath = path.join(tmpdir(), `tro-close-audit-${randomBytes(6).toString('hex')}.jsonl`);
    db = new Database(dbPath);
    db.open();
    engine = new DurabilityEngine(db);
  });

  afterEach(() => {
    db.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, auditPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  const inboundState = (seq: number): InboundState =>
    db.raw.prepare(
      'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
    ).get(seq) as unknown as InboundState;

  const reopen = (seq: number, status: string): void => {
    db.raw.prepare(
      `UPDATE inbound_events
       SET processing_status = ?, completed_at = NULL, terminal_reason = NULL, failure_class = NULL
       WHERE seq = ?`,
    ).run(status, seq);
  };

  const audit = (): Array<Record<string, unknown>> =>
    readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

  function journal(suffix: string): number {
    return engine.journalInbound(`${MESSAGE_ID_PREFIX}-${suffix}`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
  }

  function identity(seq: number, logicalTurnId = `turn-${seq}`): TurnTerminalResult['identity'] {
    return {
      scope: 'per_chat',
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      inboundSeq: seq,
      logicalTurnId,
      managerId: 'manager-close-cli',
      generation: 1,
    };
  }

  /** Real failed_terminal finalize, then reopened; returns the finalized state. */
  function seedStaleFailed(suffix: string, openStatus = 'pending'): { seq: number; finalized: InboundState } {
    const seq = journal(suffix);
    engine.finalizeTurnTerminal(toTurnFinalizationPersistence({
      identity: identity(seq),
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    }));
    const finalized = inboundState(seq);
    reopen(seq, openStatus);
    return { seq, finalized };
  }

  it('dry-run is the default: previews the derived status without mutating', () => {
    const { seq } = seedStaleFailed('dry');
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      dryRun: true,
      wouldClose: {
        seq,
        disposition: 'failed_terminal',
        fromStatus: 'pending',
        toStatus: 'failed',
        failureClass: 'session_crash',
      },
    });
    expect(inboundState(seq).processing_status).toBe('pending');
    expect(audit()).toEqual([expect.objectContaining({ action: 'close-inbound', inboundSeq: seq, mode: 'dry-run', outcome: 'previewed' })]);
  });

  it('--apply closes exactly the status finalization applied, then a rerun reports alreadyClosed', () => {
    const { seq, finalized } = seedStaleFailed('apply', 'processing');
    const applied = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, closed: { seq, fromStatus: 'processing', toStatus: 'failed' } });
    expect(inboundState(seq)).toEqual(finalized);

    const rerun = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ applied: false, alreadyClosed: true });
    expect(inboundState(seq)).toEqual(finalized);
    expect(audit().map((entry) => entry.outcome)).toEqual(['applied', 'not-applied:already-closed']);

    for (const leak of [CONVERSATION_KEY, DELIVERY_JID, MESSAGE_ID_PREFIX, `turn-${seq}`, 'manager-close-cli']) {
      expect(applied.stdout + applied.stderr + rerun.stdout + readFileSync(auditPath, 'utf8')).not.toContain(leak);
    }
  });

  it('refuses an open inbound with no terminal record', () => {
    const seq = journal('no-record');
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no_terminal_record');
    expect(inboundState(seq).processing_status).toBe('processing');
    expect(audit()).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'no_terminal_record' })]);
  });

  it('refuses a record that transferred to a recovery owner', () => {
    const seq = journal('transferred');
    const opId = engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text: 'selected delivery' }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
    });
    const owner = { logicalTurnId: 'turn-owner', managerId: 'manager-owner', generation: 2 };
    const result: TurnTerminalResult = {
      identity: identity(seq),
      attemptOutcome: { kind: 'failed', class: 'transient-network' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: { kind: 'enqueued', opId },
    };
    engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, owner),
      recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
        sourceMessageId: `${MESSAGE_ID_PREFIX}-transferred`,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: '15550106667@s.whatsapp.net',
        senderName: null,
        text: 'replay text',
        isGroup: false,
      }),
    });

    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('non_final_disposition');
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a row with a disposition link', () => {
    const { seq } = seedStaleFailed('linked', 'processing');
    db.raw.prepare(
      `INSERT INTO recovery_plans (plan_id, origin, actor, summary) VALUES ('plan-close-cli', 'operator', 'test', 'fixture')`,
    ).run();
    db.raw.prepare(
      `INSERT INTO inbound_disposition_links (inbound_seq, recovery_plan_id, disposition, reason, actor)
       VALUES (?, 'plan-close-cli', 'recovery_pending_operator_catchup', 'fixture', 'test')`,
    ).run(seq);

    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('disposition_link');
    expect(inboundState(seq).processing_status).toBe('processing');
  });

  it('refuses a row already closed with a status its record does not imply', () => {
    const { seq } = seedStaleFailed('mismatch', 'processing');
    db.raw.prepare(
      `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = 'response_sent' WHERE seq = ?`,
    ).run(seq);

    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('closed_differently');
    expect(inboundState(seq)).toMatchObject({ processing_status: 'complete', terminal_reason: 'response_sent' });
  });

  it('refuses an unknown seq and an invalid --seq', () => {
    const missing = run(['close-inbound', '--db', dbPath, '--seq', '999999', '--audit-file', auditPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('inbound_not_found');

    const invalid = run(['close-inbound', '--db', dbPath, '--seq', '0', '--audit-file', auditPath]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('--seq must be a positive integer');
  });
});
