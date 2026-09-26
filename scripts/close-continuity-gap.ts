// Operator command: close one recorded continuity gap as `addressed` or
// `declined`, bound to protected evidence. Preview (the default) reads only a
// static snapshot; `--apply` rechecks everything under a writer reservation on
// the live database and appends at most one row. See docs/runbook.md,
// "Close a continuity gap (addressed or declined)".
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  applyContinuityGapClosure,
  ContinuityGapClosureError,
  inspectContinuityGapClosure,
} from '../src/core/continuity-gap-closure.ts';
import { assertSchemaCeiling, sqliteFileUri } from '../src/core/database-compatibility.ts';
import { systemClock, type Clock } from '../src/lib/clock.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';
import {
  evaluateContinuityGapClosure,
  type ClosureEvaluationInputs,
  type ClosureEvaluationTrace,
} from './lib/continuity-closure-evidence.ts';

export interface CloseContinuityGapIo {
  stdout: (line: string) => void;
  clock: Clock;
}

interface CliArgs {
  evidenceRoot: string;
  evidencePath: string;
  snapshotPath: string | null;
  dbPath: string | null;
  apply: boolean;
  policyPath: string | null;
  instanceId: string | null;
}

const VALUE_FLAGS = new Set([
  '--evidence-root', '--evidence', '--snapshot', '--db', '--policy', '--instance',
]);

function usage(): string {
  return [
    'Usage: close-continuity-gap --evidence-root DIR --evidence REL_PATH',
    '         (--snapshot STATIC_COPY | --db PATH --apply)',
    '         [--policy PATH --instance ID]',
    '',
    'Preview (default) reads a static snapshot and never writes. --apply rechecks the',
    'same evidence inside BEGIN IMMEDIATE on the live database and appends one closure.',
    'Exit 0 ready/applied/already closed, 2 Blocked, 3 CLOSURE_PROOF_CONFLICT, 1 error.',
  ].join('\n');
}

export function parseCloseContinuityGapArgs(argv: string[]): CliArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (apply) throw new Error('Duplicate argument: --apply');
      apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new Error(`${flag} is required`);
    }
    values.set(flag, value);
    index += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`${flag} is required`);
    return value;
  };
  const evidenceRoot = resolve(required('--evidence-root'));
  const evidencePath = required('--evidence');
  const snapshot = values.get('--snapshot');
  const db = values.get('--db');
  if (apply && snapshot !== undefined) {
    throw new Error('--snapshot cannot be combined with --apply; apply reads the live --db');
  }
  if (apply && db === undefined) throw new Error('--db is required with --apply');
  if (!apply && db !== undefined) {
    throw new Error('--db requires --apply; preview reads a static --snapshot only');
  }
  if (!apply && snapshot === undefined) {
    throw new Error('--snapshot is required for preview (a static copy made with VACUUM INTO)');
  }
  const policy = values.get('--policy');
  const instance = values.get('--instance');
  if (policy !== undefined && instance === undefined) {
    throw new Error('--instance is required with --policy');
  }
  if (instance !== undefined && policy === undefined) {
    throw new Error('--policy is required with --instance');
  }
  return {
    evidenceRoot,
    evidencePath,
    snapshotPath: snapshot === undefined ? null : resolve(snapshot),
    dbPath: db === undefined ? null : resolve(db),
    apply,
    policyPath: policy === undefined ? null : resolve(policy),
    instanceId: instance ?? null,
  };
}

interface FileState {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
}

function regularFile(path: string, label: string): FileState {
  try {
    const stat = statSync(path);
    if (stat.isFile()) {
      return { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  } catch {
    // by design: one fail-closed diagnostic for missing and inaccessible paths.
  }
  throw new Error(`${label} must be an existing regular file`);
}

function sameFile(left: FileState, right: FileState): boolean {
  return left.device === right.device && left.inode === right.inode;
}

interface Outcome {
  ok: boolean;
  decision: 'ready' | 'applied' | 'already_closed' | 'blocked' | 'conflict';
  code: null | 'CLOSURE_BLOCKED' | 'CLOSURE_PROOF_CONFLICT';
  condition: string | null;
  operationId: string | null;
  disposition: string | null;
  message?: string;
}

function failure(error: ContinuityGapClosureError, operationId: string | null): Outcome {
  return {
    ok: false,
    decision: error.kind,
    code: error.kind === 'blocked' ? 'CLOSURE_BLOCKED' : 'CLOSURE_PROOF_CONFLICT',
    condition: error.condition,
    operationId,
    disposition: null,
    message: error.message,
  };
}

/** A binary must not judge or write a ledger newer than it understands. */
function assertCompatibleSchema(raw: DatabaseSync, path: string, trace: ClosureEvaluationTrace): void {
  try {
    assertSchemaCeiling(raw, path);
  } catch (error) {
    throw new ContinuityGapClosureError(
      'blocked',
      'schema_incompatible',
      error instanceof Error ? error.message : 'Database schema is not compatible with this binary',
    );
  }
  trace.checks.push('schema_ceiling');
}

function exitCode(outcome: Outcome): number {
  if (outcome.ok) return 0;
  return outcome.decision === 'blocked' ? 2 : 3;
}

/**
 * Preview never writes: the snapshot must be a static copy with no WAL or
 * rollback-journal sidecar, and is opened `immutable=1` so SQLite creates no
 * lock or shared-memory file. Its identity, size and mtime are rechecked.
 */
function preview(args: CliArgs, inputs: ClosureEvaluationInputs, trace: ClosureEvaluationTrace): Outcome {
  const snapshotPath = args.snapshotPath as string;
  const before = regularFile(snapshotPath, 'Snapshot');
  if (existsSync(`${snapshotPath}-wal`) || existsSync(`${snapshotPath}-journal`)) {
    return failure(new ContinuityGapClosureError(
      'blocked',
      'snapshot_not_static',
      'Snapshot has a WAL or journal sidecar; preview needs a static VACUUM INTO copy',
    ), null);
  }
  trace.checks.push('snapshot_static');
  const raw = new DatabaseSync(`${sqliteFileUri(snapshotPath, 'ro')}&immutable=1`, {
    readOnly: true,
  });
  let outcome: Outcome;
  try {
    assertCompatibleSchema(raw, snapshotPath, trace);
    const { record } = evaluateContinuityGapClosure(raw, inputs, trace);
    const inspection = inspectContinuityGapClosure(raw, record);
    trace.checks.push('gap_open');
    outcome = {
      ok: true,
      decision: inspection.state === 'open' ? 'ready' : 'already_closed',
      code: null,
      condition: null,
      operationId: record.operationId,
      disposition: record.disposition,
    };
  } catch (error) {
    if (!(error instanceof ContinuityGapClosureError)) throw error;
    outcome = failure(error, null);
  } finally {
    raw.close();
  }
  const after = regularFile(snapshotPath, 'Snapshot');
  if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Snapshot changed during preview');
  }
  return outcome;
}

function applyClosure(args: CliArgs, inputs: ClosureEvaluationInputs, trace: ClosureEvaluationTrace): Outcome {
  const dbPath = args.dbPath as string;
  const identity = regularFile(dbPath, 'Database');
  const raw = new DatabaseSync(sqliteFileUri(dbPath, 'rw'));
  let operationId: string | null = null;
  try {
    raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    raw.exec('PRAGMA foreign_keys = ON');
    if (!sameFile(identity, regularFile(dbPath, 'Database'))) {
      throw new Error('Database path changed before the writer reservation');
    }
    const result = applyContinuityGapClosure(raw, (inner) => {
      assertCompatibleSchema(inner, dbPath, trace);
      const { record } = evaluateContinuityGapClosure(inner, inputs, trace);
      operationId = record.operationId;
      if (!sameFile(identity, regularFile(dbPath, 'Database'))) {
        throw new Error('Database path changed during the writer reservation');
      }
      trace.checks.push('gap_open');
      return record;
    });
    return {
      ok: true,
      decision: result.inserted ? 'applied' : 'already_closed',
      code: null,
      condition: null,
      operationId: result.record.operationId,
      disposition: result.record.disposition,
    };
  } catch (error) {
    if (!(error instanceof ContinuityGapClosureError)) throw error;
    return failure(error, operationId);
  } finally {
    raw.close();
  }
}

export function runCloseContinuityGapCli(
  argv: string[],
  io: CloseContinuityGapIo = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    clock: systemClock,
  },
): number {
  const args = parseCloseContinuityGapArgs(argv);
  const inputs: ClosureEvaluationInputs = {
    evidenceRoot: args.evidenceRoot,
    evidencePath: args.evidencePath,
    policyPath: args.policyPath,
    instanceId: args.instanceId,
    nowMs: io.clock.now(),
  };
  const trace: ClosureEvaluationTrace = { planId: null, checks: [] };
  const outcome = args.apply ? applyClosure(args, inputs, trace) : preview(args, inputs, trace);
  io.stdout(JSON.stringify({
    ok: outcome.ok,
    mode: args.apply ? 'apply' : 'preview',
    decision: outcome.decision,
    code: outcome.code,
    condition: outcome.condition,
    planId: trace.planId,
    operationId: outcome.operationId,
    disposition: outcome.disposition,
    checks: trace.checks,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
  }));
  return exitCode(outcome);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runCloseContinuityGapCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: 'CLOSURE_ERROR',
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
