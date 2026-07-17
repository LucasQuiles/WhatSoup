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
  BOUNDARY_PINNED_GENERATED_INDEX_PARENT,
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
  parseBoundaryExpectedExit,
  parseBoundaryChildPins,
  parseBoundaryJsonBytes,
  parseBoundaryMergePreviewStdout,
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
} from '../boundary-run-manifest.ts';
import { cleanGitEnv } from '../../../../src/lib/git-env.ts';

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

export function isOperationalId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

export function isSafeRelativePath(value: string): boolean {
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

export function stringOption(options: Record<string, BoundaryInvocationValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
}

export function stringListOption(options: Record<string, BoundaryInvocationValue>, name: string): string[] {
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

