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

function runCloseRecoveryCatchupWithArgs(args: CliArgs): number {
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

export function runCloseRecoveryCatchupCli(argv: string[]): number {
  return runCloseRecoveryCatchupWithArgs(parseCloseRecoveryArgs(argv));
}

// ---------------------------------------------------------------------------
// Bounded error taxonomy for the top-level CLI error path.
// ---------------------------------------------------------------------------

/**
 * Bounded, machine-classifiable failure codes for the CLI's top-level catch
 * handler. `error.constructor.name` is USELESS here — every one of this
 * file's 13 throw sites (plus every throw in recovery-catchup-closure.ts and
 * node:sqlite's own errors) is a bare `Error`/thrown-literal, so
 * `constructor.name` is always the string "Error". Classification is by
 * message-text matcher, with node:sqlite's own `.errcode` (the underlying
 * SQLite result code) checked FIRST where available — it is a precise,
 * platform-stable signal that message text is not (e.g. "unable to open
 * database file" vs. a "no longer exists" variant on some platforms).
 *
 * `invalid_args` is NOT one of the six values issue #2457 originally named
 * (invalid_proof, changed_evidence, busy_writer, changed_file, io, unknown) —
 * it was added because roughly half of this file's own throw sites (and
 * several in recovery-catchup-closure.ts) are pure CLI-argument/shape
 * validation (missing/duplicate flags, non-positive sequences, oversized
 * text) that do not fit any of those six domain buckets. Folding all of
 * those into `unknown` would make `unknown` the dominant bucket for the most
 * common real-world failure (an operator typo) — exactly what a bounded
 * taxonomy exists to prevent. The raw message (see below) still reaches the
 * operator's terminal regardless of which bucket a given error lands in, so
 * no debuggability is lost by this addition.
 */
export type CloseRecoveryErrorCode =
  | 'invalid_args'
  | 'invalid_proof'
  | 'changed_evidence'
  | 'busy_writer'
  | 'changed_file'
  | 'io'
  | 'unknown';

interface SqliteLikeError {
  readonly code?: unknown;
  readonly errcode?: unknown;
}

// node:sqlite surfaces the underlying SQLite result code as a numeric
// `.errcode` alongside the generic Node wrapper `.code === 'ERR_SQLITE_ERROR'`.
// SQLITE_BUSY (5) and SQLITE_LOCKED (6) both mean "another connection holds a
// conflicting lock"; SQLITE_CANTOPEN (14) means the file could not be opened.
const SQLITE_BUSY_ERRCODES = new Set([5, 6]);
const SQLITE_CANTOPEN_ERRCODE = 14;

const ERROR_CLASSIFIERS: ReadonlyArray<{
  readonly code: CloseRecoveryErrorCode;
  readonly test: (message: string) => boolean;
}> = [
  {
    code: 'changed_file',
    test: (m) => m === 'Database path changed after read-only preflight',
  },
  {
    code: 'changed_evidence',
    test: (m) => m === 'Recovery was already closed against a different catch-up or evidence',
  },
  {
    code: 'busy_writer',
    test: (m) => /database is locked|database table is locked/i.test(m),
  },
  {
    code: 'io',
    test: (m) => m.startsWith('Database path must be an existing regular file:')
      || m === 'unable to open database file'
      || /no longer exists/i.test(m),
  },
  {
    code: 'invalid_proof',
    test: (m) => m.startsWith('Database must include canonical schema 43 receipts')
      || m.startsWith('Database must include contiguous schema 43+ receipts')
      || m === 'canonical schema 43 receipt is missing'
      || m.startsWith('canonical schema 43 objects are missing or drifted')
      || m === 'Recovery plan does not exist'
      || m === 'Expected source sequences must exactly match the pending recovery set'
      || m === 'Catch-up sequence must be later than every source sequence'
      || m === 'Closed recovery lacks its exact durable proof witness'
      || m === 'Catch-up inbound does not exist in the recovery conversation'
      || m === 'Catch-up inbound must be complete'
      || m === 'Catch-up reply must have echoed delivery proof'
      || m === 'Catch-up closure did not resolve the exact recovery set'
      || m === 'Catch-up closure did not persist its exact proof witness',
  },
  {
    code: 'invalid_args',
    test: (m) => m.endsWith('is required')
      || m.endsWith('must be a positive safe integer')
      || /exceeds \d+ bytes$/.test(m)
      || m.startsWith('Unknown argument:')
      || m.startsWith('Duplicate argument:')
      || m === 'Source sequence set contains duplicates'
      || m === 'Expected source sequence set is required'
      || m === 'Expected source sequence set contains duplicates'
      || m.startsWith('Usage: close-recovery-catchup'), // --help
  },
];

/**
 * Classify a caught error into a bounded code. Exported for direct unit
 * coverage of the matcher table without spawning a subprocess.
 */
export function classifyError(error: unknown): CloseRecoveryErrorCode {
  const sqliteError = error as SqliteLikeError;
  if (sqliteError?.code === 'ERR_SQLITE_ERROR') {
    const errcode = sqliteError.errcode;
    if (typeof errcode === 'number' && SQLITE_BUSY_ERRCODES.has(errcode)) return 'busy_writer';
    if (errcode === SQLITE_CANTOPEN_ERRCODE) return 'io';
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const classifier of ERROR_CLASSIFIERS) {
    if (classifier.test(message)) return classifier.code;
  }
  return 'unknown';
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  let args: CliArgs | undefined;
  try {
    args = parseCloseRecoveryArgs(process.argv.slice(2));
    process.exitCode = runCloseRecoveryCatchupWithArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Issue #2457 FIX 3(c): the message is printed as its OWN line, clearly
    // separate from the JSON envelope below (never interpolated INTO JSON) —
    // this is the operator-debuggability line. The prior comment claiming
    // raw text "stays in scrollback" was false: nothing was ever printed
    // anywhere, so the operator saw nothing but a bounded error class.
    process.stderr.write(`${message}\n`);

    const errorCode = classifyError(error);
    // Correlate against the plan/conversation fingerprints an operator would
    // have already seen in a prior dry-run/receipt — far more useful than a
    // Date.now()+Math.random() value nobody could ever look up again. Only
    // available when args parsed far enough to know the target database and
    // plan; loading the salt can itself fail (e.g. dbPath doesn't exist), so
    // this is best-effort and MUST NOT throw out of the handler.
    let correlation: { planFingerprint: string; conversationFingerprint: string } | undefined;
    if (args !== undefined) {
      try {
        const salt = loadOrCreateRedactionSalt(args.dbPath);
        correlation = {
          planFingerprint: redactFingerprint(salt, 'plan', args.planId),
          conversationFingerprint: redactFingerprint(salt, 'conversation', args.conversationKey),
        };
      } catch {
        correlation = undefined;
      }
    }
    process.stderr.write(`${JSON.stringify({
      ok: false,
      errorCode,
      ...(correlation !== undefined ? { correlation } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}
