import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
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

function readBinaryVersion(entrypoint: string): string {
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
      PATH: process.env.PATH,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      LANG: process.env.LANG,
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
  try {
    return execFileSync(entrypoint, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function resolveExecutable(binary: string, pathValue = process.env.PATH ?? ''): string {
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

export function collectProviderCanaryEvidence(
  providerId: string,
  binary: string,
  proxyScriptPath: string,
  binaryVersionOverride?: string,
): ProviderCanaryEvidence {
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
  const cached = evidenceCache.get(cacheKey);
  if (cached) return cached;
  const version = binaryVersionOverride ?? readBinaryVersion(entrypoint);
  if (!version || version.length > 128 || /[/\r\n]/.test(version)) {
    throw new Error('provider binary version is unavailable');
  }
  const evidence = {
    providerId,
    platform: process.platform,
    architecture: process.arch,
    binaryVersion: version,
    entrypointDigest: sha256File(entrypoint),
    proxyDigest: sha256File(proxyPath),
  };
  if (evidenceCache.size >= 16) evidenceCache.clear();
  evidenceCache.set(cacheKey, evidence);
  return evidence;
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
    const raw = readPrivateFileSync(
      providerCanaryReceiptPath(input.stateRoot, input.providerId),
      { label: 'provider canary receipt', maxBytes: 8 * 1024 },
    );
    receipt = raw === null ? null : JSON.parse(raw);
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
