import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { cleanGitEnv } from '../src/lib/git-env.ts';
import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isRecord,
  sha256Bytes,
} from './lib/verification/boundary-run/shared.ts';
import { parseBoundaryJsonBytes } from './lib/verification/boundary-run/schema.ts';
import { reasonDefinition } from './lib/ci-control/reasons.ts';

export const HOOK_ENTRYPOINTS = [
  '.husky/commit-msg',
  '.husky/pre-commit',
  '.husky/pre-push',
] as const;
export const HOOK_HELPERS = ['.husky/check-commit-identity.sh'] as const;
export const REQUIRED_HOOK_PATHS = [...HOOK_HELPERS, ...HOOK_ENTRYPOINTS] as const;

type HookIdentityOutcome = 'pass' | 'block' | 'inconclusive';
type HookIdentityExitCode = 0 | 1 | 2;

export interface HookIdentityObservationV1 {
  path: (typeof REQUIRED_HOOK_PATHS)[number];
  expectedMode: string;
  expectedBlobOid: string;
  observedMode: string;
  observedBlobOid: string;
}

export interface GitExecutableIdentityV1 {
  identity: 'system';
  version: string;
  launcherDigest: string;
  implementationDigest: string;
}

export interface HookIdentityReceiptV1 {
  schemaVersion: 1;
  controlId: 'ci.hooks.installed';
  outcome: HookIdentityOutcome;
  exitCode: HookIdentityExitCode;
  code: string;
  expectedOid: string | null;
  observedHeadOid: string | null;
  gitExecutable: GitExecutableIdentityV1 | null;
  configuredPathKind: 'relative-current-worktree' | 'absolute-current-worktree' | 'foreign' | 'escaping' | 'missing' | 'disabled' | 'unavailable';
  location: 'git-config:core.hooksPath' | 'git-tree:.husky' | 'worktree:.husky';
  hooks: HookIdentityObservationV1[];
  why: string;
  guidance: string[];
  reproduce: 'npm run guard:hooks-installed';
  retryable: false;
  createdAt: string;
  evidenceDigest: string;
}

export interface StableHeadLineageEvaluation<T> {
  value: T | null;
  stable: boolean;
  code: 'stable' | 'ci.hooks.head-moved' | 'ci.hooks.evidence-unavailable';
  initialOid: string | null;
  finalOid: string | null;
}

type ReceiptInput = Omit<HookIdentityReceiptV1, 'evidenceDigest'>;

const OID = /^[0-9a-f]{40}$/;
const MAX_GIT_BYTES = 1_000_000;
export const MAX_HOOK_RECEIPT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const TRUSTED_GIT_PATH = '/usr/bin/git';
const MAX_GIT_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const MAX_INSTALLED_HOOK_BYTES = 1_000_000;

interface TrustedGitExecutable {
  path: typeof TRUSTED_GIT_PATH;
  identity: GitExecutableIdentityV1;
}

function trustedSystemFile(path: string): { digest: string } | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
    if (stat.size <= 0 || stat.size > MAX_GIT_EXECUTABLE_BYTES) return null;
    accessSync(path, constants.R_OK | constants.X_OK);
    const bytes = readFileSync(path);
    return { digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  } catch {
    return null;
  }
}

function trustedGitExecutable(): TrustedGitExecutable | null {
  try {
    const launcher = trustedSystemFile(TRUSTED_GIT_PATH);
    if (launcher === null) return null;
    const version = execFileSync(TRUSTED_GIT_PATH, ['--version'], {
      env: exactGitEnvironment(),
      encoding: 'utf8',
      maxBuffer: 4_096,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!/^git version [0-9][0-9A-Za-z. ()+-]{0,127}$/.test(version)) return null;
    const execPath = execFileSync(TRUSTED_GIT_PATH, ['--exec-path'], {
      env: exactGitEnvironment(),
      encoding: 'utf8',
      maxBuffer: 4_096,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!isAbsolute(execPath) || Buffer.byteLength(execPath, 'utf8') > 1_024) return null;
    const implementationPath = realpathSync(resolve(execPath, 'git'));
    const implementation = trustedSystemFile(implementationPath);
    if (implementation === null) return null;
    return {
      path: TRUSTED_GIT_PATH,
      identity: {
        identity: 'system',
        version,
        launcherDigest: launcher.digest,
        implementationDigest: implementation.digest,
      },
    };
  } catch {
    return null;
  }
}

function exactGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...cleanGitEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitBytes(git: TrustedGitExecutable, cwd: string, args: string[], input?: Uint8Array): Buffer {
  return execFileSync(git.path, args, {
    cwd,
    env: exactGitEnvironment(),
    input,
    maxBuffer: MAX_GIT_BYTES,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function gitText(git: TrustedGitExecutable, cwd: string, args: string[]): string {
  return gitBytes(git, cwd, args).toString('utf8').trim();
}

const RECEIPT_KEYS = [
  'schemaVersion', 'controlId', 'outcome', 'exitCode', 'code', 'expectedOid',
  'observedHeadOid', 'gitExecutable', 'configuredPathKind', 'location', 'hooks',
  'why', 'guidance', 'reproduce', 'retryable', 'createdAt', 'evidenceDigest',
] as const;
const HOOK_KEYS = ['path', 'expectedMode', 'expectedBlobOid', 'observedMode', 'observedBlobOid'] as const;
const GIT_EXECUTABLE_KEYS = ['identity', 'version', 'launcherDigest', 'implementationDigest'] as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class HookIdentityReceiptError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'HookIdentityReceiptError';
  }
}

function requireExactDataRecord(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new HookIdentityReceiptError(code);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new HookIdentityReceiptError(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) {
      throw new HookIdentityReceiptError(code);
    }
  }
  return value;
}

function boundedString(value: unknown, maxBytes = 4_096): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function hookIdentityEvidenceDigest(input: ReceiptInput): string {
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(input))}`;
}

function validateHookIdentityReceiptUnsafe(value: unknown): HookIdentityReceiptV1 {
  const record = requireExactDataRecord(value, RECEIPT_KEYS, 'ci.hooks.receipt.invalid-keys');
  const outcome = record.outcome;
  const exitCode = record.exitCode;
  if (record.schemaVersion !== 1 || record.controlId !== 'ci.hooks.installed') {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-identity');
  }
  if (
    !(
      (outcome === 'pass' && exitCode === 0)
      || (outcome === 'block' && exitCode === 1)
      || (outcome === 'inconclusive' && exitCode === 2)
    )
  ) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-outcome');
  if (!boundedString(record.code, 128) || !(record.code in HOOK_REASON_MESSAGES)) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.unknown-code');
  }
  const message = HOOK_REASON_MESSAGES[record.code as keyof typeof HOOK_REASON_MESSAGES];
  const registered = reasonDefinition(record.code);
  if (registered === null || registered.defaultOutcome !== outcome) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.reason-outcome-mismatch');
  }
  if (
    !Array.isArray(record.guidance)
    || record.guidance.length > 8
    || record.guidance.some((entry) => !boundedString(entry, 1_024))
  ) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-guidance');
  }
  if (record.why !== message.why || canonicalizeBoundaryRun(record.guidance) !== canonicalizeBoundaryRun(message.guidance)) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.message-mismatch');
  }
  if (record.reproduce !== 'npm run guard:hooks-installed' || record.retryable !== false) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-remediation');
  }
  if (!boundedString(record.createdAt, 64) || !TIMESTAMP.test(record.createdAt) || new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-timestamp');
  }
  if (typeof record.evidenceDigest !== 'string' || !SHA256.test(record.evidenceDigest)) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-digest');
  }
  if (record.expectedOid !== null && (typeof record.expectedOid !== 'string' || !OID.test(record.expectedOid))) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-oid');
  }
  if (record.observedHeadOid !== null && (typeof record.observedHeadOid !== 'string' || !OID.test(record.observedHeadOid))) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-oid');
  }
  const pathKinds = new Set(['relative-current-worktree', 'absolute-current-worktree', 'foreign', 'escaping', 'missing', 'disabled', 'unavailable']);
  const locations = new Set(['git-config:core.hooksPath', 'git-tree:.husky', 'worktree:.husky']);
  if (
    typeof record.configuredPathKind !== 'string'
    || typeof record.location !== 'string'
    || !pathKinds.has(record.configuredPathKind)
    || !locations.has(record.location)
  ) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-location');
  }
  if (record.gitExecutable !== null) {
    const executable = requireExactDataRecord(record.gitExecutable, GIT_EXECUTABLE_KEYS, 'ci.hooks.receipt.invalid-git-executable');
    if (
      executable.identity !== 'system'
      || !boundedString(executable.version, 128)
      || typeof executable.launcherDigest !== 'string'
      || !SHA256.test(executable.launcherDigest)
      || typeof executable.implementationDigest !== 'string'
      || !SHA256.test(executable.implementationDigest)
    ) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-git-executable');
  }
  if (!Array.isArray(record.hooks) || record.hooks.length > REQUIRED_HOOK_PATHS.length) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-hooks');
  }
  for (const [index, value] of record.hooks.entries()) {
    const hook = requireExactDataRecord(value, HOOK_KEYS, 'ci.hooks.receipt.invalid-hook');
    if (
      hook.path !== REQUIRED_HOOK_PATHS[index]
      || hook.expectedMode !== '100755'
      || hook.observedMode !== '100755'
      || typeof hook.expectedBlobOid !== 'string'
      || !OID.test(hook.expectedBlobOid)
      || typeof hook.observedBlobOid !== 'string'
      || !OID.test(hook.observedBlobOid)
    ) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-hook');
  }
  if (outcome === 'pass') {
    if (
      record.expectedOid === null
      || record.expectedOid !== record.observedHeadOid
      || record.gitExecutable === null
      || record.configuredPathKind !== 'relative-current-worktree'
      || record.hooks.length !== REQUIRED_HOOK_PATHS.length
      || record.hooks.some((hook) => {
        const row = hook as HookIdentityObservationV1;
        return row.expectedBlobOid !== row.observedBlobOid;
      })
    ) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-pass');
  }
  if (outcome === 'block') {
    if (
      (record.code !== 'ci.hooks.source-missing' && record.code !== 'ci.hooks.source-invalid')
      || record.expectedOid === null
      || record.observedHeadOid !== null
      || record.gitExecutable === null
      || record.configuredPathKind !== 'relative-current-worktree'
      || record.location !== 'git-tree:.husky'
    ) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-block');
  }
  const { evidenceDigest: _digest, ...content } = record;
  if (record.evidenceDigest !== hookIdentityEvidenceDigest(content as ReceiptInput)) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.digest-mismatch');
  }
  return value as HookIdentityReceiptV1;
}

export function validateHookIdentityReceipt(value: unknown): HookIdentityReceiptV1 {
  try {
    return validateHookIdentityReceiptUnsafe(value);
  } catch (error) {
    if (error instanceof HookIdentityReceiptError) throw error;
    throw new HookIdentityReceiptError('ci.hooks.receipt.traversal-failed');
  }
}

export function serializeHookIdentityReceipt(value: unknown): Uint8Array {
  return Buffer.from(canonicalizeBoundaryRun(validateHookIdentityReceipt(value)), 'utf8');
}

export function parseHookIdentityReceiptBytes(bytes: Uint8Array): HookIdentityReceiptV1 {
  if (bytes.byteLength > MAX_HOOK_RECEIPT_BYTES) throw new HookIdentityReceiptError('ci.hooks.receipt.byte-budget');
  const parsed = parseBoundaryJsonBytes(bytes);
  if (!parsed.result.ok || parsed.value === null) throw new HookIdentityReceiptError('ci.hooks.receipt.invalid-json');
  const receipt = validateHookIdentityReceipt(parsed.value);
  if (!Buffer.from(bytes).equals(Buffer.from(serializeHookIdentityReceipt(receipt)))) {
    throw new HookIdentityReceiptError('ci.hooks.receipt.noncanonical-json');
  }
  return receipt;
}

function finish(input: ReceiptInput): HookIdentityReceiptV1 {
  return validateHookIdentityReceipt({
    ...input,
    evidenceDigest: hookIdentityEvidenceDigest(input),
  });
}

const HOOK_REASON_MESSAGES = {
  'ci.hooks.pass': {
    why: 'The configured hooks resolve to this worktree and match the exact checked-out Git objects.',
    guidance: [],
  },
  'ci.hooks.path-foreign': {
    why: 'The active hooks directory is owned by another worktree.',
    guidance: ['After operator confirmation, configure the repository-relative hooks path.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.path-absolute': {
    why: 'The active hooks directory uses a nonportable absolute path.',
    guidance: ['After operator confirmation, configure the repository-relative hooks path.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.path-escaping': {
    why: 'The configured hooks directory does not remain inside the current worktree.',
    guidance: ['Set the reviewed repository-relative hooks path after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.path-missing': {
    why: 'The configured hooks directory is missing or not configured.',
    guidance: ['Restore the reviewed repository-relative hook configuration.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.path-disabled': {
    why: 'Repository hooks are disabled for this worktree.',
    guidance: ['Restore the reviewed repository-relative hook configuration.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.input-invalid': {
    why: 'The hook identity command received unsupported or duplicate arguments.',
    guidance: ['Run the canonical reproduction command without additional arguments.', 'Use the help command to inspect the closed CLI contract.'],
  },
  'ci.hooks.source-missing': {
    why: 'The checked-out Git revision omits a required repository hook entry.',
    guidance: ['Restore the required hook in the canonical source tree.', 'Preserve its executable mode and companion tests.'],
  },
  'ci.hooks.source-invalid': {
    why: 'A required committed hook entry has an invalid type or executable mode.',
    guidance: ['Repair the canonical hook entry without weakening the hook policy.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-missing': {
    why: 'A required installed hook entry is missing.',
    guidance: ['Restore the reviewed repository-relative hook installation after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-symlink': {
    why: 'A hook path component or installed hook is a symbolic link.',
    guidance: ['Replace the symbolic link with the reviewed regular file after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-type-invalid': {
    why: 'A required installed hook entry is not a regular file.',
    guidance: ['Restore the reviewed regular hook file after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-unexpected': {
    why: 'The active hooks directory contains an entry outside the reviewed hook closure.',
    guidance: ['Remove or register the unexpected hook entry through review.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-hardlink': {
    why: 'A required installed hook has multiple filesystem links, so repository ownership is unproven.',
    guidance: ['Restore a repository-owned regular hook file after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-identity-changed': {
    why: 'A hook filesystem identity changed while it was being inspected.',
    guidance: ['Preserve the current state and restore a stable reviewed hook installation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-mode-mismatch': {
    why: 'A required installed hook is not executable as committed.',
    guidance: ['Restore the reviewed executable mode after confirmation.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.installed-bytes-mismatch': {
    why: 'Installed hook bytes differ from the exact checked-out Git object.',
    guidance: ['Restore the reviewed hook bytes after confirmation.', 'Do not copy hooks from another worktree.'],
  },
  'ci.hooks.head-moved': {
    why: 'The checked-out revision changed while hook identity was being inspected.',
    guidance: ['Preserve the current state and reacquire exact revision evidence.', 'Re-run the hook identity guard.'],
  },
  'ci.hooks.evidence-unavailable': {
    why: 'Hook identity evidence could not be read or validated.',
    guidance: ['Restore readable Git and filesystem evidence.', 'Re-run the hook identity guard without weakening the check.'],
  },
} as const;

function receipt(
  outcome: HookIdentityOutcome,
  code: string,
  state: {
    expectedOid: string | null;
    observedHeadOid?: string | null;
    gitExecutable: GitExecutableIdentityV1 | null;
    configuredPathKind: HookIdentityReceiptV1['configuredPathKind'];
    location: HookIdentityReceiptV1['location'];
    hooks?: HookIdentityObservationV1[];
  },
): HookIdentityReceiptV1 {
  const exitCode: HookIdentityExitCode = outcome === 'pass' ? 0 : outcome === 'block' ? 1 : 2;
  const message = HOOK_REASON_MESSAGES[code as keyof typeof HOOK_REASON_MESSAGES];
  if (message === undefined) throw new Error('ci.hooks.receipt.unknown-code');
  return finish({
    schemaVersion: 1,
    controlId: 'ci.hooks.installed',
    outcome,
    exitCode,
    code,
    expectedOid: state.expectedOid,
    observedHeadOid: state.observedHeadOid ?? null,
    gitExecutable: state.gitExecutable,
    configuredPathKind: state.configuredPathKind,
    location: state.location,
    hooks: state.hooks ?? [],
    why: message.why,
    guidance: [...message.guidance],
    reproduce: 'npm run guard:hooks-installed',
    retryable: false,
    createdAt: new Date().toISOString(),
  });
}

function safeHead(git: TrustedGitExecutable, cwd: string): string | null {
  try {
    const value = gitText(git, cwd, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return OID.test(value) ? value : null;
  } catch {
    return null;
  }
}

interface HookLineageSnapshot {
  headOid: string;
  symbolicRef: string | null;
  refFormat: string;
  reflogDigest: string;
}

export interface SymbolicHeadAttempt {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  error: Error | undefined;
}

export function interpretSymbolicHeadAttempt(
  attempt: SymbolicHeadAttempt,
): { ok: true; symbolicRef: string | null } | { ok: false } {
  if (attempt.error !== undefined || attempt.signal !== null || attempt.status === null) return { ok: false };
  if (attempt.status === 1 && attempt.stdout.length === 0 && attempt.stderr.length === 0) {
    return { ok: true, symbolicRef: null };
  }
  if (attempt.status !== 0) return { ok: false };
  const value = attempt.stdout.toString('utf8').trim();
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]{1,512}$/.test(value)) return { ok: false };
  return { ok: true, symbolicRef: value };
}

function captureHookLineage(git: TrustedGitExecutable, cwd: string): HookLineageSnapshot | null {
  try {
    const headOid = safeHead(git, cwd);
    if (headOid === null) return null;
    const symbolicAttempt = spawnSync(git.path, ['symbolic-ref', '-q', 'HEAD'], {
      cwd,
      env: exactGitEnvironment(),
      maxBuffer: 4_096,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const symbolic = interpretSymbolicHeadAttempt({
      status: symbolicAttempt.status,
      signal: symbolicAttempt.signal,
      stdout: symbolicAttempt.stdout,
      stderr: symbolicAttempt.stderr,
      error: symbolicAttempt.error,
    });
    if (!symbolic.ok) return null;
    const symbolicRef = symbolic.symbolicRef;
    const refFormat = gitText(git, cwd, ['rev-parse', '--show-ref-format']);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(refFormat)) return null;
    const refs = symbolicRef === null ? ['HEAD'] : ['HEAD', symbolicRef];
    const reflogs: Array<{ ref: string; digest: string }> = [];
    for (const ref of refs) {
      gitBytes(git, cwd, ['reflog', 'exists', ref]);
      const bytes = gitBytes(git, cwd, ['reflog', 'show', '--format=%H%x00%gD', ref]);
      if (bytes.length === 0) return null;
      reflogs.push({ ref, digest: `sha256:${sha256Bytes(bytes)}` });
    }
    return {
      headOid,
      symbolicRef,
      refFormat,
      reflogDigest: `sha256:${sha256Bytes(canonicalizeBoundaryRun(reflogs))}`,
    };
  } catch {
    return null;
  }
}

function withStableHeadLineageUsing<T>(
  git: TrustedGitExecutable,
  cwd: string,
  evaluate: (expectedOid: string) => T,
): StableHeadLineageEvaluation<T> {
  const before = captureHookLineage(git, cwd);
  if (before === null) {
    return { value: null, stable: false, code: 'ci.hooks.evidence-unavailable', initialOid: null, finalOid: null };
  }
  const value = evaluate(before.headOid);
  const after = captureHookLineage(git, cwd);
  if (after === null) {
    return {
      value,
      stable: false,
      code: 'ci.hooks.evidence-unavailable',
      initialOid: before.headOid,
      finalOid: safeHead(git, cwd),
    };
  }
  const stable = canonicalizeBoundaryRun(before) === canonicalizeBoundaryRun(after);
  return {
    value,
    stable,
    code: stable ? 'stable' : 'ci.hooks.head-moved',
    initialOid: before.headOid,
    finalOid: after.headOid,
  };
}

export function withStableHeadLineage<T>(
  cwd: string,
  evaluate: (expectedOid: string) => T,
): StableHeadLineageEvaluation<T> {
  const git = trustedGitExecutable();
  if (git === null) {
    return { value: null, stable: false, code: 'ci.hooks.evidence-unavailable', initialOid: null, finalOid: null };
  }
  return withStableHeadLineageUsing(git, cwd, evaluate);
}

function pathKind(git: TrustedGitExecutable, cwd: string, expectedRoot: string): HookIdentityReceiptV1['configuredPathKind'] {
  let configured: string;
  try {
    configured = gitText(git, cwd, ['config', '--get', 'core.hooksPath']);
  } catch {
    return 'missing';
  }
  if (configured.length === 0) return 'missing';
  if (configured === '/dev/null') return 'disabled';
  if (isAbsolute(configured)) {
    return resolve(configured) === expectedRoot ? 'absolute-current-worktree' : 'foreign';
  }
  const resolved = resolve(cwd, configured);
  const fromWorktree = relative(cwd, resolved);
  if (fromWorktree === '..' || fromWorktree.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return 'escaping';
  if (configured !== '.husky') return 'missing';
  return 'relative-current-worktree';
}

function treeEntry(
  git: TrustedGitExecutable,
  cwd: string,
  oid: string,
  relativePath: string,
): { mode: string; type: string; objectOid: string } | null {
  const output = gitBytes(git, cwd, ['ls-tree', '-z', oid, '--', relativePath]);
  if (output.length === 0) return null;
  const text = output.toString('utf8').replace(/\0$/, '');
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/.exec(text);
  if (match === null || match[4] !== relativePath) throw new Error('invalid hook tree entry');
  return { mode: match[1]!, type: match[2]!, objectOid: match[3]! };
}

function treeClosurePaths(git: TrustedGitExecutable, cwd: string, oid: string): string[] {
  const output = gitBytes(git, cwd, ['ls-tree', '-r', '-z', '--name-only', oid, '--', '.husky']);
  if (output.length === 0) return [];
  let count = 0;
  for (const byte of output) {
    if (byte === 0 && ++count > REQUIRED_HOOK_PATHS.length) return ['<unexpected-hook-closure>'];
  }
  const values = output.toString('utf8').split('\0');
  if (values.at(-1) !== '') throw new Error('invalid hook closure');
  values.pop();
  return values;
}

function observedGitMode(fileMode: number): string {
  return (fileMode & 0o111) === 0 ? '100644' : '100755';
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.nlink === right.nlink
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function rootIdentityMatches(rootFd: number, rootPath: string, expected: BigIntStats): boolean {
  try {
    const descriptor = fstatSync(rootFd, { bigint: true });
    const path = lstatSync(rootPath, { bigint: true });
    return descriptor.isDirectory()
      && !path.isSymbolicLink()
      && path.isDirectory()
      && sameFileIdentity(descriptor, expected)
      && sameFileIdentity(path, expected);
  } catch {
    return false;
  }
}

function effectiveReadExecute(stat: BigIntStats): boolean {
  const mode = Number(stat.mode & 0o777n);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return false;
  if (uid === 0) return (mode & 0o111) !== 0;
  const groups = new Set([gid, ...(process.getgroups?.() ?? [])]);
  const permission = BigInt(uid) === stat.uid
    ? (mode >> 6) & 0o7
    : groups.has(Number(stat.gid))
      ? (mode >> 3) & 0o7
      : mode & 0o7;
  return (permission & 0o5) === 0o5;
}

type StableFileRead =
  | { ok: true; bytes: Buffer; stat: BigIntStats }
  | { ok: false; code: keyof typeof HOOK_REASON_MESSAGES };

export function hookReadCodeAfterCloseFailure<T extends keyof typeof HOOK_REASON_MESSAGES>(
  primary: T | null,
): T | 'ci.hooks.evidence-unavailable' {
  return primary ?? 'ci.hooks.evidence-unavailable';
}

function readStableInstalledHook(
  rootFd: number,
  rootPath: string,
  rootIdentity: BigIntStats,
  installedPath: string,
): StableFileRead {
  if (!rootIdentityMatches(rootFd, rootPath, rootIdentity)) {
    return { ok: false, code: 'ci.hooks.installed-identity-changed' };
  }
  let initial: BigIntStats;
  try {
    initial = lstatSync(installedPath, { bigint: true });
  } catch {
    return { ok: false, code: 'ci.hooks.installed-missing' };
  }
  if (initial.isSymbolicLink()) return { ok: false, code: 'ci.hooks.installed-symlink' };
  if (!initial.isFile()) return { ok: false, code: 'ci.hooks.installed-type-invalid' };
  if (initial.nlink !== 1n) return { ok: false, code: 'ci.hooks.installed-hardlink' };
  const uid = process.getuid?.();
  if (uid === undefined || initial.uid !== BigInt(uid) || (initial.mode & 0o022n) !== 0n) {
    return { ok: false, code: 'ci.hooks.installed-mode-mismatch' };
  }
  if (!effectiveReadExecute(initial)) return { ok: false, code: 'ci.hooks.installed-mode-mismatch' };
  try {
    accessSync(installedPath, constants.R_OK | constants.X_OK);
  } catch {
    return { ok: false, code: 'ci.hooks.installed-mode-mismatch' };
  }
  if (initial.size < 0n || initial.size > BigInt(MAX_INSTALLED_HOOK_BYTES)) {
    return { ok: false, code: 'ci.hooks.evidence-unavailable' };
  }

  let descriptor = -1;
  let result: StableFileRead = { ok: false, code: 'ci.hooks.evidence-unavailable' };
  try {
    if (typeof constants.O_NOFOLLOW !== 'number') return { ok: false, code: 'ci.hooks.evidence-unavailable' };
    descriptor = openSync(installedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameFileIdentity(initial, before)) {
      return { ok: false, code: 'ci.hooks.installed-identity-changed' };
    }
    const capacity = Number(before.size) + 1;
    const buffer = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < capacity) {
      const count = readSync(descriptor, buffer, offset, capacity - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    accessSync(installedPath, constants.R_OK | constants.X_OK);
    const terminal = lstatSync(installedPath, { bigint: true });
    if (
      offset !== Number(before.size)
      || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, terminal)
      || !rootIdentityMatches(rootFd, rootPath, rootIdentity)
    ) {
      result = { ok: false, code: 'ci.hooks.installed-identity-changed' };
    } else {
      result = { ok: true, bytes: buffer.subarray(0, offset), stat: after };
    }
  } catch {
    result = { ok: false, code: 'ci.hooks.installed-identity-changed' };
  } finally {
    if (descriptor >= 0) {
      try {
        closeSync(descriptor);
      } catch {
        result = {
          ok: false,
          code: hookReadCodeAfterCloseFailure(result.ok ? null : result.code),
        };
      }
    }
  }
  return result;
}

type StableDirectoryRead =
  | { ok: true; names: string[] }
  | { ok: false; code: 'ci.hooks.installed-identity-changed' | 'ci.hooks.evidence-unavailable' };

function directoryIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.ctimeNs, stat.mtimeNs]
    .map((value) => value.toString(10))
    .join(':');
}

const BOUND_DIRECTORY_READER = String.raw`
const fs = require('node:fs');
const identity = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.ctimeNs, stat.mtimeNs]
  .map((value) => value.toString(10)).join(':');
const before = fs.statSync('.', { bigint: true });
const directory = fs.opendirSync('.');
const names = [];
while (names.length <= ${REQUIRED_HOOK_PATHS.length}) {
  const entry = directory.readSync();
  if (entry === null) break;
  names.push(entry.name);
}
directory.closeSync();
const after = fs.statSync('.', { bigint: true });
process.stdout.write(JSON.stringify({ before: identity(before), after: identity(after), names }));
`;

export function readBoundDirectoryNames(rootPath: string, expected: BigIntStats): StableDirectoryRead {
  try {
    const bytes = execFileSync(process.execPath, ['-e', BOUND_DIRECTORY_READER], {
      cwd: rootPath,
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      maxBuffer: 4_096,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (bytes.length === 0 || bytes.length > 4_096) return { ok: false, code: 'ci.hooks.evidence-unavailable' };
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    const record = requireExactDataRecord(value, ['before', 'after', 'names'], 'ci.hooks.directory.invalid');
    if (
      typeof record.before !== 'string'
      || typeof record.after !== 'string'
      || !Array.isArray(record.names)
      || record.names.length > REQUIRED_HOOK_PATHS.length + 1
      || record.names.some((name) => (
        !boundedString(name, 255)
        || name.length === 0
        || name === '.'
        || name === '..'
        || name.includes('/')
        || name.includes('\\')
      ))
      || new Set(record.names).size !== record.names.length
    ) return { ok: false, code: 'ci.hooks.evidence-unavailable' };
    const expectedIdentity = directoryIdentity(expected);
    if (record.before !== expectedIdentity || record.after !== expectedIdentity) {
      return { ok: false, code: 'ci.hooks.installed-identity-changed' };
    }
    return { ok: true, names: record.names as string[] };
  } catch {
    return { ok: false, code: 'ci.hooks.evidence-unavailable' };
  }
}

function inspectDeclaredHookClosure(
  git: TrustedGitExecutable,
  cwd: string,
  expectedOid: string,
  configuredPathKind: HookIdentityReceiptV1['configuredPathKind'],
  expectedRoot: string,
  rootFd: number,
  rootIdentity: BigIntStats,
): HookIdentityReceiptV1 {
  const hooks: HookIdentityObservationV1[] = [];
  const verifiedIdentities: Array<{ path: string; stat: BigIntStats }> = [];
  try {
    const closure = treeClosurePaths(git, cwd, expectedOid);
    if (closure.some((path) => !REQUIRED_HOOK_PATHS.includes(path as (typeof REQUIRED_HOOK_PATHS)[number]))) {
      return receipt('block', 'ci.hooks.source-invalid', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
      });
    }
    if (REQUIRED_HOOK_PATHS.some((path) => !closure.includes(path))) {
      return receipt('block', 'ci.hooks.source-missing', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
      });
    }
  } catch {
    return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
      expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
    });
  }
  for (const relativePath of REQUIRED_HOOK_PATHS) {
    let expected: { mode: string; type: string; objectOid: string } | null;
    try {
      expected = treeEntry(git, cwd, expectedOid, relativePath);
    } catch {
      return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
      });
    }
    if (expected === null) {
      return receipt('block', 'ci.hooks.source-missing', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
      });
    }
    if (expected.type !== 'blob' || expected.mode !== '100755') {
      return receipt('block', 'ci.hooks.source-invalid', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'git-tree:.husky', hooks,
      });
    }

    const installed = readStableInstalledHook(
      rootFd,
      expectedRoot,
      rootIdentity,
      resolve(cwd, relativePath),
    );
    if (!installed.ok) {
      return receipt('inconclusive', installed.code, {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
    const observedMode = observedGitMode(Number(installed.stat.mode));
    if (observedMode !== expected.mode) {
      return receipt('inconclusive', 'ci.hooks.installed-mode-mismatch', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
    verifiedIdentities.push({ path: resolve(cwd, relativePath), stat: installed.stat });
    try {
      const expectedBytes = gitBytes(git, cwd, ['cat-file', 'blob', expected.objectOid]);
      const observedBlobOid = gitBytes(git, cwd, ['hash-object', '--stdin'], installed.bytes).toString('utf8').trim();
      const observation: HookIdentityObservationV1 = {
        path: relativePath,
        expectedMode: expected.mode,
        expectedBlobOid: expected.objectOid,
        observedMode,
        observedBlobOid,
      };
      hooks.push(observation);
      if (!installed.bytes.equals(expectedBytes) || observedBlobOid !== expected.objectOid) {
        return receipt('inconclusive', 'ci.hooks.installed-bytes-mismatch', {
          expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
        });
      }
    } catch {
      return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
  }

  try {
    const directory = readBoundDirectoryNames(expectedRoot, rootIdentity);
    if (!directory.ok) {
      return receipt('inconclusive', directory.code, {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
    const names = directory.names;
    if (
      names.length !== REQUIRED_HOOK_PATHS.length
      || names.some((name) => !REQUIRED_HOOK_PATHS.includes(`.husky/${name}` as (typeof REQUIRED_HOOK_PATHS)[number]))
    ) {
      return receipt('inconclusive', 'ci.hooks.installed-unexpected', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
    if (!rootIdentityMatches(rootFd, expectedRoot, rootIdentity)) {
      return receipt('inconclusive', 'ci.hooks.installed-identity-changed', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
      });
    }
    for (const verified of verifiedIdentities) {
      const terminal = lstatSync(verified.path, { bigint: true });
      if (terminal.isSymbolicLink() || !sameFileIdentity(terminal, verified.stat)) {
        return receipt('inconclusive', 'ci.hooks.installed-identity-changed', {
          expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
        });
      }
    }
  } catch {
    return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
      expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky', hooks,
    });
  }

  return receipt('pass', 'ci.hooks.pass', {
    expectedOid,
    observedHeadOid: expectedOid,
    gitExecutable: git.identity,
    configuredPathKind,
    location: 'worktree:.husky',
    hooks,
  });
}

function inspectHookInstallationAtOid(
  git: TrustedGitExecutable,
  cwd: string,
  expectedOid: string,
): HookIdentityReceiptV1 {
  const expectedRoot = resolve(cwd, '.husky');
  const configuredPathKind = pathKind(git, cwd, expectedRoot);
  if (configuredPathKind !== 'relative-current-worktree') {
    const code = configuredPathKind === 'absolute-current-worktree'
      ? 'ci.hooks.path-absolute'
      : configuredPathKind === 'foreign'
        ? 'ci.hooks.path-foreign'
        : configuredPathKind === 'escaping'
          ? 'ci.hooks.path-escaping'
          : configuredPathKind === 'disabled'
            ? 'ci.hooks.path-disabled'
            : 'ci.hooks.path-missing';
    return receipt('inconclusive', code, {
      expectedOid,
      gitExecutable: git.identity,
      configuredPathKind,
      location: 'git-config:core.hooksPath',
    });
  }

  let rootFd = -1;
  let result: HookIdentityReceiptV1;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
      throw new Error('descriptor proof unavailable');
    }
    const rootPathStat = lstatSync(expectedRoot, { bigint: true });
    if (rootPathStat.isSymbolicLink()) {
      return receipt('inconclusive', 'ci.hooks.installed-symlink', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky',
      });
    }
    if (!rootPathStat.isDirectory()) {
      return receipt('inconclusive', 'ci.hooks.installed-type-invalid', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky',
      });
    }
    const uid = process.getuid?.();
    if (uid === undefined || rootPathStat.uid !== BigInt(uid) || (rootPathStat.mode & 0o022n) !== 0n) {
      return receipt('inconclusive', 'ci.hooks.installed-mode-mismatch', {
        expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky',
      });
    }
    accessSync(expectedRoot, constants.R_OK | constants.X_OK);
    const gitResolvedRoot = gitText(git, cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    if (resolve(gitResolvedRoot) !== expectedRoot) {
      return receipt('inconclusive', 'ci.hooks.path-foreign', {
        expectedOid, gitExecutable: git.identity, configuredPathKind: 'foreign', location: 'git-config:core.hooksPath',
      });
    }
    rootFd = openSync(expectedRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const rootIdentity = fstatSync(rootFd, { bigint: true });
    if (!sameFileIdentity(rootPathStat, rootIdentity)) throw new Error('root identity changed');
    result = inspectDeclaredHookClosure(
      git,
      cwd,
      expectedOid,
      configuredPathKind,
      expectedRoot,
      rootFd,
      rootIdentity,
    );
  } catch {
    result = receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
      expectedOid, gitExecutable: git.identity, configuredPathKind, location: 'worktree:.husky',
    });
  }
  if (rootFd >= 0) {
    try {
      closeSync(rootFd);
    } catch {
      result = enforceHookReceiptCloseFailure(result);
    }
  }
  return result;
}

export function enforceHookReceiptCloseFailure(result: HookIdentityReceiptV1): HookIdentityReceiptV1 {
  if (result.outcome !== 'pass') return result;
  return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
    expectedOid: result.expectedOid,
    observedHeadOid: result.observedHeadOid,
    gitExecutable: result.gitExecutable,
    configuredPathKind: result.configuredPathKind,
    location: 'worktree:.husky',
    hooks: result.hooks,
  });
}

export function inspectHookInstallation(cwd = process.cwd()): HookIdentityReceiptV1 {
  const git = trustedGitExecutable();
  if (git === null) {
    return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
      expectedOid: null,
      observedHeadOid: null,
      gitExecutable: null,
      configuredPathKind: 'unavailable',
      location: 'git-tree:.husky',
    });
  }
  const evaluation = withStableHeadLineageUsing(git, cwd, (expectedOid) => (
    inspectHookInstallationAtOid(git, cwd, expectedOid)
  ));
  return enforceStableHookLineage(evaluation, git.identity);
}

export function enforceStableHookLineage(
  evaluation: StableHeadLineageEvaluation<HookIdentityReceiptV1>,
  fallbackGitIdentity: GitExecutableIdentityV1 | null = evaluation.value?.gitExecutable ?? null,
): HookIdentityReceiptV1 {
  if (evaluation.value === null) {
    return receipt('inconclusive', 'ci.hooks.evidence-unavailable', {
      expectedOid: evaluation.initialOid,
      observedHeadOid: evaluation.finalOid,
      gitExecutable: fallbackGitIdentity,
      configuredPathKind: 'unavailable',
      location: 'git-tree:.husky',
    });
  }
  if (!evaluation.stable) {
    return receipt('inconclusive', evaluation.code === 'ci.hooks.head-moved' ? evaluation.code : 'ci.hooks.evidence-unavailable', {
      expectedOid: evaluation.initialOid,
      observedHeadOid: evaluation.finalOid,
      gitExecutable: evaluation.value.gitExecutable ?? fallbackGitIdentity,
      configuredPathKind: evaluation.value.configuredPathKind,
      location: 'git-tree:.husky',
      hooks: evaluation.value.hooks,
    });
  }
  return evaluation.value;
}

export function runHooksInstalledGuard(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  output: Pick<Console, 'log'> = console,
): HookIdentityExitCode {
  if (argv.length === 1 && argv[0] === '--help') {
    output.log('Usage: npm run guard:hooks-installed');
    return 0;
  }
  if (argv.length !== 1 || argv[0] !== '--json') {
    const git = trustedGitExecutable();
    const result = receipt('inconclusive', 'ci.hooks.input-invalid', {
      expectedOid: git === null ? null : safeHead(git, cwd),
      gitExecutable: git?.identity ?? null,
      configuredPathKind: 'unavailable',
      location: 'git-config:core.hooksPath',
    });
    output.log(Buffer.from(serializeHookIdentityReceipt(result)).toString('utf8').trimEnd());
    return 2;
  }
  const result = inspectHookInstallation(cwd);
  output.log(Buffer.from(serializeHookIdentityReceipt(result)).toString('utf8').trimEnd());
  return result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runHooksInstalledGuard();
}
