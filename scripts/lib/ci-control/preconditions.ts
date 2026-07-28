import {
  canonicalizeBoundaryRun,
  hasExactKeys,
  isBoundedText,
  isOid,
  isRecord,
  isSafePath,
  isSortedUniqueStrings,
  isTimestamp,
  sha256Bytes,
} from '../verification/boundary-run/shared.ts';

export const MAX_PRECONDITION_BYTES = 16_384;
export const MAX_PRECONDITION_ITEMS = 64;

export interface EvidenceGraphBudget {
  maxDepth: number;
  maxItems: number;
  maxObjectKeys?: number;
  maxNodes: number;
  maxStringBytes: number;
}

export function assertBoundedEvidenceGraph(root: unknown, budget: EvidenceGraphBudget): void {
  const pending: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  const active = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth, exit } = pending.pop()!;
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > budget.maxStringBytes || value.includes('\u0000')) throw new Error('evidence string exceeds byte budget or contains NUL');
      continue;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') continue;
    if (typeof value !== 'object') throw new Error('evidence contains an unsupported value');
    if (exit) {
      active.delete(value);
      continue;
    }
    if (depth > budget.maxDepth) throw new Error('evidence graph exceeds depth budget');
    if (active.has(value)) throw new Error('evidence graph contains a cycle');
    active.add(value);
    pending.push({ value, depth, exit: true });
    nodes += 1;
    if (nodes > budget.maxNodes) throw new Error('evidence graph exceeds node budget');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('evidence values must be plain data objects');
    const keys = Reflect.ownKeys(value).filter((key) => !(Array.isArray(value) && key === 'length'));
    if (keys.length > (budget.maxObjectKeys ?? budget.maxItems) || keys.some((key) => typeof key !== 'string')) throw new Error('evidence object exceeds key budget');
    if (Array.isArray(value) && value.length > budget.maxItems) throw new Error('evidence list exceeds item budget');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[String(key)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new Error('evidence must contain data properties, not accessors');
      pending.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KEYS = ['createdAt', 'fixture', 'hook', 'host', 'installScopes', 'outcome', 'packageManager', 'runtime', 'schemaVersion', 'serviceSubstitutes', 'testSelectionDigest', 'workspace', 'wrapperDigest'] as const;
const EXPECTED_KEYS = ['fixture', 'hook', 'host', 'installScopes', 'packageManager', 'runtime', 'schemaVersion', 'serviceSubstitutes', 'testSelectionDigest', 'workspace', 'wrapperDigest'] as const;
const TOOL_KEYS = ['digest', 'name', 'version'] as const;
const WORKSPACE_KEYS = ['baseOid', 'candidateOid', 'digest', 'headOid', 'index', 'mergeOid', 'worktree'] as const;
const HOST_KEYS = ['architecture', 'capabilities', 'digest', 'os'] as const;
const HOOK_KEYS = ['digest', 'installed', 'path'] as const;
const FIXTURE_KEYS = ['created', 'digest'] as const;

export type PreconditionOutcome = 'pass' | 'inconclusive';

export interface PreconditionValidationOptions {
  now?: number;
  expected?: unknown;
}

export interface PreconditionReceiptV1 {
  schemaVersion: 1;
  outcome: PreconditionOutcome;
  runtime: { name: string; version: string; digest: string };
  packageManager: { name: string; version: string; digest: string };
  wrapperDigest: string;
  installScopes: string[];
  workspace: {
    worktree: 'clean' | 'declared-dirty';
    index: 'clean' | 'declared-dirty';
    headOid: string;
    baseOid: string | null;
    candidateOid: string;
    mergeOid: string | null;
    digest: string;
  };
  host: { os: string; architecture: string; capabilities: string[]; digest: string };
  hook: { installed: boolean; path: string | null; digest: string | null };
  fixture: { created: boolean; digest: string | null };
  serviceSubstitutes: string[];
  testSelectionDigest: string;
  createdAt: string;
}

export type PreconditionExpectationsV1 = Omit<PreconditionReceiptV1, 'createdAt' | 'outcome'>;

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function requireExact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error(`${label} keys are invalid`);
  return value;
}

function validateTool(value: unknown, label: string): void {
  const tool = requireExact(value, TOOL_KEYS, label);
  if (!isBoundedText(tool.name, 128) || !isBoundedText(tool.version, 128) || !isDigest(tool.digest)) throw new Error(`${label} identity is invalid`);
}

export function validatePreconditionReceipt(value: unknown, options: PreconditionValidationOptions = {}): PreconditionReceiptV1 {
  assertBoundedEvidenceGraph(value, { maxDepth: 8, maxItems: MAX_PRECONDITION_ITEMS, maxNodes: 512, maxStringBytes: 2_048 });
  const receipt = requireExact(value, KEYS, 'precondition receipt');
  const bytes = Buffer.byteLength(canonicalizeBoundaryRun(receipt), 'utf8');
  if (bytes > MAX_PRECONDITION_BYTES) throw new Error('precondition receipt exceeds byte budget');
  if (receipt.schemaVersion !== 1 || (receipt.outcome !== 'pass' && receipt.outcome !== 'inconclusive') || !isTimestamp(receipt.createdAt)) throw new Error('invalid precondition receipt identity');
  const now = options.now ?? Date.now();
  const createdAt = Date.parse(receipt.createdAt as string);
  if (createdAt > now + 5 * 60_000 || now - createdAt > 24 * 60 * 60_000) throw new Error('precondition receipt is stale or future-dated');
  validateTool(receipt.runtime, 'runtime');
  validateTool(receipt.packageManager, 'package manager');
  if (!isDigest(receipt.wrapperDigest) || !isDigest(receipt.testSelectionDigest)) throw new Error('invalid precondition digest');
  if (!isSortedUniqueStrings(receipt.installScopes, (item) => isBoundedText(item, 128)) || receipt.installScopes.length > MAX_PRECONDITION_ITEMS) throw new Error('invalid install scopes');
  if (!isSortedUniqueStrings(receipt.serviceSubstitutes, (item) => isBoundedText(item, 128)) || receipt.serviceSubstitutes.length > MAX_PRECONDITION_ITEMS) throw new Error('invalid service substitutes');

  const workspace = requireExact(receipt.workspace, WORKSPACE_KEYS, 'workspace precondition');
  if ((workspace.worktree !== 'clean' && workspace.worktree !== 'declared-dirty') || (workspace.index !== 'clean' && workspace.index !== 'declared-dirty') || !isOid(workspace.headOid) || !isOid(workspace.candidateOid) || !(workspace.baseOid === null || isOid(workspace.baseOid)) || !(workspace.mergeOid === null || isOid(workspace.mergeOid)) || !isDigest(workspace.digest)) throw new Error('invalid workspace precondition');

  const host = requireExact(receipt.host, HOST_KEYS, 'host precondition');
  if (!isBoundedText(host.os, 64) || !isBoundedText(host.architecture, 64) || !isDigest(host.digest) || !isSortedUniqueStrings(host.capabilities, (item) => isBoundedText(item, 128)) || host.capabilities.length > MAX_PRECONDITION_ITEMS) throw new Error('invalid host precondition');

  const hook = requireExact(receipt.hook, HOOK_KEYS, 'hook precondition');
  if (typeof hook.installed !== 'boolean' || !(hook.path === null || isSafePath(hook.path)) || !(hook.digest === null || isDigest(hook.digest)) || (hook.installed && (hook.path === null || hook.digest === null))) throw new Error('invalid hook precondition');

  const fixture = requireExact(receipt.fixture, FIXTURE_KEYS, 'fixture precondition');
  if (typeof fixture.created !== 'boolean' || !(fixture.digest === null || isDigest(fixture.digest)) || (fixture.created && fixture.digest === null)) throw new Error('invalid fixture precondition');
  if (receipt.outcome === 'pass' && (receipt.installScopes.length === 0 || !fixture.created)) throw new Error('passing preconditions are incomplete');
  if (options.expected !== undefined) {
    assertBoundedEvidenceGraph(options.expected, { maxDepth: 8, maxItems: MAX_PRECONDITION_ITEMS, maxNodes: 512, maxStringBytes: 2_048 });
    const expected = requireExact(options.expected, EXPECTED_KEYS, 'trusted precondition expectation');
    const { createdAt: _createdAt, outcome: _outcome, ...actual } = receipt;
    if (receipt.outcome === 'pass' && canonicalizeBoundaryRun(actual) !== canonicalizeBoundaryRun(expected)) throw new Error('passing precondition receipt does not match trusted expectations');
  }
  return receipt as unknown as PreconditionReceiptV1;
}

export function preconditionDigest(value: PreconditionReceiptV1, options: PreconditionValidationOptions = {}): string {
  const receipt = validatePreconditionReceipt(value, options);
  return `sha256:${sha256Bytes(canonicalizeBoundaryRun(receipt))}`;
}
