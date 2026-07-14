import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from '../src/core/database.ts';
import { closeOperatorCatchupRecovery } from '../src/core/recovery-catchup-closure.ts';

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

function usage(): string {
  return [
    'Usage: close-recovery-catchup --db PATH --plan-id ID --conversation-key KEY',
    '  --source-seqs 1,2,3 --catchup-seq N --actor ID --evidence-ref REF [--confirm]',
    '',
    'Without --confirm this command is a non-mutating dry run.',
  ].join('\n');
}

function valueAfter(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${flag} is required`);
  return value;
}

export function parseCloseRecoveryArgs(argv: string[]): CliArgs {
  if (argv.includes('--help')) throw new Error(usage());
  const sourceSeqs = valueAfter(argv, '--source-seqs')
    .split(',')
    .map((value) => Number(value.trim()));
  return {
    dbPath: resolve(valueAfter(argv, '--db')),
    planId: valueAfter(argv, '--plan-id'),
    conversationKey: valueAfter(argv, '--conversation-key'),
    sourceSeqs,
    catchupSeq: Number(valueAfter(argv, '--catchup-seq')),
    actor: valueAfter(argv, '--actor'),
    evidenceRef: valueAfter(argv, '--evidence-ref'),
    confirm: argv.includes('--confirm'),
  };
}

export function runCloseRecoveryCatchupCli(argv: string[]): number {
  const args = parseCloseRecoveryArgs(argv);
  if (!args.confirm) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      dryRun: true,
      dbPath: args.dbPath,
      planId: args.planId,
      conversationKey: args.conversationKey,
      sourceSeqs: args.sourceSeqs,
      catchupSeq: args.catchupSeq,
    })}\n`);
    return 2;
  }

  const db = new Database(args.dbPath);
  try {
    db.open();
    const receipt = closeOperatorCatchupRecovery(db, {
      planId: args.planId,
      conversationKey: args.conversationKey,
      expectedSourceSeqs: args.sourceSeqs,
      catchupSeq: args.catchupSeq,
      actor: args.actor,
      evidenceRef: args.evidenceRef,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
    return 0;
  } finally {
    db.close();
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
