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
 *   - promotion validates an allowlisted evidence type + bounded reference
 *     shape (a bare nonempty label is NOT acceptable evidence), and refuses
 *     when the conversation has journaled inbound activity newer than the
 *     job's source (an old reply must not be blindly replayed).
 *   - output and audit receipts are content-free: job ids, states, scopes,
 *     epochs, timestamps, and hashes only — never replay text, sender/chat
 *     identifiers, message ids, or group names.
 *   - every attempted and applied mutation appends a durable JSON-lines
 *     audit receipt next to the database (or --audit-file). A close-inbound
 *     whose receipt append fails AFTER commit prints its applied result and
 *     exits 3, distinct from a refusal (1).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CliArgError, takeValue } from './lib/cli-args.ts';
import type { TurnRecoveryJobRow } from '../src/core/turn-recovery-store.ts';
import type { TerminalRecordInboundCloseEvaluation } from '../src/core/terminal-record-inbound-close.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';

// stdout is the CLI's data channel (JSON only) — silence the pino logger the
// database/durability modules construct at import time, BEFORE importing them.
process.env.LOG_LEVEL ??= 'silent';
const { Database } = await import('../src/core/database.ts');
const { DurabilityEngine } = await import('../src/core/durability.ts');
const { TerminalRecordInboundCloser } = await import('../src/core/terminal-record-inbound-close.ts');
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

/** close-inbound applied and committed, but its audit receipt could not be appended. */
const AUDIT_RECEIPT_FAILED_EXIT = 3;

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
  const raw = openExistingWritableDatabase(dbPath, identity);
  let refusal: string | undefined;
  let closed: EligibleClose | undefined;
  try {
    raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('BEGIN IMMEDIATE');
    try {
      assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
      assertSchema43Foundation(raw);
      const recheck = new TerminalRecordInboundCloser(raw).evaluate(seq);
      if (schemaVersion(raw) !== CURRENT_SCHEMA_MIGRATION) refusal = 'schema_not_current';
      else if (recheck.verdict !== 'eligible') refusal = recheck.verdict === 'refused' ? recheck.reason : 'state_changed';
      else if (closeDigest(identity, recheck) !== args.expectDigest) refusal = 'digest_mismatch';
      else {
        new TerminalRecordInboundCloser(raw).applyWithinCallerTransaction(recheck);
        closed = recheck;
      }
      raw.exec(refusal === undefined ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  } finally {
    raw.close();
  }
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || !['list', 'show', 'reassign', 'promote', 'close-inbound'].includes(args.command)) {
    fail('usage: turn-recovery-operator <list|show|reassign|promote|close-inbound> --db <path> [options]');
  }
  if (!args.db) fail('--db <instance dbPath> is required');
  if (!existsSync(args.db)) fail('database file does not exist');
  const auditPath = args.auditFile ?? path.join(path.dirname(args.db), 'turn-recovery-operator-audit.jsonl');

  // Before the Database wrapper: opening it migrates the file.
  if (args.command === 'close-inbound') {
    closeInbound(args, args.db, auditPath);
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
      console.log(JSON.stringify({
        job: redactedJob(job),
        fence: { claimEpoch: job.claim_epoch, assignmentEpoch: job.assignment_epoch },
        eligibility: job.state === 'blocked_unsafe'
          ? 'blocked_unsafe: reassign and evidence-gated promote available'
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

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
