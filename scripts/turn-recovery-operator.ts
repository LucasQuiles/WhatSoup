/**
 * Operator workflow for blocked-unsafe turn-recovery jobs (#2155 part B).
 *
 * blocked_unsafe jobs are never auto-replayed; the durability layer retains
 * them with fenced reassignment and a one-way evidence-gated promotion to
 * pending (which the supervisor dispatches via the shared eligibility
 * contract, isTurnRecoveryReplayEligible — #2155 part A). This CLI is the
 * supported operator surface over those EXISTING store transitions; it adds
 * no parallel state machine and never issues raw SQL mutations.
 *
 * Subcommands (all against --db <instance dbPath>):
 *   list    [--after-id N] [--limit N]   redacted page of blocked_unsafe jobs
 *   show    --job N                      redacted detail + fence preview
 *   reassign --job N [--apply]           fenced blocked-owner reassignment
 *   promote --job N --evidence-type T --evidence-ref R [--apply]
 *   close-inbound --seq N [--apply --expect-digest D]
 *                                        close ONE open inbound left behind a
 *                                        final terminal record, with the status
 *                                        that record implies (the sweep's rules)
 *   settle-orphan-transfer [--terminal N --evidence-ref R [--apply --expect-digest D]]
 *                                        without --terminal: list orphan recovery
 *                                        transfers (read-only). With it: settle ONE
 *                                        transferred terminal record that has no
 *                                        recovery job (src/core/turn-recovery-orphan-settle.ts)
 *
 * Safety posture:
 *   - dry-run is the DEFAULT for mutations; --apply is the explicit
 *     confirmation. Exactly one job (or inbound seq) per invocation — no bulk.
 *   - close-inbound never opens the migrating Database wrapper. Its dry run
 *     reads through a read-only handle (no migration, no sidecar creation on a
 *     quiescent file) and prints a digest binding the database file identity,
 *     the row, its record and the derived status. --apply requires that digest,
 *     the exact current schema, and re-proves identity, schema, eligibility and
 *     digest inside its write transaction. It refuses unless exactly one FINAL
 *     terminal record owns the row with intact delivery proof and no
 *     disposition link or recovery job touches it; a rerun on a row already
 *     closed as its record implies is a no-op report.
 *   - settle-orphan-transfer follows the same read-only-preflight, digest and
 *     in-transaction re-proof contract. Its v3 digest binds the database
 *     file identity, every value the settled job copies from the terminal
 *     record and its source inbound (including the recovery-owner logical
 *     turn id, manager id and generation, and the source message id), every
 *     admission input, and the evidence reference; the dry run prints the
 *     recovery-owner tuple but not the copied jids, conversation key or
 *     message id. For an admitted record the copied terminal-record values
 *     are already frozen by trigger corroborated_terminal_proof_immutable;
 *     the source inbound's message id is not while no job exists, and the
 *     digest is what refuses a change to it. Admission is an allowlist: no linked
 *     job; a terminal source inbound that is not echo-settled and has no open
 *     disposition link (open_disposition_link); a selected op that is
 *     maybe_sent, terminal, with a NULL provider message id (an empty string
 *     counts as an id), and validly corroborated. Everything else is refused
 *     with a specific reason. A rerun on a record it already settled is a
 *     no-op report, and so is an apply whose in-transaction recheck finds the
 *     record already settled by this command (a concurrent apply won). The
 *     terminal record is never modified or deleted. `show` on the written
 *     job reports the operator settlement, so it does not read as ordinary
 *     attempt exhaustion.
 *   - promotion validates an allowlisted evidence type + bounded reference
 *     shape (a bare nonempty label is NOT acceptable evidence), and refuses
 *     when the conversation has journaled inbound activity newer than the
 *     job's source (an old reply must not be blindly replayed).
 *   - output and audit receipts are content-free: job ids, states, scopes,
 *     epochs, timestamps, and hashes only — never replay text, sender/chat
 *     identifiers, message ids, or group names. The one addition is
 *     settle-orphan-transfer's printed output, which also names the recovery
 *     owner (logical turn id, manager id, generation) the job will carry.
 *   - audit receipts are durable JSON lines next to the database (or
 *     --audit-file). close-inbound and settle-orphan-transfer append one for
 *     every evaluated dry run and apply: previewed, refused, already
 *     closed/settled, applied, or failed. reassign appends one for a preview
 *     and for an applied or not-applied transition; promote appends one for a
 *     preview, an already-promoted job, a newer-activity refusal, and an
 *     applied or not-applied:<state> transition. Argument errors, a database
 *     that cannot be opened or preflighted, a missing job or one in the wrong
 *     state for reassign or promote, and
 *     settle-orphan-transfer's list mode (no --terminal) exit without one. A
 *     close-inbound or settle-orphan-transfer --apply that throws while
 *     opening, writing or committing its transaction rolls back, appends an
 *     apply-mode receipt with outcome `failed`, and exits 1 with the original
 *     error; if that append also fails, both errors are reported. A failure
 *     to close the connection after COMMIT is reported on stderr and does not
 *     turn the committed change into a failed apply. A close-inbound or
 *     settle-orphan-transfer whose receipt append fails AFTER commit prints
 *     its applied result and exits 3, distinct from a refusal (1). Any other
 *     receipt append that fails exits 1 with that error and leaves no receipt.
 *     For a dry run or a refusal nothing was written. reassign and promote
 *     append after their transition, so a failed append there exits 1 with
 *     the transition already committed and no result printed; read the job
 *     with `show` before retrying.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CliArgError, takeValue } from './lib/cli-args.ts';
import type { TurnRecoveryJobRow } from '../src/core/turn-recovery-store.ts';
import type { TerminalRecordInboundCloseEvaluation } from '../src/core/terminal-record-inbound-close.ts';
import type {
  EligibleOrphanTransferSettle,
  OrphanTransferSettleEvaluation,
} from '../src/core/turn-recovery-orphan-settle.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';

// stdout is the CLI's data channel (JSON only) — silence the pino logger the
// database/durability modules construct at import time, BEFORE importing them.
process.env.LOG_LEVEL ??= 'silent';
const { Database } = await import('../src/core/database.ts');
const { DurabilityEngine } = await import('../src/core/durability.ts');
const { TerminalRecordInboundCloser } = await import('../src/core/terminal-record-inbound-close.ts');
const {
  OrphanTransferSettler,
  ORPHAN_TRANSFER_SETTLE_EVIDENCE_REF_PATTERN,
  ORPHAN_TRANSFER_SETTLE_PLAN_PREFIX,
  ORPHAN_TRANSFER_SETTLE_ACTOR,
} = await import('../src/core/turn-recovery-orphan-settle.ts');
const {
  assertExistingRegularDatabase,
  assertSameDatabaseFile,
  assertSchema43Foundation,
  openExistingWritableDatabase,
} = await import('./close-recovery-catchup.ts');
type DurabilityEngineT = InstanceType<typeof DurabilityEngine>;
type FileIdentity = ReturnType<typeof assertExistingRegularDatabase>;

// Evidence a promotion may cite. Provenance rule per type: the reference must
// match the bounded shape AND the operator asserts, via the type itself, what
// the evidence establishes. Shapes are strict so free-form prose cannot pass.
const EVIDENCE_TYPES: Record<string, { refPattern: RegExp; describes: string }> = {
  'provider-receipt': {
    refPattern: /^[A-Za-z0-9_.:-]{8,120}$/,
    describes: 'a provider delivery/rejection receipt proving the original send outcome is known',
  },
  'operator-verified-no-delivery': {
    refPattern: /^[A-Za-z0-9_.:/-]{8,120}$/,
    describes: 'an operator investigation record (ticket/runbook ref) establishing the original send did not reach the destination',
  },
};

interface Args {
  command: string;
  db?: string;
  job?: number;
  seq?: string;
  terminal?: string;
  expectDigest?: string;
  afterId: number;
  limit: number;
  apply: boolean;
  evidenceType?: string;
  evidenceRef?: string;
  auditFile?: string;
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const args: Args = { command: command ?? '', afterId: 0, limit: 50, apply: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const next = (): string => {
      const taken = takeValue(rest, i, flag);
      i = taken.index;
      return taken.value;
    };
    switch (flag) {
      case '--db': args.db = next(); break;
      case '--job': args.job = Number.parseInt(next(), 10); break;
      case '--seq': args.seq = next(); break;
      case '--terminal': args.terminal = next(); break;
      case '--expect-digest': args.expectDigest = next(); break;
      case '--after-id': args.afterId = Number.parseInt(next(), 10); break;
      case '--limit': args.limit = Number.parseInt(next(), 10); break;
      case '--apply': args.apply = true; break;
      case '--evidence-type': args.evidenceType = next(); break;
      case '--evidence-ref': args.evidenceRef = next(); break;
      case '--audit-file': args.auditFile = next(); break;
      default: throw new CliArgError(`unknown flag: ${flag}`);
    }
  }
  return args;
}

/** Content-free projection of a job row — the ONLY shape this CLI prints. */
function redactedJob(job: TurnRecoveryJobRow): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    scope: job.scope,
    replay_safe: job.replay_safe,
    has_proof: job.replay_safety_proof_id !== null,
    attempt_count: job.attempt_count,
    claim_epoch: job.claim_epoch,
    assignment_epoch: job.assignment_epoch,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_attempt_at: job.next_attempt_at,
  };
}

function auditReceipt(
  auditPath: string,
  entry: {
    action: string;
    jobId?: number;
    inboundSeq?: number;
    terminalRecordId?: number;
    mode: 'dry-run' | 'apply';
    outcome: string;
    reason?: string;
    evidenceType?: string;
    proofHash?: string;
  },
): void {
  appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function fail(message: string): never {
  console.error(`turn-recovery-operator: ${message}`);
  process.exit(1);
}

function requireJob(engine: DurabilityEngineT, jobId: number | undefined): TurnRecoveryJobRow {
  if (jobId === undefined || !Number.isSafeInteger(jobId) || jobId < 1) {
    fail('--job must be a positive integer');
  }
  const job = engine.getTurnRecoveryJob(jobId);
  if (!job) fail(`job ${jobId} not found`);
  return job;
}

/** Content-free projection of a close: seq, record id, disposition, statuses. */
function closeProjection(
  evaluation: Extract<TerminalRecordInboundCloseEvaluation, { verdict: 'eligible' }>,
): Record<string, unknown> {
  const { mutation } = evaluation;
  return {
    seq: evaluation.seq,
    recordId: evaluation.recordId,
    disposition: evaluation.disposition,
    fromStatus: evaluation.fromStatus,
    toStatus: mutation.kind === 'complete' ? 'complete' : 'failed',
    ...(mutation.kind === 'complete'
      ? { terminalReason: mutation.terminalReason }
      : { failureClass: mutation.failureClass }),
  };
}

type EligibleClose = Extract<TerminalRecordInboundCloseEvaluation, { verdict: 'eligible' }>;
type SettledOrphanTransfer = Extract<OrphanTransferSettleEvaluation, { verdict: 'already_settled' }>;

/** close-inbound applied and committed, but its audit receipt could not be appended. */
const AUDIT_RECEIPT_FAILED_EXIT = 3;

/** Receipt reason for an apply that threw in its write step; never the error text. */
const WRITE_TRANSACTION_FAILED_REASON = 'write_transaction_error';

/**
 * Runs an apply's write step. If it throws, appends the apply-mode `failed`
 * receipt and rethrows the original error. If that append also fails, both
 * errors are reported and the original is still the one rethrown.
 */
function withFailedApplyReceipt<T>(appendFailedReceipt: () => void, write: () => T): T {
  try {
    return write();
  } catch (err) {
    try {
      appendFailedReceipt();
    } catch (appendErr) {
      console.error(
        'turn-recovery-operator: the apply failed and its audit receipt was not written: ' +
        (appendErr instanceof Error ? appendErr.message : String(appendErr)),
      );
    }
    throw err;
  }
}

/**
 * Test seam (R4-m1). Runs after a settle apply opens its writable connection
 * and before its BEGIN IMMEDIATE, so a test can change the database between
 * the preflight and the in-transaction recheck. The default does nothing;
 * only a test driver that imports this module replaces it.
 */
let beforeSettleWriteTransaction: (dbPath: string) => void = () => {};

export function setBeforeSettleWriteTransactionForTests(hook: ((dbPath: string) => void) | undefined): void {
  beforeSettleWriteTransaction = hook ?? (() => {});
}

/** A ROLLBACK that never replaces the error that caused it. */
function rollbackKeepingCause(raw: DatabaseSync): void {
  try {
    raw.exec('ROLLBACK');
  } catch {
    // intentional: SQLite may already have rolled back, and the caller rethrows the cause.
  }
}

/**
 * Closes an apply's write connection. Before a COMMIT a close failure still
 * propagates. After a COMMIT the change is durable, so a close failure is
 * reported on stderr and never turned into a failed apply.
 */
function closeWriteConnection(raw: DatabaseSync, committed: boolean): void {
  if (!committed) {
    raw.close();
    return;
  }
  try {
    raw.close();
  } catch (err) {
    console.error(
      'turn-recovery-operator: the apply committed, but its database connection did not close: ' +
      (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Binds an apply to the dry run that previewed it: the database file identity,
 * the row, its terminal record, and the exact status the close will write.
 */
function closeDigest(identity: FileIdentity, evaluation: EligibleClose): string {
  return createHash('sha256').update(JSON.stringify({
    v: 1,
    device: identity.device,
    inode: identity.inode,
    ...closeProjection(evaluation),
  })).digest('hex');
}

function schemaVersion(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  return Number(row.version ?? 0);
}

/**
 * A read-only handle that neither migrates nor, on a quiescent file, creates
 * WAL sidecars: with no -wal/-shm present no other connection has the file
 * open, so it is read as immutable; otherwise a plain read-only connection
 * shares the live sidecars.
 */
function openReadOnly(dbPath: string): DatabaseSync {
  if (existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    return new DatabaseSync(dbPath, { readOnly: true });
  }
  const url = pathToFileURL(dbPath);
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url.href, { readOnly: true });
}

function preflightClose(dbPath: string, seq: number): {
  identity: FileIdentity;
  evaluation: TerminalRecordInboundCloseEvaluation;
  schema: number;
} {
  const identity = assertExistingRegularDatabase(dbPath);
  const raw = openReadOnly(dbPath);
  try {
    assertSchema43Foundation(raw);
    const evaluation = new TerminalRecordInboundCloser(raw).evaluate(seq);
    const schema = schemaVersion(raw);
    assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
    return { identity, evaluation, schema };
  } finally {
    raw.close();
  }
}

function closeInbound(args: Args, dbPath: string, auditPath: string): void {
  if (args.seq === undefined || !/^[1-9]\d*$/.test(args.seq) || !Number.isSafeInteger(Number(args.seq))) {
    fail('--seq must be a positive integer');
  }
  const seq = Number(args.seq);
  const mode: 'dry-run' | 'apply' = args.apply ? 'apply' : 'dry-run';
  if (args.apply && (args.expectDigest === undefined || !/^[0-9a-f]{64}$/.test(args.expectDigest))) {
    fail('--apply requires --expect-digest <the 64-hex digest a dry run printed>');
  }
  const refuse = (reason: string): never => {
    auditReceipt(auditPath, { action: 'close-inbound', inboundSeq: seq, mode, outcome: 'refused', reason });
    fail(`inbound seq ${seq} refused: ${reason}`);
  };

  const { identity, evaluation, schema } = preflightClose(dbPath, seq);
  if (evaluation.verdict === 'refused') refuse(evaluation.reason);
  if (evaluation.verdict === 'already_closed') {
    auditReceipt(auditPath, { action: 'close-inbound', inboundSeq: seq, mode, outcome: 'not-applied:already-closed' });
    console.log(JSON.stringify({
      applied: false,
      alreadyClosed: true,
      seq,
      recordId: evaluation.recordId,
      disposition: evaluation.disposition,
      status: evaluation.status,
    }, null, 2));
    return;
  }
  const eligible = evaluation as EligibleClose;
  const digest = closeDigest(identity, eligible);
  if (!args.apply) {
    auditReceipt(auditPath, { action: 'close-inbound', inboundSeq: seq, mode, outcome: 'previewed' });
    console.log(JSON.stringify({
      dryRun: true,
      wouldClose: closeProjection(eligible),
      digest,
      schemaCurrent: schema === CURRENT_SCHEMA_MIGRATION,
    }, null, 2));
    return;
  }
  if (schema !== CURRENT_SCHEMA_MIGRATION) refuse('schema_not_current');
  if (digest !== args.expectDigest) refuse('digest_mismatch');

  // Re-prove everything on the connection and transaction that writes.
  const { refusal, closed } = withFailedApplyReceipt(() => auditReceipt(auditPath, {
    action: 'close-inbound', inboundSeq: seq, mode, outcome: 'failed', reason: WRITE_TRANSACTION_FAILED_REASON,
  }), () => {
    const written: { refusal?: string; closed?: EligibleClose } = {};
    const raw = openExistingWritableDatabase(dbPath, identity);
    let committed = false;
    try {
      raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('BEGIN IMMEDIATE');
      try {
        assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
        assertSchema43Foundation(raw);
        const recheck = new TerminalRecordInboundCloser(raw).evaluate(seq);
        if (schemaVersion(raw) !== CURRENT_SCHEMA_MIGRATION) written.refusal = 'schema_not_current';
        else if (recheck.verdict !== 'eligible') written.refusal = recheck.verdict === 'refused' ? recheck.reason : 'state_changed';
        else if (closeDigest(identity, recheck) !== args.expectDigest) written.refusal = 'digest_mismatch';
        else {
          new TerminalRecordInboundCloser(raw).applyWithinCallerTransaction(recheck);
          written.closed = recheck;
        }
        raw.exec(written.refusal === undefined ? 'COMMIT' : 'ROLLBACK');
        committed = written.refusal === undefined;
      } catch (err) {
        rollbackKeepingCause(raw);
        throw err;
      }
    } finally {
      closeWriteConnection(raw, committed);
    }
    return written;
  });
  if (refusal !== undefined) refuse(refusal);
  // The close is committed: report it before the receipt, so a failed append
  // can never read as "nothing happened".
  console.log(JSON.stringify({ applied: true, closed: closeProjection(closed!) }, null, 2));
  try {
    auditReceipt(auditPath, { action: 'close-inbound', inboundSeq: seq, mode, outcome: 'applied' });
  } catch (err) {
    console.error(
      `turn-recovery-operator: inbound seq ${seq} WAS closed, but the audit receipt not written: ` +
      (err instanceof Error ? err.message : String(err)),
    );
    process.exit(AUDIT_RECEIPT_FAILED_EXIT);
  }
}

/**
 * Content-free projection of a settle: ids, kinds, statuses and the recovery
 * owner the job will name. Never jids, conversation keys or message ids.
 */
function settleProjection(settle: EligibleOrphanTransferSettle): Record<string, unknown> {
  return {
    terminalRecordId: settle.terminalId,
    planId: settle.planId,
    scope: settle.scope,
    inboundSeq: settle.inboundSeq,
    recoveryOwner: {
      logicalTurnId: settle.recoveryOwnerLogicalTurnId,
      managerId: settle.recoveryOwnerManagerId,
      generation: settle.recoveryOwnerGeneration,
    },
    deliveryKind: settle.deliveryKind,
    deliveryOpId: settle.deliveryOpId,
    deliveryStatus: settle.deliveryStatus,
    deliveryIsTerminal: settle.deliveryIsTerminal,
    deliveryHasWaMessageId: settle.deliveryHasWaMessageId,
    deliveryIdentityMatches: settle.deliveryIdentityMatches,
    sourceInboundIdentityMatches: settle.sourceInboundIdentityMatches,
    sourceInboundStatus: settle.sourceInboundStatus,
    sourceInboundTerminalReason: settle.sourceInboundTerminalReason,
    corroborated: settle.corroborated,
    settledJobState: 'exhausted',
  };
}

/**
 * Binds a settle apply to its dry run (v3): the database file identity; every
 * value the settled job copies from the terminal record and its source inbound
 * (record id, scope, conversation key, delivery JID, source seq, source
 * logical turn id, manager id and generation, source message id, the
 * recovery-owner logical turn id, manager id and generation, and the derived
 * group flag); every admission input (delivery kind, op id, status, terminal
 * flag, message-id presence, delivery and source-inbound identity match,
 * source-inbound status and reason, corroboration); and the evidence
 * reference. The recheck inside the write transaction recomputes this v3
 * digest from the same rows the insert copies, so a value that changed after
 * the dry run refuses with digest_mismatch. The copied identifiers are hashed,
 * never printed.
 */
function settleDigest(identity: FileIdentity, settle: EligibleOrphanTransferSettle, evidenceRef: string): string {
  return createHash('sha256').update(JSON.stringify({
    v: 3,
    action: 'settle-orphan-transfer',
    device: identity.device,
    inode: identity.inode,
    ...settleProjection(settle),
    copied: {
      conversationKey: settle.conversationKey,
      deliveryJid: settle.deliveryJid,
      sourceLogicalTurnId: settle.sourceLogicalTurnId,
      sourceManagerId: settle.sourceManagerId,
      sourceGeneration: settle.sourceGeneration,
      sourceMessageId: settle.sourceMessageId,
      isGroup: settle.isGroup,
    },
    evidenceRef,
  })).digest('hex');
}

function preflightSettle(dbPath: string, terminalId: number | undefined): {
  identity: FileIdentity;
  evaluation?: OrphanTransferSettleEvaluation;
  orphans?: number[];
  schema: number;
} {
  const identity = assertExistingRegularDatabase(dbPath);
  const raw = openReadOnly(dbPath);
  try {
    assertSchema43Foundation(raw);
    const settler = new OrphanTransferSettler(raw);
    const result = terminalId === undefined
      ? { orphans: settler.orphanTerminalIds() }
      : { evaluation: settler.evaluate(terminalId) };
    const schema = schemaVersion(raw);
    assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
    return { identity, schema, ...result };
  } finally {
    raw.close();
  }
}

function settleOrphanTransfer(args: Args, dbPath: string, auditPath: string): void {
  const mode: 'dry-run' | 'apply' = args.apply ? 'apply' : 'dry-run';
  if (args.terminal === undefined) {
    if (args.apply) fail('--apply requires --terminal <terminal record id>: one record per invocation');
    const { orphans, schema } = preflightSettle(dbPath, undefined);
    console.log(JSON.stringify({
      dryRun: true,
      orphanTransfers: orphans,
      schemaCurrent: schema === CURRENT_SCHEMA_MIGRATION,
    }, null, 2));
    return;
  }
  if (!/^[1-9]\d*$/.test(args.terminal) || !Number.isSafeInteger(Number(args.terminal))) {
    fail('--terminal must be a positive integer');
  }
  const terminalId = Number(args.terminal);
  const evidenceRef = args.evidenceRef;
  if (evidenceRef === undefined || !ORPHAN_TRANSFER_SETTLE_EVIDENCE_REF_PATTERN.test(evidenceRef)) {
    fail(
      `--evidence-ref must match ${String(ORPHAN_TRANSFER_SETTLE_EVIDENCE_REF_PATTERN)} ` +
      '(an operator investigation record establishing the transfer will never be replayed)',
    );
  }
  if (args.apply && (args.expectDigest === undefined || !/^[0-9a-f]{64}$/.test(args.expectDigest))) {
    fail('--apply requires --expect-digest <the 64-hex digest a dry run printed>');
  }
  const proofHash = createHash('sha256').update(evidenceRef).digest('hex').slice(0, 16);
  const receipt = (outcome: string, reason?: string): void => auditReceipt(auditPath, {
    action: 'settle-orphan-transfer',
    terminalRecordId: terminalId,
    mode,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    proofHash,
  });
  const refuse = (reason: string): never => {
    receipt('refused', reason);
    fail(`terminal record ${terminalId} refused: ${reason}`);
  };

  // The documented no-op, for a rerun (found by the preflight) and for the
  // loser of two concurrent applies (found by the in-transaction recheck).
  const reportAlreadySettled = (settledBefore: SettledOrphanTransfer): void => {
    receipt('not-applied:already-settled');
    console.log(JSON.stringify({
      applied: false,
      alreadySettled: true,
      terminalRecordId: terminalId,
      planId: settledBefore.planId,
      jobId: settledBefore.jobId,
    }, null, 2));
  };

  const { identity, evaluation, schema } = preflightSettle(dbPath, terminalId);
  if (evaluation === undefined) fail(`terminal record ${terminalId} was not evaluated`);
  if (evaluation.verdict === 'refused') refuse(evaluation.reason);
  if (evaluation.verdict === 'already_settled') {
    reportAlreadySettled(evaluation);
    return;
  }
  const eligible = evaluation as EligibleOrphanTransferSettle;
  const digest = settleDigest(identity, eligible, evidenceRef);
  if (!args.apply) {
    receipt('previewed');
    console.log(JSON.stringify({
      dryRun: true,
      wouldSettle: settleProjection(eligible),
      digest,
      schemaCurrent: schema === CURRENT_SCHEMA_MIGRATION,
    }, null, 2));
    return;
  }
  if (schema !== CURRENT_SCHEMA_MIGRATION) refuse('schema_not_current');
  if (digest !== args.expectDigest) refuse('digest_mismatch');

  // Re-prove everything on the connection and transaction that writes.
  const { refusal, settledBefore, settled } = withFailedApplyReceipt(
    () => receipt('failed', WRITE_TRANSACTION_FAILED_REASON),
    () => {
      const written: {
        refusal?: string;
        settledBefore?: SettledOrphanTransfer;
        settled?: { settle: EligibleOrphanTransferSettle; jobId: number };
      } = {};
      const raw = openExistingWritableDatabase(dbPath, identity);
      let committed = false;
      try {
        raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
        raw.exec('PRAGMA foreign_keys = ON');
        beforeSettleWriteTransaction(dbPath);
        raw.exec('BEGIN IMMEDIATE');
        try {
          assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
          assertSchema43Foundation(raw);
          const settler = new OrphanTransferSettler(raw);
          const recheck = settler.evaluate(terminalId);
          if (schemaVersion(raw) !== CURRENT_SCHEMA_MIGRATION) written.refusal = 'schema_not_current';
          else if (recheck.verdict === 'refused') written.refusal = recheck.reason;
          // A concurrent apply settled the record first: the documented no-op.
          else if (recheck.verdict === 'already_settled') written.settledBefore = recheck;
          // Fail closed on any verdict this command does not handle. The
          // current evaluator returns only the three handled here.
          else if (recheck.verdict !== 'eligible') written.refusal = 'state_changed';
          else if (settleDigest(identity, recheck, evidenceRef) !== args.expectDigest) written.refusal = 'digest_mismatch';
          else written.settled = { settle: recheck, ...settler.applyWithinCallerTransaction(recheck, evidenceRef) };
          raw.exec(written.settled === undefined ? 'ROLLBACK' : 'COMMIT');
          committed = written.settled !== undefined;
        } catch (err) {
          rollbackKeepingCause(raw);
          throw err;
        }
      } finally {
        closeWriteConnection(raw, committed);
      }
      return written;
    },
  );
  if (refusal !== undefined) refuse(refusal);
  if (settledBefore !== undefined) {
    reportAlreadySettled(settledBefore);
    return;
  }
  // Committed: report it before the receipt, so a failed append can never
  // read as "nothing happened".
  console.log(JSON.stringify({
    applied: true,
    settled: { ...settleProjection(settled!.settle), jobId: settled!.jobId },
  }, null, 2));
  try {
    receipt('applied');
  } catch (err) {
    console.error(
      `turn-recovery-operator: terminal record ${terminalId} WAS settled, but the audit receipt not written: ` +
      (err instanceof Error ? err.message : String(err)),
    );
    process.exit(AUDIT_RECEIPT_FAILED_EXIT);
  }
}

/**
 * The settle plan a job's proof id names, or null when the proof id does not
 * carry the settle prefix. `settled` is true only when the plan exists with
 * origin operator and the CLI actor, the job is exhausted and assigned to the
 * CLI actor: the full shape settle-orphan-transfer writes. Content-free.
 */
function operatorSettlement(
  raw: DatabaseSync,
  job: TurnRecoveryJobRow,
): { settled: boolean; facts: Record<string, unknown> } | null {
  const proofId = job.replay_safety_proof_id;
  if (proofId === null || !proofId.startsWith(ORPHAN_TRANSFER_SETTLE_PLAN_PREFIX)) return null;
  const plan = raw.prepare(
    'SELECT plan_id, origin, actor, created_at FROM recovery_plans WHERE plan_id = ?',
  ).get(proofId) as { plan_id: string; origin: string; actor: string; created_at: string } | undefined;
  const settled = plan !== undefined
    && plan.origin === 'operator'
    && plan.actor === ORPHAN_TRANSFER_SETTLE_ACTOR
    && job.state === 'exhausted'
    && job.assigned_owner_manager_id === ORPHAN_TRANSFER_SETTLE_ACTOR;
  return {
    settled,
    facts: {
      planId: proofId,
      planFound: plan !== undefined,
      ...(plan === undefined ? {} : { origin: plan.origin, actor: plan.actor, createdAt: plan.created_at }),
    },
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const commands = ['list', 'show', 'reassign', 'promote', 'close-inbound', 'settle-orphan-transfer'];
  if (!args.command || !commands.includes(args.command)) {
    fail(`usage: turn-recovery-operator <${commands.join('|')}> --db <path> [options]`);
  }
  if (!args.db) fail('--db <instance dbPath> is required');
  if (!existsSync(args.db)) fail('database file does not exist');
  const auditPath = args.auditFile ?? path.join(path.dirname(args.db), 'turn-recovery-operator-audit.jsonl');

  // Before the Database wrapper: opening it migrates the file.
  if (args.command === 'close-inbound') {
    closeInbound(args, args.db, auditPath);
    return;
  }
  if (args.command === 'settle-orphan-transfer') {
    settleOrphanTransfer(args, args.db, auditPath);
    return;
  }

  const db = new Database(args.db);
  db.open();
  try {
    const engine = new DurabilityEngine(db);

    if (args.command === 'list') {
      if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200) fail('--limit must be 1..200');
      if (!Number.isSafeInteger(args.afterId) || args.afterId < 0) fail('--after-id must be >= 0');
      const page = engine.getOutstandingTurnRecoveryJobsForSupervisor({ limit: args.limit, afterId: args.afterId });
      const blocked = page.jobs.filter((j) => j.state === 'blocked_unsafe');
      console.log(JSON.stringify({
        blocked: blocked.map(redactedJob),
        page: { scanComplete: page.scanComplete, nextAfterId: page.jobs.at(-1)?.id ?? args.afterId },
      }, null, 2));
      return;
    }

    if (args.command === 'show') {
      const job = requireJob(engine, args.job);
      const settlement = operatorSettlement(db.raw, job);
      console.log(JSON.stringify({
        job: redactedJob(job),
        fence: { claimEpoch: job.claim_epoch, assignmentEpoch: job.assignment_epoch },
        ...(settlement === null
          ? {}
          : settlement.settled
            ? { operatorSettlement: { kind: 'orphan_transfer_settle', ...settlement.facts } }
            : { settlePlan: settlement.facts }),
        eligibility: job.state === 'blocked_unsafe'
          ? 'blocked_unsafe: reassign and evidence-gated promote available'
          : settlement?.settled
            ? 'operator-settled orphan transfer: not attempt exhaustion; no operator transition available'
            : `state ${job.state}: no operator transition available from this CLI`,
      }, null, 2));
      return;
    }

    const mode: 'dry-run' | 'apply' = args.apply ? 'apply' : 'dry-run';

    if (args.command === 'reassign') {
      const job = requireJob(engine, args.job);
      if (job.state !== 'blocked_unsafe') fail(`job ${job.id} is ${job.state}, not blocked_unsafe`);
      const currentOwner = {
        logicalTurnId: job.assigned_owner_logical_turn_id,
        managerId: job.assigned_owner_manager_id,
        generation: job.assigned_owner_generation,
      };
      const newOwner = {
        logicalTurnId: `operator-reassign-${randomUUID()}`,
        managerId: 'turn-recovery-operator-cli',
        generation: 1,
      };
      if (!args.apply) {
        auditReceipt(auditPath, { action: 'reassign', jobId: job.id, mode, outcome: 'previewed' });
        console.log(JSON.stringify({ dryRun: true, wouldReassign: redactedJob(job), fence: { claimEpoch: job.claim_epoch, assignmentEpoch: job.assignment_epoch } }, null, 2));
        return;
      }
      const result = engine.reassignBlockedTurnRecoveryJob(job.id, currentOwner, newOwner, {
        claimEpoch: job.claim_epoch,
        assignmentEpoch: job.assignment_epoch,
      });
      auditReceipt(auditPath, { action: 'reassign', jobId: job.id, mode, outcome: result.applied ? 'applied' : 'not-applied' });
      console.log(JSON.stringify({ applied: result.applied, job: redactedJob(engine.getTurnRecoveryJob(job.id)!) }, null, 2));
      return;
    }

    // promote
    const job = requireJob(engine, args.job);
    const evidence = args.evidenceType !== undefined ? EVIDENCE_TYPES[args.evidenceType] : undefined;
    if (!evidence) {
      fail(`--evidence-type must be one of: ${Object.keys(EVIDENCE_TYPES).join(', ')}`);
    }
    if (args.evidenceRef === undefined || !evidence.refPattern.test(args.evidenceRef)) {
      fail(`--evidence-ref must match ${String(evidence.refPattern)} for ${args.evidenceType} (${evidence.describes})`);
    }
    const proofId = `proof:${args.evidenceType}:${args.evidenceRef}`;
    const proofHash = createHash('sha256').update(proofId).digest('hex').slice(0, 16);
    // Idempotent retry: the SAME evidence against an already-promoted job is a
    // no-op report, not an error. A different proof falls through to the state
    // guard and is rejected — one job, one proof.
    if (job.state === 'pending' && job.replay_safety_proof_id === proofId) {
      auditReceipt(auditPath, { action: 'promote', jobId: job.id, mode, outcome: 'not-applied:already-promoted', evidenceType: args.evidenceType, proofHash });
      console.log(JSON.stringify({ applied: false, alreadyPromoted: true, job: redactedJob(job) }, null, 2));
      return;
    }
    if (job.state !== 'blocked_unsafe') fail(`job ${job.id} is ${job.state}, not blocked_unsafe`);
    // Newer-activity gate: journaled inbound activity after the job's source
    // means the conversation moved on — promotion fails closed, no override.
    const newest = engine.getNewestInboundSeqForConversation(job.conversation_key);
    if (newest !== null && newest > job.source_inbound_seq) {
      auditReceipt(auditPath, { action: 'promote', jobId: job.id, mode, outcome: 'refused-newer-activity', evidenceType: args.evidenceType });
      fail(`conversation has newer journaled activity (newest seq ${newest} > source seq ${job.source_inbound_seq}); promotion refused`);
    }
    if (!args.apply) {
      auditReceipt(auditPath, { action: 'promote', jobId: job.id, mode, outcome: 'previewed', evidenceType: args.evidenceType, proofHash });
      console.log(JSON.stringify({
        dryRun: true,
        wouldPromote: redactedJob(job),
        fence: { claimEpoch: job.claim_epoch, assignmentEpoch: job.assignment_epoch },
        warning: 'promotion makes this job replayable: the supervisor may dispatch it on its next scan',
      }, null, 2));
      return;
    }
    const owner = {
      logicalTurnId: job.assigned_owner_logical_turn_id,
      managerId: job.assigned_owner_manager_id,
      generation: job.assigned_owner_generation,
    };
    const result = engine.promoteBlockedTurnRecoveryJob(job.id, owner, {
      claimEpoch: job.claim_epoch,
      assignmentEpoch: job.assignment_epoch,
    }, { idempotencyProofId: proofId });
    auditReceipt(auditPath, {
      action: 'promote', jobId: job.id, mode,
      outcome: result.applied ? 'applied' : `not-applied:${result.state}`,
      evidenceType: args.evidenceType, proofHash,
    });
    console.log(JSON.stringify({
      applied: result.applied,
      job: redactedJob(engine.getTurnRecoveryJob(job.id)!),
      warning: 'pending work is replayable and may subsequently dispatch',
    }, null, 2));
  } finally {
    db.close();
  }
}

/** The CLI entry: main(), with any thrown error reported and exit 1. */
export function runTurnRecoveryOperatorCli(): void {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// The repo's main-module gate. scripts/run-with-pinned-node.sh passes Node the
// realpath'd script, so argv[1] matches import.meta.url even from a symlinked
// checkout (#1831). A test driver that imports this module is argv[1] itself,
// so the CLI does not run there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTurnRecoveryOperatorCli();
}
