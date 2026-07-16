import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BOUNDARY_RUN_SCHEMA,
  RUN_ATTEMPT_CONTRACTS,
  RUN_CHILD_CONTRACTS,
  RUN_CONTRACT_PROFILES,
  RUN_PREDECESSOR_CONTRACTS,
  RUN_SOURCE_REVIEW_CONTRACTS,
  RUN_TEST_CONTRACTS,
  RUN_VITEST_PREDICATES,
  RUN_WIRE_SCHEMAS,
  admitBoundaryOutput,
  aggregateBoundaryReviewFindingVerdict,
  boundaryTestFilesForProfile,
  canonicalizeBoundaryRun,
  captureBoundaryWorktreeSnapshot,
  createBoundaryRunInitAnchor,
  createBoundaryDerivedRoot,
  parseBoundaryChildPins,
  parseBoundaryJsonBytes,
  reserveBoundaryDerivedRoot,
  resolveBoundaryToolCapability,
  runBoundaryAttemptProcess,
  validateBoundaryAttemptStatus,
  validateBoundaryChildImport,
  validateAndAppendBoundaryPredecessor,
  validateBoundaryOutputClosure,
  validateBoundaryReviewInput,
  validateBoundaryRun,
  validateBoundaryRunJson,
  validateBoundaryStdoutPredicate,
  validateBoundaryStructuredRecord,
  validateBoundaryVitestJsonReport,
  type BoundaryDocumentHashRecord,
  type BoundaryChildRecord,
  type BoundaryImportedFileRecord,
  type BoundaryOutputAdmission,
  type BoundaryPredecessorPin,
  type BoundaryPredecessorRecord,
  type BoundaryReviewInputRecord,
  type BoundaryReviewRecord,
  type BoundaryReservedDerivedRootRecord,
  type BoundaryRunManifest,
  type BoundaryValidationIssue,
  type BoundaryValidationResult,
} from './lib/verification/boundary-run-manifest.ts';
import { cleanGitEnv } from '../src/lib/git-env.ts';

export const BOUNDARY_RUN_COMMANDS = [
  'init',
  'record-command',
  'record-internal-check',
  'record-git-transition',
  'record-artifact',
  'record-child-run',
  'record-review',
  'set-upstream',
  'set-lifecycle',
  'finalize',
  'verify',
  'closeout',
  'verify-closeout',
] as const;

export type BoundaryRunCommand = (typeof BOUNDARY_RUN_COMMANDS)[number];
type BoundaryInvocationValue = string | string[] | true;

export interface BoundaryRunInvocation {
  command: BoundaryRunCommand;
  options: Record<string, BoundaryInvocationValue>;
  commandArgv?: string[];
}

interface CommandOptionSchema {
  flags: Readonly<Record<string, string>>;
  required: readonly string[];
  repeatable?: readonly string[];
  boolean?: readonly string[];
}

const COMMAND_OPTION_SCHEMAS: Readonly<Record<BoundaryRunCommand, CommandOptionSchema>> = {
  init: {
    flags: {
      '--run-dir': 'runDir', '--task': 'task', '--profile': 'profile',
      '--predecessor-run-dir': 'predecessorRunDir', '--predecessor-pin': 'predecessorPin',
      '--child-pin': 'childPin', '--allow-path': 'allowPath', '--allow-untracked': 'allowUntracked',
      '--preserve-owner-path': 'preserveOwnerPath',
    },
    required: ['runDir', 'task', 'profile'],
    repeatable: ['childPin', 'allowPath', 'allowUntracked', 'preserveOwnerPath'],
  },
  'record-command': {
    flags: {
      '--run-dir': 'runDir', '--attempt': 'attempt', '--expect-exit': 'expectExit',
      '--timeout-owner': 'timeoutOwner', '--output-path': 'outputPath',
    },
    required: ['runDir', 'attempt'],
    repeatable: ['outputPath'],
  },
  'record-internal-check': {
    flags: { '--run-dir': 'runDir', '--attempt': 'attempt' },
    required: ['runDir', 'attempt'],
  },
  'record-git-transition': {
    flags: {
      '--run-dir': 'runDir', '--attempt': 'attempt', '--kind': 'kind',
      '--expect-before': 'expectBefore', '--expect-second-parent': 'expectSecondParent',
      '--message-subject': 'messageSubject',
    },
    required: ['runDir', 'attempt', 'kind', 'expectBefore'],
  },
  'record-artifact': {
    flags: {
      '--run-dir': 'runDir', '--producer-attempt': 'producerAttempt', '--path': 'artifactPath', '--role': 'role',
    },
    required: ['runDir', 'producerAttempt', 'artifactPath', 'role'],
  },
  'record-child-run': {
    flags: {
      '--run-dir': 'runDir', '--alias': 'alias', '--kind': 'kind', '--child-run-dir': 'childRunDir',
      '--expect-task': 'expectTask', '--expect-head': 'expectHead', '--expect-run-id': 'expectRunId',
      '--expect-manifest-sha256': 'expectManifestSha256',
    },
    required: [
      'runDir', 'alias', 'kind', 'childRunDir', 'expectTask', 'expectHead', 'expectRunId',
      'expectManifestSha256',
    ],
  },
  'record-review': {
    flags: { '--run-dir': 'runDir', '--alias': 'alias', '--review-path': 'reviewPath' },
    required: ['runDir', 'alias', 'reviewPath'],
  },
  'set-upstream': {
    flags: { '--run-dir': 'runDir' },
    required: ['runDir'],
  },
  'set-lifecycle': {
    flags: {
      '--run-dir': 'runDir', '--status': 'status', '--final-gate': 'finalGate',
      '--artifact-sha256': 'artifactSha256', '--successor': 'successor',
      '--superseded-by': 'supersededBy', '--oracle': 'oracle',
    },
    required: ['runDir', 'status', 'finalGate', 'oracle'],
  },
  finalize: {
    flags: { '--run-dir': 'runDir' },
    required: ['runDir'],
  },
  verify: {
    flags: {
      '--run-dir': 'runDir', '--expect-current-snapshot': 'expectCurrentSnapshot',
      '--expect-staged-allowlist': 'expectStagedAllowlist',
    },
    required: ['runDir'],
    boolean: ['expectCurrentSnapshot', 'expectStagedAllowlist'],
  },
  closeout: {
    flags: { '--run-dir': 'runDir', '--attempt-id': 'attemptId' },
    required: ['runDir', 'attemptId'],
  },
  'verify-closeout': {
    flags: { '--run-dir': 'runDir', '--failure-receipt-dir': 'failureReceiptDir' },
    required: [],
  },
};

function invocationInvalid(message: string): never {
  throw new Error(`semantic.invocation-invalid: ${message}`);
}

function isOperationalId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function isSafeRelativePath(value: string): boolean {
  return value !== ''
    && Buffer.byteLength(value, 'utf8') <= 1_024
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseOptions(
  argv: readonly string[],
  schema: CommandOptionSchema,
): Record<string, BoundaryInvocationValue> {
  const options: Record<string, BoundaryInvocationValue> = {};
  const repeatable = new Set(schema.repeatable ?? []);
  const booleans = new Set(schema.boolean ?? []);
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === undefined || !(flag in schema.flags)) invocationInvalid(`unknown option ${flag ?? '<missing>'}`);
    const name = schema.flags[flag]!;
    if (booleans.has(name)) {
      if (name in options) invocationInvalid(`duplicate singleton option ${flag}`);
      options[name] = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) invocationInvalid(`${flag} requires one value`);
    if (repeatable.has(name)) {
      const values = (options[name] ?? []) as string[];
      if (values.includes(value)) invocationInvalid(`duplicate repeatable option value ${flag} ${value}`);
      options[name] = [...values, value];
    } else {
      if (name in options) invocationInvalid(`duplicate singleton option ${flag}`);
      options[name] = value;
    }
    index += 2;
  }
  for (const name of schema.required) {
    if (!(name in options)) invocationInvalid(`${name} is required`);
  }
  return options;
}

function stringOption(options: Record<string, BoundaryInvocationValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

function stringListOption(options: Record<string, BoundaryInvocationValue>, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? value : [];
}

function validateInvocationOptions(invocation: BoundaryRunInvocation): void {
  const { command, options } = invocation;
  for (const name of ['runDir', 'predecessorRunDir', 'childRunDir', 'failureReceiptDir']) {
    const value = stringOption(options, name);
    if (value !== undefined && (!path.isAbsolute(value) || path.normalize(value) !== value)) {
      invocationInvalid(`--${name} must be an absolute canonical path`);
    }
  }
  for (const name of ['attempt', 'attemptId', 'producerAttempt', 'alias', 'expectRunId']) {
    const value = stringOption(options, name);
    if (value !== undefined && !isOperationalId(value)) invocationInvalid(`${name} must be a canonical operational ID`);
  }
  for (const name of ['allowPath', 'allowUntracked', 'preserveOwnerPath', 'outputPath']) {
    for (const value of stringListOption(options, name)) {
      if (!isSafeRelativePath(value)) invocationInvalid(`${name} must contain normalized relative paths`);
    }
  }
  for (const name of ['artifactPath', 'reviewPath']) {
    const value = stringOption(options, name);
    if (value !== undefined && !isSafeRelativePath(value)) invocationInvalid(`${name} must be a normalized relative path`);
  }
  const expectedExit = stringOption(options, 'expectExit');
  if (expectedExit !== undefined && expectedExit !== 'nonzero') {
    const values = expectedExit.split(',');
    if (
      values.length === 0
      || new Set(values).size !== values.length
      || values.some((value) => !/^\d{1,3}$/.test(value) || Number(value) > 255)
    ) invocationInvalid('--expect-exit must be nonzero or unique decimal statuses in 0..255');
  }
  if (command === 'init') {
    if (('predecessorRunDir' in options) !== ('predecessorPin' in options)) {
      invocationInvalid('predecessor options are an all-or-none pair');
    }
  }
  if (command === 'record-git-transition') {
    const kind = stringOption(options, 'kind');
    if (kind !== 'commit' && kind !== 'merge') invocationInvalid('--kind must be commit or merge');
    if (kind === 'commit' && (!stringOption(options, 'messageSubject') || 'expectSecondParent' in options)) {
      invocationInvalid('commit transition requires only --message-subject');
    }
    if (kind === 'merge' && (!stringOption(options, 'expectSecondParent') || 'messageSubject' in options)) {
      invocationInvalid('merge transition requires only --expect-second-parent');
    }
  }
  if (command === 'verify-closeout') {
    if (('runDir' in options) === ('failureReceiptDir' in options)) {
      invocationInvalid('verify-closeout requires exactly one receipt mode');
    }
  }
}

export function parseBoundaryRunInvocation(argv: readonly string[]): BoundaryRunInvocation {
  const command = argv[0];
  if (!BOUNDARY_RUN_COMMANDS.includes(command as BoundaryRunCommand)) {
    invocationInvalid(`unknown command ${command ?? '<missing>'}`);
  }
  const typedCommand = command as BoundaryRunCommand;
  const separator = argv.indexOf('--', 1);
  if (typedCommand === 'record-command' && separator < 0) {
    invocationInvalid('record-command requires -- followed by one direct command');
  }
  if (typedCommand !== 'record-command' && separator >= 0) {
    invocationInvalid(`${typedCommand} does not accept a command separator`);
  }
  const optionArgv = typedCommand === 'record-command' ? argv.slice(1, separator) : argv.slice(1);
  const commandArgv = typedCommand === 'record-command' ? argv.slice(separator + 1) : undefined;
  if (commandArgv !== undefined && commandArgv.length === 0) invocationInvalid('direct command argv cannot be empty');
  const invocation: BoundaryRunInvocation = {
    command: typedCommand,
    options: parseOptions(optionArgv, COMMAND_OPTION_SCHEMAS[typedCommand]),
    ...(commandArgv === undefined ? {} : { commandArgv: [...commandArgv] }),
  };
  validateInvocationOptions(invocation);
  return invocation;
}

function operationResult(
  issues: BoundaryValidationIssue[],
  exitCode: 0 | 1 | 2 = issues.length === 0 ? 0 : 1,
  verdict: BoundaryValidationResult['verdict'] = issues.length === 0 ? 'Pass' : 'Inconclusive',
): BoundaryValidationResult {
  return { ok: issues.length === 0, exitCode, verdict, issues };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitText(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function documentHash(cwd: string, relativePath: string): BoundaryDocumentHashRecord {
  const bytes = readFileSync(path.join(cwd, relativePath));
  return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function canonicalSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function discoverEntryTestRoster(
  cwd: string,
  profileId: string,
  observedTools: BoundaryRunManifest['run']['observedTools'],
): BoundaryRunManifest['entryTestRoster'] {
  const testPaths = boundaryTestFilesForProfile(profileId);
  const files = testPaths.map((testPath) => {
    const absolute = path.join(cwd, testPath);
    return { path: testPath, state: existsSync(absolute) ? 'present' as const : 'absent' as const, testNames: [] as string[] };
  });
  const present = files.filter((entry) => entry.state === 'present');
  if (present.length > 0) {
    const bash = observedTools.find((entry) => entry.name === 'bash');
    const timeout = observedTools.find((entry) => entry.name === 'gnu-timeout');
    if (bash === undefined || timeout === undefined) throw new Error('test roster collection lacks frozen bash/gnu-timeout capabilities');
    const stdout = execFileSync(timeout.realPath, [
      '--kill-after=30s', '15m', bash.realPath, 'scripts/run-with-pinned-npm.sh',
      'exec', '--', 'vitest', 'list', ...present.map((entry) => entry.path), '--json',
      '--pool=forks', '--fileParallelism=false',
    ], {
      cwd,
      encoding: 'utf8',
      env: reconstructedChildEnvironment(cwd),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => !isPlainRecord(entry)
      || typeof entry['name'] !== 'string' || typeof entry['file'] !== 'string')) {
      throw new Error('Vitest list returned a malformed roster');
    }
    for (const row of parsed as Array<Record<string, unknown>>) {
      const relativeFile = path.relative(cwd, String(row['file']));
      const target = files.find((entry) => entry.path === relativeFile);
      if (target === undefined || target.state !== 'present') throw new Error(`Vitest listed a foreign test file: ${relativeFile}`);
      target.testNames.push(String(row['name']).replace(/ > /g, ' '));
    }
    for (const entry of present) {
      entry.testNames = canonicalSet(entry.testNames);
      if (entry.testNames.length === 0) throw new Error(`Vitest listed zero tests for ${entry.path}`);
    }
  }
  return { files, digestSha256: sha256(canonicalizeBoundaryRun(files)) };
}

function durableExclusiveWrite(filePath: string, bytes: Uint8Array | string): void {
  const descriptor = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function durableAtomicRewrite(filePath: string, bytes: string): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  durableExclusiveWrite(temporary, bytes);
  renameSync(temporary, filePath);
  const parent = openSync(path.dirname(filePath), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

function verifyRunInitAnchor(manifest: BoundaryRunManifest, runDir: string): BoundaryValidationResult {
  try {
    const anchorPath = path.join(runDir, 'run_init.json');
    const lockPath = path.join(runDir, 'run_init.sha256');
    const anchorBytes = readFileSync(anchorPath);
    const parsed = parseBoundaryJsonBytes(anchorBytes);
    if (!parsed.result.ok || parsed.text === null) {
      return operationResult([
        { code: 'init-anchor-mismatch', message: 'init anchor is not strict canonical JSON' },
        ...parsed.result.issues,
      ]);
    }
    const expectedBytes = canonicalizeBoundaryRun(createBoundaryRunInitAnchor(manifest));
    const expectedLock = shaLockBytes(sha256(anchorBytes), 'run_init.json');
    if (
      parsed.text !== canonicalizeBoundaryRun(parsed.value)
      || anchorBytes.toString('utf8') !== expectedBytes
      || readFileSync(lockPath, 'utf8') !== expectedLock
    ) {
      return operationResult([{ code: 'init-anchor-mismatch', message: 'manifest init projection differs from its immutable anchor' }]);
    }
    return operationResult([]);
  } catch (error) {
    return operationResult([{ code: 'init-anchor-mismatch', message: (error as Error).message }]);
  }
}

class BoundaryRunLoadError extends Error {
  readonly issues: BoundaryValidationIssue[];

  constructor(issues: BoundaryValidationIssue[]) {
    super(issues.map((entry) => entry.code).join(', '));
    this.issues = issues;
  }
}

function runLoadFailure(error: unknown): BoundaryValidationResult {
  return error instanceof BoundaryRunLoadError
    ? operationResult(error.issues)
    : operationResult([{ code: 'run-load-failed', message: (error as Error).message }]);
}

interface PreparedBoundaryPredecessor {
  record: BoundaryPredecessorRecord;
  files: Array<{ path: string; bytes: Buffer }>;
  sourceManifest: BoundaryRunManifest;
  receipt: Record<string, unknown>;
  ledger: Record<string, unknown>;
}

function parsePredecessorPin(value: string | undefined): {
  result: BoundaryValidationResult;
  pin: BoundaryPredecessorPin | null;
} {
  const fields = value?.split(',') ?? [];
  if (fields.length !== 7) {
    return {
      result: operationResult([{ code: 'predecessor-pin-invalid', message: 'predecessor pin must contain exactly seven fields' }], 2),
      pin: null,
    };
  }
  const [taskId, profileId, runId, terminalHead, manifestSha256, completionReceiptSha256, ledgerSha256] = fields;
  if (
    taskId === undefined
    || profileId === undefined
    || runId === undefined
    || terminalHead === undefined
    || manifestSha256 === undefined
    || completionReceiptSha256 === undefined
    || ledgerSha256 === undefined
    || !isOperationalId(profileId)
    || !isOperationalId(runId)
    || !/^[0-9a-f]{40}$/.test(terminalHead)
    || ![manifestSha256, completionReceiptSha256, ledgerSha256].every((entry) => /^[0-9a-f]{64}$/.test(entry))
  ) {
    return {
      result: operationResult([{ code: 'predecessor-pin-invalid', message: 'predecessor pin violates the closed identity grammar' }], 2),
      pin: null,
    };
  }
  return {
    result: operationResult([]),
    pin: { taskId, profileId, runId, terminalHead, manifestSha256, completionReceiptSha256, ledgerSha256 },
  };
}

function strictCanonicalObject(bytes: Buffer, label: string): Record<string, unknown> {
  const parsed = parseBoundaryJsonBytes(bytes);
  if (
    !parsed.result.ok
    || parsed.text === null
    || parsed.value === null
    || typeof parsed.value !== 'object'
    || Array.isArray(parsed.value)
    || parsed.text !== canonicalizeBoundaryRun(parsed.value)
  ) {
    throw new Error(`${label} is not strict canonical JSON`);
  }
  return parsed.value as Record<string, unknown>;
}

function prepareBoundaryPredecessor(
  profileId: string,
  entryHead: string,
  successorRunId: string,
  sourceRunDir: string,
  pinValue: string | undefined,
  cwd: string,
): { result: BoundaryValidationResult; prepared: PreparedBoundaryPredecessor | null } {
  const relation = RUN_PREDECESSOR_CONTRACTS[profileId as keyof typeof RUN_PREDECESSOR_CONTRACTS];
  const parsedPin = parsePredecessorPin(pinValue);
  if (!parsedPin.result.ok || parsedPin.pin === null) return { result: parsedPin.result, prepared: null };
  const pin = parsedPin.pin;
  if (
    relation === undefined
    || pin.taskId !== relation.predecessorTaskId
    || pin.profileId !== relation.predecessorProfileId
  ) {
    return {
      result: operationResult([{ code: 'predecessor-profile-mismatch', message: 'predecessor pin differs from the generated relation' }], 2),
      prepared: null,
    };
  }
  try {
    const sourceRoot = realpathSync(sourceRunDir);
    const manifestBytes = readConfinedRegularFile(sourceRoot, 'run_manifest.json');
    if (sha256(manifestBytes) !== pin.manifestSha256) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'source manifest differs from the declared predecessor pin' }], 2),
        prepared: null,
      };
    }
    const sourceVerification = verifyRun({ command: 'verify', options: { runDir: sourceRoot } }, cwd);
    if (!sourceVerification.ok || sourceVerification.verdict !== 'Pass') {
      return {
        result: operationResult([
          { code: 'predecessor-source-verification-failed', message: 'predecessor source did not pass read-only verification' },
          ...sourceVerification.issues,
        ]),
        prepared: null,
      };
    }
    const sourceManifest = JSON.parse(manifestBytes.toString('utf8')) as BoundaryRunManifest;
    const completionRecord = sourceManifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    const expectedCompletionRoot = path.join(path.dirname(path.dirname(sourceRoot)), 'completion', pin.runId);
    if (
      sourceManifest.manifestState !== 'finalized'
      || sourceManifest.overallVerdict !== 'Pass'
      || sourceManifest.run.taskId !== pin.taskId
      || sourceManifest.run.profileId !== pin.profileId
      || sourceManifest.run.runId !== pin.runId
      || sourceManifest.run.terminalHead !== pin.terminalHead
      || completionRecord === undefined
      || completionRecord.path !== expectedCompletionRoot
    ) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'verified predecessor identity differs from the declared pin' }], 2),
        prepared: null,
      };
    }
    const completionRoot = realpathSync(expectedCompletionRoot);
    const receiptBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.json');
    const receiptLockBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.sha256');
    const ledgerBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.json');
    const ledgerLockBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.sha256');
    if (
      sha256(receiptBytes) !== pin.completionReceiptSha256
      || sha256(ledgerBytes) !== pin.ledgerSha256
      || receiptLockBytes.toString('utf8') !== shaLockBytes(pin.completionReceiptSha256, 'completion_receipt.json')
      || ledgerLockBytes.toString('utf8') !== shaLockBytes(pin.ledgerSha256, 'chain_ledger.json')
    ) {
      return {
        result: operationResult([{ code: 'predecessor-pin-mismatch', message: 'completion receipt or ledger differs from the declared pin' }], 2),
        prepared: null,
      };
    }
    const receipt = strictCanonicalObject(receiptBytes, 'completion receipt');
    const ledger = strictCanonicalObject(ledgerBytes, 'chain ledger');
    const inherited = {
      reconciledBase: receipt['reconciledBase'],
      upstreamObservedOid: receipt['upstreamObservedOid'],
      corpusDigests: receipt['corpusDigests'],
      oracleDigest: receipt['oracleDigest'],
    };
    const rows = Array.isArray(ledger['rows']) ? ledger['rows'] : [];
    if (pin.profileId === 'bcf00-observation') {
      if (
        profileId !== 'bcf00-reconciliation'
        || sourceManifest.run.chainAppend !== false
        || rows.length !== 0
        || receipt['ledgerSha256'] !== pin.ledgerSha256
        || receipt['manifestSha256'] !== pin.manifestSha256
        || receipt['overallVerdict'] !== 'Pass'
        || canonicalizeBoundaryRun(inherited) !== canonicalizeBoundaryRun({
          reconciledBase: ledger['reconciledBase'],
          upstreamObservedOid: ledger['upstreamObservedOid'],
          corpusDigests: ledger['corpusDigests'],
          oracleDigest: ledger['oracleDigest'],
        })
        || entryHead !== pin.terminalHead
      ) {
        return {
          result: operationResult([{ code: 'predecessor-observation-mismatch', message: 'observation predecessor is not the canonical empty-ledger Pass' }]),
          prepared: null,
        };
      }
    } else {
      const validation = validateAndAppendBoundaryPredecessor({
        profileId,
        pin,
        receipt,
        receiptSha256: pin.completionReceiptSha256,
        ledger,
        ledgerSha256: pin.ledgerSha256,
        inherited,
        currentRow: {
          ordinal: rows.length + 1,
          taskId: relation.taskId,
          profileId,
          runId: successorRunId,
          entryHead,
          terminalHead: entryHead,
          manifestSha256: '0'.repeat(64),
          previousLedgerSha256: pin.ledgerSha256,
          overallVerdict: 'Pass',
        },
      });
      if (!validation.result.ok) return { result: validation.result, prepared: null };
    }

    const files = childClosurePaths(sourceManifest).map((relativePath) => ({
      path: relativePath,
      bytes: readConfinedRegularFile(sourceRoot, relativePath),
    }));
    files.push(
      { path: 'completion/chain_ledger.json', bytes: ledgerBytes },
      { path: 'completion/chain_ledger.sha256', bytes: ledgerLockBytes },
      { path: 'completion/completion_receipt.json', bytes: receiptBytes },
      { path: 'completion/completion_receipt.sha256', bytes: receiptLockBytes },
    );
    files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
    if (new Set(files.map((entry) => entry.path)).size !== files.length) throw new Error('predecessor closure paths collide');
    const importedFiles = files.map((entry) => ({
      path: entry.path,
      sha256: sha256(entry.bytes),
      bytes: entry.bytes.byteLength,
    }));
    const record: BoundaryPredecessorRecord = {
      pin,
      sourceManifestSha256: pin.manifestSha256,
      importedFiles,
      treeDigestSha256: sha256(canonicalizeBoundaryRun(importedFiles)),
      overallVerdict: 'Pass',
    };
    return { result: operationResult([]), prepared: { record, files, sourceManifest, receipt, ledger } };
  } catch (error) {
    return {
      result: operationResult([{ code: 'predecessor-source-verification-failed', message: (error as Error).message }]),
      prepared: null,
    };
  }
}

function initializeRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const options = invocation.options;
  const runDir = stringOption(options, 'runDir')!;
  const taskId = stringOption(options, 'task')!;
  const profileId = stringOption(options, 'profile')!;
  const profile = RUN_CONTRACT_PROFILES[profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || profile.taskId !== taskId) {
    return operationResult([{ code: 'profile-contract-mismatch', message: 'task/profile pair is not authorized' }], 2);
  }
  const runId = path.basename(runDir);
  if (!isOperationalId(runId) || path.basename(path.dirname(runDir)) !== profile.phase) {
    return operationResult([{ code: 'derived-root-path-invalid', message: 'run directory must match the profile phase and run ID' }], 2);
  }
  let entryHead: string;
  try {
    entryHead = gitText(cwd, ['rev-parse', 'HEAD']);
  } catch (error) {
    return operationResult([{ code: 'init-head-unavailable', message: (error as Error).message }]);
  }
  const parsedChildPins = parseBoundaryChildPins(profileId, entryHead, stringListOption(options, 'childPin'));
  if (!parsedChildPins.result.ok || parsedChildPins.pins === null) {
    return operationResult(parsedChildPins.result.issues, 2);
  }
  const predecessorRunDir = stringOption(options, 'predecessorRunDir');
  const predecessorPinValue = stringOption(options, 'predecessorPin');
  let preparedPredecessor: PreparedBoundaryPredecessor | null = null;
  if (profile.predecessorProfileId === null) {
    if (predecessorRunDir !== undefined || predecessorPinValue !== undefined) {
      return operationResult([{ code: 'predecessor-forbidden', message: 'observation init does not accept predecessor options' }], 2);
    }
  } else {
    if (predecessorRunDir === undefined || predecessorPinValue === undefined) {
      return operationResult([{ code: 'predecessor-required', message: 'profile requires one pinned predecessor source' }], 2);
    }
    const prepared = prepareBoundaryPredecessor(
      profileId,
      entryHead,
      runId,
      predecessorRunDir,
      predecessorPinValue,
      cwd,
    );
    if (!prepared.result.ok || prepared.prepared === null) return prepared.result;
    preparedPredecessor = prepared.prepared;
  }
  const allowedPaths = canonicalSet(stringListOption(options, 'allowPath'));
  const expectedAllowedPaths = profile.allowedPaths === 'observation-preview'
    ? preparedPredecessor?.sourceManifest.upstream.remotePaths ?? []
    : profile.allowedPaths;
  if (!Array.isArray(expectedAllowedPaths) || canonicalizeBoundaryRun(allowedPaths) !== canonicalizeBoundaryRun(expectedAllowedPaths)) {
    return operationResult([{ code: 'profile-path-mismatch', message: 'allowed paths differ from the selected profile' }], 2);
  }
  if (preparedPredecessor !== null) {
    const linkedAliases = profileId === 'bcf00-reconciliation'
      ? ['upstream-observation']
      : profileId === 'bcf08b-docs'
        ? ['docs-precommit']
        : profileId === 'bcf08-final'
          ? ['docs']
          : [];
    for (const alias of linkedAliases) {
      const childPin = parsedChildPins.pins.find((entry) => entry.alias === alias);
      if (
        childPin === undefined
        || childPin.runId !== preparedPredecessor.record.pin.runId
        || childPin.head !== preparedPredecessor.record.pin.terminalHead
        || childPin.manifestSha256 !== preparedPredecessor.record.pin.manifestSha256
      ) {
        return operationResult([{ code: 'predecessor-child-pin-mismatch', message: 'required child pin differs from the predecessor pin' }], 2);
      }
    }
  }
  const allowedUntrackedPaths = canonicalSet(stringListOption(options, 'allowUntracked'));
  const preservedOwnerPaths = canonicalSet(stringListOption(options, 'preserveOwnerPath'));
  const evidenceRoot = path.dirname(path.dirname(runDir));
  const protectedPaths = [...allowedPaths, ...allowedUntrackedPaths, ...preservedOwnerPaths]
    .map((entry) => path.join(cwd, entry));
  const runReservation = reserveBoundaryDerivedRoot({
    evidenceRoot, parentSegments: [profile.phase], runId, kind: 'run', protectedPaths,
  });
  if (!runReservation.ok || runReservation.reservation === null) {
    return operationResult(runReservation.issues, runReservation.issues.some((entry) => entry.code === 'derived-root-exists') ? 2 : 1);
  }
  const completionReservation = reserveBoundaryDerivedRoot({
    evidenceRoot, parentSegments: ['completion'], runId, kind: 'completion', protectedPaths,
  });
  if (!completionReservation.ok || completionReservation.reservation === null) {
    return operationResult(completionReservation.issues);
  }
  const closeoutReservation = profileId === 'bcf08-final'
    ? reserveBoundaryDerivedRoot({
        evidenceRoot, parentSegments: ['closeout'], runId, kind: 'closeout', protectedPaths,
      })
    : null;
  if (closeoutReservation !== null && (!closeoutReservation.ok || closeoutReservation.reservation === null)) {
    return operationResult(closeoutReservation.issues);
  }
  const closeoutFailureReservation = profileId === 'bcf08-final'
    ? reserveBoundaryDerivedRoot({
        evidenceRoot, parentSegments: ['closeout-failures'], runId, kind: 'closeout-failure', protectedPaths,
      })
    : null;
  if (
    closeoutFailureReservation !== null
    && (!closeoutFailureReservation.ok || closeoutFailureReservation.reservation === null)
  ) return operationResult(closeoutFailureReservation.issues);
  const snapshot = captureBoundaryWorktreeSnapshot(cwd, { allowedUntrackedPaths, preservedOwnerPaths });
  if (!snapshot.ok || snapshot.snapshot === null) return operationResult(snapshot.issues);

  try {
    const helperPath = 'scripts/verify-boundary-run.ts';
    const requiredAttemptIds = [...profile.requiredAttemptIds];
    const requestedTools = canonicalSet([
      ...requiredAttemptIds
      .map((id) => RUN_ATTEMPT_CONTRACTS[id]?.toolName)
      .filter((name): name is string => name !== null && name !== undefined),
      ...(boundaryTestFilesForProfile(profileId).length > 0 ? ['gnu-timeout'] : []),
    ]);
    const observedTools = requestedTools.map(resolveBoundaryToolCapability)
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    const created = createBoundaryDerivedRoot(runReservation.reservation);
    if (!created.ok || created.record === undefined) return operationResult(created.issues);
    const now = new Date().toISOString();
    const inheritedReconciledBase = preparedPredecessor?.receipt['reconciledBase'] ?? 'not-observed';
    if (inheritedReconciledBase !== 'not-observed' && !/^[0-9a-f]{40}$/.test(String(inheritedReconciledBase))) {
      throw new Error('predecessor reconciled base is malformed');
    }
    const inheritedUpstream = preparedPredecessor !== null && profileId !== 'bcf00-reconciliation'
      ? structuredClone(preparedPredecessor.sourceManifest.upstream)
      : {
          remoteUrl: 'not-observed' as const,
          observedOid: 'not-observed' as const,
          mergeBase: 'not-observed' as const,
          ahead: 'not-observed' as const,
          behind: 'not-observed' as const,
          remotePaths: [],
          localPaths: [],
          observationManifestSha256: 'not-observed' as const,
          mergeCommit: 'not-observed' as const,
          mergeParents: [] as [],
        };
    const manifest: BoundaryRunManifest = {
      schemaVersion: BOUNDARY_RUN_SCHEMA,
      manifestState: 'active',
      run: {
        runId,
        taskId,
        profileId,
        phase: profile.phase,
        createdAtUtc: now,
        finalizedAtUtc: null,
        entryHead,
        terminalHead: null,
        reconciledBase: inheritedReconciledBase as string | 'not-observed',
        helperCommit: entryHead,
        helperSha256: sha256(readFileSync(path.join(cwd, helperPath))),
        allowedPaths,
        allowedUntrackedPaths,
        preservedOwnerPaths,
        requiredAttemptIds,
        requiredChildAliases: (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!),
        requiredChildPins: parsedChildPins.pins,
        transitionCount: 0,
        mayComplete: profile.mayComplete,
        chainAppend: profile.chainAppend,
        requestedTools,
        observedTools,
        reservedDerivedRoots: ([
          {
            kind: 'completion', path: completionReservation.reservation.path,
            parentDevice: completionReservation.reservation.parentDevice,
            parentInode: completionReservation.reservation.parentInode, state: 'reserved',
          },
          {
            kind: 'run', path: created.record.path, parentDevice: created.record.parentDevice,
            parentInode: created.record.parentInode, state: 'created',
          },
          ...(closeoutReservation === null || closeoutReservation.reservation === null ? [] : [{
            kind: 'closeout' as const,
            path: closeoutReservation.reservation.path,
            parentDevice: closeoutReservation.reservation.parentDevice,
            parentInode: closeoutReservation.reservation.parentInode,
            state: 'reserved' as const,
          }]),
          ...(closeoutFailureReservation === null || closeoutFailureReservation.reservation === null ? [] : [{
            kind: 'closeout-failure' as const,
            path: closeoutFailureReservation.reservation.path,
            parentDevice: closeoutFailureReservation.reservation.parentDevice,
            parentInode: closeoutFailureReservation.reservation.parentInode,
            state: 'reserved' as const,
          }]),
        ] satisfies BoundaryReservedDerivedRootRecord[])
          .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
      },
      entrySnapshot: snapshot.snapshot,
      currentSnapshot: structuredClone(snapshot.snapshot),
      attempts: [],
      artifacts: [],
      children: [],
      predecessor: preparedPredecessor?.record ?? null,
      entryTestRoster: discoverEntryTestRoster(cwd, profileId, observedTools),
      reviews: [],
      lifecycle: {
        status: 'active', completionCommit: null, finalGate: 'not-run', artifactSha256: null,
        successor: null, supersededBy: null, oracle: 'not-applicable', branchDeletionAuthorized: false,
      },
      documentHashes: {
        spec: documentHash(cwd, 'docs/superpowers/specs/2026-07-15-semantic-boundary-hygiene-design.md'),
        plan: documentHash(cwd, 'docs/superpowers/plans/2026-07-16-boundary-contract-feedback-hardening.md'),
        notes: documentHash(cwd, 'docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md'),
        helper: documentHash(cwd, helperPath),
      },
      upstream: inheritedUpstream,
      overallVerdict: 'Inconclusive',
    };
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) throw new Error(validation.issues.map((entry) => entry.code).join(', '));
    mkdirSync(path.join(runDir, 'attempts'), { recursive: false, mode: 0o700 });
    if (preparedPredecessor !== null) {
      const predecessorRoot = path.join(runDir, 'predecessor');
      mkdirSync(predecessorRoot, { recursive: false, mode: 0o700 });
      for (const file of preparedPredecessor.files) {
        const destination = path.join(predecessorRoot, file.path);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        durableExclusiveWrite(destination, file.bytes);
      }
    }
    durableExclusiveWrite(path.join(runDir, 'run_manifest.json'), canonicalizeBoundaryRun(manifest));
    const initAnchorBytes = canonicalizeBoundaryRun(createBoundaryRunInitAnchor(manifest));
    durableExclusiveWrite(path.join(runDir, 'run_init.json'), initAnchorBytes);
    durableExclusiveWrite(path.join(runDir, 'run_init.sha256'), shaLockBytes(sha256(initAnchorBytes), 'run_init.json'));
    return operationResult([]);
  } catch (error) {
    try {
      if (existsSync(runDir) && lstatSync(runDir).isDirectory() && !existsSync(path.join(runDir, 'run_manifest.json'))) {
        rmdirSync(runDir);
      }
    } catch {
      // Retain non-empty or identity-ambiguous state for inspection.
    }
    return operationResult([{ code: 'init-failed', message: (error as Error).message }]);
  }
}

function loadActiveManifest(runDir: string): { manifest: BoundaryRunManifest; path: string } {
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const bytes = readFileSync(manifestPath);
  const validation = validateBoundaryRunJson(bytes);
  if (!validation.ok) throw new Error(validation.issues.map((entry) => entry.code).join(', '));
  const manifest = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
  if (manifest.manifestState !== 'active') throw new Error('run manifest is immutable');
  const anchor = verifyRunInitAnchor(manifest, runDir);
  if (!anchor.ok) throw new BoundaryRunLoadError(anchor.issues);
  return { manifest, path: manifestPath };
}

function reconstructedChildEnvironment(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? cwd,
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

function capabilityForManifest(manifest: BoundaryRunManifest, name: string): BoundaryRunManifest['run']['observedTools'][number] {
  const frozen = manifest.run.observedTools.find((entry) => entry.name === name);
  const live = resolveBoundaryToolCapability(name);
  if (frozen === undefined || canonicalizeBoundaryRun(frozen) !== canonicalizeBoundaryRun(live)) {
    throw new Error(`${name} capability changed since run initialization`);
  }
  return frozen;
}

function streamRecord(runDir: string, relativePath: string): { path: string; sha256: string; bytes: number } {
  const bytes = readFileSync(path.join(runDir, relativePath));
  return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function resolveAttemptArgv(
  template: readonly string[],
  manifest: BoundaryRunManifest,
  runDir: string,
): string[] {
  const prerequisiteStdout = (id: string): string => {
    const attempt = manifest.attempts.find((entry) => entry.id === id);
    if (attempt === undefined || !attempt.expectationMet || attempt.verdict !== 'Pass') {
      throw new Error(`required prerequisite attempt is unavailable: ${id}`);
    }
    return readFileSync(path.join(runDir, attempt.stdout.path), 'utf8').trim();
  };
  const observedMergeBase = (): string => {
    const id = manifest.run.profileId === 'bcf08-final' ? 'final-upstream-merge-base' : 'upstream-merge-base';
    const value = prerequisiteStdout(id);
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${id} stdout is not one exact Git OID`);
    return value;
  };
  const canaryIdentity = (name: 'parent' | 'child' | 'pgid'): string => {
    const artifact = manifest.artifacts.find((entry) => entry.path === 'watchdog-canary/pids.txt');
    if (artifact === undefined || artifact.producerAttemptId !== 'watchdog-canary') {
      throw new Error('watchdog canary PID artifact is unavailable');
    }
    const content = readFileSync(path.join(runDir, artifact.path), 'utf8');
    const match = new RegExp(`^${name}=([1-9]\\d*)$`, 'm').exec(content);
    if (match === null) throw new Error(`watchdog canary ${name} is malformed`);
    return match[1]!;
  };
  return template.map((argument) => {
    if (argument.includes('<run-dir>')) return argument.replaceAll('<run-dir>', runDir);
    if (argument.includes('<observed-merge-base>')) {
      return argument.replaceAll('<observed-merge-base>', observedMergeBase());
    }
    if (argument === '<test-integrity-real-path>') return resolveBoundaryToolCapability('test-integrity').realPath;
    if (argument === '<watchdog-parent-pid>') return canaryIdentity('parent');
    if (argument === '<watchdog-child-pid>') return canaryIdentity('child');
    if (argument === '-<watchdog-group-pgid>') return `-${canaryIdentity('pgid')}`;
    return argument;
  });
}

async function recordCommand(invocation: BoundaryRunInvocation, cwd: string): Promise<BoundaryValidationResult> {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest, path: manifestPath } = loaded;
  if (manifest.attempts.some((entry) => entry.id === attemptId)) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  const expectedExit = stringOption(invocation.options, 'expectExit') ?? '0';
  const timeoutOwner = stringOption(invocation.options, 'timeoutOwner') ?? null;
  const outputPaths = canonicalSet(stringListOption(invocation.options, 'outputPath'));
  const required = manifest.run.requiredAttemptIds.includes(attemptId);
  let contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  if (required) {
    if (contract === undefined || contract.operation !== 'command') {
      return operationResult([{ code: 'attempt-operation-mismatch', message: 'attempt is not a command contract' }], 2);
    }
    if (
      canonicalizeBoundaryRun(invocation.commandArgv) !== canonicalizeBoundaryRun(contract.argv)
      || expectedExit !== contract.expectedExit
      || timeoutOwner !== contract.innerTimeoutOwner
      || canonicalizeBoundaryRun(outputPaths) !== canonicalizeBoundaryRun(contract.outputPaths)
    ) {
      return operationResult([{ code: 'attempt-contract-mismatch', message: 'command invocation differs from its reserved contract' }], 2);
    }
  } else {
    const commandArgv = invocation.commandArgv ?? [];
    const toolName = commandArgv[0];
    const statuses = expectedExit === 'nonzero' ? [] : expectedExit.split(',').map(Number);
    const normalizedExit = expectedExit === 'nonzero'
      || (
        /^(?:0|[1-9]\d?\d?)(?:,(?:0|[1-9]\d?\d?))*$/.test(expectedExit)
        && statuses.every((status) => status <= 255)
        && statuses.every((status, index) => index === 0 || status > statuses[index - 1]!)
      );
    if (
      manifest.run.profileId !== 'bcf-reproduction'
      || toolName === undefined
      || !isOperationalId(toolName)
      || !normalizedExit
      || timeoutOwner !== null
      || outputPaths.length !== 0
      || manifest.run.observedTools.every((entry) => entry.name !== toolName)
    ) {
      return operationResult([{
        code: 'reproduction-attempt-contract-mismatch',
        message: 'generic attempts require the closed reproduction profile, frozen tool, bounds, and no outputs',
      }], 2);
    }
    contract = {
      operation: 'command',
      argv: commandArgv,
      environmentKeys: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'],
      toolName,
      expectedExit,
      watchdogOwner: 'helper-watchdog',
      innerTimeoutOwner: null,
      deadlineMs: 900_000,
      killGraceMs: 30_000,
      outputPaths: [],
      headAnchor: 'entry',
      stdinSource: null,
      stdoutPredicate: null,
      resultPredicate: null,
      structuredResultPath: null,
      internalCheck: null,
      transitionKind: null,
      messageSubject: null,
      allowlistSource: null,
    };
  }
  const capability = resolveBoundaryToolCapability(contract.toolName!);
  const frozenCapability = manifest.run.observedTools.find((entry) => entry.name === contract.toolName);
  if (frozenCapability === undefined || canonicalizeBoundaryRun(frozenCapability) !== canonicalizeBoundaryRun(capability)) {
    return operationResult([{ code: 'attempt-tool-capability-mismatch', message: 'tool identity changed since init' }]);
  }
  const expectedHead = contract.headAnchor === 'entry'
    ? manifest.run.entryHead
    : manifest.run.terminalHead;
  if (expectedHead === null || gitText(cwd, ['rev-parse', 'HEAD']) !== expectedHead) {
    return operationResult([{ code: 'attempt-head-anchor-mismatch', message: 'Git head differs from the attempt anchor' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  if (canonicalizeBoundaryRun(before.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'attempt-pre-snapshot-drift', message: 'worktree changed before command execution' }]);
  }
  const attemptDir = path.join(runDir, 'attempts', attemptId);
  try {
    mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    return operationResult([{
      code: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'attempt-duplicate' : 'attempt-directory-failed',
      message: (error as Error).message,
    }], (error as NodeJS.ErrnoException).code === 'EEXIST' ? 2 : 1);
  }
  let resolvedArgv: string[];
  let stdinPath: string | null = null;
  let structuredResultPath: string | null = null;
  let measurementChannel: {
    path: string;
    tokenSha256: string;
    device: number;
    inode: number;
    mode: number;
  } | null = null;
  let childEnvironment = reconstructedChildEnvironment(cwd);
  try {
    resolvedArgv = resolveAttemptArgv(contract.argv, manifest, runDir);
    resolvedArgv[0] = capability.realPath;
    if (contract.stdinSource !== null) {
      const source = manifest.attempts.find((entry) => entry.id === contract.stdinSource);
      if (source === undefined || source.verdict !== 'Pass') throw new Error('stdin source attempt is unavailable');
      stdinPath = path.join(runDir, source.stdout.path);
    }
    if (contract.structuredResultPath !== null) {
      structuredResultPath = contract.structuredResultPath;
      const vitestPredicate = contract.resultPredicate === null
        ? undefined
        : RUN_VITEST_PREDICATES[contract.resultPredicate];
      if (vitestPredicate?.mode === 'red') {
        const selectedMarkers = vitestPredicate.testContractIds.flatMap((id) => [
          ...RUN_TEST_CONTRACTS[id].unsafeMarkerIds,
          ...RUN_TEST_CONTRACTS[id].safeMarkerIds,
        ]);
        const pattern = selectedMarkers.map((markerId) => markerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        resolvedArgv.push('--testNamePattern', pattern);
      }
      if (!structuredResultPath.endsWith('/stdout.log')) {
        resolvedArgv.push('--reporter=json', '--outputFile', path.join(runDir, structuredResultPath));
      }
    }
    if (attemptId === 'feedback-green') {
      const measurementPath = path.join(runDir, 'feedback-measurements.json');
      const token = randomUUID();
      durableExclusiveWrite(measurementPath, '');
      const stat = lstatSync(measurementPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('measurement channel is not a regular file');
      measurementChannel = {
        path: measurementPath,
        tokenSha256: sha256(token),
        device: Number(stat.dev),
        inode: Number(stat.ino),
        mode: stat.mode,
      };
      childEnvironment = {
        ...childEnvironment,
        BCF_MEASUREMENT_PATH: measurementPath,
        BCF_MEASUREMENT_TOKEN: token,
      };
    }
  } catch (error) {
    return operationResult([{ code: 'attempt-prerequisite-invalid', message: (error as Error).message }]);
  }
  const stdoutPath = `attempts/${attemptId}/stdout.log`;
  const stderrPath = `attempts/${attemptId}/stderr.log`;
  const outcome = await runBoundaryAttemptProcess(resolvedArgv, {
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    expectedExit: contract.expectedExit,
    cwd,
    env: childEnvironment,
    stdinPath,
    stdoutPath: path.join(runDir, stdoutPath),
    stderrPath: path.join(runDir, stderrPath),
  });
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  const statusRecord = {
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet: false,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const parsedStatus = validateBoundaryAttemptStatus(
    { ...statusRecord, expectationMet: outcome.result.ok },
    { rawExit: outcome.rawExit, rawSignal: outcome.rawSignal },
    contract,
  );
  const expectationMet = outcome.result.ok && parsedStatus.ok;
  const outputAdmissions: BoundaryOutputAdmission[] = contract.outputPaths.map((relativePath) => {
    const absolute = path.join(runDir, relativePath);
    try {
      const stat = lstatSync(absolute);
      return {
        path: relativePath,
        state: stat.isFile() && !stat.isSymbolicLink() ? 'pending' as const : 'missing' as const,
        role: null,
        sha256: null,
        bytes: null,
      };
    } catch {
      return { path: relativePath, state: 'missing' as const, role: null, sha256: null, bytes: null };
    }
  });
  let measurementValidation = operationResult([]);
  if (measurementChannel !== null) {
    try {
      const stat = lstatSync(measurementChannel.path);
      const bytes = readFileSync(measurementChannel.path);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || Number(stat.dev) !== measurementChannel.device
        || Number(stat.ino) !== measurementChannel.inode
        || stat.mode !== measurementChannel.mode
        || bytes.byteLength === 0
      ) throw new Error('measurement channel identity or contents changed outside the one-use contract');
      const descriptor = openSync(measurementChannel.path, 'r');
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const parsed = parseBoundaryJsonBytes(bytes);
      if (
        !parsed.result.ok
        || parsed.value === null
        || parsed.value === undefined
        || typeof parsed.value !== 'object'
        || Array.isArray(parsed.value)
      ) {
        measurementValidation = parsed.result;
      } else {
        const measurement = parsed.value as Record<string, unknown>;
        measurementValidation = validateBoundaryStructuredRecord('FeedbackMeasurements', measurement);
        if (
          measurementValidation.ok
          && (
            measurement['runId'] !== manifest.run.runId
            || measurement['taskId'] !== manifest.run.taskId
            || measurement['profileId'] !== manifest.run.profileId
            || measurement['producerAttemptId'] !== attemptId
            || measurement['head'] !== expectedHead
            || measurement['snapshotDigestSha256'] !== before.snapshot.digestSha256
            || measurement['tokenSha256'] !== measurementChannel.tokenSha256
          )
        ) {
          measurementValidation = operationResult([{
            code: 'feedback-measurement-identity-mismatch',
            message: 'measurement fields differ from the helper-owned one-use channel',
          }]);
        }
      }
      if (measurementValidation.ok) {
        const admission = outputAdmissions.find((entry) => entry.path === 'feedback-measurements.json');
        if (admission === undefined || admission.state !== 'pending') {
          measurementValidation = operationResult([{
            code: 'feedback-measurement-admission-mismatch',
            message: 'measurement output is not the sole pending profile declaration',
          }]);
        } else {
          admission.state = 'admitted';
          admission.role = 'measurement';
          admission.sha256 = sha256(bytes);
          admission.bytes = bytes.byteLength;
        }
      }
    } catch (error) {
      measurementValidation = operationResult([{ code: 'feedback-measurement-invalid', message: (error as Error).message }]);
    }
  }
  const snapshotStable = after.ok
    && after.snapshot !== null
    && canonicalizeBoundaryRun(after.snapshot) === canonicalizeBoundaryRun(before.snapshot);
  const stdoutPredicate = validateBoundaryStdoutPredicate(
    contract.stdoutPredicate,
    readFileSync(path.join(runDir, stdoutPath), 'utf8'),
    manifest.run.allowedPaths,
  );
  let structuredResult = null;
  let resultPredicate = operationResult([]);
  if (contract.resultPredicate !== null) {
    if (structuredResultPath === null || !existsSync(path.join(runDir, structuredResultPath))) {
      resultPredicate = operationResult([{
        code: 'attempt-structured-result-missing',
        message: 'required structured result was not written',
      }]);
    } else {
      structuredResult = streamRecord(runDir, structuredResultPath);
      const parsed = parseBoundaryJsonBytes(readFileSync(path.join(runDir, structuredResultPath)));
      resultPredicate = parsed.result.ok && parsed.value !== null
        ? validateBoundaryVitestJsonReport({
            predicate: contract.resultPredicate,
            cwd,
            entryTestRoster: manifest.entryTestRoster,
            report: parsed.value,
          })
        : parsed.result;
    }
  }
  const resultPredicateMet = resultPredicate.ok;
  const verdict = expectationMet
    && snapshotStable
    && stdoutPredicate.ok
    && resultPredicateMet
    && measurementValidation.ok
    && outputAdmissions.every((entry) => entry.state === 'admitted')
    ? 'Pass' as const
    : 'Inconclusive' as const;
  const attempt = {
    id: attemptId,
    operation: 'command' as const,
    headAnchor: contract.headAnchor,
    argv: [...contract.argv],
    cwd,
    startedAtUtc: outcome.startedAtUtc,
    endedAtUtc: outcome.endedAtUtc,
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot ?? before.snapshot,
    stdout: streamRecord(runDir, stdoutPath),
    stderr: streamRecord(runDir, stderrPath),
    declaredOutputs: [...contract.outputPaths],
    outputAdmissions,
    structuredResult,
    verdict,
  };
  manifest.attempts.push(attempt);
  if (measurementChannel !== null && measurementValidation.ok) {
    const admission = outputAdmissions.find((entry) => entry.path === 'feedback-measurements.json')!;
    manifest.artifacts.push({
      path: admission.path,
      role: 'measurement',
      producerAttemptId: attemptId,
      sha256: admission.sha256!,
      bytes: admission.bytes!,
    });
  }
  manifest.currentSnapshot = structuredClone(attempt.postSnapshot);
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(manifestPath, canonicalizeBoundaryRun(manifest));
  const issues = [
    ...outcome.result.issues,
    ...parsedStatus.issues,
    ...after.issues,
    ...stdoutPredicate.issues,
    ...resultPredicate.issues,
    ...measurementValidation.issues,
    ...(!snapshotStable ? [{ code: 'attempt-post-snapshot-drift', message: 'worktree changed during command' }] : []),
  ];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}

function recordArtifact(invocation: BoundaryRunInvocation): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const producerAttemptId = stringOption(invocation.options, 'producerAttempt')!;
  const artifactPath = stringOption(invocation.options, 'artifactPath')!;
  const role = stringOption(invocation.options, 'role')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const attemptIndex = loaded.manifest.attempts.findIndex((entry) => entry.id === producerAttemptId);
  if (attemptIndex < 0) {
    return operationResult([{ code: 'output-producer-missing', message: 'producer attempt is unavailable' }]);
  }
  const admitted = admitBoundaryOutput({
    runDir,
    attempt: loaded.manifest.attempts[attemptIndex]!,
    artifacts: loaded.manifest.artifacts,
    path: artifactPath,
    role,
    producerAttemptId,
  });
  if (!admitted.result.ok) return admitted.result;
  const closure = validateBoundaryOutputClosure(runDir, admitted.attempt, admitted.artifacts);
  if (!closure.ok) return closure;
  loaded.manifest.attempts[attemptIndex] = admitted.attempt;
  loaded.manifest.artifacts = admitted.artifacts
    .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const validation = validateBoundaryRun(loaded.manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([], 0, admitted.attempt.verdict);
}

function recordReview(invocation: BoundaryRunInvocation): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const alias = stringOption(invocation.options, 'alias')!;
  const reviewPath = stringOption(invocation.options, 'reviewPath')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    loaded.manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract === undefined) {
    return recordParentReview(loaded, runDir, alias, reviewPath);
  }
  if (alias !== sourceContract.alias) {
    return operationResult([{ code: 'review-alias-mismatch', message: 'review alias differs from the source profile contract' }], 2);
  }
  if (
    loaded.manifest.reviews.some((entry) => (
      entry.alias === alias
      || entry.dedupeKey === sourceContract.dedupeKey
    ))
  ) {
    return operationResult([{ code: 'review-duplicate', message: 'review alias or dedupe key is already recorded' }], 2);
  }
  let input: BoundaryReviewInputRecord;
  try {
    const bytes = readConfinedRegularFile(runDir, reviewPath);
    const parsed = strictCanonicalObject(bytes, 'review input');
    const validation = validateBoundaryReviewInput(parsed);
    if (!validation.ok) return validation;
    input = parsed as unknown as BoundaryReviewInputRecord;
  } catch (error) {
    return operationResult([{ code: 'review-input-invalid', message: (error as Error).message }]);
  }
  if (
    input.dedupeKey !== sourceContract.dedupeKey
    || input.head !== loaded.manifest.run.entryHead
    || input.snapshotDigestSha256 !== loaded.manifest.entrySnapshot.digestSha256
  ) {
    return operationResult([{ code: 'review-identity-mismatch', message: 'review input differs from the profile entry identity' }], 2);
  }
  if (loaded.manifest.reviews.some((entry) => entry.reviewId === input.reviewId)) {
    return operationResult([{ code: 'review-duplicate', message: 'review ID is already recorded' }], 2);
  }
  const closure = [
    { path: input.reportPath, digest: input.reportSha256 },
    { path: input.metaPath, digest: input.metaSha256 },
    { path: input.stderrPath, digest: input.stderrSha256 },
    ...input.findings.map((finding) => ({ path: finding.evidencePath, digest: finding.evidenceSha256 })),
  ];
  const closurePaths = closure.map((entry) => entry.path);
  if (new Set([reviewPath, ...closurePaths]).size !== closurePaths.length + 1) {
    return operationResult([{ code: 'review-path-collision', message: 'review input and evidence paths must be pairwise distinct' }], 2);
  }
  try {
    for (const entry of closure) {
      const bytes = readConfinedRegularFile(runDir, entry.path);
      if (sha256(bytes) !== entry.digest) {
        return operationResult([{ code: 'review-evidence-mismatch', message: `review evidence hash changed: ${entry.path}` }]);
      }
    }
  } catch (error) {
    return operationResult([{ code: 'review-evidence-invalid', message: (error as Error).message }]);
  }
  for (const contract of input.reproductionContracts) {
    const prior = loaded.manifest.reviews
      .flatMap((review) => review.reproductionContracts)
      .find((entry) => entry.attemptId === contract.attemptId);
    if (prior !== undefined) {
      return operationResult([{
        code: 'reproduction-contract-reused',
        message: 'one reproduction attempt ID cannot be reused across reviews',
      }], 2);
    }
  }
  const { schemaVersion: _schemaVersion, ...sourceRecord } = input;
  const record: BoundaryReviewRecord = { alias, ...structuredClone(sourceRecord) };
  loaded.manifest.reviews.push(record);
  loaded.manifest.reviews.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const validation = validateBoundaryRun(loaded.manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([]);
}

function recordParentReview(
  loaded: { manifest: BoundaryRunManifest; path: string },
  runDir: string,
  alias: string,
  reviewPath: string,
): BoundaryValidationResult {
  const contract = childContractFor(loaded.manifest.run.profileId, alias);
  const expectedReviewPath = `children/${alias}/run_manifest.json`;
  if (contract === undefined || contract.kind !== 'review' || reviewPath !== expectedReviewPath) {
    return operationResult([{
      code: 'review-parent-contract-mismatch',
      message: 'parent review mode requires one profile-owned imported review manifest path',
    }], 2);
  }
  if (
    loaded.manifest.reviews.some((entry) => (
      entry.alias === alias
      || entry.dedupeKey === contract.dedupeKey
    ))
  ) {
    return operationResult([{ code: 'review-duplicate', message: 'review alias or dedupe key is already recorded' }], 2);
  }
  const child = loaded.manifest.children.find((entry) => entry.alias === alias);
  const lead = loaded.manifest.children.find((entry) => entry.alias === 'lead-reproduction');
  if (child === undefined || lead === undefined || child.kind !== 'review' || lead.kind !== 'reproduction') {
    return operationResult([{ code: 'review-parent-child-missing', message: 'review and lead reproduction children must already be imported' }]);
  }
  const childValidation = validateRecordedChild(loaded.manifest, runDir, child);
  const leadValidation = validateRecordedChild(loaded.manifest, runDir, lead);
  if (!childValidation.ok || !leadValidation.ok) {
    return operationResult([...childValidation.issues, ...leadValidation.issues]);
  }
  let sourceManifest: BoundaryRunManifest;
  let leadManifest: BoundaryRunManifest;
  try {
    sourceManifest = JSON.parse(readConfinedRegularFile(path.join(runDir, 'children', alias), 'run_manifest.json').toString('utf8')) as BoundaryRunManifest;
    leadManifest = JSON.parse(readConfinedRegularFile(path.join(runDir, 'children', 'lead-reproduction'), 'run_manifest.json').toString('utf8')) as BoundaryRunManifest;
  } catch (error) {
    return operationResult([{ code: 'review-parent-import-invalid', message: (error as Error).message }]);
  }
  if (sourceManifest.reviews.length !== 1) {
    return operationResult([{ code: 'review-source-cardinality-invalid', message: 'review child must contain exactly one source review' }]);
  }
  const source = sourceManifest.reviews[0]!;
  if (
    source.alias !== alias
    || source.dedupeKey !== contract.dedupeKey
    || source.head !== child.entryHead
    || source.head !== child.terminalHead
    || source.snapshotDigestSha256 !== child.snapshotDigestSha256
    || source.reviewId === ''
  ) {
    return operationResult([{ code: 'review-source-identity-mismatch', message: 'source review differs from its imported child contract' }]);
  }
  const sourceShape = { schemaVersion: 1, ...source } as Record<string, unknown>;
  delete sourceShape['alias'];
  const sourceValidation = validateBoundaryReviewInput(sourceShape);
  if (!sourceValidation.ok) return sourceValidation;
  const proofValidation = validateReviewProofContracts(source, leadManifest);
  if (!proofValidation.ok) return proofValidation;
  const prefix = `children/${alias}/`;
  const record: BoundaryReviewRecord = {
    ...structuredClone(source),
    reportPath: `${prefix}${source.reportPath}`,
    metaPath: `${prefix}${source.metaPath}`,
    stderrPath: `${prefix}${source.stderrPath}`,
    findings: source.findings.map((finding) => ({
      ...structuredClone(finding),
      evidencePath: `${prefix}${finding.evidencePath}`,
    })),
  };
  const recordShape = { schemaVersion: 1, ...record } as Record<string, unknown>;
  delete recordShape['alias'];
  const recordValidation = validateBoundaryReviewInput(recordShape);
  if (!recordValidation.ok) return recordValidation;
  loaded.manifest.reviews.push(record);
  loaded.manifest.reviews.sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
  const manifestValidation = validateBoundaryRun(loaded.manifest);
  if (!manifestValidation.ok) return manifestValidation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(loaded.manifest));
  return operationResult([]);
}

function validateReviewProofContracts(
  source: BoundaryReviewRecord,
  leadManifest: BoundaryRunManifest,
): BoundaryValidationResult {
  const declaredIds = source.reproductionContracts.map((entry) => entry.attemptId);
  const genericIds = leadManifest.attempts
    .filter((attempt) => !leadManifest.run.requiredAttemptIds.includes(attempt.id))
    .map((attempt) => attempt.id)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalizeBoundaryRun(genericIds) !== canonicalizeBoundaryRun(declaredIds)) {
    return operationResult([{ code: 'review-proof-set-mismatch', message: 'lead reproduction proof set differs from the review contracts' }]);
  }
  const expectedExitMatches = (expected: string, rawExit: number | null, rawSignal: string | null): boolean => {
    if (rawSignal !== null || rawExit === null) return false;
    if (expected === 'nonzero') return rawExit !== 0;
    return expected.split(',').map(Number).includes(rawExit);
  };
  for (const proofContract of source.reproductionContracts) {
    const matches = leadManifest.attempts.filter((attempt) => attempt.id === proofContract.attemptId);
    const proof = matches[0];
    const tool = leadManifest.run.observedTools.find((entry) => entry.name === proofContract.toolName);
    if (
      matches.length !== 1
      || proof === undefined
      || tool === undefined
      || proof.argv[0] !== proofContract.toolName
      || canonicalizeBoundaryRun(proof.argv) !== canonicalizeBoundaryRun(proofContract.argv)
      || proof.expectedExit !== proofContract.expectedExit
      || proof.deadlineMs !== proofContract.deadlineMs
      || proof.killGraceMs !== proofContract.killGraceMs
      || proof.watchdogOwner !== 'helper-watchdog'
      || proof.innerTimeoutOwner !== null
      || proof.headAnchor !== 'entry'
      || proof.preSnapshot.head !== source.head
      || proof.postSnapshot.head !== source.head
      || proof.preSnapshot.digestSha256 !== source.snapshotDigestSha256
      || proof.postSnapshot.digestSha256 !== source.snapshotDigestSha256
      || proof.declaredOutputs.length !== 0
      || proof.outputAdmissions.length !== 0
      || !expectedExitMatches(proof.expectedExit, proof.rawExit, proof.rawSignal)
      || proof.expectationMet !== true
      || proof.verdict !== 'Pass'
    ) {
      return operationResult([{
        code: 'review-proof-contract-mismatch',
        message: `lead reproduction proof differs from its immutable contract: ${proofContract.attemptId}`,
      }]);
    }
  }
  return operationResult([]);
}

function readConfinedRegularFile(root: string, relativePath: string): Buffer {
  if (!isSafeRelativePath(relativePath)) throw new Error(`unsafe child closure path: ${relativePath}`);
  const absolute = path.resolve(root, relativePath);
  if (path.relative(root, absolute).split(path.sep).includes('..')) {
    throw new Error(`child closure path escapes its root: ${relativePath}`);
  }
  let cursor = root;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    cursor = path.join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`child closure path contains a symlink: ${relativePath}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`child closure ancestor is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`child closure leaf is not a regular file: ${relativePath}`);
    }
  }
  return readFileSync(absolute);
}

function childClosurePaths(manifest: BoundaryRunManifest): string[] {
  const paths = ['run_init.json', 'run_init.sha256', 'run_manifest.json', 'run_manifest.sha256'];
  for (const attempt of manifest.attempts) {
    paths.push(attempt.stdout.path, attempt.stderr.path);
    if (attempt.structuredResult !== null) paths.push(attempt.structuredResult.path);
  }
  for (const artifact of manifest.artifacts) paths.push(artifact.path);
  for (const review of manifest.reviews) {
    paths.push(review.reportPath, review.metaPath, review.stderrPath);
    for (const finding of review.findings) paths.push(finding.evidencePath);
  }
  for (const child of manifest.children) {
    for (const row of child.importedFiles) paths.push(`children/${child.alias}/${row.path}`);
  }
  if (manifest.predecessor !== null) {
    for (const row of manifest.predecessor.importedFiles) paths.push(`predecessor/${row.path}`);
  }
  const canonical = canonicalSet(paths);
  if (canonical.length !== paths.length) throw new Error('child closure contains duplicate logical paths');
  return canonical;
}

function childClosureRows(root: string, manifest: BoundaryRunManifest): BoundaryImportedFileRecord[] {
  return childClosurePaths(manifest).map((relativePath) => {
    const bytes = readConfinedRegularFile(root, relativePath);
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.byteLength };
  });
}

function importedManifestDepth(
  manifest: BoundaryRunManifest,
  importRoot: string,
  ancestors: ReadonlySet<string> = new Set(),
): number {
  if (ancestors.has(manifest.run.runId)) throw new Error(`child cycle repeats run ID ${manifest.run.runId}`);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(manifest.run.runId);
  let depth = 0;
  for (const child of manifest.children) {
    const childRoot = path.join(importRoot, 'children', child.alias);
    const bytes = readConfinedRegularFile(childRoot, 'run_manifest.json');
    if (sha256(bytes) !== child.sourceManifestSha256) {
      throw new Error(`nested child manifest digest changed: ${child.alias}`);
    }
    const validation = validateBoundaryRunJson(bytes);
    if (!validation.ok) throw new Error(`nested child manifest is invalid: ${child.alias}`);
    const nested = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
    depth = Math.max(depth, 1 + importedManifestDepth(nested, childRoot, nextAncestors));
  }
  return depth;
}

function childContractFor(
  parentProfileId: string,
  alias: string,
): (typeof RUN_CHILD_CONTRACTS)[keyof typeof RUN_CHILD_CONTRACTS] | undefined {
  return RUN_CHILD_CONTRACTS[`${parentProfileId}/${alias}` as keyof typeof RUN_CHILD_CONTRACTS];
}

function childRelationIssues(
  parent: BoundaryRunManifest,
  child: BoundaryChildRecord,
  headRelation: (typeof RUN_CHILD_CONTRACTS)[keyof typeof RUN_CHILD_CONTRACTS]['headRelation'],
  pinnedHead: string,
): BoundaryValidationIssue[] {
  let expectedHead = parent.run.entryHead;
  if (headRelation === 'both-docs-entry') {
    const docs = parent.children.find((entry) => entry.alias === 'docs');
    if (docs === undefined) {
      return [{ code: 'child-head-relation-missing', message: 'final review imports require the pinned docs child first' }];
    }
    expectedHead = docs.entryHead;
  }
  const both = headRelation === 'both-parent-entry' || headRelation === 'both-docs-entry';
  if (
    pinnedHead !== expectedHead
    || child.terminalHead !== expectedHead
    || (both && child.entryHead !== expectedHead)
  ) {
    return [{ code: 'child-head-relation-mismatch', message: 'child heads differ from the profile-owned relation' }];
  }
  return [];
}

function validateRecordedChild(
  parent: BoundaryRunManifest,
  parentRunDir: string,
  child: BoundaryChildRecord,
): BoundaryValidationResult {
  const contract = childContractFor(parent.run.profileId, child.alias);
  const dynamicPin = parent.run.requiredChildPins.find((entry) => entry.alias === child.alias);
  if (contract === undefined || dynamicPin === undefined) {
    return operationResult([{ code: 'child-contract-missing', message: 'child is not owned by the parent profile' }]);
  }
  const importRoot = path.join(parentRunDir, 'children', child.alias);
  let nestedDepth = 0;
  let copiedManifest: BoundaryRunManifest;
  const closureIssues: BoundaryValidationIssue[] = [];
  try {
    const manifestBytes = readConfinedRegularFile(importRoot, 'run_manifest.json');
    if (sha256(manifestBytes) !== dynamicPin.manifestSha256) {
      return operationResult([{ code: 'child-import-mutation', message: 'copied child manifest differs from its frozen pin' }]);
    }
    const parsed = validateBoundaryRunJson(manifestBytes);
    if (!parsed.ok) return parsed;
    copiedManifest = JSON.parse(manifestBytes.toString('utf8')) as BoundaryRunManifest;
    nestedDepth = importedManifestDepth(copiedManifest, importRoot);
    const expectedPaths = childClosurePaths(copiedManifest);
    const recordedPaths = child.importedFiles.map((entry) => entry.path);
    if (canonicalizeBoundaryRun(expectedPaths) !== canonicalizeBoundaryRun(recordedPaths)) {
      closureIssues.push({ code: 'child-closure-set-mismatch', message: 'copied child closure differs from its manifest declarations' });
    }
    if (
      copiedManifest.manifestState !== 'finalized'
      || copiedManifest.run.taskId !== child.taskId
      || copiedManifest.run.profileId !== child.profileId
      || copiedManifest.run.runId !== child.runId
      || copiedManifest.run.entryHead !== child.entryHead
      || copiedManifest.run.terminalHead !== child.terminalHead
      || copiedManifest.currentSnapshot.digestSha256 !== child.snapshotDigestSha256
      || copiedManifest.overallVerdict !== child.overallVerdict
    ) {
      closureIssues.push({ code: 'child-identity-mismatch', message: 'copied manifest identity differs from the parent child row' });
    }
    if (
      readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8')
      !== shaLockBytes(dynamicPin.manifestSha256, 'run_manifest.json')
    ) {
      closureIssues.push({ code: 'child-manifest-lock-mismatch', message: 'copied child manifest lock differs from the frozen pin' });
    }
  } catch (error) {
    return operationResult([{ code: 'child-import-mutation', message: (error as Error).message }]);
  }
  const identity = validateBoundaryChildImport({
    parentRunId: parent.run.runId,
    parentDepth: nestedDepth,
    maxDepth: contract.maxDepth,
    importRoot,
    existingAliases: [],
    existingPaths: [],
    verifiedSourceManifestSha256: dynamicPin.manifestSha256,
    pin: {
      alias: dynamicPin.alias,
      kind: contract.kind,
      taskId: contract.taskId,
      profileId: contract.profileId,
      runId: dynamicPin.runId,
      entryHead: child.entryHead,
      terminalHead: child.terminalHead,
      manifestSha256: dynamicPin.manifestSha256,
    },
    child,
  });
  const relationIssues = childRelationIssues(parent, child, contract.headRelation, dynamicPin.head);
  return operationResult([...identity.issues, ...relationIssues, ...closureIssues]);
}

function validateRecordedPredecessor(
  manifest: BoundaryRunManifest,
  runDir: string,
): BoundaryValidationResult {
  const relation = RUN_PREDECESSOR_CONTRACTS[manifest.run.profileId as keyof typeof RUN_PREDECESSOR_CONTRACTS];
  if (relation === undefined) {
    return manifest.predecessor === null
      ? operationResult([])
      : operationResult([{ code: 'predecessor-forbidden', message: 'profile unexpectedly contains a predecessor import' }]);
  }
  const predecessor = manifest.predecessor;
  if (predecessor === null) {
    return operationResult([{ code: 'predecessor-missing', message: 'profile predecessor import is missing' }]);
  }
  const issues: BoundaryValidationIssue[] = [];
  const importRoot = path.join(runDir, 'predecessor');
  if (
    predecessor.pin.taskId !== relation.predecessorTaskId
    || predecessor.pin.profileId !== relation.predecessorProfileId
    || predecessor.sourceManifestSha256 !== predecessor.pin.manifestSha256
    || predecessor.overallVerdict !== 'Pass'
  ) {
    issues.push({ code: 'predecessor-pin-mismatch', message: 'predecessor record differs from the generated relation' });
  }
  try {
    const observedRows = predecessor.importedFiles.map((row) => {
      const bytes = readConfinedRegularFile(importRoot, row.path);
      if (bytes.byteLength !== row.bytes || sha256(bytes) !== row.sha256) {
        issues.push({ code: 'predecessor-import-mutation', message: `predecessor file changed: ${row.path}`, path: row.path });
      }
      return { path: row.path, sha256: sha256(bytes), bytes: bytes.byteLength };
    });
    if (sha256(canonicalizeBoundaryRun(observedRows)) !== predecessor.treeDigestSha256) {
      issues.push({ code: 'predecessor-import-mutation', message: 'predecessor tree digest changed' });
    }
    const sourceManifestBytes = readConfinedRegularFile(importRoot, 'run_manifest.json');
    const sourceValidation = validateBoundaryRunJson(sourceManifestBytes);
    if (!sourceValidation.ok) issues.push(...sourceValidation.issues);
    const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8')) as BoundaryRunManifest;
    const expectedPaths = canonicalSet([
      ...childClosurePaths(sourceManifest),
      'completion/chain_ledger.json',
      'completion/chain_ledger.sha256',
      'completion/completion_receipt.json',
      'completion/completion_receipt.sha256',
    ]);
    if (
      canonicalizeBoundaryRun(expectedPaths)
      !== canonicalizeBoundaryRun(predecessor.importedFiles.map((row) => row.path))
    ) {
      issues.push({ code: 'predecessor-import-mutation', message: 'predecessor imported path set differs from the source manifest closure' });
    }
    if (
      sha256(sourceManifestBytes) !== predecessor.pin.manifestSha256
      || sourceManifest.manifestState !== 'finalized'
      || sourceManifest.overallVerdict !== 'Pass'
      || sourceManifest.run.taskId !== predecessor.pin.taskId
      || sourceManifest.run.profileId !== predecessor.pin.profileId
      || sourceManifest.run.runId !== predecessor.pin.runId
      || sourceManifest.run.terminalHead !== predecessor.pin.terminalHead
      || readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.manifestSha256, 'run_manifest.json')
    ) {
      issues.push({ code: 'predecessor-pin-mismatch', message: 'copied predecessor manifest identity or lock changed' });
    }
    issues.push(...verifyRunInitAnchor(sourceManifest, importRoot).issues);

    const receiptBytes = readConfinedRegularFile(importRoot, 'completion/completion_receipt.json');
    const ledgerBytes = readConfinedRegularFile(importRoot, 'completion/chain_ledger.json');
    if (
      sha256(receiptBytes) !== predecessor.pin.completionReceiptSha256
      || sha256(ledgerBytes) !== predecessor.pin.ledgerSha256
      || readConfinedRegularFile(importRoot, 'completion/completion_receipt.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.completionReceiptSha256, 'completion_receipt.json')
      || readConfinedRegularFile(importRoot, 'completion/chain_ledger.sha256').toString('utf8')
        !== shaLockBytes(predecessor.pin.ledgerSha256, 'chain_ledger.json')
    ) {
      issues.push({ code: 'predecessor-import-mutation', message: 'copied completion receipt or ledger lock changed' });
    }
    const receipt = strictCanonicalObject(receiptBytes, 'copied completion receipt');
    const ledger = strictCanonicalObject(ledgerBytes, 'copied chain ledger');
    const rows = Array.isArray(ledger['rows']) ? ledger['rows'] : [];
    const inherited = {
      reconciledBase: receipt['reconciledBase'],
      upstreamObservedOid: receipt['upstreamObservedOid'],
      corpusDigests: receipt['corpusDigests'],
      oracleDigest: receipt['oracleDigest'],
    };
    if (predecessor.pin.profileId === 'bcf00-observation') {
      if (
        manifest.run.profileId !== 'bcf00-reconciliation'
        || rows.length !== 0
        || sourceManifest.run.chainAppend !== false
        || receipt['manifestSha256'] !== predecessor.pin.manifestSha256
        || receipt['ledgerSha256'] !== predecessor.pin.ledgerSha256
        || manifest.run.entryHead !== predecessor.pin.terminalHead
        || canonicalizeBoundaryRun(inherited) !== canonicalizeBoundaryRun({
          reconciledBase: ledger['reconciledBase'],
          upstreamObservedOid: ledger['upstreamObservedOid'],
          corpusDigests: ledger['corpusDigests'],
          oracleDigest: ledger['oracleDigest'],
        })
      ) {
        issues.push({ code: 'predecessor-observation-mismatch', message: 'copied observation predecessor is not the canonical empty-ledger Pass' });
      }
    } else {
      const chain = validateAndAppendBoundaryPredecessor({
        profileId: manifest.run.profileId,
        pin: predecessor.pin,
        receipt,
        receiptSha256: predecessor.pin.completionReceiptSha256,
        ledger,
        ledgerSha256: predecessor.pin.ledgerSha256,
        inherited,
        currentRow: {
          ordinal: rows.length + 1,
          taskId: relation.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.entryHead,
          manifestSha256: '0'.repeat(64),
          previousLedgerSha256: predecessor.pin.ledgerSha256,
          overallVerdict: 'Pass',
        },
      });
      issues.push(...chain.result.issues);
    }
  } catch (error) {
    issues.push({ code: 'predecessor-import-mutation', message: (error as Error).message });
  }
  return operationResult(issues);
}

function recordChildRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const alias = stringOption(invocation.options, 'alias')!;
  const kind = stringOption(invocation.options, 'kind')!;
  const childRunDir = stringOption(invocation.options, 'childRunDir')!;
  const expectTask = stringOption(invocation.options, 'expectTask')!;
  const expectHead = stringOption(invocation.options, 'expectHead')!;
  const expectRunId = stringOption(invocation.options, 'expectRunId')!;
  const expectManifestSha256 = stringOption(invocation.options, 'expectManifestSha256')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const contract = childContractFor(manifest.run.profileId, alias);
  const dynamicPin = manifest.run.requiredChildPins.find((entry) => entry.alias === alias);
  if (
    contract === undefined
    || dynamicPin === undefined
    || kind !== contract.kind
    || expectTask !== contract.taskId
    || expectHead !== dynamicPin.head
    || expectRunId !== dynamicPin.runId
    || expectManifestSha256 !== dynamicPin.manifestSha256
  ) {
    return operationResult([{ code: 'child-declaration-mismatch', message: 'child declarations differ from the frozen profile pin' }], 2);
  }
  if (
    manifest.children.some((entry) => entry.alias === alias)
    || manifest.children.some((entry) => entry.runId === expectRunId || entry.sourceManifestSha256 === expectManifestSha256)
    || existsSync(path.join(runDir, 'children', alias))
  ) {
    return operationResult([{ code: 'child-alias-collision', message: 'child alias, run ID, or manifest digest was already imported' }], 2);
  }

  let sourceRoot: string;
  let sourceManifestBytes: Buffer;
  let childManifest: BoundaryRunManifest;
  let sourceRows: BoundaryImportedFileRecord[];
  let nestedDepth: number;
  try {
    sourceRoot = realpathSync(childRunDir);
    sourceManifestBytes = readConfinedRegularFile(sourceRoot, 'run_manifest.json');
    if (sha256(sourceManifestBytes) !== expectManifestSha256) {
      return operationResult([{ code: 'child-manifest-digest-mismatch', message: 'source manifest differs from the frozen digest' }], 2);
    }
    const sourceVerification = verifyRun({ command: 'verify', options: { runDir: sourceRoot } }, cwd);
    if (!sourceVerification.ok || sourceVerification.verdict !== 'Pass') {
      return operationResult([
        { code: 'child-source-verification-failed', message: 'source child did not pass read-only verification' },
        ...sourceVerification.issues,
      ]);
    }
    childManifest = JSON.parse(sourceManifestBytes.toString('utf8')) as BoundaryRunManifest;
    if (
      childManifest.manifestState !== 'finalized'
      || childManifest.overallVerdict !== 'Pass'
      || childManifest.run.taskId !== contract.taskId
      || childManifest.run.profileId !== contract.profileId
      || childManifest.run.runId !== dynamicPin.runId
      || childManifest.run.terminalHead === null
    ) {
      return operationResult([{ code: 'child-identity-mismatch', message: 'verified source identity differs from the profile contract' }], 2);
    }
    sourceRows = childClosureRows(sourceRoot, childManifest);
    nestedDepth = importedManifestDepth(childManifest, sourceRoot);
  } catch (error) {
    return operationResult([{ code: 'child-source-verification-failed', message: (error as Error).message }]);
  }

  const child: BoundaryChildRecord = {
    alias,
    kind: contract.kind,
    taskId: childManifest.run.taskId,
    profileId: childManifest.run.profileId,
    runId: childManifest.run.runId,
    entryHead: childManifest.run.entryHead,
    terminalHead: childManifest.run.terminalHead!,
    snapshotDigestSha256: childManifest.currentSnapshot.digestSha256,
    sourceManifestSha256: expectManifestSha256,
    importedFiles: sourceRows,
    treeDigestSha256: sha256(canonicalizeBoundaryRun(sourceRows)),
    overallVerdict: childManifest.overallVerdict,
    dedupeKey: contract.dedupeKey,
  };
  const preflight = validateBoundaryChildImport({
    parentRunId: manifest.run.runId,
    parentDepth: nestedDepth,
    maxDepth: contract.maxDepth,
    importRoot: sourceRoot,
    existingAliases: manifest.children.map((entry) => entry.alias),
    existingPaths: [],
    verifiedSourceManifestSha256: expectManifestSha256,
    pin: {
      alias,
      kind: contract.kind,
      taskId: contract.taskId,
      profileId: contract.profileId,
      runId: dynamicPin.runId,
      entryHead: child.entryHead,
      terminalHead: child.terminalHead,
      manifestSha256: dynamicPin.manifestSha256,
    },
    child,
  });
  const relationIssues = childRelationIssues(manifest, child, contract.headRelation, dynamicPin.head);
  const crossJoinIssues: BoundaryValidationIssue[] = [];
  if (manifest.run.profileId === 'bcf00-reconciliation') {
    const predecessorPin = manifest.predecessor?.pin;
    const completion = childManifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    try {
      if (
        predecessorPin === undefined
        || completion === undefined
        || predecessorPin.taskId !== child.taskId
        || predecessorPin.profileId !== child.profileId
        || predecessorPin.runId !== child.runId
        || predecessorPin.terminalHead !== child.terminalHead
        || predecessorPin.manifestSha256 !== child.sourceManifestSha256
        || predecessorPin.completionReceiptSha256 !== sha256(readConfinedRegularFile(completion.path, 'completion_receipt.json'))
        || predecessorPin.ledgerSha256 !== sha256(readConfinedRegularFile(completion.path, 'chain_ledger.json'))
      ) {
        crossJoinIssues.push({ code: 'child-predecessor-pin-mismatch', message: 'observation child differs from the reconciliation predecessor pin' });
      }
    } catch (error) {
      crossJoinIssues.push({ code: 'child-predecessor-pin-mismatch', message: (error as Error).message });
    }
  }
  const preflightIssues = [...preflight.issues, ...relationIssues, ...crossJoinIssues];
  if (preflightIssues.length > 0) return operationResult(preflightIssues);

  const childrenRoot = path.join(runDir, 'children');
  const importRoot = path.join(childrenRoot, alias);
  try {
    if (!existsSync(childrenRoot)) mkdirSync(childrenRoot, { recursive: false, mode: 0o700 });
    const childrenStat = lstatSync(childrenRoot);
    if (childrenStat.isSymbolicLink() || !childrenStat.isDirectory()) throw new Error('children root is not a helper-owned directory');
    mkdirSync(importRoot, { recursive: false, mode: 0o700 });
    for (const row of sourceRows) {
      const destination = path.join(importRoot, row.path);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      durableExclusiveWrite(destination, readConfinedRegularFile(sourceRoot, row.path));
    }
    const copiedRows = childClosureRows(importRoot, childManifest);
    const copiedChild = {
      ...child,
      importedFiles: copiedRows,
      treeDigestSha256: sha256(canonicalizeBoundaryRun(copiedRows)),
    };
    const copiedValidation = validateBoundaryChildImport({
      parentRunId: manifest.run.runId,
      parentDepth: nestedDepth,
      maxDepth: contract.maxDepth,
      importRoot,
      existingAliases: manifest.children.map((entry) => entry.alias),
      existingPaths: [],
      verifiedSourceManifestSha256: expectManifestSha256,
      pin: {
        alias,
        kind: contract.kind,
        taskId: contract.taskId,
        profileId: contract.profileId,
        runId: dynamicPin.runId,
        entryHead: copiedChild.entryHead,
        terminalHead: copiedChild.terminalHead,
        manifestSha256: dynamicPin.manifestSha256,
      },
      child: copiedChild,
    });
    if (!copiedValidation.ok) return copiedValidation;
    const copiedManifestLock = readConfinedRegularFile(importRoot, 'run_manifest.sha256').toString('utf8');
    if (copiedManifestLock !== shaLockBytes(expectManifestSha256, 'run_manifest.json')) {
      return operationResult([{ code: 'child-manifest-lock-mismatch', message: 'copied manifest lock differs from the frozen digest' }]);
    }
    manifest.children = [...manifest.children, copiedChild]
      .sort((left, right) => Buffer.from(left.alias).compare(Buffer.from(right.alias)));
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) return validation;
    durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
    return operationResult([], 0, 'Pass');
  } catch (error) {
    return operationResult([{ code: 'child-import-failed', message: (error as Error).message }]);
  }
}

function gitPathSet(cwd: string, args: readonly string[]): string[] {
  const stdout = gitText(cwd, args);
  return canonicalSet(stdout === '' ? [] : stdout.split('\n').filter((entry) => entry !== ''));
}

export const BOUNDARY_IMPLEMENTED_INTERNAL_CHECKS = [
  'docs-authoring-scope',
  'docs-lineage-scope',
  'output-budget-contract',
  'producer-inventory-contract',
  'read-only-scope',
  'readiness-contract',
  'review-contract',
  'staged-scope',
  'worktree-scope',
] as const;

function evaluateInternalCheck(
  check: string,
  manifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
  snapshot: NonNullable<ReturnType<typeof captureBoundaryWorktreeSnapshot>['snapshot']>,
): {
  result: BoundaryValidationResult;
  details: Record<string, unknown>;
  structuredRecord?: Record<string, unknown>;
  structuredPath?: string;
  artifactRole?: 'receipt' | 'measurement' | 'scope';
  reuseStructuredArtifact?: boolean;
} {
  const changedPaths = gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']);
  const stagedPaths = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
  const unstagedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
  const allowedPaths = manifest.run.allowedPaths;
  const foreignPaths = changedPaths.filter((entry) => !allowedPaths.includes(entry));
  const ownerStable = canonicalizeBoundaryRun(snapshot.preservedOwner)
    === canonicalizeBoundaryRun(manifest.entrySnapshot.preservedOwner);
  const issues: BoundaryValidationIssue[] = [];
  let structuredRecord: Record<string, unknown> | undefined;
  let structuredPath: string | undefined;
  let artifactRole: 'receipt' | 'measurement' | 'scope' | undefined;
  let reuseStructuredArtifact = false;
  if (foreignPaths.length > 0) {
    issues.push({ code: 'internal-scope-foreign-path', message: `tracked paths exceed profile scope: ${foreignPaths.join(', ')}` });
  }
  if (!ownerStable) issues.push({ code: 'internal-scope-owner-drift', message: 'preserved owner paths changed' });
  switch (check) {
    case 'worktree-scope':
      break;
    case 'readiness-contract': {
      const prerequisiteAttempts = manifest.run.requiredAttemptIds
        .filter((id) => id !== 'readiness-check')
        .map((id) => manifest.attempts.find((entry) => entry.id === id));
      const evidence = prerequisiteAttempts
        .filter((attempt): attempt is NonNullable<typeof attempt> => attempt !== undefined)
        .map((attempt) => {
          const stream = attempt.structuredResult ?? attempt.stdout;
          return {
            evidenceId: attempt.id,
            artifactPath: stream.path,
            producerAttemptId: attempt.id,
            sha256: stream.sha256,
            verdict: attempt.verdict,
          };
        })
        .sort((left, right) => Buffer.from(left.evidenceId).compare(Buffer.from(right.evidenceId)));
      const evidenceRefs = evidence.map((entry) => entry.evidenceId);
      const dueConditions = [
        manifest.run.profileId === 'bcf00-reconciliation',
        manifest.lifecycle.status === 'completed',
        manifest.lifecycle.finalGate === 'pass',
        manifest.lifecycle.oracle === 'current',
        prerequisiteAttempts.length === manifest.run.requiredAttemptIds.length - 1,
        prerequisiteAttempts.every((attempt) => attempt?.expectationMet === true && attempt.verdict === 'Pass'),
        manifest.run.requiredChildAliases.every((alias) => {
          const child = manifest.children.find((entry) => entry.alias === alias);
          return child?.overallVerdict === 'Pass';
        }),
        manifest.upstream.observedOid !== 'not-observed',
      ];
      const ready = dueConditions.every(Boolean);
      const blockers = ready ? [] : [{
        blockerId: 'reconciliation-evidence-incomplete',
        reason: 'One or more required reconciliation attempts, children, lifecycle fields, or upstream identities are non-pass.',
        evidenceRefs,
      }];
      const riskEvidence = evidence.find((entry) => entry.evidenceId === 'predecessor-branch-gate') ?? evidence[0];
      const risks = riskEvidence === undefined ? [] : [{
        riskId: 'later-checkpoints',
        owner: 'implementation-lead',
        checkpoint: 'before each dependent boundary task',
        artifactPath: riskEvidence.artifactPath,
        artifactSha256: riskEvidence.sha256,
        stopCondition: 'Stop when a constrained assumption, bound artifact, corpus, tool, or upstream identity changes.',
      }];
      structuredRecord = {
        schemaVersion: 1,
        runId: manifest.run.runId,
        taskId: manifest.run.taskId,
        profileId: manifest.run.profileId,
        head: manifest.run.terminalHead ?? snapshot.head,
        snapshotDigestSha256: snapshot.digestSha256,
        readinessState: ready ? 'Ready with Constraints' : 'Not Ready',
        evaluatedAtUtc: new Date().toISOString(),
        evidence,
        assumptions: ['A-08', 'A-09', 'A-10'].map((assumptionId) => ({
          assumptionId,
          disposition: ready ? 'validated' : 'blocked',
          evidenceRefs,
        })),
        risks,
        blockers,
        decisionRationale: ready
          ? 'All due reconciliation assumptions passed; later boundary checkpoints remain constrained.'
          : 'Required reconciliation evidence is missing, non-pass, or no longer identity-consistent.',
        decisionAuthority: 'implementation-lead',
        nextAllowedAction: ready ? 'BCF-01' : null,
        overallVerdict: ready ? 'Pass' : 'Inconclusive',
      };
      const structuredValidation = validateBoundaryStructuredRecord('ReadinessRecord', structuredRecord);
      issues.push(...structuredValidation.issues);
      if (!ready) issues.push({ code: 'readiness-not-ready', message: 'reconciliation is not ready for BCF-01' });
      structuredPath = 'readiness.json';
      artifactRole = 'receipt';
      break;
    }
    case 'producer-inventory-contract': {
      const queryArgv = [
        'rg', '-n', 'buildBoundaryReceipt\\(|buildSemanticReceipt\\(|schemaVersion',
        'scripts', 'tests', 'docs', '--glob', '*.ts', '--glob', '*.md',
      ];
      const rgCapability = manifest.run.observedTools.find((entry) => entry.name === 'rg');
      if (rgCapability === undefined) {
        issues.push({ code: 'consumer-inventory-tool-missing', message: 'the frozen rg capability is unavailable' });
        break;
      }
      try {
        const raw = execFileSync(rgCapability.realPath, queryArgv.slice(1), {
          cwd,
          encoding: 'utf8',
          env: reconstructedChildEnvironment(cwd),
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const inventoryMatches: Array<Record<string, unknown>> = [];
        const tokenPattern = /buildBoundaryReceipt\(|buildSemanticReceipt\(|schemaVersion/g;
        for (const outputLine of raw.split('\n')) {
          if (outputLine === '') continue;
          const parsed = /^([^:]+):(\d+):(.*)$/.exec(outputLine);
          if (parsed === null) throw new Error(`unparseable inventory row: ${outputLine.slice(0, 160)}`);
          const [, relativePath, lineText, sourceLine] = parsed;
          tokenPattern.lastIndex = 0;
          for (let match = tokenPattern.exec(sourceLine!); match !== null; match = tokenPattern.exec(sourceLine!)) {
            const matchedToken = match[0]!;
            inventoryMatches.push({
              path: relativePath,
              line: Number(lineText),
              column: match.index + 1,
              matchKind: matchedToken === 'schemaVersion'
                ? /schemaVersion\s*(?:===?|:)\s*1\b/.test(sourceLine!)
                  ? 'compatibility-read'
                  : 'schema-reference'
                : 'producer-call',
              matchedToken,
              lineSha256: sha256(`${sourceLine}\n`),
            });
          }
        }
        inventoryMatches.sort((left, right) => {
          for (const key of ['path', 'line', 'column', 'matchKind', 'matchedToken'] as const) {
            const leftValue = left[key];
            const rightValue = right[key];
            if (typeof leftValue === 'number' && typeof rightValue === 'number' && leftValue !== rightValue) return leftValue - rightValue;
            const compared = Buffer.from(String(leftValue)).compare(Buffer.from(String(rightValue)));
            if (compared !== 0) return compared;
          }
          return 0;
        });
        const localConsumers = inventoryMatches.map((row, index) => {
          const matchRef = `${String(row['path'])}:${String(row['line'])}:${String(row['column'])}:${String(row['matchKind'])}:${String(row['matchedToken'])}`;
          const relativePath = String(row['path']);
          const kind = row['matchKind'] === 'producer-call'
            ? 'producer'
            : relativePath.startsWith('tests/')
              ? 'test'
              : relativePath.startsWith('docs/')
                ? 'documentation'
                : 'reader';
          return {
            consumerId: `consumer-${String(index + 1).padStart(4, '0')}`,
            kind,
            path: relativePath,
            symbol: String(row['matchedToken']).replace(/\($/, ''),
            schemaSupport: 'schema-1',
            matchRefs: [matchRef],
          };
        });
        const packageJson = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { version?: unknown };
        structuredRecord = {
          schemaVersion: 1,
          runId: manifest.run.runId,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          head: manifest.run.entryHead,
          snapshotDigestSha256: snapshot.digestSha256,
          packageVersion: packageJson.version,
          currentProducerSchema: 1,
          proposedProducerSchema: 2,
          supportStage: 'beta-shadow-only',
          inventoryQuerySha256: sha256(canonicalizeBoundaryRun(queryArgv)),
          inventoryMatches,
          localConsumers,
          externalConsumers: 'unknown',
          compatibilityReader: 'schema-1-read-render',
          rollbackCommit: manifest.predecessor?.pin.terminalHead ?? '',
          decision: 'pre-1.0-shadow-compatible',
          releaseNoteRequired: false,
          limitations: ['external-consumers-unknown'],
          overallVerdict: 'Pass',
        };
        const structuredValidation = validateBoundaryStructuredRecord('ConsumerVersionDecision', structuredRecord);
        issues.push(...structuredValidation.issues);
        structuredPath = 'consumer-version-decision.json';
        artifactRole = 'receipt';
      } catch (error) {
        issues.push({ code: 'consumer-inventory-failed', message: (error as Error).message });
      }
      break;
    }
    case 'output-budget-contract': {
      const artifact = manifest.artifacts.find((entry) => entry.path === 'feedback-measurements.json');
      const producer = manifest.attempts.find((entry) => entry.id === 'feedback-green');
      if (
        artifact === undefined
        || artifact.producerAttemptId !== 'feedback-green'
        || artifact.role !== 'measurement'
        || producer?.verdict !== 'Pass'
      ) {
        issues.push({ code: 'feedback-measurement-missing', message: 'the accepted feedback-green measurement artifact is unavailable' });
        break;
      }
      try {
        const bytes = readConfinedRegularFile(runDir, artifact.path);
        if (sha256(bytes) !== artifact.sha256 || bytes.byteLength !== artifact.bytes) {
          throw new Error('measurement bytes differ from the producer-bound artifact');
        }
        const parsed = parseBoundaryJsonBytes(bytes);
        if (
          !parsed.result.ok
          || parsed.value === null
          || parsed.value === undefined
          || typeof parsed.value !== 'object'
          || Array.isArray(parsed.value)
        ) {
          issues.push(...parsed.result.issues);
          break;
        }
        const measurement = parsed.value as Record<string, unknown>;
        structuredRecord = measurement;
        const structuredValidation = validateBoundaryStructuredRecord('FeedbackMeasurements', measurement);
        issues.push(...structuredValidation.issues);
        if (
          measurement['runId'] !== manifest.run.runId
          || measurement['taskId'] !== manifest.run.taskId
          || measurement['profileId'] !== manifest.run.profileId
          || measurement['head'] !== manifest.run.entryHead
          || measurement['snapshotDigestSha256'] !== producer.postSnapshot.digestSha256
        ) {
          issues.push({ code: 'feedback-measurement-identity-mismatch', message: 'measurement identity differs from feedback-green' });
        }
        structuredPath = artifact.path;
        artifactRole = 'measurement';
        reuseStructuredArtifact = true;
      } catch (error) {
        issues.push({ code: 'feedback-measurement-invalid', message: (error as Error).message });
      }
      break;
    }
    case 'docs-lineage-scope': {
      try {
        if (manifest.run.profileId !== 'bcf08b-docs' || manifest.predecessor === null) {
          throw new Error('docs lineage requires the BCF-08B predecessor chain');
        }
        const predecessorCompletion = path.join(runDir, 'predecessor', 'completion');
        const ledger = strictCanonicalObject(
          readConfinedRegularFile(predecessorCompletion, 'chain_ledger.json'),
          'docs predecessor chain ledger',
        );
        const rows = Array.isArray(ledger['rows']) ? ledger['rows'] as Array<Record<string, unknown>> : [];
        const reconciliation = rows.find((row) => row['profileId'] === 'bcf00-reconciliation');
        if (reconciliation === undefined) throw new Error('reconciliation ledger row is unavailable');
        const validatorCommit = String(reconciliation['entryHead']);
        const upstreamMerge = String(reconciliation['terminalHead']);
        const reconciledBase = String(ledger['reconciledBase']);
        const upstreamObservedOid = String(ledger['upstreamObservedOid']);
        const validatorBase = gitText(cwd, ['rev-parse', `${validatorCommit}^`]);
        const mergeParents = gitText(cwd, ['rev-list', '--parents', '-n', '1', upstreamMerge]).split(/\s+/).slice(1);
        if (
          mergeParents.length !== 2
          || mergeParents[0] !== validatorCommit
          || mergeParents[1] !== upstreamObservedOid
          || reconciledBase !== upstreamMerge
        ) throw new Error('validator, reconciliation, or upstream parent identity is inconsistent');
        const operationSpecs: Array<{ id: string; args: string[] }> = [
          { id: 'diff-check', args: ['diff', '--check'] },
          { id: 'status-short', args: ['status', '--short'] },
          { id: 'validator-endpoints', args: ['rev-parse', validatorBase, validatorCommit] },
          { id: 'validator-name-status', args: ['diff', '--name-status', validatorBase, validatorCommit] },
          { id: 'validator-stat', args: ['diff', '--stat', validatorBase, validatorCommit] },
          { id: 'merge-origin', args: ['rev-parse', `${upstreamMerge}^1`, `${upstreamMerge}^2`, 'origin/main'] },
          { id: 'upstream-name-status', args: ['diff', '--name-status', `${upstreamMerge}^1`, upstreamMerge] },
          { id: 'upstream-stat', args: ['diff', '--stat', `${upstreamMerge}^1`, upstreamMerge] },
          { id: 'authored-name-status', args: ['diff', '--name-status', `${reconciledBase}...HEAD`] },
          { id: 'authored-stat', args: ['diff', '--stat', `${reconciledBase}...HEAD`] },
        ];
        const operations: Array<Record<string, unknown>> = [];
        const outputs = new Map<string, string>();
        for (const [index, spec] of operationSpecs.entries()) {
          let rawExit: number | null = 0;
          let rawSignal: string | null = null;
          let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
          try {
            stdout = execFileSync(capabilityForManifest(manifest, 'git').realPath, spec.args, {
              cwd,
              env: reconstructedChildEnvironment(cwd),
              maxBuffer: 64 * 1024 * 1024,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch (error) {
            const failure = error as NodeJS.ErrnoException & {
              status?: number | null;
              signal?: string | null;
              stdout?: Buffer;
              stderr?: Buffer;
            };
            rawExit = typeof failure.status === 'number' ? failure.status : null;
            rawSignal = typeof failure.signal === 'string' ? failure.signal : rawExit === null ? 'SIGUNKNOWN' : null;
            stdout = Buffer.isBuffer(failure.stdout) ? failure.stdout : Buffer.alloc(0);
            stderr = Buffer.isBuffer(failure.stderr) ? failure.stderr : Buffer.from(failure.message);
          }
          const stdoutText = stdout.toString('utf8').trim();
          outputs.set(spec.id, stdoutText);
          const parsedOids = (spec.id === 'validator-endpoints' || spec.id === 'merge-origin')
            ? canonicalSet(stdoutText === '' ? [] : stdoutText.split(/\s+/).filter((entry) => /^[0-9a-f]{40}$/.test(entry)))
            : [];
          const parsedPaths = spec.id.endsWith('name-status')
            ? canonicalSet(stdoutText === '' ? [] : stdoutText.split('\n').flatMap((line) => line.split('\t').slice(1)))
            : [];
          const expectationMet = rawExit === 0 && rawSignal === null;
          operations.push({
            ordinal: index + 1,
            operationId: spec.id,
            argv: ['git', ...spec.args],
            rawExit,
            rawSignal,
            stdoutSha256: sha256(stdout),
            stderrSha256: sha256(stderr),
            parsedOids,
            parsedPaths,
            expectationMet,
            verdict: expectationMet ? 'Pass' : 'Inconclusive',
          });
        }
        const parseNameStatus = (operationId: string, source: string): Array<Record<string, unknown>> => {
          const value = outputs.get(operationId) ?? '';
          return value === '' ? [] : value.split('\n').flatMap((line) => {
            const fields = line.split('\t');
            const status = fields[0]!;
            return fields.slice(1).map((relativePath) => ({ path: relativePath, status, source }));
          });
        };
        const pathClasses = [
          ...parseNameStatus('validator-name-status', 'validator'),
          ...parseNameStatus('upstream-name-status', 'upstream'),
          ...parseNameStatus('authored-name-status', 'authored'),
        ].sort((left, right) => {
          for (const key of ['path', 'source', 'status'] as const) {
            const compared = Buffer.from(String(left[key])).compare(Buffer.from(String(right[key])));
            if (compared !== 0) return compared;
          }
          return 0;
        });
        const validatorPaths = pathClasses
          .filter((row) => row['source'] === 'validator')
          .map((row) => row['path']);
        const expectedValidatorPaths = [
          'scripts/lib/verification/boundary-run-manifest.ts',
          'scripts/verify-boundary-run.ts',
          'tests/scripts/verify-boundary-run.test.ts',
        ];
        if (canonicalizeBoundaryRun(canonicalSet(validatorPaths as string[])) !== canonicalizeBoundaryRun(expectedValidatorPaths)) {
          throw new Error('validator interval differs from the exact three-file bootstrap');
        }
        const mergeOrigin = (outputs.get('merge-origin') ?? '').split(/\s+/);
        if (
          mergeOrigin.length !== 3
          || mergeOrigin[0] !== validatorCommit
          || mergeOrigin[1] !== upstreamObservedOid
          || mergeOrigin[2] !== upstreamObservedOid
        ) throw new Error('merge parents or origin/main moved during lineage derivation');
        const authoredAllowed = new Set(
          Object.values(RUN_CONTRACT_PROFILES)
            .flatMap((profile) => Array.isArray(profile.allowedPaths) ? profile.allowedPaths : []),
        );
        const foreignAuthored = pathClasses
          .filter((row) => row['source'] === 'authored' && !authoredAllowed.has(String(row['path'])));
        if (foreignAuthored.length > 0) throw new Error('authored interval contains a path outside the Required File Interface');
        const hashTrackedFile = (relativePath: string): string => sha256(readFileSync(path.join(cwd, relativePath)));
        const publicationAudit = manifest.entrySnapshot.preservedOwner.find((entry) => entry.path === 'docs/publication-audit.md');
        if (publicationAudit === undefined) throw new Error('publication audit is not preserved by the B docs run');
        structuredRecord = {
          schemaVersion: 1,
          runId: manifest.run.runId,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          head: snapshot.head,
          snapshotDigestSha256: snapshot.digestSha256,
          anchors: {
            validatorBase,
            validatorCommit,
            upstreamMerge,
            upstreamFirstParent: mergeParents[0],
            upstreamSecondParent: mergeParents[1],
            originMain: mergeOrigin[2],
            reconciledBase,
            docsEntryHead: manifest.run.entryHead,
            docsCurrentHead: snapshot.head,
          },
          operations,
          pathClasses,
          bEntryIdentity: {
            snapshotDigestSha256: manifest.entrySnapshot.digestSha256,
            publicSurfaceSha256: hashTrackedFile('docs/public-surface.md'),
            publicationAuditSha256: publicationAudit.sha256,
            handoffSha256: hashTrackedFile('docs/superpowers/handoffs/2026-07-16-boundary-contract-feedback-implementation-notes.md'),
            workIndexJsonSha256: hashTrackedFile('docs/work-index.json'),
            workIndexMarkdownSha256: hashTrackedFile('docs/work-index.md'),
          },
          overallVerdict: operations.every((row) => row['verdict'] === 'Pass') ? 'Pass' : 'Inconclusive',
        };
        const structuredValidation = validateBoundaryStructuredRecord('DocsLineageReport', structuredRecord);
        issues.push(...structuredValidation.issues);
        structuredPath = 'docs-lineage.json';
        artifactRole = 'scope';
      } catch (error) {
        issues.push({ code: 'docs-lineage-invalid', message: (error as Error).message });
      }
      break;
    }
    case 'read-only-scope':
      if (changedPaths.length > 0 || canonicalizeBoundaryRun(snapshot) !== canonicalizeBoundaryRun(manifest.entrySnapshot)) {
        issues.push({ code: 'internal-read-only-drift', message: 'read-only scope changed the worktree' });
      }
      break;
    case 'staged-scope':
      if (canonicalizeBoundaryRun(stagedPaths) !== canonicalizeBoundaryRun(allowedPaths) || unstagedPaths.length > 0) {
        issues.push({ code: 'internal-staged-scope-mismatch', message: 'staged paths are not the exact profile allowlist' });
      }
      break;
    case 'docs-authoring-scope':
      if (stagedPaths.length > 0 || manifest.children.length !== manifest.run.requiredChildAliases.length) {
        issues.push({ code: 'internal-docs-authoring-incomplete', message: 'docs authoring scope requires no staged paths and all child joins' });
      }
      break;
    case 'review-contract':
      issues.push(...verifyRecordedReviews(manifest, runDir, true));
      break;
    default:
      issues.push({ code: 'internal-check-not-implemented', message: `internal check is not implemented: ${check}` });
  }
  return {
    result: operationResult(issues),
    details: { check, changedPaths, stagedPaths, unstagedPaths, foreignPaths, ownerStable },
    ...(structuredRecord === undefined ? {} : { structuredRecord }),
    ...(structuredPath === undefined ? {} : { structuredPath }),
    ...(artifactRole === undefined ? {} : { artifactRole }),
    ...(reuseStructuredArtifact ? { reuseStructuredArtifact: true } : {}),
  };
}

function recordInternalCheck(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (manifest.attempts.some((entry) => entry.id === attemptId) || existsSync(path.join(runDir, 'attempts', attemptId))) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  if (!manifest.run.requiredAttemptIds.includes(attemptId)) {
    return operationResult([{ code: 'attempt-not-required', message: `attempt is not owned by the profile: ${attemptId}` }], 2);
  }
  const contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  if (contract === undefined || contract.operation !== 'internal-check' || contract.internalCheck === null) {
    return operationResult([{ code: 'attempt-operation-mismatch', message: 'attempt is not an internal-check contract' }], 2);
  }
  const expectedHead = contract.headAnchor === 'entry' ? manifest.run.entryHead : manifest.run.terminalHead;
  if (expectedHead === null || gitText(cwd, ['rev-parse', 'HEAD']) !== expectedHead) {
    return operationResult([{ code: 'attempt-head-anchor-mismatch', message: 'Git head differs from the internal-check anchor' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  const startedAtUtc = new Date().toISOString();
  const evaluated = evaluateInternalCheck(contract.internalCheck, manifest, runDir, cwd, before.snapshot);
  if (
    evaluated.structuredPath !== undefined
    && !evaluated.reuseStructuredArtifact
    && !contract.outputPaths.includes(evaluated.structuredPath)
  ) {
    return operationResult([{
      code: 'internal-check-output-contract-mismatch',
      message: 'helper-derived output path differs from the frozen internal-check contract',
    }], 2);
  }
  if (evaluated.result.ok && contract.outputPaths.length > 0 && evaluated.structuredPath === undefined) {
    return operationResult([{
      code: 'internal-check-required-output-missing',
      message: 'successful internal check did not derive its profile-owned output',
    }]);
  }
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!after.ok || after.snapshot === null) return operationResult(after.issues);
  const attemptDir = path.join(runDir, 'attempts', attemptId);
  const structuredPath = evaluated.structuredPath
    ?? contract.outputPaths[0]
    ?? `attempts/${attemptId}/structured-result.json`;
  try {
    mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    durableExclusiveWrite(path.join(attemptDir, 'stdout.log'), '');
    durableExclusiveWrite(path.join(attemptDir, 'stderr.log'), '');
    if (!evaluated.reuseStructuredArtifact) {
      durableExclusiveWrite(path.join(runDir, structuredPath), canonicalizeBoundaryRun(
        evaluated.structuredRecord ?? {
          schemaVersion: 1,
          attemptId,
          ...evaluated.details,
          issues: evaluated.result.issues,
          verdict: evaluated.result.verdict,
        },
      ));
    }
  } catch (error) {
    return operationResult([{ code: 'attempt-directory-failed', message: (error as Error).message }]);
  }
  const rawExit = evaluated.result.ok ? 0 : 1;
  const status = {
    expectedExit: contract.expectedExit,
    rawExit,
    rawSignal: null,
    expectationMet: evaluated.result.ok,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const statusValidation = validateBoundaryAttemptStatus(status, { rawExit, rawSignal: null }, contract);
  const verdict = evaluated.result.ok && statusValidation.ok ? 'Pass' as const : 'Inconclusive' as const;
  const structuredStream = streamRecord(runDir, structuredPath);
  const ownsStructuredOutput = contract.outputPaths.includes(structuredPath) && !evaluated.reuseStructuredArtifact;
  const declaredOutputs = ownsStructuredOutput ? [...contract.outputPaths] : [];
  const outputAdmissions = !ownsStructuredOutput ? [] : [{
    path: structuredPath,
    state: 'admitted' as const,
    role: evaluated.artifactRole ?? 'receipt' as const,
    sha256: structuredStream.sha256,
    bytes: structuredStream.bytes,
  }];
  manifest.attempts.push({
    id: attemptId,
    operation: 'internal-check',
    headAnchor: contract.headAnchor,
    argv: [],
    cwd,
    startedAtUtc,
    endedAtUtc: new Date().toISOString(),
    ...status,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot,
    stdout: streamRecord(runDir, `attempts/${attemptId}/stdout.log`),
    stderr: streamRecord(runDir, `attempts/${attemptId}/stderr.log`),
    declaredOutputs,
    outputAdmissions,
    structuredResult: structuredStream,
    verdict,
  });
  if (ownsStructuredOutput) {
    manifest.artifacts.push({
      path: structuredPath,
      role: evaluated.artifactRole ?? 'receipt',
      producerAttemptId: attemptId,
      sha256: structuredStream.sha256,
      bytes: structuredStream.bytes,
    });
  }
  manifest.currentSnapshot = structuredClone(after.snapshot);
  manifest.overallVerdict = aggregateRunVerdict(manifest);
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
  const issues = [...evaluated.result.issues, ...statusValidation.issues];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}

async function recordGitTransition(
  invocation: BoundaryRunInvocation,
  cwd: string,
): Promise<BoundaryValidationResult> {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attempt')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest, path: manifestPath } = loaded;
  if (
    manifest.attempts.some((entry) => entry.id === attemptId)
    || existsSync(path.join(runDir, 'attempts', attemptId))
  ) {
    return operationResult([{ code: 'attempt-duplicate', message: `attempt already exists: ${attemptId}` }], 2);
  }
  if (!manifest.run.requiredAttemptIds.includes(attemptId)) {
    return operationResult([{ code: 'attempt-not-required', message: `attempt is not owned by the profile: ${attemptId}` }], 2);
  }
  const contract = RUN_ATTEMPT_CONTRACTS[attemptId];
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  const kind = stringOption(invocation.options, 'kind') as 'commit' | 'merge';
  const expectedBefore = stringOption(invocation.options, 'expectBefore')!;
  const expectedSecondParent = stringOption(invocation.options, 'expectSecondParent') ?? null;
  const messageSubject = stringOption(invocation.options, 'messageSubject') ?? null;
  const expectedChildAliases = profile === undefined
    ? []
    : (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!);
  if (
    contract === undefined
    || contract.operation !== 'git-transition'
    || profile === undefined
    || profile.taskId !== manifest.run.taskId
    || profile.transition !== kind
    || contract.transitionKind !== kind
    || contract.messageSubject !== messageSubject
    || expectedBefore !== manifest.run.entryHead
    || (kind === 'commit' && expectedSecondParent !== null)
    || canonicalizeBoundaryRun(manifest.run.requiredAttemptIds)
      !== canonicalizeBoundaryRun(profile?.requiredAttemptIds ?? [])
    || canonicalizeBoundaryRun(manifest.run.requiredChildAliases)
      !== canonicalizeBoundaryRun(expectedChildAliases)
  ) {
    return operationResult([{
      code: 'transition-contract-mismatch',
      message: 'Git transition invocation differs from its profile-owned contract',
    }], 2);
  }
  if (manifest.run.transitionCount !== 0 || manifest.run.terminalHead !== null) {
    return operationResult([{ code: 'transition-already-used', message: 'run already consumed its sole Git transition' }], 2);
  }
  const capability = resolveBoundaryToolCapability('git');
  const frozenCapability = manifest.run.observedTools.find((entry) => entry.name === 'git');
  if (frozenCapability === undefined || canonicalizeBoundaryRun(frozenCapability) !== canonicalizeBoundaryRun(capability)) {
    return operationResult([{ code: 'attempt-tool-capability-mismatch', message: 'Git identity changed since init' }]);
  }
  const beforeHead = gitText(cwd, ['rev-parse', 'HEAD']);
  if (beforeHead !== expectedBefore) {
    return operationResult([{ code: 'transition-parent-mismatch', message: 'Git head differs from the frozen transition parent' }]);
  }
  const before = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!before.ok || before.snapshot === null) return operationResult(before.issues);
  if (canonicalizeBoundaryRun(before.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'transition-pre-snapshot-drift', message: 'worktree changed before Git transition' }]);
  }
  const allowedPaths = canonicalSet(manifest.run.allowedPaths);
  const stagedPaths = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
  const changedPathsBefore = gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']);
  const unstagedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
  const prePathsValid = kind === 'commit'
    ? canonicalizeBoundaryRun(stagedPaths) === canonicalizeBoundaryRun(allowedPaths)
      && canonicalizeBoundaryRun(changedPathsBefore) === canonicalizeBoundaryRun(allowedPaths)
      && unstagedPaths.length === 0
    : stagedPaths.length === 0 && changedPathsBefore.length === 0 && unstagedPaths.length === 0;
  if (!prePathsValid) {
    return operationResult([{
      code: 'transition-path-mismatch',
      message: kind === 'commit'
        ? 'staged and changed paths must equal the exact profile allowlist with no unstaged delta'
        : 'merge transition requires an unchanged pre-merge index and worktree',
    }], 2);
  }
  let observationUpstream: BoundaryRunManifest['upstream'] | null = null;
  let previewConflictPaths: string[] = [];
  if (kind === 'commit') {
    if (
      !Array.isArray(profile!.allowedPaths)
      || canonicalizeBoundaryRun(allowedPaths) !== canonicalizeBoundaryRun(profile!.allowedPaths)
    ) {
      return operationResult([{ code: 'transition-path-mismatch', message: 'commit allowlist differs from its profile' }], 2);
    }
  } else {
    const evidence = verifyManifestEvidence(manifest, runDir, cwd, false);
    if (evidence.length > 0) return operationResult(evidence);
    try {
      const predecessor = manifest.predecessor;
      if (predecessor === null) throw new Error('merge predecessor is unavailable');
      const sourceBytes = readConfinedRegularFile(path.join(runDir, 'predecessor'), 'run_manifest.json');
      const sourceValidation = validateBoundaryRunJson(sourceBytes);
      if (!sourceValidation.ok) throw new Error('merge observation manifest is invalid');
      const source = JSON.parse(sourceBytes.toString('utf8')) as BoundaryRunManifest;
      observationUpstream = source.upstream;
      const preview = acceptedAttemptStdout(source, path.join(runDir, 'predecessor'), 'merge-preview');
      previewConflictPaths = canonicalSet(preview.split('\n').flatMap((line) => {
        const conflict = /CONFLICT \([^)]*\): .* in (.+)$/.exec(line);
        if (conflict !== null) return [conflict[1]!];
        const stage = /^[0-7]{6} [0-9a-f]{40} [123]\t(.+)$/.exec(line);
        return stage === null ? [] : [stage[1]!];
      }));
      if (
        source.run.profileId !== 'bcf00-observation'
        || source.manifestState !== 'finalized'
        || source.overallVerdict !== 'Pass'
        || source.upstream.observedOid !== expectedSecondParent
        || canonicalizeBoundaryRun(source.upstream.remotePaths) !== canonicalizeBoundaryRun(allowedPaths)
        || predecessor.pin.manifestSha256 !== sha256(sourceBytes)
      ) {
        throw new Error('merge parent or allowlist differs from the pinned observation');
      }
    } catch (error) {
      return operationResult([{ code: 'transition-observation-mismatch', message: (error as Error).message }], 2);
    }
  }
  let frozenIndexTreeOid: string;
  try {
    frozenIndexTreeOid = gitText(cwd, ['write-tree']);
  } catch (error) {
    return operationResult([{ code: 'transition-index-freeze-failed', message: (error as Error).message }]);
  }
  const attemptDir = path.join(runDir, 'attempts', attemptId);
  try {
    mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    return operationResult([{
      code: (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'attempt-duplicate' : 'attempt-directory-failed',
      message: (error as Error).message,
    }], (error as NodeJS.ErrnoException).code === 'EEXIST' ? 2 : 1);
  }
  const stdoutPath = `attempts/${attemptId}/stdout.log`;
  const stderrPath = `attempts/${attemptId}/stderr.log`;
  const logicalArgv = kind === 'commit'
    ? ['git', 'commit', '-m', messageSubject!]
    : ['git', 'merge', '--no-edit', expectedSecondParent!];
  const directStdoutPath = kind === 'merge' ? path.join(attemptDir, '.merge-stdout.tmp') : path.join(runDir, stdoutPath);
  const directStderrPath = kind === 'merge' ? path.join(attemptDir, '.merge-stderr.tmp') : path.join(runDir, stderrPath);
  let outcome = await runBoundaryAttemptProcess([capability.realPath, ...logicalArgv.slice(1)], {
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
    expectedExit: contract.expectedExit,
    cwd,
    env: reconstructedChildEnvironment(cwd),
    stdinPath: null,
    stdoutPath: directStdoutPath,
    stderrPath: directStderrPath,
  });
  let directSucceeded = outcome.rawExit === 0 && outcome.rawSignal === null && outcome.result.ok;
  let conflictPaths: string[] = [];
  let conflictResolutionReport: Record<string, unknown> | null = null;
  const resolutionStdout: Buffer[] = [];
  const resolutionStderr: Buffer[] = [];
  let abortAttempted = false;
  let abortRestored: boolean | null = null;
  let abortIssues: BoundaryValidationIssue[] = [];
  if (kind === 'merge' && !directSucceeded) {
    conflictPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
    const generatedIndexPaths = ['docs/work-index.json', 'docs/work-index.md'];
    const resolutionEligible = manifest.run.profileId === 'bcf00-reconciliation'
      && expectedSecondParent === '5d16cd401e1250f417f7bde481a4cc8b0ad1df55'
      && canonicalizeBoundaryRun(conflictPaths) === canonicalizeBoundaryRun(generatedIndexPaths)
      && canonicalizeBoundaryRun(previewConflictPaths) === canonicalizeBoundaryRun(generatedIndexPaths);
    if (resolutionEligible) {
      const indexStages = gitText(cwd, ['ls-files', '-u', '--', ...generatedIndexPaths])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parsed = /^([0-7]{6}) ([0-9a-f]{40}) ([123])\t(.+)$/.exec(line);
          if (parsed === null) throw new Error(`invalid conflict stage: ${line}`);
          return { path: parsed[4]!, stage: Number(parsed[3]), mode: parsed[1]!, oid: parsed[2]! };
        })
        .sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)) || left.stage - right.stage);
      const deadlineAt = Date.parse(outcome.startedAtUtc) + contract.deadlineMs;
      const runResolutionStep = async (
        label: string,
        argv: string[],
        expectedExit = '0',
      ): Promise<Awaited<ReturnType<typeof runBoundaryAttemptProcess>>> => {
        const stdoutTemp = path.join(attemptDir, `.${label}-stdout.tmp`);
        const stderrTemp = path.join(attemptDir, `.${label}-stderr.tmp`);
        const step = await runBoundaryAttemptProcess(argv, {
          deadlineMs: Math.max(1, deadlineAt - Date.now()),
          killGraceMs: contract.killGraceMs,
          expectedExit,
          cwd,
          env: reconstructedChildEnvironment(cwd),
          stdinPath: null,
          stdoutPath: stdoutTemp,
          stderrPath: stderrTemp,
        });
        resolutionStdout.push(Buffer.from(`\n${label}:\n`), readFileSync(stdoutTemp));
        resolutionStderr.push(Buffer.from(`\n${label}:\n`), readFileSync(stderrTemp));
        unlinkSync(stdoutTemp);
        unlinkSync(stderrTemp);
        return step;
      };
      const bashCapability = capabilityForManifest(manifest, 'bash');
      let generator = await runResolutionStep('generator', [
        bashCapability.realPath, 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen',
      ]);
      let resolvedPaths = gitPathSet(cwd, ['diff', '--name-only', '--']);
      let unmergedPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
      let conflictMarkerPaths = generatedIndexPaths.filter((relativePath) => {
        const text = readFileSync(path.join(cwd, relativePath), 'utf8');
        return text.split('\n').some((line) => /^(?:<{7}|={7}|>{7})/.test(line));
      });
      let addResult: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let diffCheck: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let workIndexGuard: Awaited<ReturnType<typeof runBoundaryAttemptProcess>> | null = null;
      let resolvedStateDigestSha256 = before.snapshot.digestSha256;
      if (
        generator.result.ok
        && canonicalizeBoundaryRun(resolvedPaths) === canonicalizeBoundaryRun(generatedIndexPaths)
        && conflictMarkerPaths.length === 0
      ) {
        addResult = await runResolutionStep('stage-generated-indexes', [
          capability.realPath, 'add', '--', ...generatedIndexPaths,
        ]);
        unmergedPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
        conflictMarkerPaths = generatedIndexPaths.filter((relativePath) => {
          const text = readFileSync(path.join(cwd, relativePath), 'utf8');
          return text.split('\n').some((line) => /^(?:<{7}|={7}|>{7})/.test(line));
        });
      }
      if (addResult?.result.ok && unmergedPaths.length === 0 && conflictMarkerPaths.length === 0) {
        diffCheck = await runResolutionStep('diff-check', [capability.realPath, 'diff', '--check']);
      }
      if (diffCheck?.result.ok) {
        workIndexGuard = await runResolutionStep('work-index-guard', [
          bashCapability.realPath, 'scripts/run-with-pinned-npm.sh', 'run', 'guard:work-index',
        ]);
      }
      const resolvedSnapshot = workIndexGuard?.result.ok
        ? captureBoundaryWorktreeSnapshot(cwd, {
            allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
            preservedOwnerPaths: manifest.run.preservedOwnerPaths,
          })
        : null;
      let resolutionReady = false;
      if (resolvedSnapshot?.ok && resolvedSnapshot.snapshot !== null) {
        resolvedStateDigestSha256 = resolvedSnapshot.snapshot.digestSha256;
        resolutionReady = true;
      }
      conflictResolutionReport = {
        schemaVersion: 1,
        policy: 'regenerate-generated-work-index',
        beforeHead,
        expectedSecondParent,
        conflictPaths,
        indexStages,
        generatorArgv: ['bash', 'scripts/run-with-pinned-npm.sh', 'run', 'work-index:regen'],
        generatorRawExit: generator.rawExit,
        generatorRawSignal: generator.rawSignal,
        resolvedPaths,
        unmergedPaths,
        conflictMarkerPaths,
        diffCheckRawExit: diffCheck?.rawExit ?? 1,
        diffCheckRawSignal: diffCheck?.rawSignal ?? null,
        workIndexGuardRawExit: workIndexGuard?.rawExit ?? 1,
        workIndexGuardRawSignal: workIndexGuard?.rawSignal ?? null,
        preStateDigestSha256: before.snapshot.digestSha256,
        resolvedStateDigestSha256,
        verdict: resolutionReady ? 'Pass' : 'Inconclusive',
      };
      if (resolutionReady) {
        const reportValidation = validateBoundaryStructuredRecord(
          'MergeConflictResolutionReport', conflictResolutionReport,
        );
        if (reportValidation.ok) {
          outcome = await runResolutionStep('commit-merge', [capability.realPath, 'commit', '--no-edit']);
          directSucceeded = outcome.rawExit === 0 && outcome.rawSignal === null && outcome.result.ok;
          if (!directSucceeded) conflictResolutionReport['verdict'] = 'Inconclusive';
        } else {
          abortIssues.push(...reportValidation.issues);
          directSucceeded = false;
        }
      }
    }
  }
  if (kind === 'merge' && !directSucceeded) {
    if (conflictPaths.length === 0) {
      conflictPaths = gitPathSet(cwd, ['diff', '--name-only', '--diff-filter=U', '--']);
    }
    abortAttempted = true;
    const abortStdoutPath = path.join(attemptDir, '.abort-stdout.tmp');
    const abortStderrPath = path.join(attemptDir, '.abort-stderr.tmp');
    const abort = await runBoundaryAttemptProcess([capability.realPath, 'merge', '--abort'], {
      deadlineMs: contract.deadlineMs,
      killGraceMs: contract.killGraceMs,
      expectedExit: '0',
      cwd,
      env: reconstructedChildEnvironment(cwd),
      stdinPath: null,
      stdoutPath: abortStdoutPath,
      stderrPath: abortStderrPath,
    });
    abortIssues.push(...abort.result.issues);
    const mergeStdout = readFileSync(directStdoutPath);
    const mergeStderr = readFileSync(directStderrPath);
    const abortStdout = readFileSync(abortStdoutPath);
    const abortStderr = readFileSync(abortStderrPath);
    durableExclusiveWrite(path.join(runDir, stdoutPath), Buffer.concat([
      Buffer.from('merge:\n'), mergeStdout, Buffer.from('\nabort:\n'), abortStdout,
      ...resolutionStdout,
    ]));
    durableExclusiveWrite(path.join(runDir, stderrPath), Buffer.concat([
      Buffer.from('merge:\n'), mergeStderr, Buffer.from('\nabort:\n'), abortStderr,
      ...resolutionStderr,
    ]));
    for (const temporary of [directStdoutPath, directStderrPath, abortStdoutPath, abortStderrPath]) unlinkSync(temporary);
  } else if (kind === 'merge') {
    durableExclusiveWrite(path.join(runDir, stdoutPath), Buffer.concat([
      readFileSync(directStdoutPath), ...resolutionStdout,
    ]));
    durableExclusiveWrite(path.join(runDir, stderrPath), Buffer.concat([
      readFileSync(directStderrPath), ...resolutionStderr,
    ]));
    unlinkSync(directStdoutPath);
    unlinkSync(directStderrPath);
  }
  const after = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  const afterHead = gitText(cwd, ['rev-parse', 'HEAD']);
  let parents: string[] = [];
  let postIndexTreeOid = frozenIndexTreeOid;
  let commitTreeOid = gitText(cwd, ['rev-parse', `${afterHead}^{tree}`]);
  let changedPaths: string[] = [];
  try {
    postIndexTreeOid = gitText(cwd, ['write-tree']);
    if (afterHead !== beforeHead) {
      const ancestry = gitText(cwd, ['rev-list', '--parents', '-n', '1', afterHead]).split(/\s+/);
      parents = ancestry.slice(1);
      changedPaths = gitPathSet(cwd, ['diff', '--name-only', beforeHead, afterHead, '--']);
    }
  } catch {
    // The postcondition issues below preserve the direct child result as non-pass.
  }
  const structuredResultPath = `attempts/${attemptId}/structured-result.json`;
  const transitionRecord = {
    kind,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    beforeHead,
    afterHead,
    parents,
    frozenIndexTreeOid,
    postIndexTreeOid,
    commitTreeOid,
    changedPaths,
    conflictPaths,
    abortAttempted,
    abortRestored: abortRestored as boolean | null,
    beforeSnapshotDigestSha256: before.snapshot.digestSha256,
    afterSnapshotDigestSha256: after.snapshot?.digestSha256 ?? before.snapshot.digestSha256,
    conflictResolutionReport,
  };
  durableExclusiveWrite(path.join(runDir, structuredResultPath), canonicalizeBoundaryRun(transitionRecord));

  const postconditionIssues: BoundaryValidationIssue[] = [];
  if (!after.ok || after.snapshot === null) postconditionIssues.push(...after.issues);
  if (directSucceeded) {
    const expectedParents = kind === 'commit' ? [beforeHead] : [beforeHead, expectedSecondParent!];
    if (afterHead === beforeHead || canonicalizeBoundaryRun(parents) !== canonicalizeBoundaryRun(expectedParents)) {
      postconditionIssues.push({ code: 'transition-parent-mismatch', message: 'transition parents differ from the frozen contract' });
    }
    if (
      commitTreeOid !== postIndexTreeOid
      || (kind === 'commit' && commitTreeOid !== frozenIndexTreeOid)
    ) {
      postconditionIssues.push({ code: 'transition-tree-mismatch', message: 'commit, post-index, or frozen index tree is inconsistent' });
    }
    if (
      canonicalizeBoundaryRun(changedPaths) !== canonicalizeBoundaryRun(allowedPaths)
      || gitPathSet(cwd, ['diff', '--name-only', 'HEAD', '--']).length !== 0
    ) {
      postconditionIssues.push({ code: 'transition-path-mismatch', message: 'transition paths or remaining worktree delta violate the profile' });
    }
    const resolvedConflict = conflictResolutionReport?.['verdict'] === 'Pass';
    if (
      abortAttempted
      || abortRestored !== null
      || (
        resolvedConflict
          ? canonicalizeBoundaryRun(conflictPaths) !== canonicalizeBoundaryRun(['docs/work-index.json', 'docs/work-index.md'])
          : conflictPaths.length !== 0
      )
    ) {
      postconditionIssues.push({ code: 'transition-abort-incomplete', message: 'successful transition carried conflict or abort state' });
    }
    if (
      after.snapshot !== null
      && canonicalizeBoundaryRun(after.snapshot.preservedOwner) !== canonicalizeBoundaryRun(before.snapshot.preservedOwner)
    ) {
      postconditionIssues.push({ code: 'transition-owner-drift', message: 'preserved owner paths changed during commit' });
    }
  } else {
    abortRestored = kind === 'merge'
      ? abortIssues.length === 0
        && afterHead === beforeHead
        && after.snapshot !== null
        && canonicalizeBoundaryRun(after.snapshot) === canonicalizeBoundaryRun(before.snapshot)
      : null;
    transitionRecord.abortRestored = abortRestored;
    durableAtomicRewrite(path.join(runDir, structuredResultPath), canonicalizeBoundaryRun(transitionRecord));
    if (
      afterHead !== beforeHead
      || after.snapshot === null
      || canonicalizeBoundaryRun(after.snapshot) !== canonicalizeBoundaryRun(before.snapshot)
      || (kind === 'merge' && abortRestored !== true)
    ) {
      postconditionIssues.push({ code: 'transition-failure-state-drift', message: 'failed transition did not restore the frozen pre-state' });
    }
  }
  const status = {
    expectedExit: contract.expectedExit,
    rawExit: outcome.rawExit,
    rawSignal: outcome.rawSignal,
    expectationMet: directSucceeded && postconditionIssues.length === 0,
    watchdogOwner: contract.watchdogOwner,
    innerTimeoutOwner: contract.innerTimeoutOwner,
    deadlineMs: contract.deadlineMs,
    killGraceMs: contract.killGraceMs,
  };
  const statusValidation = validateBoundaryAttemptStatus(
    status,
    { rawExit: outcome.rawExit, rawSignal: outcome.rawSignal },
    contract,
  );
  const verdict = status.expectationMet && statusValidation.ok ? 'Pass' as const : 'Inconclusive' as const;
  manifest.attempts.push({
    id: attemptId,
    operation: 'git-transition',
    headAnchor: contract.headAnchor,
    argv: logicalArgv,
    cwd,
    startedAtUtc: outcome.startedAtUtc,
    endedAtUtc: outcome.endedAtUtc,
    ...status,
    preSnapshot: before.snapshot,
    postSnapshot: after.snapshot ?? before.snapshot,
    stdout: streamRecord(runDir, stdoutPath),
    stderr: streamRecord(runDir, stderrPath),
    declaredOutputs: [],
    outputAdmissions: [],
    structuredResult: streamRecord(runDir, structuredResultPath),
    verdict,
  });
  manifest.currentSnapshot = structuredClone(after.snapshot ?? before.snapshot);
  if (verdict === 'Pass') {
    manifest.run.terminalHead = afterHead;
    manifest.run.transitionCount = 1;
    if (kind === 'merge' && observationUpstream !== null) {
      manifest.run.reconciledBase = afterHead;
      manifest.upstream = {
        ...structuredClone(observationUpstream),
        observationManifestSha256: manifest.predecessor!.pin.manifestSha256,
        mergeCommit: afterHead,
        mergeParents: [parents[0]!, parents[1]!],
      };
    }
  }
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(manifestPath, canonicalizeBoundaryRun(manifest));
  const issues = [...outcome.result.issues, ...abortIssues, ...statusValidation.issues, ...postconditionIssues];
  return operationResult(issues, issues.length === 0 ? 0 : 1, verdict);
}

function acceptedAttemptStdout(manifest: BoundaryRunManifest, runDir: string, attemptId: string): string {
  const attempt = manifest.attempts.find((entry) => entry.id === attemptId);
  if (attempt === undefined || attempt.verdict !== 'Pass' || !attempt.expectationMet) {
    throw new Error(`required attempt is unavailable or non-pass: ${attemptId}`);
  }
  const bytes = readFileSync(path.join(runDir, attempt.stdout.path));
  if (bytes.byteLength !== attempt.stdout.bytes || sha256(bytes) !== attempt.stdout.sha256) {
    throw new Error(`required attempt stdout changed: ${attemptId}`);
  }
  return bytes.toString('utf8');
}

function parseNameStatusPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.trim() === '' ? [] : stdout.replace(/\n$/, '').split('\n')) {
    const columns = line.split('\t');
    if (columns.length < 2 || !/^(?:[ACDMRTUXB]|R\d{1,3}|C\d{1,3})$/.test(columns[0]!)) {
      throw new Error(`malformed Git name-status row: ${line}`);
    }
    for (const candidate of columns.slice(1)) {
      if (!isSafeRelativePath(candidate)) throw new Error(`unsafe Git name-status path: ${candidate}`);
      paths.push(candidate);
    }
  }
  return canonicalSet(paths);
}

function setUpstream(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (
    manifest.upstream.remoteUrl !== 'not-observed'
    || manifest.upstream.observedOid !== 'not-observed'
    || manifest.upstream.mergeBase !== 'not-observed'
  ) {
    return operationResult([{ code: 'upstream-already-set', message: 'upstream state is single-assignment' }], 2);
  }
  if (manifest.run.profileId !== 'bcf00-observation' && manifest.run.profileId !== 'bcf08-final') {
    return operationResult([{
      code: 'upstream-profile-unsupported',
      message: 'this profile requires predecessor or transition evidence before upstream derivation',
    }]);
  }
  const prefix = manifest.run.profileId === 'bcf08-final' ? 'final-upstream-' : 'upstream-';
  try {
    const remoteUrl = acceptedAttemptStdout(manifest, runDir, `${prefix}remote`).trim();
    const observedOid = acceptedAttemptStdout(manifest, runDir, `${prefix}origin-oid`).trim();
    const mergeBase = acceptedAttemptStdout(manifest, runDir, `${prefix}merge-base`).trim();
    const counts = acceptedAttemptStdout(manifest, runDir, `${prefix}ahead-behind`).trim().split(/\s+/);
    const remotePaths = parseNameStatusPaths(acceptedAttemptStdout(manifest, runDir, `${prefix}remote-diff`));
    const localPaths = parseNameStatusPaths(acceptedAttemptStdout(manifest, runDir, `${prefix}local-diff`));
    if (!/^git@[^:\s]+:[^\s]+$/.test(remoteUrl)) throw new Error('origin remote is not an SSH URL');
    if (!/^[0-9a-f]{40}$/.test(observedOid) || !/^[0-9a-f]{40}$/.test(mergeBase)) {
      throw new Error('upstream OID or merge base is malformed');
    }
    if (counts.length !== 2 || counts.some((value) => !/^\d+$/.test(value))) {
      throw new Error('ahead/behind result is malformed');
    }
    if (manifest.run.profileId === 'bcf00-observation') {
      const root = acceptedAttemptStdout(manifest, runDir, 'upstream-root').trim();
      const head = acceptedAttemptStdout(manifest, runDir, 'upstream-head').trim();
      acceptedAttemptStdout(manifest, runDir, 'upstream-status');
      acceptedAttemptStdout(manifest, runDir, 'upstream-fetch');
      acceptedAttemptStdout(manifest, runDir, 'merge-preview');
      if (root !== cwd || head !== manifest.run.entryHead) throw new Error('observation root or head differs from init');
    } else {
      acceptedAttemptStdout(manifest, runDir, 'final-upstream-refresh');
    }
    manifest.upstream = {
      remoteUrl,
      observedOid,
      mergeBase,
      behind: Number(counts[0]),
      ahead: Number(counts[1]),
      remotePaths,
      localPaths,
      observationManifestSha256: manifest.predecessor?.pin.manifestSha256 ?? 'not-observed',
      mergeCommit: 'not-observed',
      mergeParents: [],
    };
    const validation = validateBoundaryRun(manifest);
    if (!validation.ok) return validation;
    durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
    return operationResult([]);
  } catch (error) {
    return operationResult([{ code: 'upstream-derivation-failed', message: (error as Error).message }]);
  }
}

function aggregateRunVerdict(manifest: BoundaryRunManifest): BoundaryValidationResult['verdict'] {
  if (manifest.lifecycle.status === 'blocked' || manifest.lifecycle.finalGate === 'blocked') return 'Blocked';
  const requiredAttempts = manifest.run.requiredAttemptIds.map((id) => manifest.attempts.find((entry) => entry.id === id));
  const requiredChildren = manifest.run.requiredChildAliases.map((alias) => manifest.children.find((entry) => entry.alias === alias));
  if (
    manifest.lifecycle.finalGate === 'fail'
    || requiredAttempts.some((entry) => entry?.verdict === 'Fail')
    || requiredChildren.some((entry) => entry?.overallVerdict === 'Fail')
  ) return 'Fail';
  const reviewVerdict = aggregateReviewVerdict(manifest);
  if (reviewVerdict === 'Blocked') return 'Blocked';
  if (reviewVerdict === 'Fail') return 'Fail';
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (
    profile === undefined
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || requiredAttempts.some((entry) => entry?.verdict !== 'Pass' || entry.expectationMet !== true)
    || requiredChildren.some((entry) => entry?.overallVerdict !== 'Pass')
    || reviewVerdict !== 'Pass'
  ) return 'Inconclusive';
  return 'Pass';
}

function aggregateReviewVerdict(manifest: BoundaryRunManifest): BoundaryValidationResult['verdict'] {
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract !== undefined) {
    return manifest.reviews.length === 1
      && manifest.reviews[0]!.alias === sourceContract.alias
      && manifest.reviews[0]!.dedupeKey === sourceContract.dedupeKey
      ? 'Pass'
      : 'Inconclusive';
  }
  if (manifest.run.profileId !== 'bcf08a-docs' && manifest.run.profileId !== 'bcf08-final') {
    return manifest.reviews.length === 0 ? 'Pass' : 'Inconclusive';
  }
  const requiredAliases = manifest.run.requiredChildAliases.filter((alias) => (
    childContractFor(manifest.run.profileId, alias)?.kind === 'review'
  ));
  const recordedAliases = manifest.reviews.map((review) => review.alias);
  if (canonicalizeBoundaryRun(canonicalSet(recordedAliases)) !== canonicalizeBoundaryRun(canonicalSet(requiredAliases))) return 'Inconclusive';
  return aggregateBoundaryReviewFindingVerdict(manifest.reviews);
}

function verifyRecordedStream(runDir: string, stream: { path: string; sha256: string; bytes: number }): BoundaryValidationIssue[] {
  try {
    const bytes = readFileSync(path.join(runDir, stream.path));
    return bytes.byteLength === stream.bytes && sha256(bytes) === stream.sha256
      ? []
      : [{ code: 'recorded-stream-drift', message: `recorded stream changed: ${stream.path}`, path: stream.path }];
  } catch (error) {
    return [{ code: 'recorded-stream-drift', message: (error as Error).message, path: stream.path }];
  }
}

function verifyManifestEvidence(
  manifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
  requireComplete: boolean,
): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined || profile.taskId !== manifest.run.taskId) {
    issues.push({ code: 'profile-contract-mismatch', message: 'manifest task/profile is not generated' });
  } else {
    if (canonicalizeBoundaryRun(manifest.run.requiredAttemptIds) !== canonicalizeBoundaryRun(profile.requiredAttemptIds)) {
      issues.push({ code: 'profile-contract-mismatch', message: 'required attempt set differs from the profile' });
    }
    const expectedAliases = (profile.requiredChildren as readonly string[]).map((entry) => entry.split(':', 1)[0]!);
    if (canonicalizeBoundaryRun(manifest.run.requiredChildAliases) !== canonicalizeBoundaryRun(expectedAliases)) {
      issues.push({ code: 'profile-contract-mismatch', message: 'required child set differs from the profile' });
    }
  }
  for (const row of Object.values(manifest.documentHashes)) {
    try {
      if (canonicalizeBoundaryRun(documentHash(cwd, row.path)) !== canonicalizeBoundaryRun(row)) {
        issues.push({ code: 'document-hash-drift', message: `document changed: ${row.path}`, path: row.path });
      }
    } catch (error) {
      issues.push({ code: 'document-hash-drift', message: (error as Error).message, path: row.path });
    }
  }
  for (const capability of manifest.run.observedTools) {
    try {
      if (canonicalizeBoundaryRun(resolveBoundaryToolCapability(capability.name)) !== canonicalizeBoundaryRun(capability)) {
        issues.push({ code: 'attempt-tool-capability-mismatch', message: `tool changed: ${capability.name}` });
      }
    } catch (error) {
      issues.push({ code: 'attempt-tool-capability-mismatch', message: (error as Error).message });
    }
  }
  const attemptIds = manifest.attempts.map((entry) => entry.id);
  if (new Set(attemptIds).size !== attemptIds.length) {
    issues.push({ code: 'attempt-duplicate', message: 'attempt IDs are not unique' });
  }
  if (requireComplete) {
    for (const id of manifest.run.requiredAttemptIds) {
      const matches = manifest.attempts.filter((entry) => entry.id === id);
      if (matches.length !== 1 || matches[0]!.verdict !== 'Pass' || !matches[0]!.expectationMet) {
        issues.push({ code: 'lifecycle-required-incomplete', message: `required attempt is missing or non-pass: ${id}` });
      }
    }
  }
  for (const attempt of manifest.attempts) {
    issues.push(...verifyRecordedStream(runDir, attempt.stdout), ...verifyRecordedStream(runDir, attempt.stderr));
    if (attempt.structuredResult !== null) issues.push(...verifyRecordedStream(runDir, attempt.structuredResult));
    issues.push(...validateBoundaryOutputClosure(runDir, attempt, manifest.artifacts).issues);
  }
  if (requireComplete) {
    for (const alias of manifest.run.requiredChildAliases) {
      const matches = manifest.children.filter((entry) => entry.alias === alias);
      if (matches.length !== 1 || matches[0]!.overallVerdict !== 'Pass') {
        issues.push({ code: 'lifecycle-required-incomplete', message: `required child is missing or non-pass: ${alias}` });
      }
    }
  }
  for (const child of manifest.children) {
    issues.push(...validateRecordedChild(manifest, runDir, child).issues);
  }
  issues.push(...verifyRecordedReviews(manifest, runDir, requireComplete));
  issues.push(...validateRecordedPredecessor(manifest, runDir).issues);
  const live = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  issues.push(...live.issues);
  if (live.snapshot !== null && canonicalizeBoundaryRun(live.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    issues.push({ code: 'verification-snapshot-drift', message: 'live worktree differs from the current manifest snapshot' });
  }
  return issues;
}

function verifyRecordedReviews(
  manifest: BoundaryRunManifest,
  runDir: string,
  requireComplete: boolean,
): BoundaryValidationIssue[] {
  const issues: BoundaryValidationIssue[] = [];
  for (const review of manifest.reviews) {
    const sourceShape = { schemaVersion: 1, ...review } as Record<string, unknown>;
    delete sourceShape['alias'];
    issues.push(...validateBoundaryReviewInput(sourceShape).issues);
    for (const [relativePath, digest] of [
      [review.reportPath, review.reportSha256],
      [review.metaPath, review.metaSha256],
      [review.stderrPath, review.stderrSha256],
      ...review.findings.map((finding) => [finding.evidencePath, finding.evidenceSha256]),
    ] as Array<[string, string]>) {
      try {
        if (sha256(readConfinedRegularFile(runDir, relativePath)) !== digest) {
          issues.push({ code: 'review-evidence-mismatch', message: `review evidence changed: ${relativePath}`, path: relativePath });
        }
      } catch (error) {
        issues.push({ code: 'review-evidence-invalid', message: (error as Error).message, path: relativePath });
      }
    }
  }
  const sourceContract = RUN_SOURCE_REVIEW_CONTRACTS[
    manifest.run.profileId as keyof typeof RUN_SOURCE_REVIEW_CONTRACTS
  ];
  if (sourceContract !== undefined) {
    if (
      manifest.reviews.length > 1
      || (requireComplete && manifest.reviews.length !== 1)
      || manifest.reviews.some((review) => review.alias !== sourceContract.alias || review.dedupeKey !== sourceContract.dedupeKey)
    ) {
      issues.push({ code: 'review-source-cardinality-invalid', message: 'source review profile requires its one exact role review' });
    }
    return issues;
  }
  const requiredAliases = manifest.run.requiredChildAliases.filter((alias) => (
    childContractFor(manifest.run.profileId, alias)?.kind === 'review'
  ));
  if (requiredAliases.length === 0) {
    if (manifest.reviews.length !== 0) issues.push({ code: 'review-profile-forbidden', message: 'profile does not accept review rows' });
    return issues;
  }
  const recordedAliases = manifest.reviews.map((review) => review.alias);
  if (
    recordedAliases.some((alias) => !requiredAliases.includes(alias))
    || (
      requireComplete
      && canonicalizeBoundaryRun(canonicalSet(recordedAliases)) !== canonicalizeBoundaryRun(canonicalSet(requiredAliases))
    )
  ) {
    issues.push({ code: 'review-parent-cardinality-invalid', message: 'parent review rows differ from the required role set' });
  }
  const lead = manifest.children.find((entry) => entry.alias === 'lead-reproduction');
  if (lead === undefined) {
    if (manifest.reviews.length > 0 || requireComplete) {
      issues.push({ code: 'review-parent-child-missing', message: 'lead reproduction child is unavailable' });
    }
    return issues;
  }
  let leadManifest: BoundaryRunManifest;
  try {
    leadManifest = JSON.parse(
      readConfinedRegularFile(path.join(runDir, 'children/lead-reproduction'), 'run_manifest.json').toString('utf8'),
    ) as BoundaryRunManifest;
  } catch (error) {
    issues.push({ code: 'review-parent-import-invalid', message: (error as Error).message });
    return issues;
  }
  for (const recorded of manifest.reviews) {
    try {
      const sourceManifest = JSON.parse(
        readConfinedRegularFile(path.join(runDir, 'children', recorded.alias), 'run_manifest.json').toString('utf8'),
      ) as BoundaryRunManifest;
      if (sourceManifest.reviews.length !== 1) {
        issues.push({ code: 'review-source-cardinality-invalid', message: `source review cardinality changed: ${recorded.alias}` });
        continue;
      }
      const source = sourceManifest.reviews[0]!;
      const prefix = `children/${recorded.alias}/`;
      const expected: BoundaryReviewRecord = {
        ...structuredClone(source),
        reportPath: `${prefix}${source.reportPath}`,
        metaPath: `${prefix}${source.metaPath}`,
        stderrPath: `${prefix}${source.stderrPath}`,
        findings: source.findings.map((finding) => ({
          ...structuredClone(finding),
          evidencePath: `${prefix}${finding.evidencePath}`,
        })),
      };
      if (canonicalizeBoundaryRun(expected) !== canonicalizeBoundaryRun(recorded)) {
        issues.push({ code: 'review-parent-binding-mismatch', message: `parent review row changed: ${recorded.alias}` });
      }
      issues.push(...validateReviewProofContracts(source, leadManifest).issues);
    } catch (error) {
      issues.push({ code: 'review-parent-import-invalid', message: (error as Error).message });
    }
  }
  return issues;
}

function setLifecycle(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  const status = stringOption(invocation.options, 'status') as BoundaryRunManifest['lifecycle']['status'];
  const finalGate = stringOption(invocation.options, 'finalGate') as BoundaryRunManifest['lifecycle']['finalGate'];
  const oracle = stringOption(invocation.options, 'oracle') as BoundaryRunManifest['lifecycle']['oracle'];
  const artifactSha256 = stringOption(invocation.options, 'artifactSha256') ?? null;
  const successor = stringOption(invocation.options, 'successor') ?? null;
  const supersededBy = stringOption(invocation.options, 'supersededBy') ?? null;
  if (profile === undefined) return operationResult([{ code: 'profile-contract-mismatch', message: 'run profile is unknown' }]);
  if (manifest.lifecycle.status !== 'active' || manifest.lifecycle.finalGate !== 'not-run') {
    return operationResult([{ code: 'lifecycle-already-set', message: 'lifecycle is single-assignment' }], 2);
  }
  if (
    !['pending', 'active', 'completed', 'deferred', 'closed', 'blocked'].includes(status)
    || !['not-run', 'pass', 'fail', 'inconclusive', 'blocked'].includes(finalGate)
    || !['not-applicable', 'current', 'superseded-invalid-oracle'].includes(oracle)
    || (artifactSha256 !== null && !/^[0-9a-f]{64}$/.test(artifactSha256))
    || (successor !== null && !isSafeRelativePath(successor))
    || (supersededBy !== null && !isSafeRelativePath(supersededBy))
  ) {
    return operationResult([{ code: 'lifecycle-invalid', message: 'lifecycle values violate the closed contract' }], 2);
  }
  const live = captureBoundaryWorktreeSnapshot(cwd, {
    allowedUntrackedPaths: manifest.run.allowedUntrackedPaths,
    preservedOwnerPaths: manifest.run.preservedOwnerPaths,
  });
  if (!live.ok || live.snapshot === null) return operationResult(live.issues);
  if (canonicalizeBoundaryRun(live.snapshot) !== canonicalizeBoundaryRun(manifest.currentSnapshot)) {
    return operationResult([{ code: 'verification-snapshot-drift', message: 'worktree changed before lifecycle transition' }]);
  }
  const terminalHead = gitText(cwd, ['rev-parse', 'HEAD']);
  if (profile.transition === null && terminalHead !== manifest.run.entryHead) {
    return operationResult([{ code: 'lifecycle-head-mismatch', message: 'no-transition profile advanced Git head' }]);
  }
  if (profile.transition !== null && manifest.run.transitionCount !== 1) {
    return operationResult([{ code: 'lifecycle-required-incomplete', message: 'required Git transition is missing' }]);
  }
  manifest.run.terminalHead = terminalHead;
  manifest.lifecycle = {
    status,
    completionCommit: status === 'completed' || status === 'closed' ? terminalHead : null,
    finalGate,
    artifactSha256,
    successor,
    supersededBy,
    oracle,
    branchDeletionAuthorized: false,
  };
  manifest.overallVerdict = aggregateRunVerdict(manifest);
  const readinessPending = manifest.run.profileId === 'bcf00-reconciliation'
    && status === 'completed'
    && finalGate === 'pass'
    && oracle === 'current'
    && !manifest.attempts.some((entry) => entry.id === 'readiness-check')
    && manifest.run.requiredAttemptIds
      .filter((id) => id !== 'readiness-check')
      .every((id) => {
        const attempt = manifest.attempts.find((entry) => entry.id === id);
        return attempt?.expectationMet === true && attempt.verdict === 'Pass';
      })
    && manifest.run.requiredChildAliases.every((alias) => {
      const child = manifest.children.find((entry) => entry.alias === alias);
      return child?.overallVerdict === 'Pass';
    });
  if (finalGate === 'pass' && manifest.overallVerdict !== 'Pass' && !readinessPending) {
    return operationResult([{
      code: 'lifecycle-required-incomplete',
      message: 'terminal Pass requires every profile-owned attempt and child to Pass',
    }]);
  }
  const validation = validateBoundaryRun(manifest);
  if (!validation.ok) return validation;
  durableAtomicRewrite(loaded.path, canonicalizeBoundaryRun(manifest));
  return operationResult([], 0, manifest.overallVerdict);
}

function shaLockBytes(digest: string, basename: string): string {
  return `${digest}  ${basename}\n`;
}

interface BoundaryFinalCompletionCandidate {
  manifest: BoundaryRunManifest;
  manifestBytes: string;
  manifestSha256: string;
  manifestLock: string;
  ledger: Record<string, unknown>;
  ledgerBytes: string;
  ledgerSha256: string;
  ledgerLock: string;
  completionReceipt: Record<string, unknown>;
  completionReceiptBytes: string;
  completionReceiptSha256: string;
  completionReceiptLock: string;
}

function buildFinalCompletionCandidate(
  sourceManifest: BoundaryRunManifest,
  runDir: string,
  cwd: string,
): { result: BoundaryValidationResult; candidate: BoundaryFinalCompletionCandidate | null } {
  const manifest = structuredClone(sourceManifest);
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (
    profile === undefined
    || manifest.run.taskId !== 'BCF-08C'
    || manifest.run.profileId !== 'bcf08-final'
    || manifest.overallVerdict !== 'Pass'
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || manifest.run.terminalHead === null
    || manifest.predecessor === null
  ) {
    return {
      result: operationResult([{ code: 'closeout-run-nonpass', message: 'only one terminal BCF-08C Pass can close out' }]),
      candidate: null,
    };
  }
  const evidenceIssues = verifyManifestEvidence(manifest, runDir, cwd, true);
  if (evidenceIssues.length > 0) return { result: operationResult(evidenceIssues), candidate: null };
  try {
    const liveCorpusDigests = {
      cases: sha256(readFileSync(path.join(cwd, 'tests/fixtures/semantic-boundary-eval/cases.json'))),
      holdout: sha256(readFileSync(path.join(cwd, 'tests/fixtures/semantic-boundary-eval/holdout.json'))),
    };
    const liveOracleDigest = sha256(canonicalizeBoundaryRun(liveCorpusDigests));
    const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
    const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
    const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
    const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
    const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
    const predecessorReceiptSha256 = sha256(predecessorReceiptBytes);
    const predecessorLedgerSha256 = sha256(predecessorLedgerBytes);
    if (
      predecessorReceiptSha256 !== manifest.predecessor.pin.completionReceiptSha256
      || predecessorLedgerSha256 !== manifest.predecessor.pin.ledgerSha256
      || canonicalizeBoundaryRun(predecessorReceipt['corpusDigests']) !== canonicalizeBoundaryRun(liveCorpusDigests)
      || predecessorReceipt['oracleDigest'] !== liveOracleDigest
      || predecessorReceipt['reconciledBase'] !== manifest.run.reconciledBase
      || predecessorReceipt['upstreamObservedOid'] !== manifest.upstream.observedOid
    ) throw new Error('final predecessor, corpus, oracle, or upstream identity changed');
    manifest.manifestState = 'finalized';
    manifest.run.finalizedAtUtc = new Date().toISOString();
    const provisionalBytes = canonicalizeBoundaryRun(manifest);
    const provisionalSha256 = sha256(provisionalBytes);
    const predecessorRows = Array.isArray(predecessorLedger['rows']) ? predecessorLedger['rows'] : [];
    const currentRow = {
      ordinal: predecessorRows.length + 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256: provisionalSha256,
      previousLedgerSha256: predecessorLedgerSha256,
      overallVerdict: manifest.overallVerdict,
    };
    const appended = validateAndAppendBoundaryPredecessor({
      profileId: manifest.run.profileId,
      pin: manifest.predecessor.pin,
      receipt: predecessorReceipt,
      ledger: predecessorLedger,
      receiptSha256: predecessorReceiptSha256,
      ledgerSha256: predecessorLedgerSha256,
      inherited: {
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests: liveCorpusDigests,
        oracleDigest: liveOracleDigest,
      },
      currentRow,
    });
    if (!appended.result.ok || appended.ledger === null) return { result: appended.result, candidate: null };
    const manifestBytes = canonicalizeBoundaryRun(manifest);
    const manifestSha256 = sha256(manifestBytes);
    if (manifestSha256 !== provisionalSha256) throw new Error('final manifest identity changed during ledger construction');
    const manifestLock = shaLockBytes(manifestSha256, 'run_manifest.json');
    const ledger = appended.ledger;
    const ledgerBytes = canonicalizeBoundaryRun(ledger);
    const ledgerSha256 = sha256(ledgerBytes);
    const ledgerLock = shaLockBytes(ledgerSha256, 'chain_ledger.json');
    const completionReceipt = {
      schemaVersion: 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256,
      manifestLockSha256: sha256(manifestLock),
      ledgerSha256,
      predecessorReceiptSha256,
      predecessorLedgerSha256,
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: manifest.upstream.observedOid,
      corpusDigests: liveCorpusDigests,
      oracleDigest: liveOracleDigest,
      lifecycleStatus: manifest.lifecycle.status,
      finalGate: manifest.lifecycle.finalGate,
      overallVerdict: manifest.overallVerdict,
    };
    const completionReceiptBytes = canonicalizeBoundaryRun(completionReceipt);
    const completionReceiptSha256 = sha256(completionReceiptBytes);
    return {
      result: operationResult([]),
      candidate: {
        manifest,
        manifestBytes,
        manifestSha256,
        manifestLock,
        ledger,
        ledgerBytes,
        ledgerSha256,
        ledgerLock,
        completionReceipt,
        completionReceiptBytes,
        completionReceiptSha256,
        completionReceiptLock: shaLockBytes(completionReceiptSha256, 'completion_receipt.json'),
      },
    };
  } catch (error) {
    return {
      result: operationResult([{ code: 'closeout-completion-failed', message: (error as Error).message }]),
      candidate: null,
    };
  }
}

function finalizeRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  const profile = RUN_CONTRACT_PROFILES[manifest.run.profileId as keyof typeof RUN_CONTRACT_PROFILES];
  if (profile === undefined) return operationResult([{ code: 'profile-contract-mismatch', message: 'run profile is unknown' }]);
  if (manifest.run.profileId === 'bcf08-final') {
    return operationResult([{ code: 'finalize-profile-forbidden', message: 'BCF-08C may finalize only inside closeout' }], 2);
  }
  if (
    manifest.overallVerdict !== 'Pass'
    || manifest.lifecycle.status !== profile.terminalLifecycle
    || manifest.lifecycle.finalGate !== 'pass'
    || manifest.run.terminalHead === null
  ) {
    return operationResult([{ code: 'finalize-run-nonpass', message: 'only a profile-terminal Pass run may finalize' }]);
  }
  const evidenceIssues = verifyManifestEvidence(manifest, runDir, cwd, true);
  if (evidenceIssues.length > 0) return operationResult(evidenceIssues);
  if (manifest.upstream.observedOid === 'not-observed') {
    return operationResult([{ code: 'finalize-upstream-missing', message: 'observation upstream state is incomplete' }]);
  }
  try {
    const casesPath = path.join(cwd, 'tests/fixtures/semantic-boundary-eval/cases.json');
    const holdoutPath = path.join(cwd, 'tests/fixtures/semantic-boundary-eval/holdout.json');
    const liveCorpusDigests = {
      cases: sha256(readFileSync(casesPath)),
      holdout: sha256(readFileSync(holdoutPath)),
    };
    const liveOracleDigest = sha256(canonicalizeBoundaryRun(liveCorpusDigests));
    manifest.manifestState = 'finalized';
    manifest.run.finalizedAtUtc = new Date().toISOString();
    const manifestBytes = canonicalizeBoundaryRun(manifest);
    const manifestSha256 = sha256(manifestBytes);
    const manifestLock = shaLockBytes(manifestSha256, 'run_manifest.json');
    const isObservation = manifest.run.profileId === 'bcf00-observation';
    const isReconciliation = manifest.run.profileId === 'bcf00-reconciliation';
    let corpusDigests = liveCorpusDigests;
    let oracleDigest = liveOracleDigest;
    let predecessorReceiptSha256: string | null = null;
    let predecessorLedgerSha256: string | null = null;
    let ledger: Record<string, unknown>;
    if (isObservation) {
      ledger = {
        schemaVersion: 1,
        rows: [],
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests,
        oracleDigest,
      };
    } else if (isReconciliation) {
      if (
        manifest.run.reconciledBase === 'not-observed'
        || manifest.predecessor === null
        || manifest.predecessor.pin.profileId !== 'bcf00-observation'
        || manifest.children.length !== 1
        || manifest.children[0]?.alias !== 'upstream-observation'
        || manifest.children[0].runId !== manifest.predecessor.pin.runId
        || manifest.children[0].sourceManifestSha256 !== manifest.predecessor.pin.manifestSha256
      ) {
        return operationResult([{
          code: 'finalize-reconciliation-genesis-mismatch',
          message: 'BCF-00 genesis requires the exact observation predecessor and child identity',
        }]);
      }
      ledger = {
        schemaVersion: 1,
        rows: [{
          ordinal: 1,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256,
          previousLedgerSha256: null,
          overallVerdict: manifest.overallVerdict,
        }],
        reconciledBase: manifest.run.reconciledBase,
        upstreamObservedOid: manifest.upstream.observedOid,
        corpusDigests,
        oracleDigest,
      };
    } else {
      const predecessor = manifest.predecessor;
      if (predecessor === null) throw new Error('non-genesis completion requires a predecessor import');
      const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
      const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
      const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
      const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
      const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
      predecessorReceiptSha256 = sha256(predecessorReceiptBytes);
      predecessorLedgerSha256 = sha256(predecessorLedgerBytes);
      corpusDigests = predecessorReceipt['corpusDigests'] as typeof liveCorpusDigests;
      oracleDigest = String(predecessorReceipt['oracleDigest']);
      if (
        predecessorReceiptSha256 !== predecessor.pin.completionReceiptSha256
        || predecessorLedgerSha256 !== predecessor.pin.ledgerSha256
        || canonicalizeBoundaryRun(corpusDigests) !== canonicalizeBoundaryRun(liveCorpusDigests)
        || oracleDigest !== liveOracleDigest
        || predecessorReceipt['reconciledBase'] !== manifest.run.reconciledBase
        || predecessorReceipt['upstreamObservedOid'] !== manifest.upstream.observedOid
      ) {
        return operationResult([{
          code: 'finalize-inherited-drift',
          message: 'predecessor receipt, current corpus, or inherited reconciliation fields changed',
        }]);
      }
      if (manifest.run.chainAppend) {
        const predecessorRows = predecessorLedger['rows'];
        const ordinal = Array.isArray(predecessorRows) ? predecessorRows.length + 1 : 0;
        const currentRow = {
          ordinal,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256,
          previousLedgerSha256: predecessorLedgerSha256,
          overallVerdict: manifest.overallVerdict,
        };
        const appended = validateAndAppendBoundaryPredecessor({
          profileId: manifest.run.profileId,
          pin: predecessor.pin,
          receipt: predecessorReceipt,
          ledger: predecessorLedger,
          receiptSha256: predecessorReceiptSha256,
          ledgerSha256: predecessorLedgerSha256,
          inherited: {
            reconciledBase: manifest.run.reconciledBase,
            upstreamObservedOid: manifest.upstream.observedOid,
            corpusDigests,
            oracleDigest,
          },
          currentRow,
        });
        if (!appended.result.ok || appended.ledger === null) return appended.result;
        ledger = appended.ledger;
      } else {
        ledger = predecessorLedger;
      }
    }
    const ledgerBytes = canonicalizeBoundaryRun(ledger);
    const ledgerSha256 = sha256(ledgerBytes);
    const completionReceipt = {
      schemaVersion: 1,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      runId: manifest.run.runId,
      entryHead: manifest.run.entryHead,
      terminalHead: manifest.run.terminalHead,
      manifestSha256,
      manifestLockSha256: sha256(manifestLock),
      ledgerSha256,
      predecessorReceiptSha256,
      predecessorLedgerSha256,
      reconciledBase: manifest.run.reconciledBase,
      upstreamObservedOid: manifest.upstream.observedOid,
      corpusDigests,
      oracleDigest,
      lifecycleStatus: manifest.lifecycle.status,
      finalGate: manifest.lifecycle.finalGate,
      overallVerdict: manifest.overallVerdict,
    };
    const completionReceiptBytes = canonicalizeBoundaryRun(completionReceipt);
    const completionReceiptSha256 = sha256(completionReceiptBytes);
    const completionRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    if (completionRecord === undefined) throw new Error('completion root reservation is missing');
    const evidenceRoot = path.dirname(path.dirname(runDir));
    const completionReservation = reserveBoundaryDerivedRoot({
      evidenceRoot,
      parentSegments: ['completion'],
      runId: manifest.run.runId,
      kind: 'completion',
      protectedPaths: [
        ...manifest.run.allowedPaths,
        ...manifest.run.allowedUntrackedPaths,
        ...manifest.run.preservedOwnerPaths,
      ].map((entry) => path.join(cwd, entry)),
    });
    if (!completionReservation.ok || completionReservation.reservation === null) {
      return operationResult(completionReservation.issues);
    }
    if (
      completionReservation.reservation.path !== completionRecord.path
      || completionReservation.reservation.parentDevice !== completionRecord.parentDevice
      || completionReservation.reservation.parentInode !== completionRecord.parentInode
    ) throw new Error('completion root reservation identity changed');
    durableAtomicRewrite(loaded.path, manifestBytes);
    durableExclusiveWrite(path.join(runDir, 'run_manifest.sha256'), manifestLock);
    const created = createBoundaryDerivedRoot(completionReservation.reservation);
    if (!created.ok) return operationResult(created.issues);
    const completionDir = completionReservation.reservation.path;
    durableExclusiveWrite(path.join(completionDir, 'chain_ledger.json'), ledgerBytes);
    durableExclusiveWrite(path.join(completionDir, 'chain_ledger.sha256'), shaLockBytes(ledgerSha256, 'chain_ledger.json'));
    durableExclusiveWrite(path.join(completionDir, 'completion_receipt.json'), completionReceiptBytes);
    durableExclusiveWrite(
      path.join(completionDir, 'completion_receipt.sha256'),
      shaLockBytes(completionReceiptSha256, 'completion_receipt.json'),
    );
    return operationResult([], 0, 'Pass');
  } catch (error) {
    return operationResult([{ code: 'finalize-failed', message: (error as Error).message }]);
  }
}

function verifyRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  try {
    const bytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const structural = validateBoundaryRunJson(bytes);
    if (!structural.ok) return structural;
    const manifest = JSON.parse(bytes.toString('utf8')) as BoundaryRunManifest;
    const issues = [
      ...verifyRunInitAnchor(manifest, runDir).issues,
      ...verifyManifestEvidence(manifest, runDir, cwd, manifest.manifestState !== 'active'),
    ];
    if (invocation.options['expectStagedAllowlist'] === true) {
      const staged = gitPathSet(cwd, ['diff', '--cached', '--name-only', '--']);
      if (canonicalizeBoundaryRun(staged) !== canonicalizeBoundaryRun(manifest.run.allowedPaths)) {
        issues.push({ code: 'verification-staged-allowlist-mismatch', message: 'staged paths differ from the profile allowlist' });
      }
    }
    if (manifest.manifestState === 'active') {
      if (existsSync(path.join(runDir, 'run_manifest.sha256'))) {
        issues.push({ code: 'active-final-file', message: 'active run contains a final manifest lock' });
      }
      const completion = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
      if (completion !== undefined && existsSync(completion.path)) {
        issues.push({ code: 'active-final-file', message: 'active run contains a completion bundle' });
      }
      return operationResult(issues, issues.length === 0 ? 0 : 1, 'Inconclusive');
    }
    const manifestDigest = sha256(bytes);
    const manifestLockPath = path.join(runDir, 'run_manifest.sha256');
    const manifestLock = readFileSync(manifestLockPath, 'utf8');
    if (manifestLock !== shaLockBytes(manifestDigest, 'run_manifest.json')) {
      issues.push({ code: 'manifest-lock-mismatch', message: 'run manifest lock differs from finalized bytes' });
    }
    const completion = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'completion');
    if (completion === undefined || !existsSync(completion.path)) {
      issues.push({ code: 'completion-missing', message: 'completion bundle is unavailable' });
    } else {
      const expectedFiles = [
        'chain_ledger.json', 'chain_ledger.sha256', 'completion_receipt.json', 'completion_receipt.sha256',
      ];
      if (canonicalizeBoundaryRun(readdirSync(completion.path).sort()) !== canonicalizeBoundaryRun(expectedFiles.sort())) {
        issues.push({ code: 'completion-file-set-mismatch', message: 'completion bundle file set is not closed' });
      }
      const ledgerBytes = readFileSync(path.join(completion.path, 'chain_ledger.json'));
      const receiptBytes = readFileSync(path.join(completion.path, 'completion_receipt.json'));
      const ledgerDigest = sha256(ledgerBytes);
      const receiptDigest = sha256(receiptBytes);
      if (readFileSync(path.join(completion.path, 'chain_ledger.sha256'), 'utf8') !== shaLockBytes(ledgerDigest, 'chain_ledger.json')) {
        issues.push({ code: 'ledger-lock-mismatch', message: 'chain ledger lock differs from ledger bytes' });
      }
      if (readFileSync(path.join(completion.path, 'completion_receipt.sha256'), 'utf8') !== shaLockBytes(receiptDigest, 'completion_receipt.json')) {
        issues.push({ code: 'completion-receipt-lock-mismatch', message: 'completion receipt lock differs from receipt bytes' });
      }
      const ledgerParsed = parseBoundaryJsonBytes(ledgerBytes);
      const receiptParsed = parseBoundaryJsonBytes(receiptBytes);
      issues.push(...ledgerParsed.result.issues, ...receiptParsed.result.issues);
      if (
        ledgerParsed.text !== null
        && ledgerParsed.text !== canonicalizeBoundaryRun(ledgerParsed.value)
      ) issues.push({ code: 'completion-noncanonical-json', message: 'chain ledger is not canonical JSON' });
      if (
        receiptParsed.text !== null
        && receiptParsed.text !== canonicalizeBoundaryRun(receiptParsed.value)
      ) issues.push({ code: 'completion-noncanonical-json', message: 'completion receipt is not canonical JSON' });
      const ledger = ledgerParsed.value as Record<string, unknown> | null;
      const receipt = receiptParsed.value as Record<string, unknown> | null;
      const exactKeys = (value: Record<string, unknown> | null, expected: readonly string[]): boolean => value !== null
        && canonicalizeBoundaryRun(Object.keys(value).sort()) === canonicalizeBoundaryRun([...expected].sort());
      if (!exactKeys(ledger, RUN_WIRE_SCHEMAS.ChainLedger) || !exactKeys(receipt, RUN_WIRE_SCHEMAS.CompletionReceipt)) {
        issues.push({ code: 'completion-schema-mismatch', message: 'completion object keys differ from schema 1' });
      } else if (
        receipt!['runId'] !== manifest.run.runId
        || receipt!['taskId'] !== manifest.run.taskId
        || receipt!['profileId'] !== manifest.run.profileId
        || receipt!['manifestSha256'] !== manifestDigest
        || receipt!['manifestLockSha256'] !== sha256(manifestLock)
        || receipt!['ledgerSha256'] !== ledgerDigest
        || receipt!['overallVerdict'] !== manifest.overallVerdict
        || receipt!['terminalHead'] !== manifest.run.terminalHead
      ) {
        issues.push({ code: 'completion-identity-mismatch', message: 'completion receipt differs from the finalized run' });
      }
      if (manifest.run.profileId === 'bcf00-observation' && (!Array.isArray(ledger?.['rows']) || ledger['rows'].length !== 0)) {
        issues.push({ code: 'completion-ledger-mismatch', message: 'observation completion requires the canonical empty ledger' });
      }
      if (
        ledger !== null
        && receipt !== null
        && (
          ledger['reconciledBase'] !== receipt['reconciledBase']
          || ledger['upstreamObservedOid'] !== receipt['upstreamObservedOid']
          || canonicalizeBoundaryRun(ledger['corpusDigests']) !== canonicalizeBoundaryRun(receipt['corpusDigests'])
          || ledger['oracleDigest'] !== receipt['oracleDigest']
          || receipt['reconciledBase'] !== manifest.run.reconciledBase
          || receipt['upstreamObservedOid'] !== manifest.upstream.observedOid
        )
      ) {
        issues.push({ code: 'completion-ledger-mismatch', message: 'completion receipt and ledger inherited fields differ' });
      }
      if (manifest.run.profileId === 'bcf00-reconciliation' && ledger !== null && receipt !== null) {
        const expectedRows = [{
          ordinal: 1,
          taskId: manifest.run.taskId,
          profileId: manifest.run.profileId,
          runId: manifest.run.runId,
          entryHead: manifest.run.entryHead,
          terminalHead: manifest.run.terminalHead,
          manifestSha256: manifestDigest,
          previousLedgerSha256: null,
          overallVerdict: manifest.overallVerdict,
        }];
        if (
          canonicalizeBoundaryRun(ledger['rows']) !== canonicalizeBoundaryRun(expectedRows)
          || receipt['predecessorReceiptSha256'] !== null
          || receipt['predecessorLedgerSha256'] !== null
        ) {
          issues.push({ code: 'completion-ledger-mismatch', message: 'reconciliation completion is not the sole BCF-00 genesis' });
        }
      }
      if (
        manifest.run.profileId !== 'bcf00-observation'
        && manifest.run.profileId !== 'bcf00-reconciliation'
        && ledger !== null
        && receipt !== null
      ) {
        const predecessor = manifest.predecessor;
        if (predecessor === null) {
          issues.push({ code: 'completion-ledger-mismatch', message: 'non-genesis completion lacks its predecessor' });
        } else {
          try {
            const predecessorRoot = path.join(runDir, 'predecessor', 'completion');
            const predecessorReceiptBytes = readConfinedRegularFile(predecessorRoot, 'completion_receipt.json');
            const predecessorLedgerBytes = readConfinedRegularFile(predecessorRoot, 'chain_ledger.json');
            const predecessorReceipt = strictCanonicalObject(predecessorReceiptBytes, 'predecessor completion receipt');
            const predecessorLedger = strictCanonicalObject(predecessorLedgerBytes, 'predecessor chain ledger');
            const predecessorReceiptDigest = sha256(predecessorReceiptBytes);
            const predecessorLedgerDigest = sha256(predecessorLedgerBytes);
            let chainValid = receipt['predecessorReceiptSha256'] === predecessorReceiptDigest
              && receipt['predecessorLedgerSha256'] === predecessorLedgerDigest
              && predecessorReceiptDigest === predecessor.pin.completionReceiptSha256
              && predecessorLedgerDigest === predecessor.pin.ledgerSha256;
            if (manifest.run.chainAppend) {
              const predecessorRows = predecessorLedger['rows'];
              const currentRow = {
                ordinal: Array.isArray(predecessorRows) ? predecessorRows.length + 1 : 0,
                taskId: manifest.run.taskId,
                profileId: manifest.run.profileId,
                runId: manifest.run.runId,
                entryHead: manifest.run.entryHead,
                terminalHead: manifest.run.terminalHead,
                manifestSha256: manifestDigest,
                previousLedgerSha256: predecessorLedgerDigest,
                overallVerdict: manifest.overallVerdict,
              };
              const appended = validateAndAppendBoundaryPredecessor({
                profileId: manifest.run.profileId,
                pin: predecessor.pin,
                receipt: predecessorReceipt,
                ledger: predecessorLedger,
                receiptSha256: predecessorReceiptDigest,
                ledgerSha256: predecessorLedgerDigest,
                inherited: {
                  reconciledBase: receipt['reconciledBase'],
                  upstreamObservedOid: receipt['upstreamObservedOid'],
                  corpusDigests: receipt['corpusDigests'],
                  oracleDigest: receipt['oracleDigest'],
                },
                currentRow,
              });
              chainValid = chainValid
                && appended.result.ok
                && appended.ledger !== null
                && canonicalizeBoundaryRun(appended.ledger) === canonicalizeBoundaryRun(ledger);
            } else {
              chainValid = chainValid
                && canonicalizeBoundaryRun(predecessorLedger) === canonicalizeBoundaryRun(ledger);
            }
            if (!chainValid) {
              issues.push({ code: 'completion-ledger-mismatch', message: 'completion ledger does not exactly extend or preserve its predecessor' });
            }
          } catch (error) {
            issues.push({ code: 'completion-ledger-mismatch', message: (error as Error).message });
          }
        }
      }
    }
    return operationResult(
      issues,
      issues.length === 0 ? 0 : 1,
      issues.length === 0 ? manifest.overallVerdict : 'Inconclusive',
    );
  } catch (error) {
    return operationResult([{ code: 'verify-failed', message: (error as Error).message }]);
  }
}

function exactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BoundaryCloseoutControlClosure {
  manifest: BoundaryRunManifest;
  closeoutCore: Record<string, unknown>;
  completionReceipt: Record<string, unknown> | null;
  ledger: Record<string, unknown> | null;
}

export function validateBoundaryCloseoutControlClosure(
  closure: BoundaryCloseoutControlClosure,
  base: BoundaryCloseoutControlClosure,
): BoundaryValidationResult {
  const artifactIdentity = (manifest: BoundaryRunManifest) => manifest.artifacts.map((entry) => ({
    path: entry.path, producerAttemptId: entry.producerAttemptId, role: entry.role,
  }));
  const artifactBytes = (manifest: BoundaryRunManifest) => manifest.artifacts.map((entry) => ({
    path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
  }));
  if (canonicalizeBoundaryRun(artifactIdentity(closure.manifest)) !== canonicalizeBoundaryRun(artifactIdentity(base.manifest))) {
    return operationResult([{ code: 'foreign-artifact', message: 'artifact identity set differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(artifactBytes(closure.manifest)) !== canonicalizeBoundaryRun(artifactBytes(base.manifest))) {
    return operationResult([{ code: 'artifact-byte-mutation', message: 'artifact byte identity differs from the accepted closure' }]);
  }
  if (closure.manifest.run.terminalHead !== base.manifest.run.terminalHead) {
    return operationResult([{ code: 'head-mismatch', message: 'terminal head differs from the accepted closure' }]);
  }
  if (closure.manifest.currentSnapshot.digestSha256 !== base.manifest.currentSnapshot.digestSha256) {
    return operationResult([{ code: 'diff-mismatch', message: 'worktree diff identity differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(closure.manifest.children) !== canonicalizeBoundaryRun(base.manifest.children)) {
    return operationResult([{ code: 'missing-child-receipt', message: 'required child receipt closure differs from the accepted closure' }]);
  }
  if (canonicalizeBoundaryRun(closure.manifest) !== canonicalizeBoundaryRun(base.manifest)) {
    return operationResult([{ code: 'changed-manifest', message: 'manifest differs from the accepted closure' }]);
  }
  const internalStatus = closure.closeoutCore['internalStatus'];
  if (
    Array.isArray(internalStatus)
    && internalStatus.some((entry) => isPlainRecord(entry)
      && (entry['rawExit'] !== 0 || entry['rawSignal'] !== null || entry['expectationMet'] !== true || entry['verdict'] !== 'Pass'))
  ) return operationResult([{ code: 'forged-internal-status', message: 'closeout internal status is not a direct Pass' }]);
  if (canonicalizeBoundaryRun(closure.closeoutCore) !== canonicalizeBoundaryRun(base.closeoutCore)) {
    return operationResult([{ code: 'substituted-core', message: 'closeout core differs from the accepted closure' }]);
  }
  if (closure.completionReceipt === null) {
    return operationResult([{ code: 'missing-completion-receipt', message: 'completion receipt is missing' }]);
  }
  if (canonicalizeBoundaryRun(closure.completionReceipt) !== canonicalizeBoundaryRun(base.completionReceipt)) {
    return operationResult([{ code: 'changed-completion-receipt', message: 'completion receipt differs from the accepted closure' }]);
  }
  if (closure.ledger === null || canonicalizeBoundaryRun(closure.ledger) !== canonicalizeBoundaryRun(base.ledger)) {
    return operationResult([{ code: 'changed-chain-ledger', message: 'chain ledger differs from the accepted closure' }]);
  }
  const structural = validateBoundaryRun(closure.manifest);
  if (!structural.ok) return structural;
  return operationResult([], 0, 'Pass');
}

function ensureReservedParent(record: BoundaryReservedDerivedRootRecord): string {
  const parent = realpathSync(path.dirname(record.path));
  const stat = lstatSync(parent);
  if (
    stat.isSymbolicLink()
    || Number(stat.dev) !== record.parentDevice
    || Number(stat.ino) !== record.parentInode
    || path.join(parent, path.basename(record.path)) !== record.path
  ) throw new Error(`reserved ${record.kind} parent identity changed`);
  return parent;
}

function writeRejectedCloseout(
  manifest: BoundaryRunManifest,
  runDir: string,
  attemptId: string,
  failedStage: string,
  reasonCode: string,
): BoundaryValidationResult {
  try {
    const record = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout-failure');
    if (record === undefined) throw new Error('closeout failure root reservation is unavailable');
    ensureReservedParent(record);
    if (!existsSync(record.path)) mkdirSync(record.path, { recursive: false, mode: 0o700 });
    const attemptDir = path.join(record.path, attemptId);
    if (!existsSync(attemptDir)) mkdirSync(attemptDir, { recursive: false, mode: 0o700 });
    if (existsSync(path.join(attemptDir, 'closeout_receipt.json'))) throw new Error('closeout rejection attempt already has a receipt');
    const manifestBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const receipt = {
      schemaVersion: 1,
      kind: 'rejected',
      runId: manifest.run.runId,
      taskId: manifest.run.taskId,
      profileId: manifest.run.profileId,
      terminalHead: manifest.run.terminalHead,
      snapshotDigestSha256: manifest.currentSnapshot.digestSha256,
      helperCommit: manifest.run.helperCommit,
      helperSha256: manifest.run.helperSha256,
      runManifestSha256: sha256(manifestBytes),
      runManifestLockSha256: existsSync(path.join(runDir, 'run_manifest.sha256'))
        ? sha256(readFileSync(path.join(runDir, 'run_manifest.sha256')))
        : null,
      finalizeRawExit: 1,
      finalizeRawSignal: null,
      verifyRawExit: null,
      verifyRawSignal: null,
      completionReceiptSha256: null,
      completionReceiptLockSha256: null,
      ledgerSha256: null,
      ledgerLockSha256: null,
      startedAtUtc: new Date().toISOString(),
      endedAtUtc: new Date().toISOString(),
      lifecycleStatus: manifest.lifecycle.status,
      requiredAttemptIds: manifest.run.requiredAttemptIds,
      requiredChildAliases: manifest.run.requiredChildAliases,
      closeoutCoreSha256: null,
      negativeControlReportSha256: null,
      failedStage,
      runVerdict: manifest.overallVerdict,
      rawExit: 1,
      rawSignal: null,
      reasonCode,
      manifestState: manifest.manifestState,
      overallVerdict: 'Inconclusive',
    };
    const bytes = canonicalizeBoundaryRun(receipt);
    durableExclusiveWrite(path.join(attemptDir, 'closeout_receipt.json'), bytes);
    durableExclusiveWrite(
      path.join(attemptDir, 'closeout_receipt.sha256'),
      shaLockBytes(sha256(bytes), 'closeout_receipt.json'),
    );
    return operationResult([{ code: reasonCode, message: `closeout rejected at ${failedStage}` }]);
  } catch (error) {
    return operationResult([{ code: 'closeout-rejection-write-failed', message: (error as Error).message }]);
  }
}

function closeoutRun(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir')!;
  const attemptId = stringOption(invocation.options, 'attemptId')!;
  let loaded: { manifest: BoundaryRunManifest; path: string };
  try {
    loaded = loadActiveManifest(runDir);
  } catch (error) {
    return runLoadFailure(error);
  }
  const { manifest } = loaded;
  if (manifest.run.taskId !== 'BCF-08C' || manifest.run.profileId !== 'bcf08-final') {
    return operationResult([{ code: 'closeout-profile-forbidden', message: 'closeout accepts only BCF-08C/bcf08-final' }], 2);
  }
  const closeoutRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout');
  const failureRecord = manifest.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout-failure');
  if (closeoutRecord === undefined || failureRecord === undefined) {
    return operationResult([{ code: 'closeout-reservation-missing', message: 'final run lacks its derived closeout roots' }]);
  }
  if (existsSync(closeoutRecord.path) || existsSync(path.join(failureRecord.path, attemptId))) {
    return operationResult([{ code: 'closeout-attempt-reused', message: 'closeout attempt or accepted destination already exists' }], 2);
  }
  const built = buildFinalCompletionCandidate(manifest, runDir, cwd);
  if (!built.result.ok || built.candidate === null) {
    const reason = built.result.issues[0]?.code ?? 'closeout-completion-failed';
    writeRejectedCloseout(manifest, runDir, attemptId, 'completion', reason);
    return built.result;
  }
  const candidate = built.candidate;
  const startedAtUtc = new Date().toISOString();
  const internalStatus = [
    { stage: 'finalize', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
    { stage: 'verify', rawExit: 0, rawSignal: null, expectationMet: true, verdict: 'Pass' },
  ];
  const closeoutCore = {
    schemaVersion: 1,
    runId: candidate.manifest.run.runId,
    taskId: candidate.manifest.run.taskId,
    profileId: candidate.manifest.run.profileId,
    terminalHead: candidate.manifest.run.terminalHead,
    snapshotDigestSha256: candidate.manifest.currentSnapshot.digestSha256,
    helperCommit: candidate.manifest.run.helperCommit,
    helperSha256: candidate.manifest.run.helperSha256,
    runManifestSha256: candidate.manifestSha256,
    runManifestLockSha256: sha256(candidate.manifestLock),
    finalizeRawExit: 0,
    finalizeRawSignal: null,
    verifyRawExit: 0,
    verifyRawSignal: null,
    completionReceiptSha256: candidate.completionReceiptSha256,
    completionReceiptLockSha256: sha256(candidate.completionReceiptLock),
    ledgerSha256: candidate.ledgerSha256,
    ledgerLockSha256: sha256(candidate.ledgerLock),
    startedAtUtc,
    endedAtUtc: new Date().toISOString(),
    lifecycleStatus: candidate.manifest.lifecycle.status,
    requiredAttemptIds: candidate.manifest.run.requiredAttemptIds,
    requiredChildAliases: candidate.manifest.run.requiredChildAliases,
    internalStatus,
    overallVerdict: 'Pass',
  };
  const closeoutCoreBytes = canonicalizeBoundaryRun(closeoutCore);
  const closeoutCoreSha256 = sha256(closeoutCoreBytes);
  try {
    ensureReservedParent(failureRecord);
    if (!existsSync(failureRecord.path)) mkdirSync(failureRecord.path, { recursive: false, mode: 0o700 });
    const controlRoot = path.join(failureRecord.path, attemptId);
    mkdirSync(controlRoot, { recursive: false, mode: 0o700 });
    const mutationIds = [
      'foreign-artifact', 'artifact-byte-mutation', 'head-mismatch', 'diff-mismatch',
      'missing-child-receipt', 'changed-manifest', 'substituted-core',
      'missing-completion-receipt', 'changed-completion-receipt', 'changed-chain-ledger',
      'forged-internal-status',
    ];
    const baseClosure: BoundaryCloseoutControlClosure = {
      manifest: candidate.manifest,
      closeoutCore,
      completionReceipt: candidate.completionReceipt,
      ledger: candidate.ledger,
    };
    const unchanged = validateBoundaryCloseoutControlClosure(structuredClone(baseClosure), baseClosure);
    if (!unchanged.ok) throw new Error(`unchanged closeout control failed: ${unchanged.issues[0]?.code ?? 'unknown'}`);
    const negativeCases = mutationIds.map((mutationId, index) => {
      const fixturePath = `controls/${String(index + 1).padStart(2, '0')}-${mutationId}.json`;
      const mutated = structuredClone(baseClosure);
      switch (mutationId) {
        case 'foreign-artifact': {
          const source = mutated.manifest.artifacts[0];
          if (source === undefined) throw new Error('negative matrix requires at least one admitted artifact');
          mutated.manifest.artifacts.push({ ...source, path: `foreign/${path.basename(source.path)}` });
          break;
        }
        case 'artifact-byte-mutation': {
          const source = mutated.manifest.artifacts[0];
          if (source === undefined) throw new Error('negative matrix requires at least one admitted artifact');
          source.sha256 = source.sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
          break;
        }
        case 'head-mismatch':
          mutated.manifest.run.terminalHead = '0'.repeat(40);
          break;
        case 'diff-mismatch':
          mutated.manifest.currentSnapshot.digestSha256 = '0'.repeat(64);
          break;
        case 'missing-child-receipt':
          mutated.manifest.children = mutated.manifest.children.slice(1);
          break;
        case 'changed-manifest':
          mutated.manifest.run.createdAtUtc = new Date(Date.parse(mutated.manifest.run.createdAtUtc) + 1).toISOString();
          break;
        case 'substituted-core':
          mutated.closeoutCore['helperSha256'] = '0'.repeat(64);
          break;
        case 'missing-completion-receipt':
          mutated.completionReceipt = null;
          break;
        case 'changed-completion-receipt':
          mutated.completionReceipt!['oracleDigest'] = '0'.repeat(64);
          break;
        case 'changed-chain-ledger':
          mutated.ledger!['oracleDigest'] = '0'.repeat(64);
          break;
        case 'forged-internal-status':
          (mutated.closeoutCore['internalStatus'] as Array<Record<string, unknown>>)[0]!['rawExit'] = 1;
          break;
      }
      const controlResult = validateBoundaryCloseoutControlClosure(mutated, baseClosure);
      if (controlResult.ok || controlResult.issues[0]?.code !== mutationId) {
        throw new Error(`negative control ${mutationId} produced ${controlResult.issues[0]?.code ?? 'Pass'}`);
      }
      const fixture = {
        schemaVersion: 1,
        mutationId,
        baseManifestSha256: candidate.manifestSha256,
        baseCoreSha256: closeoutCoreSha256,
        closure: mutated,
      };
      const bytes = canonicalizeBoundaryRun(fixture);
      const destination = path.join(controlRoot, fixturePath);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      durableExclusiveWrite(destination, bytes);
      return {
        ordinal: index + 1,
        mutationId,
        fixturePath,
        expectedReasonCode: controlResult.issues[0].code,
        rawExit: controlResult.exitCode,
        rawSignal: null,
        expectationMet: controlResult.exitCode !== 0,
        stdoutSha256: sha256(''),
        stderrSha256: sha256(`${controlResult.issues[0].code}\n`),
        treeDigestSha256: sha256(bytes),
        verdict: 'Pass',
      };
    });
    const negativeReport = {
      schemaVersion: 1,
      runId: candidate.manifest.run.runId,
      closeoutCoreSha256,
      cases: negativeCases,
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      overallVerdict: 'Pass',
    };
    const negativeReportBytes = canonicalizeBoundaryRun(negativeReport);
    const negativeControlReportSha256 = sha256(negativeReportBytes);
    durableExclusiveWrite(path.join(controlRoot, 'closeout_core.json'), closeoutCoreBytes);
    durableExclusiveWrite(path.join(controlRoot, 'negative_control_report.json'), negativeReportBytes);
    const receipt = {
      schemaVersion: 1,
      kind: 'accepted',
      runId: candidate.manifest.run.runId,
      taskId: candidate.manifest.run.taskId,
      profileId: candidate.manifest.run.profileId,
      terminalHead: candidate.manifest.run.terminalHead,
      snapshotDigestSha256: candidate.manifest.currentSnapshot.digestSha256,
      helperCommit: candidate.manifest.run.helperCommit,
      helperSha256: candidate.manifest.run.helperSha256,
      runManifestSha256: candidate.manifestSha256,
      runManifestLockSha256: sha256(candidate.manifestLock),
      finalizeRawExit: 0,
      finalizeRawSignal: null,
      verifyRawExit: 0,
      verifyRawSignal: null,
      completionReceiptSha256: candidate.completionReceiptSha256,
      completionReceiptLockSha256: sha256(candidate.completionReceiptLock),
      ledgerSha256: candidate.ledgerSha256,
      ledgerLockSha256: sha256(candidate.ledgerLock),
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
      lifecycleStatus: candidate.manifest.lifecycle.status,
      requiredAttemptIds: candidate.manifest.run.requiredAttemptIds,
      requiredChildAliases: candidate.manifest.run.requiredChildAliases,
      closeoutCoreSha256,
      negativeControlReportSha256,
      failedStage: null,
      runVerdict: candidate.manifest.overallVerdict,
      rawExit: 0,
      rawSignal: null,
      reasonCode: null,
      manifestState: candidate.manifest.manifestState,
      overallVerdict: 'Pass',
    };
    const receiptBytes = canonicalizeBoundaryRun(receipt);
    const receiptSha256 = sha256(receiptBytes);
    const acceptedParent = ensureReservedParent(closeoutRecord);
    const staging = path.join(acceptedParent, `.${candidate.manifest.run.runId}.${attemptId}.publishing`);
    mkdirSync(staging, { recursive: false, mode: 0o700 });
    const completionDir = path.join(staging, 'completion');
    mkdirSync(completionDir, { recursive: false, mode: 0o700 });
    const rootFiles: Array<[string, string]> = [
      ['run_manifest.json', candidate.manifestBytes],
      ['run_manifest.sha256', candidate.manifestLock],
      ['closeout_core.json', closeoutCoreBytes],
      ['negative_control_report.json', negativeReportBytes],
      ['closeout_receipt.json', receiptBytes],
      ['closeout_receipt.sha256', shaLockBytes(receiptSha256, 'closeout_receipt.json')],
    ];
    const completionFiles: Array<[string, string]> = [
      ['chain_ledger.json', candidate.ledgerBytes],
      ['chain_ledger.sha256', candidate.ledgerLock],
      ['completion_receipt.json', candidate.completionReceiptBytes],
      ['completion_receipt.sha256', candidate.completionReceiptLock],
    ];
    for (const [basename, bytes] of rootFiles) durableExclusiveWrite(path.join(staging, basename), bytes);
    for (const [basename, bytes] of completionFiles) durableExclusiveWrite(path.join(completionDir, basename), bytes);
    for (const directory of [completionDir, staging]) {
      const descriptor = openSync(directory, 'r');
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    }
    durableAtomicRewrite(loaded.path, candidate.manifestBytes);
    durableExclusiveWrite(path.join(runDir, 'run_manifest.sha256'), candidate.manifestLock);
    renameSync(staging, closeoutRecord.path);
    const parentDescriptor = openSync(acceptedParent, 'r');
    try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
    return operationResult([], 0, 'Pass');
  } catch (error) {
    writeRejectedCloseout(manifest, runDir, attemptId, 'negative-control', 'closeout-publication-failed');
    return operationResult([{ code: 'closeout-publication-failed', message: (error as Error).message }]);
  }
}

function verifyAcceptedCloseout(runDir: string, cwd: string): BoundaryValidationResult {
  const issues: BoundaryValidationIssue[] = [];
  try {
    const originalBytes = readFileSync(path.join(runDir, 'run_manifest.json'));
    const originalValidation = validateBoundaryRunJson(originalBytes);
    if (!originalValidation.ok) return originalValidation;
    const original = JSON.parse(originalBytes.toString('utf8')) as BoundaryRunManifest;
    const record = original.run.reservedDerivedRoots.find((entry) => entry.kind === 'closeout');
    if (record === undefined) throw new Error('accepted closeout path is not reserved by the run');
    const root = realpathSync(record.path);
    const expectedRootFiles = [
      'closeout_core.json', 'closeout_receipt.json', 'closeout_receipt.sha256', 'completion',
      'negative_control_report.json', 'run_manifest.json', 'run_manifest.sha256',
    ].sort();
    if (canonicalizeBoundaryRun(readdirSync(root).sort()) !== canonicalizeBoundaryRun(expectedRootFiles)) {
      issues.push({ code: 'closeout-file-set-mismatch', message: 'accepted closeout file set is not closed' });
    }
    const manifestBytes = readConfinedRegularFile(root, 'run_manifest.json');
    const manifestLock = readConfinedRegularFile(root, 'run_manifest.sha256').toString('utf8');
    const coreBytes = readConfinedRegularFile(root, 'closeout_core.json');
    const reportBytes = readConfinedRegularFile(root, 'negative_control_report.json');
    const receiptBytes = readConfinedRegularFile(root, 'closeout_receipt.json');
    const receiptLock = readConfinedRegularFile(root, 'closeout_receipt.sha256').toString('utf8');
    const completionRoot = path.join(root, 'completion');
    const completionBytes = readConfinedRegularFile(completionRoot, 'completion_receipt.json');
    const completionLock = readConfinedRegularFile(completionRoot, 'completion_receipt.sha256').toString('utf8');
    const ledgerBytes = readConfinedRegularFile(completionRoot, 'chain_ledger.json');
    const ledgerLock = readConfinedRegularFile(completionRoot, 'chain_ledger.sha256').toString('utf8');
    const core = strictCanonicalObject(coreBytes, 'closeout core');
    const report = strictCanonicalObject(reportBytes, 'negative-control report');
    const receipt = strictCanonicalObject(receiptBytes, 'closeout receipt');
    const completion = strictCanonicalObject(completionBytes, 'completion receipt');
    if (!exactObjectKeys(core, RUN_WIRE_SCHEMAS.CloseoutCore)
      || !exactObjectKeys(report, RUN_WIRE_SCHEMAS.CloseoutNegativeReport)
      || !exactObjectKeys(receipt, RUN_WIRE_SCHEMAS.CloseoutReceipt)) {
      issues.push({ code: 'closeout-schema-mismatch', message: 'closeout core, report, or receipt has a foreign key' });
    }
    if (
      !manifestBytes.equals(originalBytes)
      || manifestLock !== shaLockBytes(sha256(manifestBytes), 'run_manifest.json')
      || receiptLock !== shaLockBytes(sha256(receiptBytes), 'closeout_receipt.json')
      || completionLock !== shaLockBytes(sha256(completionBytes), 'completion_receipt.json')
      || ledgerLock !== shaLockBytes(sha256(ledgerBytes), 'chain_ledger.json')
      || receipt['kind'] !== 'accepted'
      || receipt['overallVerdict'] !== 'Pass'
      || receipt['runVerdict'] !== 'Pass'
      || receipt['rawExit'] !== 0
      || receipt['rawSignal'] !== null
      || receipt['runManifestSha256'] !== sha256(manifestBytes)
      || receipt['closeoutCoreSha256'] !== sha256(coreBytes)
      || receipt['negativeControlReportSha256'] !== sha256(reportBytes)
      || receipt['completionReceiptSha256'] !== sha256(completionBytes)
      || receipt['ledgerSha256'] !== sha256(ledgerBytes)
      || report['closeoutCoreSha256'] !== sha256(coreBytes)
      || completion['manifestSha256'] !== sha256(manifestBytes)
      || completion['ledgerSha256'] !== sha256(ledgerBytes)
    ) issues.push({ code: 'closeout-hash-mismatch', message: 'accepted closeout lock or cross-record identity changed' });
    const cases = Array.isArray(report['cases']) ? report['cases'] as Array<Record<string, unknown>> : [];
    if (
      cases.length !== 11
      || cases.some((entry, index) => !exactObjectKeys(entry, RUN_WIRE_SCHEMAS.CloseoutNegativeCase)
        || entry['ordinal'] !== index + 1 || entry['expectationMet'] !== true || entry['verdict'] !== 'Pass')
    ) issues.push({ code: 'closeout-negative-control-mismatch', message: 'negative-control matrix is incomplete or non-pass' });
    issues.push(...verifyManifestEvidence(original, runDir, cwd, true));
  } catch (error) {
    issues.push({ code: 'verify-closeout-failed', message: (error as Error).message });
  }
  return operationResult(issues, issues.length === 0 ? 0 : 1, issues.length === 0 ? 'Pass' : 'Inconclusive');
}

function verifyCloseout(invocation: BoundaryRunInvocation, cwd: string): BoundaryValidationResult {
  const runDir = stringOption(invocation.options, 'runDir');
  if (runDir !== undefined) return verifyAcceptedCloseout(runDir, cwd);
  const failureDir = stringOption(invocation.options, 'failureReceiptDir')!;
  try {
    const root = realpathSync(failureDir);
    const bytes = readConfinedRegularFile(root, 'closeout_receipt.json');
    const lock = readConfinedRegularFile(root, 'closeout_receipt.sha256').toString('utf8');
    const receipt = strictCanonicalObject(bytes, 'rejected closeout receipt');
    const issues: BoundaryValidationIssue[] = [];
    if (!exactObjectKeys(receipt, RUN_WIRE_SCHEMAS.CloseoutReceipt)
      || receipt['kind'] !== 'rejected'
      || receipt['overallVerdict'] === 'Pass'
      || lock !== shaLockBytes(sha256(bytes), 'closeout_receipt.json')) {
      issues.push({ code: 'rejected-closeout-invalid', message: 'rejected receipt schema, verdict, or lock is invalid' });
    }
    return operationResult(issues, issues.length === 0 ? 0 : 1, issues.length === 0 ? receipt['overallVerdict'] as BoundaryValidationResult['verdict'] : 'Inconclusive');
  } catch (error) {
    return operationResult([{ code: 'verify-closeout-failed', message: (error as Error).message }]);
  }
}

export async function runBoundaryRunCli(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<BoundaryValidationResult> {
  let invocation: BoundaryRunInvocation;
  try {
    invocation = parseBoundaryRunInvocation(argv);
  } catch (error) {
    return operationResult([{ code: 'invocation-invalid', message: (error as Error).message }], 2);
  }
  if (invocation.command === 'init') return initializeRun(invocation, cwd);
  if (invocation.command === 'record-command') return recordCommand(invocation, cwd);
  if (invocation.command === 'record-internal-check') return recordInternalCheck(invocation, cwd);
  if (invocation.command === 'record-git-transition') return recordGitTransition(invocation, cwd);
  if (invocation.command === 'record-artifact') return recordArtifact(invocation);
  if (invocation.command === 'record-child-run') return recordChildRun(invocation, cwd);
  if (invocation.command === 'record-review') return recordReview(invocation);
  if (invocation.command === 'set-upstream') return setUpstream(invocation, cwd);
  if (invocation.command === 'set-lifecycle') return setLifecycle(invocation, cwd);
  if (invocation.command === 'finalize') return finalizeRun(invocation, cwd);
  if (invocation.command === 'verify') return verifyRun(invocation, cwd);
  if (invocation.command === 'closeout') return closeoutRun(invocation, cwd);
  return verifyCloseout(invocation, cwd);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runBoundaryRunCli(process.argv.slice(2));
  const destination = result.ok ? process.stdout : process.stderr;
  destination.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
