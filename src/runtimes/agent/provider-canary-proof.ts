import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { systemClock } from '../../lib/clock.ts';
import { readPrivateFileSync } from '../../lib/private-fs.ts';
import { isRecord } from '../../lib/type-guards.ts';
import { isProviderId, mcpModeForProvider } from './providers/index.ts';

export const CANARY_CONTRACT_VERSION = '1';
const MAX_FUTURE_SKEW_MS = 60_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'contractVersion',
  'providerId',
  'recordedAt',
  'platform',
  'architecture',
  'binaryVersion',
  'entrypointDigest',
  'proxyDigest',
  'dynamicInitialize',
  'dynamicToolsList',
  'staticConnections',
  'proxyDescendant',
  'processGroupReaped',
]);

export interface ProviderCanaryEvidence {
  providerId: string;
  platform: string;
  architecture: string;
  binaryVersion: string;
  entrypointDigest: string;
  proxyDigest: string;
}

export interface ProviderCanaryReceipt extends ProviderCanaryEvidence {
  schemaVersion: 1;
  contractVersion: string;
  recordedAt: string;
  dynamicInitialize: true;
  dynamicToolsList: true;
  staticConnections: 0;
  proxyDescendant: true;
  processGroupReaped: true;
}

export type ProviderCanaryValidationReason =
  | 'proven'
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'future';

export interface ProviderCanaryValidation {
  proven: boolean;
  reason: ProviderCanaryValidationReason;
}

/** Validation classes plus `unavailable`: the binary or its version cannot be resolved. */
export type ProviderCanaryReadinessReason = ProviderCanaryValidationReason | 'unavailable';

/** One configured provider's canary state as bounded classes: no paths, digests or versions. */
export interface ProviderCanaryReadinessEntry {
  readonly providerId: string;
  readonly reason: ProviderCanaryReadinessReason;
}

/**
 * Admission record binding the validated provider identity at admission time.
 * Returned by readProviderCanaryAdmission and consumed by SessionManager at
 * every spawn path to prevent TOCTOU swaps between admission and execution.
 */
export interface ProviderAdmission {
  allowed: boolean;
  /** Whether the provider canary proof was required for this admission. */
  required: boolean;
  /** Absolute resolved path to the provider binary (no PATH re-resolution). */
  resolvedPath: string;
  /** SHA-256 hex digest of the binary file at admission time (empty if !required). */
  binarySha256: string;
  /** SHA-256 hex digest of the MCP proxy script at admission time (empty if !required). */
  proxyScriptSha256: string;
}

/**
 * Identity of the executable that a readiness probe will actually invoke.
 * Unlike ProviderAdmission, this is usable for every CLI mode and does not
 * require a canary receipt or a version subprocess.
 */
export interface ProviderBinaryIdentity {
  readonly resolvedPath: string;
  readonly sha256: string;
}

function isSafeReceiptShape(value: unknown): value is ProviderCanaryReceipt {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return false;
  return (
    value.schemaVersion === 1
    && typeof value.contractVersion === 'string'
    && typeof value.providerId === 'string'
    && typeof value.recordedAt === 'string'
    && typeof value.platform === 'string'
    && typeof value.architecture === 'string'
    && typeof value.binaryVersion === 'string'
    && value.binaryVersion.length > 0
    && value.binaryVersion.length <= 128
    && !/[/\r\n]/.test(value.binaryVersion)
    && typeof value.entrypointDigest === 'string'
    && DIGEST_RE.test(value.entrypointDigest)
    && typeof value.proxyDigest === 'string'
    && DIGEST_RE.test(value.proxyDigest)
    && value.dynamicInitialize === true
    && value.dynamicToolsList === true
    && value.staticConnections === 0
    && value.proxyDescendant === true
    && value.processGroupReaped === true
  );
}

export function validateProviderCanaryReceipt(
  value: unknown,
  expected: ProviderCanaryEvidence,
  nowMs = systemClock.now(),
): ProviderCanaryValidation {
  if (value === null || value === undefined) return { proven: false, reason: 'missing' };
  if (!isSafeReceiptShape(value)) return { proven: false, reason: 'malformed' };
  const recordedAtMs = Date.parse(value.recordedAt);
  if (!Number.isFinite(recordedAtMs)) return { proven: false, reason: 'malformed' };
  if (recordedAtMs > nowMs + MAX_FUTURE_SKEW_MS) return { proven: false, reason: 'future' };
  if (
    value.contractVersion !== CANARY_CONTRACT_VERSION
    || value.providerId !== expected.providerId
    || value.platform !== expected.platform
    || value.architecture !== expected.architecture
    || value.binaryVersion !== expected.binaryVersion
    || value.entrypointDigest !== expected.entrypointDigest
    || value.proxyDigest !== expected.proxyDigest
  ) {
    return { proven: false, reason: 'stale' };
  }
  return { proven: true, reason: 'proven' };
}

export function providerCanaryReceiptPath(stateRoot: string, providerId: string): string {
  if (!isProviderId(providerId) || mcpModeForProvider(providerId) !== 'stdio_proxy') {
    throw new Error('provider is not an eligible CLI provider');
  }
  return join(stateRoot, PROVIDER_CANARY_DIR, `${providerId}.json`);
}

/** The provider-canary receipts directory name (relative to stateRoot.
 *  MUST be kept in sync with the join in providerCanaryReceiptPath — any
 *  change to one MUST update the other. */
const PROVIDER_CANARY_DIR = 'provider-canaries';

/** Whether the canary-receipt store has been provisioned (directory exists).
 *  Derived from the SAME constant as providerCanaryReceiptPath, so the
 *  directory name never drifts. A non-provisioned store means the canary
 *  proof is not enforceable in this deployment; admission proceeds as if
 *  not required (allowed true, required false, empty hashes). */
export function canaryStoreProvisioned(stateRoot: string): boolean {
  return existsSync(join(stateRoot, PROVIDER_CANARY_DIR));
}

function providerCanaryRequired(
  providerId: string,
  sessionScope: string,
  sandboxPerChat: boolean,
): boolean {
  return (
    sessionScope === 'per_chat'
    && !sandboxPerChat
    && isProviderId(providerId)
    && mcpModeForProvider(providerId) === 'stdio_proxy'
  );
}

export function validateProviderCanaryAdmission(input: {
  providerId: string;
  sessionScope: string;
  sandboxPerChat: boolean;
  receipt: unknown;
  evidence: ProviderCanaryEvidence;
  nowMs?: number;
}): { required: boolean; allowed: boolean; reason: ProviderCanaryValidationReason | 'not-required' } {
  const required = providerCanaryRequired(
    input.providerId,
    input.sessionScope,
    input.sandboxPerChat,
  );
  if (!required) return { required: false, allowed: true, reason: 'not-required' };
  const result = validateProviderCanaryReceipt(input.receipt, input.evidence, input.nowMs);
  return { required: true, allowed: result.proven, reason: result.reason };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const evidenceCache = new Map<string, ProviderCanaryEvidence>();
const VERSION_TMP_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp';

async function sha256FileAsync(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Private HOME/XDG/TMP sandbox and allow-listed env for a `--version` child. */
function createVersionSandbox(): { root: string; env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(join(VERSION_TMP_ROOT, 'wspv-')));
  chmodSync(root, 0o700);
  const config = join(root, 'config');
  const data = join(root, 'data');
  const temp = join(root, 'tmp');
  for (const directory of [config, data, temp]) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const env = Object.fromEntries(
    Object.entries({
      // env-allowed: ambient OS PATH contract for executable resolution
      PATH: process.env.PATH,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      USER: process.env.USER,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      SHELL: process.env.SHELL,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      LANG: process.env.LANG,
      // env-allowed: child-env forward; explicit per-var allow-list, not passthrough
      SYSTEMROOT: process.env.SYSTEMROOT,
      HOME: root,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_RUNTIME_DIR: temp,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
    }).filter(([, value]) => value !== undefined),
  );
  return { root, env };
}

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BYTES = 16 * 1024;

function readBinaryVersion(entrypoint: string): string {
  const { root, env } = createVersionSandbox();
  try {
    return execFileSync(entrypoint, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_MAX_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Event-loop-safe twin of readBinaryVersion, with the same sandbox, stdio, output
 * budget and stdout-only result. The deadline kills the child and destroys its stdout,
 * so a descendant that inherited the pipe cannot keep the promise pending.
 */
function readBinaryVersionAsync(entrypoint: string, timeoutMs: number): Promise<string> {
  const { root, env } = createVersionSandbox();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let output = '';
    let bytes = 0;
    let child: ReturnType<typeof spawn> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child?.stdout?.destroy();
      rmSync(root, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(output.trim());
    };
    try {
      child = spawn(entrypoint, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], env, windowsHide: true });
    } catch (err) {
      // A synchronous spawn throw (e.g. an invalid path) still removes the sandbox.
      finish(err instanceof Error ? err : new Error('provider binary version spawn failed'));
      return;
    }
    // Unref'd: a probe in flight never holds process shutdown.
    deadline = setTimeout(() => finish(new Error('provider binary version timed out')), timeoutMs);
    deadline.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > VERSION_MAX_BYTES) finish(new Error('provider binary version output exceeded its budget'));
      else output += chunk;
    });
    child.once('error', (err) => finish(err));
    child.once('close', (code) => finish(code === 0 ? null : new Error('provider binary version exited non-zero')));
  });
}

// env-allowed: ambient OS PATH contract for executable resolution
export function resolveExecutable(binary: string, pathValue = process.env.PATH ?? ''): string {
  if (binary.includes('/')) {
    accessSync(binary, constants.X_OK);
    return realpathSync(binary);
  }
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // intentional: X_OK probe miss means this PATH component lacks the binary — continue scanning the remaining components.
    }
  }
  throw new Error('provider binary is unavailable');
}

/** Resolve and hash the exact executable selected by the effective child PATH. */
export function resolveProviderBinaryIdentity(
  binary: string,
  pathValue?: string,
): ProviderBinaryIdentity {
  const resolvedPath = resolveExecutable(binary, pathValue);
  return { resolvedPath, sha256: sha256File(resolvedPath) };
}

interface EvidenceTarget {
  entrypoint: string;
  proxyPath: string;
  cacheKey: string;
}

function evidenceTarget(
  providerId: string,
  binary: string,
  proxyScriptPath: string,
  binaryVersionOverride?: string,
): EvidenceTarget {
  const entrypoint = resolveExecutable(binary);
  const proxyPath = realpathSync(proxyScriptPath);
  const binaryStat = statSync(entrypoint);
  const proxyStat = statSync(proxyPath);
  const cacheKey = [
    providerId,
    entrypoint,
    binaryStat.dev,
    binaryStat.ino,
    binaryStat.size,
    binaryStat.mtimeMs,
    proxyPath,
    proxyStat.dev,
    proxyStat.ino,
    proxyStat.size,
    proxyStat.mtimeMs,
    binaryVersionOverride ?? '',
  ].join(':');
  return { entrypoint, proxyPath, cacheKey };
}

function cacheEvidence(
  cacheKey: string,
  providerId: string,
  version: string,
  entrypointDigest: string,
  proxyDigest: string,
): ProviderCanaryEvidence {
  if (!version || version.length > 128 || /[/\r\n]/.test(version)) {
    throw new Error('provider binary version is unavailable');
  }
  const evidence = {
    providerId,
    platform: process.platform,
    architecture: process.arch,
    binaryVersion: version,
    entrypointDigest,
    proxyDigest,
  };
  if (evidenceCache.size >= 16) evidenceCache.clear();
  evidenceCache.set(cacheKey, evidence);
  return evidence;
}

export function collectProviderCanaryEvidence(
  providerId: string,
  binary: string,
  proxyScriptPath: string,
  binaryVersionOverride?: string,
): ProviderCanaryEvidence {
  const { entrypoint, proxyPath, cacheKey } = evidenceTarget(providerId, binary, proxyScriptPath, binaryVersionOverride);
  const cached = evidenceCache.get(cacheKey);
  if (cached) return cached;
  const version = binaryVersionOverride ?? readBinaryVersion(entrypoint);
  return cacheEvidence(cacheKey, providerId, version, sha256File(entrypoint), sha256File(proxyPath));
}

/**
 * collectProviderCanaryEvidence without blocking the event loop: the `--version` child and
 * both digests run asynchronously, bounded by `versionTimeoutMs`. It fills the cache the
 * synchronous admission path reads, so admission sees the same evidence.
 */
async function collectProviderCanaryEvidenceAsync(
  providerId: string,
  binary: string,
  proxyScriptPath: string,
  versionTimeoutMs: number,
): Promise<ProviderCanaryEvidence> {
  const { entrypoint, proxyPath, cacheKey } = evidenceTarget(providerId, binary, proxyScriptPath);
  const cached = evidenceCache.get(cacheKey);
  if (cached) return cached;
  const version = await readBinaryVersionAsync(entrypoint, versionTimeoutMs);
  const [entrypointDigest, proxyDigest] = await Promise.all([sha256FileAsync(entrypoint), sha256FileAsync(proxyPath)]);
  // The awaits above can span seconds: a binary or proxy replaced meanwhile must not be
  // cached under the old stat key. Report it unavailable; the next tick re-reads it.
  if (evidenceTarget(providerId, binary, proxyScriptPath).cacheKey !== cacheKey) {
    throw new Error('provider binary changed while its evidence was collected');
  }
  return cacheEvidence(cacheKey, providerId, version, entrypointDigest, proxyDigest);
}

/** Parsed receipt, or null when absent. Throws on an unsafe read or invalid JSON. */
function readProviderCanaryReceipt(stateRoot: string, providerId: string): unknown {
  const raw = readPrivateFileSync(
    providerCanaryReceiptPath(stateRoot, providerId),
    { label: 'provider canary receipt', maxBytes: 8 * 1024 },
  );
  return raw === null ? null : JSON.parse(raw);
}

export function readProviderCanaryAdmission(input: {
  providerId: string;
  binary: string;
  proxyScriptPath: string;
  stateRoot: string;
  sessionScope: string;
  sandboxPerChat: boolean;
  nowMs?: number;
}): ProviderAdmission {
  const required = providerCanaryRequired(
    input.providerId,
    input.sessionScope,
    input.sandboxPerChat,
  );
  // Provisioning gate: if the receipts directory does not exist, the feature
  // is not deployed — treat as not-required (matching main's test contract).
  const effectiveRequired = required && canaryStoreProvisioned(input.stateRoot);
  if (!effectiveRequired) {
    return {
      allowed: true,
      required: false,
      resolvedPath: input.binary,
      binarySha256: '',
      proxyScriptSha256: '',
    };
  }
  let receipt: unknown = null;
  let evidence: ProviderCanaryEvidence;
  try {
    receipt = readProviderCanaryReceipt(input.stateRoot, input.providerId);
    evidence = collectProviderCanaryEvidence(
      input.providerId,
      input.binary,
      input.proxyScriptPath,
    );
  } catch {
    return {
      allowed: false,
      required: true,
      resolvedPath: input.binary,
      binarySha256: '',
      proxyScriptSha256: '',
    };
  }
  const resolvedPath = resolveExecutable(input.binary);
  const validation = validateProviderCanaryAdmission({
    providerId: input.providerId,
    sessionScope: input.sessionScope,
    sandboxPerChat: input.sandboxPerChat,
    receipt,
    evidence,
    nowMs: input.nowMs,
  });
  return {
    allowed: validation.allowed,
    required: true,
    resolvedPath,
    binarySha256: evidence.entrypointDigest,
    proxyScriptSha256: evidence.proxyDigest,
  };
}

async function providerCanaryReadinessReason(
  providerId: string,
  binary: string,
  proxyScriptPath: string,
  stateRoot: string,
  nowMs: number | undefined,
  versionTimeoutMs: number,
): Promise<ProviderCanaryReadinessReason> {
  let receipt: unknown;
  try {
    receipt = readProviderCanaryReceipt(stateRoot, providerId);
  } catch {
    // intentional: admission refuses an unsafe or unparsable receipt; report it as malformed.
    return 'malformed';
  }
  // A missing receipt needs no version subprocess to classify.
  if (receipt === null) return 'missing';
  let evidence: ProviderCanaryEvidence;
  try {
    evidence = await collectProviderCanaryEvidenceAsync(providerId, binary, proxyScriptPath, versionTimeoutMs);
  } catch {
    // intentional: admission refuses an unresolvable, hung or failing binary version; report it as its own class.
    return 'unavailable';
  }
  return validateProviderCanaryReceipt(receipt, evidence, nowMs).reason;
}

/**
 * Read-only view of the proof readProviderCanaryAdmission enforces, for every
 * configured provider that admission gates (#3832). Admission refuses an
 * unproven provider only when a turn reaches it, so without this view a
 * missing receipt or a provider upgrade stays invisible until turns fail.
 *
 * Returns no entries when the receipt store is not provisioned, because
 * admission requires no proof there. Providers outside the gated mode (API
 * providers, non-`per_chat` scopes, sandbox-per-chat) are skipped. A receipt
 * that cannot be read safely or parsed reports `malformed`.
 *
 * Runs on the health tick, so it never blocks the event loop: each `--version`
 * child is asynchronous and bounded by `versionTimeoutMs` (default 5 s, the
 * admission bound); a hung or slow binary reports `unavailable`.
 */
export async function inspectProviderCanaryReadiness(input: {
  providerIds: readonly string[];
  resolveBinary: (providerId: string) => string | null;
  proxyScriptPath: string;
  stateRoot: string;
  sessionScope: string;
  sandboxPerChat: boolean;
  nowMs?: number;
  versionTimeoutMs?: number;
}): Promise<ProviderCanaryReadinessEntry[]> {
  const required = [...new Set(input.providerIds)].filter((providerId) => providerCanaryRequired(
    providerId,
    input.sessionScope,
    input.sandboxPerChat,
  ));
  if (required.length === 0 || !canaryStoreProvisioned(input.stateRoot)) return [];
  const versionTimeoutMs = input.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  return Promise.all(required.map(async (providerId): Promise<ProviderCanaryReadinessEntry> => {
    let binary: string;
    try {
      binary = input.resolveBinary(providerId) ?? '';
    } catch {
      // intentional: admission cannot run a provider whose binary does not resolve.
      return { providerId, reason: 'unavailable' };
    }
    return {
      providerId,
      reason: await providerCanaryReadinessReason(
        providerId,
        binary,
        input.proxyScriptPath,
        input.stateRoot,
        input.nowMs,
        versionTimeoutMs,
      ),
    };
  }));
}
