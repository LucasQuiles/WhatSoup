import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  closeOperatorCatchupRecoveryRaw,
  inspectOperatorCatchupRecovery,
  type CloseOperatorCatchupRecoveryParams,
  type CloseOperatorCatchupRecoveryReceipt,
  type OperatorCatchupRecoveryInspection,
} from '../src/core/recovery-catchup-closure.ts';
import { SQLITE_BUSY_TIMEOUT_PRAGMA } from '../src/lib/sqlite-constants.ts';

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
): { inspection: OperatorCatchupRecoveryInspection; identity: FileIdentity; salt: Buffer } {
  const identity = assertExistingRegularDatabase(dbPath);
  const salt = loadOrCreateRedactionSalt(dbPath);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    assertSchema43Foundation(raw);
    const inspection = inspectOperatorCatchupRecovery(raw, params);
    assertSameDatabaseFile(identity, assertExistingRegularDatabase(dbPath));
    return { inspection, identity, salt };
  } finally {
    raw.close();
  }
}

const REDACTION_SALT_BYTES = 32;

/**
 * Load the per-database HMAC redaction salt from `${dbPath}.redaction-salt`,
 * creating it (32 random bytes, mode 0600) on first use and reusing it on
 * every later call. Only invoked after the target database is confirmed to
 * exist (see call sites), so a typo'd --db path never leaves an orphaned
 * salt file behind.
 *
 * Creation uses an exclusive-create write ('wx') so two concurrent
 * invocations against a brand-new database cannot each write a different
 * salt: the loser of the race reads back the winner's file instead of
 * silently using its own discarded bytes.
 *
 * NOTE for #2470/#2386 (sibling redaction surfaces): this file's mode-0600
 * sidecar-salt-file convention is the shared keyed-redaction primitive those
 * surfaces should adopt rather than re-forking their own — see FIX 1 of
 * issue #2457 for the rationale (offline enumeration of small/guessable
 * preimages defeats an unsalted hash).
 *
 * Exported so tests can read/verify the salt file's bytes, mode, and reuse
 * behavior directly, and so they can compute the exact expected fingerprint
 * for a given database without duplicating this file's I/O.
 */
export function loadOrCreateRedactionSalt(dbPath: string): Buffer {
  const saltPath = `${dbPath}.redaction-salt`;
  try {
    return readFileSync(saltPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const salt = randomBytes(REDACTION_SALT_BYTES);
  try {
    writeFileSync(saltPath, salt, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the creation race to a concurrent invocation — use its salt,
      // not the bytes we generated and failed to persist.
      return readFileSync(saltPath);
    }
    throw error;
  }
  // Belt-and-braces: enforce the exact bit pattern regardless of umask
  // (POSIX umask can only NARROW the requested mode, never widen it, so
  // this is a determinism guarantee for tests more than a security fix).
  chmodSync(saltPath, 0o600);
  return salt;
}

/**
 * Keyed (HMAC-SHA256), domain-separated fingerprint. Produces a
 * deterministic 12-character hex handle that lets operators correlate
 * outputs across dry-run and confirmation without exposing the raw private
 * identifier.
 *
 * The domain prefix prevents two different field types (e.g. a plan ID and a
 * conversation key that happen to share the same text) from producing the
 * same fingerprint.
 *
 * Property: keyed and non-correlatable WITHOUT the local per-database salt
 * file. This is NOT a claim of one-way/non-reversible in the abstract — a
 * bare domain-separated hash of a small or guessable preimage space (e.g.
 * catch-up sequences, which are small integers) is trivially recoverable by
 * offline enumeration once an attacker has the hash. HMAC-keying with a
 * random per-database salt defeats that: the attacker also needs the salt
 * file, which never leaves this host.
 *
 * Exported for canary tests that assert determinism, domain-separation, and
 * salt-separation.
 */
export function redactFingerprint(salt: Buffer, domain: string, value: string | number): string {
  return createHmac('sha256', salt)
    .update(`${domain}:`)
    .update(String(value))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Redacted dry-run inspection shape. Exposes only readiness, bounded counts,
 * proof basis, idempotency, open-before/open-after, and keyed correlation
 * fingerprints (non-correlatable without the local per-database salt file —
 * see redactFingerprint). Never emits raw plan IDs, conversation keys,
 * source/catch-up sequences, terminal IDs, operation IDs, job IDs, or
 * completion-proof IDs.
 *
 * Issue #2457 § "Required behavior": replace raw identifiers in stdout with
 * deterministic, domain-separated fingerprints or omit them when a count/state
 * is sufficient.
 */
function publicInspection(salt: Buffer, inspection: OperatorCatchupRecoveryInspection): Record<string, unknown> {
  return {
    planFingerprint: redactFingerprint(salt, 'plan', inspection.planId),
    conversationFingerprint: redactFingerprint(salt, 'conversation', inspection.conversationKey),
    nSourceSeqs: inspection.sourceSeqs.length,
    catchupSeqFingerprint: redactFingerprint(salt, 'catchup-seq', inspection.catchupSeq),
    evidenceBasis: inspection.evidenceBasis,
    wouldInsert: inspection.wouldInsert,
    idempotent: inspection.idempotent,
    openBefore: inspection.openBefore,
    openAfter: inspection.openAfter,
  };
}

/**
 * Redacted confirmed-receipt shape. Exposes only mutation counts, idempotency,
 * proof basis, bounded state, and the same safe correlation fingerprints as
 * the dry-run inspection. Never emits raw identifiers, actor, or evidence
 * reference.
 *
 * Issue #2457 § "Required behavior": confirmed output should expose only
 * mutation counts, idempotency, proof basis, bounded state, and the same
 * safe correlations.
 */
function publicReceipt(salt: Buffer, receipt: CloseOperatorCatchupRecoveryReceipt): Record<string, unknown> {
  return {
    planFingerprint: redactFingerprint(salt, 'plan', receipt.planId),
    conversationFingerprint: redactFingerprint(salt, 'conversation', receipt.conversationKey),
    nSourceSeqs: receipt.sourceSeqs.length,
    catchupSeqFingerprint: redactFingerprint(salt, 'catchup-seq', receipt.catchupSeq),
    evidenceBasis: receipt.evidenceBasis,
    inserted: receipt.inserted,
    idempotent: receipt.idempotent,
    openBefore: receipt.openBefore,
    openAfter: receipt.openAfter,
  };
}

export function runCloseRecoveryCatchupCli(argv: string[]): number {
  const args = parseCloseRecoveryArgs(argv);
  const params = closureParams(args);
  const { inspection, identity, salt } = inspectReadOnly(args.dbPath, params);
  if (!args.confirm) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      ready: true,
      ...publicInspection(salt, inspection),
    })}\n`);
    return 0;
  }

  // Recheck the path after the read-only preflight, then revalidate schema and
  // proof on the same connection and transaction that performs the closure.
  assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
  const raw = openExistingWritableDatabase(args.dbPath, identity);
  try {
    raw.exec(SQLITE_BUSY_TIMEOUT_PRAGMA);
    raw.exec('PRAGMA foreign_keys = ON');
    const receipt = closeOperatorCatchupRecoveryRaw(raw, params, (transactionRaw) => {
      assertSameDatabaseFile(identity, assertExistingRegularDatabase(args.dbPath));
      assertSchema43Foundation(transactionRaw);
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: false,
      receipt: publicReceipt(salt, receipt),
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
    // Issue #2457: error messages must remain class-level and must not
    // interpolate private arguments. Emit a bounded error class with a
    // correlation handle; the raw exception text stays in the operator's
    // terminal scrollback (which is their own trust boundary) and never
    // enters a machine-parseable JSON receipt.
    const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
    process.stderr.write(`${JSON.stringify({
      ok: false,
      errorClass,
      correlation: redactFingerprint(randomBytes(REDACTION_SALT_BYTES), 'error', `${Date.now()}:${Math.random()}`),
    })}\n`);
    process.exitCode = 1;
  }
}
