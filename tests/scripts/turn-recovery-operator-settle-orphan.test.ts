// Black-box tests for `turn-recovery-operator settle-orphan-transfer`: the
// operator settle for ONE transferred terminal record left without a recovery
// job. A real on-disk migrated DB is seeded through the production finalize,
// echo and post-connect corroboration paths into the admitted shape (a
// corroborated maybe_sent terminal op with no provider message id, and a
// failed source inbound). The linked job is then removed with a hand DELETE:
// a STRUCTURAL STAND-IN for "no linked job", not a reproduction of how any
// production orphan arose. The seeding connection is CLOSED before the CLI
// runs, so the file is quiescent. The dry run must be byte-for-byte read-only,
// and an apply must be bound to the dry run's digest, the same file and the
// current schema.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'scripts/turn-recovery-operator.ts');
const CONVERSATION_KEY = '15550107777';
const DELIVERY_JID = '15550107777@s.whatsapp.net';
const MESSAGE_ID_PREFIX = 'wamid-settle-cli';
const MANAGER = 'manager-settle-cli';
const EVIDENCE_REF = 'ops/orphan-settle-cli-001';
const OWNER = { logicalTurnId: 'turn-settle-owner', managerId: 'manager-settle-owner', generation: 2 };

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * A test driver for the R4-m1 seam: it imports the CLI module (whose entry
 * guard then does not run main), installs a pre-BEGIN hook that changes the
 * database on its own connection, and runs the CLI with this process's args.
 */
const SEAM_DRIVER_SOURCE = `
import { DatabaseSync } from 'node:sqlite';
const operator = await import(process.env.TRO_TEST_CLI_URL);
const { OrphanTransferSettler } = await import(process.env.TRO_TEST_SETTLE_URL);
const terminalId = Number(process.env.TRO_TEST_TERMINAL);
operator.setBeforeSettleWriteTransactionForTests((dbPath) => {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA foreign_keys = ON');
    if (process.env.TRO_TEST_HOOK === 'replace-source-message-id') {
      const changed = raw.prepare(
        'UPDATE inbound_events SET message_id = ? WHERE seq = (SELECT inbound_seq FROM turn_terminal_records WHERE id = ?)',
      ).run(process.env.TRO_TEST_VALUE, terminalId).changes;
      if (Number(changed) !== 1) throw new Error('seam driver: source inbound not updated');
    } else if (process.env.TRO_TEST_HOOK === 'settle-first') {
      const settler = new OrphanTransferSettler(raw);
      const evaluation = settler.evaluate(terminalId);
      if (evaluation.verdict !== 'eligible') throw new Error('seam driver: record not eligible');
      raw.exec('BEGIN IMMEDIATE');
      settler.applyWithinCallerTransaction(evaluation, process.env.TRO_TEST_VALUE);
      raw.exec('COMMIT');
    } else {
      throw new Error('seam driver: unknown hook');
    }
  } finally {
    raw.close();
  }
});
operator.runTurnRecoveryOperatorCli();
`;

describe('turn-recovery-operator settle-orphan-transfer', () => {
  let dbPath: string;
  let auditPath: string;
  let driverPath: string;

  beforeEach(() => {
    dbPath = path.join(tmpdir(), `tro-settle-${randomBytes(6).toString('hex')}.db`);
    auditPath = path.join(tmpdir(), `tro-settle-audit-${randomBytes(6).toString('hex')}.jsonl`);
    driverPath = path.join(tmpdir(), `tro-settle-driver-${randomBytes(6).toString('hex')}.mjs`);
  });

  afterEach(() => {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, auditPath, driverPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  });

  /** Runs an apply through the seam driver with the given pre-BEGIN hook. */
  function applyWithHook(
    terminalId: number,
    digest: string,
    hook: 'replace-source-message-id' | 'settle-first',
    value: string,
  ): { status: number | null; stdout: string; stderr: string } {
    writeFileSync(driverPath, SEAM_DRIVER_SOURCE);
    const res = spawnSync(process.execPath, [
      '--experimental-strip-types', driverPath,
      'settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--apply', '--expect-digest', digest, '--audit-file', auditPath,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        TRO_TEST_CLI_URL: pathToFileURL(CLI).href,
        TRO_TEST_SETTLE_URL: pathToFileURL(path.join(REPO_ROOT, 'src/core/turn-recovery-orphan-settle.ts')).href,
        TRO_TEST_TERMINAL: String(terminalId),
        TRO_TEST_HOOK: hook,
        TRO_TEST_VALUE: value,
      },
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  /** Seed through a real engine, then CLOSE it so the CLI sees a quiescent file. */
  function seed<T>(fn: (db: Database, engine: DurabilityEngine) => T): T {
    const db = new Database(dbPath);
    db.open();
    try {
      return fn(db, new DurabilityEngine(db));
    } finally {
      db.close();
    }
  }

  /** Test-side reads must not create sidecars either, or they would mask the CLI's. */
  function read<T>(fn: (raw: DatabaseSync) => T): T {
    const url = pathToFileURL(dbPath);
    url.searchParams.set('immutable', '1');
    const raw = new DatabaseSync(url.href, { readOnly: true });
    try {
      return fn(raw);
    } finally {
      raw.close();
    }
  }

  const fileFacts = () => ({
    sha256: createHash('sha256').update(readFileSync(dbPath)).digest('hex'),
    wal: existsSync(`${dbPath}-wal`),
    shm: existsSync(`${dbPath}-shm`),
  });

  const audit = (): Array<Record<string, unknown>> =>
    readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

  const orphanCount = (): number => read((raw) => Number((raw.prepare(`
    SELECT COUNT(*) AS n
    FROM turn_terminal_records t
    LEFT JOIN turn_recovery_jobs j ON j.terminal_record_id = t.id
    WHERE t.inbound_disposition = 'transferred_to_recovery_owner' AND j.id IS NULL
  `).get() as { n: number }).n));

  function finalizeTransfer(
    engine: DurabilityEngine,
    suffix: string,
    seq: number,
    messageId: string,
    delivery: TurnTerminalResult['deliveryEvidence'],
  ): { recordId: number; jobId: number } {
    const result: TurnTerminalResult = {
      identity: {
        scope: 'per_chat',
        conversationKey: CONVERSATION_KEY,
        deliveryJid: DELIVERY_JID,
        inboundSeq: seq,
        logicalTurnId: `turn-${suffix}`,
        managerId: MANAGER,
        generation: 1,
      },
      attemptOutcome: delivery.kind === 'delivery_unknown'
        ? { kind: 'failed', class: 'transient-network' }
        : { kind: 'failed', class: 'crash' },
      inboundDisposition: 'transferred_to_recovery_owner',
      deliveryEvidence: delivery,
    };
    const receipt = engine.finalizeTurnTerminal({
      ...toTurnFinalizationPersistence(result, OWNER),
      recoveryJob: toTurnRecoveryJobPersistence(result, OWNER, {
        sourceMessageId: messageId,
        receivedAtUnixSeconds: 1_780_000_000,
        replaySafe: true,
        senderJid: '15550107778@s.whatsapp.net',
        senderName: null,
        text: 'replay text',
        isGroup: false,
      }),
    });
    return { recordId: receipt.recordId, jobId: receipt.recoveryJob!.jobId };
  }

  function createSelectedOp(engine: DurabilityEngine, seq: number, text: string): number {
    return engine.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'text',
      payload: JSON.stringify({ text }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: seq,
    });
  }

  /**
   * The admitted shape (as observed in production): delivery_unknown, selected op
   * maybe_sent + terminal + no provider message id, corroborated by a later
   * echoed op, failed source inbound. Then the structural-stand-in DELETE.
   */
  function seedOrphan(suffix: string): number {
    return seed((db, engine) => {
      const messageId = `${MESSAGE_ID_PREFIX}-${suffix}`;
      const seq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const opId = createSelectedOp(engine, seq, 'selected delivery');
      engine.markSending(opId);
      engine.markMaybeSent(opId, 'transport result unknown');
      const { recordId, jobId } = finalizeTransfer(engine, suffix, seq, messageId, { kind: 'delivery_unknown', opId });
      engine.markInboundFailed(seq, 'crash_recovery');
      const corroboratingOpId = createSelectedOp(engine, seq, 'later echoed delivery');
      engine.markSending(corroboratingOpId);
      engine.markSubmitted(corroboratingOpId, `wa-settle-cli-corroborating-${suffix}`);
      engine.markEchoed(corroboratingOpId);
      engine.postConnectRecovery();
      db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(jobId);
      return recordId;
    });
  }

  /** A transfer whose selected op is still queued, keeping its job. */
  function seedLinkedTransfer(suffix: string): number {
    return seed((_db, engine) => {
      const messageId = `${MESSAGE_ID_PREFIX}-${suffix}`;
      const seq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const opId = createSelectedOp(engine, seq, 'selected delivery');
      return finalizeTransfer(engine, suffix, seq, messageId, { kind: 'enqueued', opId }).recordId;
    });
  }

  /** Outside the allowlist: a quarantined selected op after a worker completion, then the stand-in DELETE. */
  function seedQuarantinedOrphan(suffix: string): number {
    return seed((db, engine) => {
      const messageId = `${MESSAGE_ID_PREFIX}-${suffix}`;
      const seq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const opId = createSelectedOp(engine, seq, 'selected delivery');
      const { recordId, jobId } = finalizeTransfer(engine, suffix, seq, messageId, { kind: 'enqueued', opId });
      engine.markSending(opId);
      engine.markSubmitted(opId, `wa-settle-cli-${suffix}`);
      const claim = engine.claimTurnRecoveryJob(jobId, OWNER, {
        claimToken: `settle-cli-claim-${suffix}`,
        leaseSeconds: 60,
      });
      engine.markInboundFailed(seq, 'crash_recovery');
      engine.markQuarantined(opId);
      engine.completeTurnRecoveryJob(jobId, OWNER, claim);
      db.raw.prepare('DELETE FROM turn_recovery_jobs WHERE id = ?').run(jobId);
      return recordId;
    });
  }

  function dryRun(terminalId: number): Record<string, unknown> {
    const res = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--audit-file', auditPath]);
    expect(res.status, res.stderr).toBe(0);
    return JSON.parse(res.stdout) as Record<string, unknown>;
  }

  function apply(terminalId: number, digest: string, auditFile = auditPath) {
    return run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--apply', '--expect-digest', digest, '--audit-file', auditFile]);
  }

  it('without --terminal lists orphan transfers only, read-only', () => {
    const orphan = seedOrphan('listed');
    seedLinkedTransfer('with-job');
    const before = fileFacts();

    const res = run(['settle-orphan-transfer', '--db', dbPath, '--audit-file', auditPath]);

    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ dryRun: true, orphanTransfers: [orphan], schemaCurrent: true });
    expect(fileFacts()).toEqual(before);
  });

  it('the dry run is read-only: file bytes, migration ledger and sidecars are unchanged', () => {
    const terminalId = seedOrphan('dry');
    const before = fileFacts();
    expect(before.wal || before.shm).toBe(false);

    const parsed = dryRun(terminalId);

    expect(parsed).toMatchObject({
      dryRun: true,
      schemaCurrent: true,
      wouldSettle: {
        terminalRecordId: terminalId,
        deliveryKind: 'delivery_unknown',
        deliveryStatus: 'maybe_sent',
        deliveryIsTerminal: true,
        deliveryHasWaMessageId: false,
        deliveryIdentityMatches: true,
        sourceInboundIdentityMatches: true,
        sourceInboundStatus: 'failed',
        corroborated: true,
        settledJobState: 'exhausted',
      },
    });
    expect(parsed).not.toHaveProperty('warning');
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fileFacts()).toEqual(before);
    expect(orphanCount()).toBe(1);
    expect(audit()).toEqual([expect.objectContaining({
      action: 'settle-orphan-transfer', terminalRecordId: terminalId, mode: 'dry-run', outcome: 'previewed',
    })]);
  });

  it('--apply requires --terminal, --evidence-ref and the dry run digest', () => {
    const terminalId = seedOrphan('digest');
    const before = fileFacts();
    const stateBefore = settleState();

    const bulk = run(['settle-orphan-transfer', '--db', dbPath, '--apply', '--audit-file', auditPath]);
    expect(bulk.status).toBe(1);
    expect(bulk.stderr).toContain('--terminal');

    const noEvidence = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--audit-file', auditPath]);
    expect(noEvidence.status).toBe(1);
    expect(noEvidence.stderr).toContain('--evidence-ref');

    const missing = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--apply', '--audit-file', auditPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--expect-digest');

    const wrong = apply(terminalId, 'a'.repeat(64));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('digest_mismatch');
    expect(fileFacts().sha256).toBe(before.sha256);
    expect(settleState()).toEqual(stateBefore);
    expect(orphanCount()).toBe(1);
  });

  it('an apply bound to the dry run settles the orphan and keeps the record; a rerun is a no-op', () => {
    const terminalId = seedOrphan('apply');
    const recordBefore = read((raw) => raw.prepare('SELECT * FROM turn_terminal_records WHERE id = ?').get(terminalId));
    const parsed = dryRun(terminalId);

    const applied = apply(terminalId, String(parsed.digest));
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      applied: true,
      settled: { terminalRecordId: terminalId, settledJobState: 'exhausted' },
    });
    expect(orphanCount()).toBe(0);
    expect(read((raw) => raw.prepare('SELECT * FROM turn_terminal_records WHERE id = ?').get(terminalId)))
      .toEqual(recordBefore);

    const rerun = apply(terminalId, String(parsed.digest));
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ applied: false, alreadySettled: true, terminalRecordId: terminalId });
    expect(read((raw) => Number((raw.prepare('SELECT COUNT(*) AS n FROM turn_recovery_jobs').get() as { n: number }).n)))
      .toBe(1);
    expect(audit().map((entry) => entry.outcome)).toEqual(['previewed', 'applied', 'not-applied:already-settled']);

    for (const leak of [CONVERSATION_KEY, DELIVERY_JID, MESSAGE_ID_PREFIX, MANAGER, EVIDENCE_REF]) {
      expect(applied.stdout + applied.stderr + rerun.stdout + readFileSync(auditPath, 'utf8')).not.toContain(leak);
    }
  });

  it('refuses an apply after the source inbound message id changed since the dry run, writing nothing', () => {
    const terminalId = seedOrphan('drift');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const parsed = dryRun(terminalId);

    // The settled job copies the source inbound's message id. With no job and
    // no disposition link on that inbound, no trigger freezes it, so it can
    // change between the dry run and the apply. (Every terminal-record column
    // the job copies is already frozen by corroborated_terminal_proof_immutable,
    // which every admitted orphan carries.)
    const changed = seed((db) => Number(db.raw.prepare(`
      UPDATE inbound_events SET message_id = ?
      WHERE seq = (SELECT inbound_seq FROM turn_terminal_records WHERE id = ?)
    `).run(`${MESSAGE_ID_PREFIX}-drift-replaced`, terminalId).changes));
    expect(changed).toBe(1);
    const stateBefore = settleState();

    const applied = apply(terminalId, String(parsed.digest));

    expect(applied.status, applied.stdout).toBe(1);
    expect(applied.stderr).toContain('digest_mismatch');
    expect(settleState()).toEqual(stateBefore);
    expect(audit().at(-1)).toEqual(expect.objectContaining({ outcome: 'refused', reason: 'digest_mismatch' }));
    expect(read((raw) => Number((raw.prepare(
      'SELECT COUNT(*) AS n FROM turn_recovery_jobs WHERE terminal_record_id = ?',
    ).get(terminalId) as { n: number }).n))).toBe(0);
    expect(read((raw) => Number((raw.prepare(
      'SELECT COUNT(*) AS n FROM recovery_plans WHERE plan_id = ?',
    ).get(planId) as { n: number }).n))).toBe(0);
    expect(orphanCount()).toBe(1);
  });

  const planRows = (planId: string): number => read((raw) => Number((raw.prepare(
    'SELECT COUNT(*) AS n FROM recovery_plans WHERE plan_id = ?',
  ).get(planId) as { n: number }).n));

  const jobIdsFor = (terminalId: number): number[] => read((raw) => (raw.prepare(
    'SELECT id FROM turn_recovery_jobs WHERE terminal_record_id = ? ORDER BY id',
  ).all(terminalId) as Array<{ id: number }>).map((row) => Number(row.id)));

  /** Full rows the settle must never change: the record, its proof and its source. */
  const evidenceRows = (terminalId: number) => read((raw) => ({
    terminal: raw.prepare('SELECT * FROM turn_terminal_records WHERE id = ?').get(terminalId),
    corroboration: raw.prepare(
      'SELECT * FROM turn_delivery_corroboration WHERE terminal_record_id = ? ORDER BY corroborating_op_id',
    ).all(terminalId),
    selectedOp: raw.prepare(`
      SELECT o.* FROM outbound_ops o
      JOIN turn_terminal_records t ON t.delivery_op_id = o.id
      WHERE t.id = ?
    `).get(terminalId),
    sourceInbound: raw.prepare(`
      SELECT i.* FROM inbound_events i
      JOIN turn_terminal_records t ON t.inbound_seq = i.seq
      WHERE t.id = ?
    `).get(terminalId),
  }));

  /** Every row of every table the settle reads or writes, in rowid order. */
  const SETTLE_STATE_TABLES = [
    'turn_terminal_records',
    'outbound_ops',
    'inbound_events',
    'turn_delivery_corroboration',
    'inbound_disposition_links',
    'turn_recovery_jobs',
    'recovery_plans',
  ] as const;
  const settleState = (): Record<string, unknown[]> => read((raw) => Object.fromEntries(
    SETTLE_STATE_TABLES.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  ));

  const lastReceipt = () => audit().at(-1);

  const FAILING_PLAN_INSERT = 'test-only: settle plan insert aborted';

  /** TEST-ONLY trigger that aborts the settle's first write (the plan row) for this terminal. */
  function failPlanInsertFor(terminalId: number): void {
    seed((db) => db.raw.exec(`
      CREATE TRIGGER test_only_settle_plan_insert_fails
      BEFORE INSERT ON recovery_plans
      WHEN NEW.plan_id = 'turn-recovery-orphan-settle:v1:${terminalId}'
      BEGIN
        SELECT RAISE(ABORT, '${FAILING_PLAN_INSERT}');
      END
    `));
  }

  const FAILING_JOB_INSERT = 'test-only: settled job insert aborted';

  /**
   * TEST-ONLY trigger that aborts the settle's second write (the job row) for
   * this terminal, after its first write (the plan row) has run.
   */
  function failJobInsertFor(terminalId: number): void {
    seed((db) => db.raw.exec(`
      CREATE TRIGGER test_only_settle_job_insert_fails
      BEFORE INSERT ON turn_recovery_jobs
      WHEN NEW.terminal_record_id = ${terminalId}
      BEGIN
        SELECT RAISE(ABORT, '${FAILING_JOB_INSERT}');
      END
    `));
  }

  it('two applies with the same digest, run one after the other: exactly one commits, the second reports already settled', () => {
    const terminalId = seedOrphan('twice');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const parsed = dryRun(terminalId);

    const first = apply(terminalId, String(parsed.digest));
    const second = apply(terminalId, String(parsed.digest));

    expect(first.status, first.stderr).toBe(0);
    const firstJobId = (JSON.parse(first.stdout) as { settled: { jobId: number } }).settled.jobId;
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      applied: false,
      alreadySettled: true,
      terminalRecordId: terminalId,
      planId,
      jobId: firstJobId,
    });
    expect(planRows(planId)).toBe(1);
    expect(jobIdsFor(terminalId)).toEqual([firstJobId]);
    expect(audit().map((entry) => [entry.mode, entry.outcome])).toEqual([
      ['dry-run', 'previewed'],
      ['apply', 'applied'],
      ['apply', 'not-applied:already-settled'],
    ]);
  });

  it('when the job insert fails inside the write transaction, the plan row rolls back and the evidence rows are unchanged', () => {
    const terminalId = seedOrphan('second-write-fails');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const parsed = dryRun(terminalId);
    failJobInsertFor(terminalId);
    const before = evidenceRows(terminalId);
    expect(before.terminal).toBeDefined();
    expect(before.corroboration).toHaveLength(1);
    expect(before.selectedOp).toBeDefined();
    expect(before.sourceInbound).toBeDefined();

    const applied = apply(terminalId, String(parsed.digest));

    expect(applied.status, applied.stdout).toBe(1);
    expect(applied.stderr).toContain(FAILING_JOB_INSERT);
    expect(applied.stdout).toBe('');
    expect(planRows(planId)).toBe(0);
    expect(jobIdsFor(terminalId)).toEqual([]);
    expect(orphanCount()).toBe(1);
    expect(evidenceRows(terminalId)).toEqual(before);
  });

  it('an apply that fails inside the write transaction appends an apply-mode audit receipt that is not applied', () => {
    // Contract: docs/runbook.md, close-inbound (an `--apply` that throws inside
    // its write transaction "appends an apply-mode receipt with outcome `failed`
    // and reason `write_transaction_error`"), which the settle section says its
    // receipts follow; and the operator header, which says the same.
    const terminalId = seedOrphan('second-write-receipt');
    const parsed = dryRun(terminalId);
    failJobInsertFor(terminalId);
    const receiptsBefore = audit().length;

    const applied = apply(terminalId, String(parsed.digest));

    expect(applied.status, applied.stdout).toBe(1);
    const receipts = audit();
    expect(receipts).toHaveLength(receiptsBefore + 1);
    expect(receipts.at(-1)).toEqual(expect.objectContaining({
      action: 'settle-orphan-transfer',
      terminalRecordId: terminalId,
      mode: 'apply',
      outcome: 'failed',
      reason: 'write_transaction_error',
    }));
  });

  it('when the plan insert (the first write) fails, nothing is written and an apply-mode failed receipt is appended', () => {
    const terminalId = seedOrphan('first-write-fails');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const parsed = dryRun(terminalId);
    failPlanInsertFor(terminalId);
    const before = settleState();
    const evidenceBefore = evidenceRows(terminalId);
    const receiptsBefore = audit().length;

    const applied = apply(terminalId, String(parsed.digest));

    expect(applied.status, applied.stdout).toBe(1);
    expect(applied.stderr).toContain(FAILING_PLAN_INSERT);
    expect(applied.stdout).toBe('');
    expect(planRows(planId)).toBe(0);
    expect(jobIdsFor(terminalId)).toEqual([]);
    expect(evidenceRows(terminalId)).toEqual(evidenceBefore);
    expect(settleState()).toEqual(before);
    expect(audit()).toHaveLength(receiptsBefore + 1);
    expect(lastReceipt()).toEqual(expect.objectContaining({
      action: 'settle-orphan-transfer',
      terminalRecordId: terminalId,
      mode: 'apply',
      outcome: 'failed',
      reason: 'write_transaction_error',
    }));
  });

  it('the in-transaction recheck refuses a source message id changed after the preflight, writing nothing', () => {
    const terminalId = seedOrphan('recheck-drift');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const parsed = dryRun(terminalId);
    const before = settleState();
    const replaced = `${MESSAGE_ID_PREFIX}-recheck-drift-replaced`;

    // The hook runs after the preflight passed the digest and before BEGIN, so
    // only the recheck inside the write transaction can see the change.
    const applied = applyWithHook(terminalId, String(parsed.digest), 'replace-source-message-id', replaced);

    expect(applied.status, applied.stdout + applied.stderr).toBe(1);
    expect(applied.stderr).toContain('digest_mismatch');
    expect(applied.stdout).toBe('');
    // The hook ran: the source inbound carries the replaced id.
    expect(read((raw) => raw.prepare(`
      SELECT i.message_id FROM inbound_events i
      JOIN turn_terminal_records t ON t.inbound_seq = i.seq
      WHERE t.id = ?
    `).get(terminalId))).toEqual({ message_id: replaced });
    expect(planRows(planId)).toBe(0);
    expect(jobIdsFor(terminalId)).toEqual([]);
    const after = settleState();
    expect({ ...after, inbound_events: null }).toEqual({ ...before, inbound_events: null });
    expect(lastReceipt()).toEqual(expect.objectContaining({
      mode: 'apply', outcome: 'refused', reason: 'digest_mismatch',
    }));
  });

  it('an apply that loses the race to a concurrent settle of the same record returns the documented no-op', () => {
    const terminalId = seedOrphan('race-loser');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    const winnerRef = 'ops/orphan-settle-race-winner';
    const parsed = dryRun(terminalId);

    // The hook commits a settle for the same record on its own connection
    // after the preflight found the record eligible and before BEGIN.
    const applied = applyWithHook(terminalId, String(parsed.digest), 'settle-first', winnerRef);

    expect(applied.status, applied.stderr).toBe(0);
    const winnerJobIds = jobIdsFor(terminalId);
    expect(winnerJobIds).toHaveLength(1);
    expect(JSON.parse(applied.stdout)).toEqual({
      applied: false,
      alreadySettled: true,
      terminalRecordId: terminalId,
      planId,
      jobId: winnerJobIds[0],
    });
    expect(planRows(planId)).toBe(1);
    // The only plan is the winner's: this apply wrote nothing.
    expect(read((raw) => raw.prepare('SELECT evidence_ref FROM recovery_plans WHERE plan_id = ?').get(planId)))
      .toEqual({ evidence_ref: expect.stringContaining(`ref=${winnerRef}`) });
    expect(audit().map((entry) => [entry.mode, entry.outcome])).toEqual([
      ['dry-run', 'previewed'],
      ['apply', 'not-applied:already-settled'],
    ]);
  });

  it('an apply whose audit append fails after commit still reports the settle, with exit 3', () => {
    const terminalId = seedOrphan('audit-fail');
    const parsed = dryRun(terminalId);

    // A directory cannot be appended to, so the receipt write fails after COMMIT.
    const applied = apply(terminalId, String(parsed.digest), path.dirname(dbPath));

    expect(applied.status).toBe(3);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, settled: { terminalRecordId: terminalId } });
    expect(applied.stderr).toContain('audit receipt not written');
    expect(orphanCount()).toBe(0);
  });

  it('refuses a transfer that still has its recovery job, writing nothing', () => {
    const terminalId = seedLinkedTransfer('live-job');
    const before = fileFacts();
    const stateBefore = settleState();

    const res = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--audit-file', auditPath]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('recovery_job_exists');
    expect(fileFacts()).toEqual(before);
    expect(settleState()).toEqual(stateBefore);
    expect(audit()).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'recovery_job_exists' })]);
  });

  it('show reports the operator settlement behind the written job', () => {
    const terminalId = seedOrphan('show');
    const parsed = dryRun(terminalId);
    const applied = apply(terminalId, String(parsed.digest));
    expect(applied.status, applied.stderr).toBe(0);
    const jobId = (JSON.parse(applied.stdout) as { settled: { jobId: number } }).settled.jobId;

    const shown = run(['show', '--db', dbPath, '--job', String(jobId), '--audit-file', auditPath]);

    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      job: { id: jobId, state: 'exhausted' },
      operatorSettlement: {
        kind: 'orphan_transfer_settle',
        planId: `turn-recovery-orphan-settle:v1:${terminalId}`,
        planFound: true,
        origin: 'operator',
        actor: 'turn-recovery-operator-cli',
      },
    });
  });

  it('show does not label a job operator-settled when its settle plan is missing', () => {
    const terminalId = seedOrphan('show-no-plan');
    const planId = `turn-recovery-orphan-settle:v1:${terminalId}`;
    // Structural stand-in: the same job row the settle writes, but with no plan
    // row. No production writer produces this; recovery_plans is append-only.
    const jobId = seed((db) => Number((db.raw.prepare(`
      INSERT INTO turn_recovery_jobs (
        terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation, source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
        replay_safe, replay_safety_proof_id, sender_jid, sender_name, replay_text,
        is_group, group_name, state, attempt_count, claim_epoch
      )
      SELECT t.id, t.scope, t.conversation_key, t.delivery_jid,
             t.inbound_seq, t.inbound_seq,
             t.logical_turn_id, t.manager_id, t.generation, i.message_id,
             t.recovery_owner_logical_turn_id, t.recovery_owner_manager_id, t.recovery_owner_generation,
             'stand-in-owner-' || t.id, 'turn-recovery-operator-cli', 1,
             0, ?, 'stand-in-sender', NULL, 'stand-in text',
             0, NULL, 'exhausted', 5, 5
      FROM turn_terminal_records t
      JOIN inbound_events i ON i.seq = t.inbound_seq
      WHERE t.id = ?
      RETURNING id
    `).get(planId, terminalId) as { id: number }).id));

    const shown = run(['show', '--db', dbPath, '--job', String(jobId), '--audit-file', auditPath]);

    expect(shown.status, shown.stderr).toBe(0);
    const parsed = JSON.parse(shown.stdout) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('operatorSettlement');
    expect(parsed).toMatchObject({
      job: { id: jobId, state: 'exhausted' },
      settlePlan: { planId, planFound: false },
      eligibility: 'state exhausted: no operator transition available from this CLI',
    });
  });

  it('refuses an orphan outside the allowlist, writing nothing', () => {
    const terminalId = seedQuarantinedOrphan('quarantined');
    const before = fileFacts();
    const stateBefore = settleState();

    const res = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', String(terminalId),
      '--evidence-ref', EVIDENCE_REF, '--audit-file', auditPath]);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('delivery_status_not_admitted');
    expect(fileFacts()).toEqual(before);
    expect(settleState()).toEqual(stateBefore);
    expect(orphanCount()).toBe(1);
    expect(audit()).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'delivery_status_not_admitted' })]);
  });

  it('refuses an unknown record and every malformed --terminal', () => {
    seedOrphan('shape');
    const stateBefore = settleState();
    const missing = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', '999999',
      '--evidence-ref', EVIDENCE_REF, '--audit-file', auditPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('terminal_not_found');
    expect(settleState()).toEqual(stateBefore);

    for (const bad of ['0', '01', '1e3', '12abc', '1.5', ' 7']) {
      const res = run(['settle-orphan-transfer', '--db', dbPath, '--terminal', bad,
        '--evidence-ref', EVIDENCE_REF, '--audit-file', auditPath]);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toContain('--terminal must be a positive integer');
    }
  });
});
