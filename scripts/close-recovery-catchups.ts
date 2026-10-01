/**
 * Batch operator closure of caught-up `recovery_pending_operator_catchup`
 * groups (npm `close-recovery-catchups`).
 *
 * Selection is the automatic reconciler's rule, taken verbatim from
 * `selectOperatorCatchupCandidates`: for each open (plan, conversation) group,
 * the earliest same-chat `operator_catchup_delivery_proofs` target later than
 * every source sequence. Every group is then proven by
 * `inspectOperatorCatchupRecovery` (dry run) or closed by
 * `closeOperatorCatchupRecoveryRaw` (confirm) — the same primitive the
 * single-group `close-recovery-catchup` command uses — so this command adds no
 * proof rule of its own. It differs from the reconciler only in recording the
 * operator's `--actor` and `--evidence-ref` instead of the reconciler's.
 *
 * Dry run is the default and makes no database change (the per-database
 * redaction salt sidecar is created on first use, as with the single-group
 * command). `--confirm` requires `--backup-dir` and takes a consistent,
 * quick_check-verified backup before the first write, then re-enumerates.
 *
 * Output is one JSON document. Raw plan IDs, conversation keys, chat JIDs,
 * sequences, actor and evidence reference never appear; groups are identified
 * by the same keyed fingerprints the single-group command prints.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  classifyReconcileSkip,
  closeOperatorCatchupRecoveryRaw,
  inspectOperatorCatchupRecovery,
  RECONCILE_DEFAULT_GROUP_LIMIT,
  selectOperatorCatchupCandidates,
  type CloseOperatorCatchupRecoveryParams,
  type OperatorCatchupCandidateGroup,
  type ReconcileSkipReason,
} from '../src/core/recovery-catchup-closure.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';
import {
  assertExistingRegularDatabase,
  assertSameDatabaseFile,
  assertSchema43Foundation,
  loadOrCreateRedactionSalt,
  openExistingWritableDatabase,
  redactFingerprint,
  type FileIdentity,
} from './close-recovery-catchup.ts';
import { CliArgError, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { backupSqliteConsistent, type SqliteBackupReceipt } from './lib/sqlite-consistent-backup.ts';

export interface BatchClosureArgs {
  dbPath: string;
  actor: string;
  evidenceRef: string;
  groupLimit: number;
  confirm: boolean;
  backupDir: string | null;
}

export type BatchGroupStatus = 'ready' | 'closed' | 'idempotent' | 'skipped';

export interface BatchGroupResult {
  planFingerprint: string;
  conversationFingerprint: string;
  nSourceSeqs: number;
  catchupSeqFingerprint: string | null;
  status: BatchGroupStatus;
  reason?: ReconcileSkipReason;
  evidenceBasis?: string;
  wouldInsert?: number;
  inserted?: number;
  openBefore?: number;
  openAfter?: number;
}

export interface BatchClosureReport {
  ok: boolean;
  dryRun: boolean;
  groupLimit: number;
  backup: { path: string; pages: number; quickCheck: 'ok' } | null;
  summary: {
    examined: number;
    ready: number;
    closed: number;
    idempotent: number;
    skipped: number;
    linksClosed: number;
    errors: number;
  };
  groups: BatchGroupResult[];
}

export const BATCH_CLOSURE_EXIT = {
  ok: 0,
  groupErrors: 1,
  usage: 2,
} as const;

const USAGE = [
  'Usage: close-recovery-catchups --db PATH --actor ID --evidence-ref REF',
  '  [--group-limit N] [--confirm --backup-dir DIR]',
  '',
  'Selects every open operator catch-up recovery group with the reconciler rule and',
  'proves each one read-only. --confirm backs the database up to DIR (quick_check',
  'verified) and then closes each proven group with the recorded actor and evidence.',
].join('\n');

const VALUE_FLAGS = ['--db', '--actor', '--evidence-ref', '--group-limit', '--backup-dir'] as const;

export function parseBatchClosureArgs(argv: readonly string[]): BatchClosureArgs {
  const values = new Map<string, string>();
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (isHelpFlag(flag)) throw new CliArgError(USAGE);
    if (flag === '--confirm') {
      if (confirm) throw new CliArgError('Duplicate argument: --confirm');
      confirm = true;
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(flag)) {
      throw new CliArgError(`Unknown argument: ${flag}`);
    }
    if (values.has(flag)) throw new CliArgError(`Duplicate argument: ${flag}`);
    const taken = takeValue(argv, index, flag);
    values.set(flag, taken.value);
    index = taken.index;
  }
  const required = (flag: string): string => {
    const value = values.get(flag)?.trim();
    if (!value) throw new CliArgError(`${flag} is required`);
    return value;
  };
  const rawLimit = values.get('--group-limit');
  let groupLimit = RECONCILE_DEFAULT_GROUP_LIMIT;
  if (rawLimit !== undefined) {
    if (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) {
      throw new CliArgError('--group-limit must be a positive safe integer');
    }
    groupLimit = Number(rawLimit);
  }
  const backupDir = values.get('--backup-dir') ?? null;
  if (confirm && backupDir === null) {
    throw new CliArgError('--confirm requires --backup-dir: a verified backup is taken before any write');
  }
  if (backupDir !== null && !path.isAbsolute(backupDir)) {
    throw new CliArgError('--backup-dir must be an absolute path');
  }
  return {
    dbPath: path.resolve(required('--db')),
    actor: required('--actor'),
    evidenceRef: required('--evidence-ref'),
    groupLimit,
    confirm,
    backupDir,
  };
}

function closureParams(args: BatchClosureArgs, group: OperatorCatchupCandidateGroup, catchupSeq: number):
  CloseOperatorCatchupRecoveryParams {
  return {
    planId: group.planId,
    conversationKey: group.conversationKey,
    expectedSourceSeqs: group.sourceSeqs,
    catchupSeq,
    actor: args.actor,
    evidenceRef: args.evidenceRef,
  };
}

function groupIdentity(salt: Buffer, group: OperatorCatchupCandidateGroup): Omit<BatchGroupResult, 'status'> {
  return {
    planFingerprint: redactFingerprint(salt, 'plan', group.planId),
    conversationFingerprint: redactFingerprint(salt, 'conversation', group.conversationKey),
    nSourceSeqs: group.sourceSeqs.length,
    catchupSeqFingerprint: group.catchupSeq === null
      ? null
      : redactFingerprint(salt, 'catchup-seq', group.catchupSeq),
  };
}

/** Reasons that mean "could not decide", as opposed to a proven not-yet-closable group. */
function isErrorReason(reason: ReconcileSkipReason | undefined): boolean {
  return reason === 'error' || reason === 'busy';
}

function inspectGroups(
  raw: DatabaseSync,
  args: BatchClosureArgs,
  salt: Buffer,
): BatchGroupResult[] {
  return selectOperatorCatchupCandidates(raw, args.groupLimit).map((group) => {
    const identity = groupIdentity(salt, group);
    if (group.catchupSeq === null) {
      return { ...identity, status: 'skipped', reason: 'no_catchup_candidate' };
    }
    try {
      const inspection = inspectOperatorCatchupRecovery(raw, closureParams(args, group, group.catchupSeq));
      return {
        ...identity,
        status: inspection.idempotent ? 'idempotent' : 'ready',
        evidenceBasis: inspection.evidenceBasis,
        wouldInsert: inspection.wouldInsert,
        openBefore: inspection.openBefore,
        openAfter: inspection.openAfter,
      };
    } catch (error) {
      return { ...identity, status: 'skipped', reason: classifyReconcileSkip(error) };
    }
  });
}

function closeGroups(
  raw: DatabaseSync,
  args: BatchClosureArgs,
  salt: Buffer,
  identity: FileIdentity,
): BatchGroupResult[] {
  return selectOperatorCatchupCandidates(raw, args.groupLimit).map((group) => {
    const fingerprint = groupIdentity(salt, group);
    if (group.catchupSeq === null) {
      return { ...fingerprint, status: 'skipped', reason: 'no_catchup_candidate' };
    }
    try {
      const receipt = closeOperatorCatchupRecoveryRaw(
        raw,
        closureParams(args, group, group.catchupSeq),
        (transactionRaw) => {
          assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
          assertSchema43Foundation(transactionRaw);
        },
      );
      return {
        ...fingerprint,
        status: receipt.idempotent ? 'idempotent' : 'closed',
        evidenceBasis: receipt.evidenceBasis,
        inserted: receipt.inserted,
        openBefore: receipt.openBefore,
        openAfter: receipt.openAfter,
      };
    } catch (error) {
      return { ...fingerprint, status: 'skipped', reason: classifyReconcileSkip(error) };
    }
  });
}

function summarize(groups: BatchGroupResult[]): BatchClosureReport['summary'] {
  return {
    examined: groups.length,
    ready: groups.filter((g) => g.status === 'ready').length,
    closed: groups.filter((g) => g.status === 'closed').length,
    idempotent: groups.filter((g) => g.status === 'idempotent').length,
    skipped: groups.filter((g) => g.status === 'skipped').length,
    linksClosed: groups.reduce((total, g) => total + (g.inserted ?? 0), 0),
    errors: groups.filter((g) => isErrorReason(g.reason)).length,
  };
}

function backupFileName(now: Date): string {
  return `bot.db.catchup-closure-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
}

/** Run one batch pass and return the report; never prints. */
export async function runBatchClosure(
  args: BatchClosureArgs,
  now: () => Date = () => new Date(),
): Promise<BatchClosureReport> {
  const identity = assertExistingRegularDatabase(args.dbPath);
  const salt = loadOrCreateRedactionSalt(args.dbPath);

  const readOnly = new DatabaseSync(args.dbPath, { readOnly: true });
  let preview: BatchGroupResult[];
  try {
    readOnly.exec('PRAGMA foreign_keys = ON');
    assertSchema43Foundation(readOnly);
    preview = inspectGroups(readOnly, args, salt);
    assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
  } finally {
    readOnly.close();
  }

  if (!args.confirm) {
    const summary = summarize(preview);
    return {
      ok: summary.errors === 0,
      dryRun: true,
      groupLimit: args.groupLimit,
      backup: null,
      summary,
      groups: preview,
    };
  }

  // The backup must exist and verify before the first write; a failure here
  // throws before any closure is attempted.
  const backupDir = args.backupDir!;
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const receipt: SqliteBackupReceipt = await backupSqliteConsistent(
    args.dbPath,
    path.join(backupDir, backupFileName(now())),
  );

  // Re-enumerate on the writable handle: the preview is advisory, and the
  // state may have moved while the backup ran.
  assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
  const raw = openExistingWritableDatabase(args.dbPath, identity);
  let groups: BatchGroupResult[];
  try {
    raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    raw.exec('PRAGMA foreign_keys = ON');
    assertSchema43Foundation(raw);
    groups = closeGroups(raw, args, salt, identity);
  } finally {
    raw.close();
  }
  const summary = summarize(groups);
  return {
    ok: summary.errors === 0,
    dryRun: false,
    groupLimit: args.groupLimit,
    backup: { path: receipt.backupPath, pages: receipt.pages, quickCheck: receipt.quickCheck },
    summary,
    groups,
  };
}

export async function runBatchClosureCli(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  let args: BatchClosureArgs;
  try {
    args = parseBatchClosureArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return BATCH_CLOSURE_EXIT.usage;
  }
  try {
    const report = await runBatchClosure(args);
    io.stdout(`${JSON.stringify(report)}\n`);
    return report.ok ? BATCH_CLOSURE_EXIT.ok : BATCH_CLOSURE_EXIT.groupErrors;
  } catch (error) {
    // Messages from the closure path and this file never interpolate raw
    // identifiers, actor or evidence (see close-recovery-catchup.ts).
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    io.stderr(`${JSON.stringify({ ok: false, dryRun: !args.confirm })}\n`);
    return BATCH_CLOSURE_EXIT.groupErrors;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await runBatchClosureCli(process.argv.slice(2));
}
