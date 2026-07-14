import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  closeOperatorCatchupRecoveryRaw,
  inspectOperatorCatchupRecovery,
  type CloseOperatorCatchupRecoveryParams,
  type CloseOperatorCatchupRecoveryReceipt,
  type OperatorCatchupRecoveryInspection,
} from '../src/core/recovery-catchup-closure.ts';

interface CliArgs {
  dbPath: string;
  planId: string;
  conversationKey: string;
  sourceSeqs: number[];
  catchupSeq: number;
  actor: string;
  evidenceRef: string;
  confirm: boolean;
}

export interface FileIdentity {
  device: number;
  inode: number;
}

function usage(): string {
  return [
    'Usage: close-recovery-catchup --db PATH --plan-id ID --conversation-key KEY',
    '  --source-seqs 1,2,3 --catchup-seq N --actor ID --evidence-ref REF [--confirm]',
    '',
    'Without --confirm this command is a non-mutating dry run.',
  ].join('\n');
}

const VALUE_FLAGS = new Set([
  '--db',
  '--plan-id',
  '--conversation-key',
  '--source-seqs',
  '--catchup-seq',
  '--actor',
  '--evidence-ref',
]);

function positiveSequence(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function sourceSequences(value: string): number[] {
  if (value.length === 0) throw new Error('Source sequence list is required');
  const parsed = value.split(',').map((entry) => positiveSequence(
    entry.trim(),
    'Source sequence',
  ));
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('Source sequence set contains duplicates');
  }
  return parsed;
}

export function parseCloseRecoveryArgs(argv: string[]): CliArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let confirm = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--confirm' && !VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === '--confirm') {
      confirm = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} is required`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    const sequenceFlag = flag === '--source-seqs' || flag === '--catchup-seq';
    if (value === undefined || (value.length === 0 && !sequenceFlag)) {
      throw new Error(`${flag} is required`);
    }
    return value;
  };
  return {
    dbPath: resolve(required('--db')),
    planId: required('--plan-id'),
    conversationKey: required('--conversation-key'),
    sourceSeqs: sourceSequences(required('--source-seqs')),
    catchupSeq: positiveSequence(required('--catchup-seq'), 'Catch-up sequence'),
    actor: required('--actor'),
    evidenceRef: required('--evidence-ref'),
    confirm,
  };
}

function assertExistingRegularDatabase(dbPath: string): FileIdentity {
  try {
    const stat = statSync(dbPath);
    if (stat.isFile()) return { device: stat.dev, inode: stat.ino };
  } catch {
    // Emit the same fail-closed diagnostic for missing and inaccessible paths.
  }
  throw new Error(`Database path must be an existing regular file: ${dbPath}`);
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertSameDatabaseFile(
  expected: FileIdentity,
  observed: FileIdentity,
): void {
  if (!sameFile(expected, observed)) {
    throw new Error('Database path changed after read-only preflight');
  }
}

/** Open an existing SQLite file for writes without SQLite's CREATE fallback. */
export function openExistingWritableDatabase(
  dbPath: string,
  expectedIdentity: FileIdentity,
): DatabaseSync {
  const writableUrl = pathToFileURL(dbPath);
  writableUrl.searchParams.set('mode', 'rw');
  const raw = new DatabaseSync(writableUrl.href);
  try {
    assertSameDatabaseFile(expectedIdentity, assertExistingRegularDatabase(dbPath));
    return raw;
  } catch (error) {
    raw.close();
    throw error;
  }
}

function assertSchema43Foundation(raw: DatabaseSync): void {
  const table = raw.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!table) throw new Error('Database must include canonical schema 43 receipts');
  const versions = (raw.prepare(`
    SELECT version
    FROM schema_migrations
    ORDER BY version
  `).all() as Array<{ version: number }>).map((row) => Number(row.version));
  if (
    versions.length < 43
    || versions.some((version, index) => version !== index + 1)
  ) {
    throw new Error(
      'Database must include contiguous schema 43+ receipts (migrations 1 through current)',
    );
  }
}

function closureParams(args: CliArgs): CloseOperatorCatchupRecoveryParams {
  return {
    planId: args.planId,
    conversationKey: args.conversationKey,
    expectedSourceSeqs: args.sourceSeqs,
    catchupSeq: args.catchupSeq,
    actor: args.actor,
    evidenceRef: args.evidenceRef,
  };
}

function inspectReadOnly(
  dbPath: string,
  params: CloseOperatorCatchupRecoveryParams,
): { inspection: OperatorCatchupRecoveryInspection; identity: FileIdentity } {
  const identity = assertExistingRegularDatabase(dbPath);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    assertSchema43Foundation(raw);
    const inspection = inspectOperatorCatchupRecovery(raw, params);
    assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
    return { inspection, identity };
  } finally {
    raw.close();
  }
}

function publicInspection(inspection: OperatorCatchupRecoveryInspection): Record<string, unknown> {
  return {
    planId: inspection.planId,
    conversationKey: inspection.conversationKey,
    sourceSeqs: inspection.sourceSeqs,
    catchupSeq: inspection.catchupSeq,
    evidenceBasis: inspection.evidenceBasis,
    terminalRecordId: inspection.terminalRecordId,
    selectedOpId: inspection.selectedOpId,
    recoveryJobId: inspection.recoveryJobId,
    completionProofId: inspection.completionProofId,
    wouldInsert: inspection.wouldInsert,
    idempotent: inspection.idempotent,
    openBefore: inspection.openBefore,
    openAfter: inspection.openAfter,
  };
}

function publicReceipt(receipt: CloseOperatorCatchupRecoveryReceipt): Record<string, unknown> {
  const { actor: _actor, evidenceRef: _evidenceRef, ...safeReceipt } = receipt;
  return safeReceipt;
}

export function runCloseRecoveryCatchupCli(argv: string[]): number {
  const args = parseCloseRecoveryArgs(argv);
  const params = closureParams(args);
  const { inspection, identity } = inspectReadOnly(args.dbPath, params);
  if (!args.confirm) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      ready: true,
      ...publicInspection(inspection),
    })}\n`);
    return 0;
  }

  // Recheck the path after the read-only preflight, then revalidate schema and
  // proof on the same connection and transaction that performs the closure.
  assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
  const raw = openExistingWritableDatabase(args.dbPath, identity);
  try {
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA foreign_keys = ON');
    const receipt = closeOperatorCatchupRecoveryRaw(raw, params, (transactionRaw) => {
      assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
      assertSchema43Foundation(transactionRaw);
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: false,
      receipt: publicReceipt(receipt),
    })}\n`);
    return 0;
  } finally {
    raw.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runCloseRecoveryCatchupCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
