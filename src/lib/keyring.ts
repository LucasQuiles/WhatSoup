/**
 * Cross-platform credential storage abstraction.
 *
 * Supports:
 *  - Linux: GNOME Keyring via secret-tool
 *  - macOS: Keychain via security CLI
 *  - Private credential files and environment/OpenCode fallbacks
 */
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createChildLogger } from '../logger.ts';
import {
  deletePrivateFileSync,
  readPrivateFileSync,
  writeAtomicPrivateFileSync,
} from './private-fs.ts';

export type KeyringBackend = 'secret-tool' | 'macos-keychain' | 'env-only';

// The pure service map + resolver live in provider-key-service.ts (no
// child_process/logger imports) so the config validator and provider MCP
// config generation can consume them. Re-exported here so runtime callers
// keep one import site for everything keyring-shaped.
import { SERVICE_ENV_MAP } from './provider-key-service.ts';
import { errorMessage } from './error-message.ts';

export { SERVICE_ENV_MAP, resolveProviderKeyService } from './provider-key-service.ts';

// Alias map: a WhatSoup service name (SERVICE_ENV_MAP key) → the keyring
// service name(s) the live key is actually stored under. lookupCredential tries
// the canonical service first, then these in order. This is the single
// source-of-truth bridge between WhatSoup's provider naming and the keyring's
// historical storage names — without it, a provider whose key was stored under
// a divergent service name silently resolves to nothing ("lost" credential).
//   glm   → zai-api-key : opencode derives service "glm" from model glm/glm-5.2,
//           but the Z.ai coding-plan key is stored under service "zai-api-key".
//   google → gemini     : SERVICE_ENV_MAP maps google→GOOGLE_API_KEY, but the
//           live Gemini key is stored under service "gemini".
const SERVICE_MIGRATION_FALLBACKS: Record<string, string[]> = {
  'whatsoup-health-token': ['whatsoup_health'],
  glm: ['zai-api-key'],
  google: ['gemini'],
};

export interface CredentialLookupOptions {
  user?: string;
  skipEnv?: boolean;
  skipMigrationFallbacks?: boolean;
}

let _cachedBackend: KeyringBackend | undefined;
const KEYRING_COMMAND_TIMEOUT_MS = 3_000;
const FILE_STORE_MAX_BYTES = 4_096;
/**
 * Which store a credential read failed against. Keyed into the warn-dedup set so
 * a platform-keyring failure for a service does not suppress the file-store or
 * opencode warning for that SAME service — they are independent faults and an
 * operator needs to see both. Keying by bare service name silently dropped the
 * second one.
 */
type CredentialReadSource = 'keyring' | 'file-store' | 'opencode-auth';

const warnedKeyringReadServices = new Set<string>();

/**
 * Services whose credential read FAILED (as opposed to being absent) during the
 * current lookup. `lookupCredential` keeps its `string | null` contract — see
 * the note on {@link lookupCredentialTyped} — so this is how a hard read failure
 * reaches the typed surface without turning "not configured" into a throw on the
 * credential-presence hot path.
 *
 * Written only by {@link recordCredentialReadFailure}; read and cleared by
 * `lookupCredentialTyped`. Safe despite being module state: the whole lookup
 * chain is synchronous, so no other lookup can interleave between the clear and
 * the read.
 */
const credentialReadFailures = new Set<string>();

/**
 * Warn once per (source, operation, service) that a credential store operation
 * failed. Does NOT touch {@link credentialReadFailures} — only a READ failure
 * should influence the typed lookup's reason code.
 */
function warnCredentialStoreFailure(
  service: string,
  source: CredentialReadSource,
  operation: 'read' | 'delete',
  err: unknown,
): void {
  const dedupKey = `${source}:${operation}:${service}`;
  if (warnedKeyringReadServices.has(dedupKey)) return;
  warnedKeyringReadServices.add(dedupKey);
  // errorMessage() only — never the raw error. A raw child-process error carries
  // `spawnargs` (may include the secret) and `stderr`, which the fleet server's
  // global `log.error({ err })` handler would serialize. Same constraint the
  // KeyringWriteError docstring states for the write path.
  getLog().warn(
    { service, source, operation, err: errorMessage(err) },
    operation === 'read'
      ? 'credential read failed — value is present-but-unreadable, not absent'
      : 'credential delete failed — value may still be present',
  );
}

/** A READ failed: warn AND flag, so the typed lookup reports `unreadable`. */
function recordCredentialReadFailure(
  service: string,
  source: CredentialReadSource,
  err: unknown,
): void {
  credentialReadFailures.add(service);
  warnCredentialStoreFailure(service, source, 'read', err);
}
const keyringExecOptions = {
  timeout: KEYRING_COMMAND_TIMEOUT_MS,
  killSignal: 'SIGKILL' as const,
};
// Credential reads return the value on stdout; bound it to the same 4 KiB the
// pinned-Node keychain helper enforces (deploy/lib/read-keychain-secret.mjs).
// Detection, writes, and deletes keep the base options — backend detection's
// `secret-tool --help` banner can legitimately exceed 4 KiB.
const keyringReadExecOptions = { ...keyringExecOptions, maxBuffer: FILE_STORE_MAX_BYTES };

// Lazy logger — avoids any risk of a cycle during module initialisation while
// still giving us structured log output once the module is fully loaded.
function getLog() {
  return createChildLogger('keyring');
}

/** Detect the available keyring backend for this platform. */
export function detectKeyringBackend(): KeyringBackend {
  if (_cachedBackend !== undefined) return _cachedBackend;

  if (process.platform === 'darwin') {
    _cachedBackend = 'macos-keychain';
    return _cachedBackend;
  }

  // Linux / WSL: probe secret-tool directly (avoids dependency on 'which').
  // secret-tool has no --version flag, and --help is not portable: some
  // libsecret builds print a valid usage banner but exit 2. Treat that exact
  // usage response as presence; other non-zero exits still mean probe failure.
  try {
    execFileSync('secret-tool', ['--help'], keyringExecOptions);
    _cachedBackend = 'secret-tool';
  } catch (err) {
    if (isSecretToolUsageHelpExit(err)) {
      _cachedBackend = 'secret-tool';
      return _cachedBackend;
    }
    const errMsg = errorMessage(err);
    // CRED-2: distinguish "no keyring installed" (ENOENT — the expected, benign
    // fallback) from "the keyring probe ERRORED" (timeout, EACCES, unexpected
    // exit). A transient/errored probe silently downgrading ALL credential
    // storage to plaintext 0600 files is alarming and must be operator-visible.
    const probeErrored = !isProbeAbsentError(err);

    if (probeErrored && process.env.REQUIRE_OS_KEYRING) {
      // Honor REQUIRE_OS_KEYRING: an errored downgrade is fatal here rather than
      // silently falling back to plaintext file storage. A genuinely-absent
      // keyring (ENOENT) is still allowed to fall back below.
      throw new Error(
        `keyring backend probe errored and REQUIRE_OS_KEYRING is set — refusing to downgrade to plaintext credential storage: ${errMsg}`,
      );
    }

    _cachedBackend = 'env-only';
    if (probeErrored) {
      // Surface the downgrade at ERROR level so it is not buried at debug/warn.
      getLog().error(
        { backend: 'env-only', err: errMsg },
        'keyring backend probe ERRORED — credential storage DOWNGRADED to plaintext file store (not a genuinely-absent keyring)',
      );
    } else {
      getLog().warn(
        { backend: 'env-only', err: errMsg },
        'keyring backend probe failed — falling back to env-only credential lookup',
      );
    }
  }
  return _cachedBackend;
}

/**
 * True when the probe error means the keyring binary is genuinely absent
 * (expected, benign) rather than present-but-errored (alarming downgrade).
 * `secret-tool --help` missing surfaces as ENOENT from execFileSync.
 */
function isProbeAbsentError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

function isSecretToolUsageHelpExit(err: unknown): boolean {
  const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string } | null;
  if (e?.status !== 2) return false;
  const output = [e.stdout, e.stderr]
    .filter((part): part is Buffer | string => part !== undefined)
    .map((part) => Buffer.isBuffer(part) ? part.toString('utf8') : part)
    .join('\n');
  return /usage:\s*secret-tool\b/i.test(output);
}

/**
 * Look up a credential by service name.
 *
 * Resolution order:
 *  - Unscoped: environment, private file, platform keyring, OpenCode
 *  - User-scoped: platform keyring, environment, OpenCode
 *
 * User-scoped lookups never consult the unscoped private file.
 *
 * Returns the trimmed value, or null if unavailable.
 */
export function lookupCredential(service: string, options: CredentialLookupOptions = {}): string | null {
  if (!isValidCredentialService(service)) return null;

  const lookupEnv = (): string | null => {
    const envKey = SERVICE_ENV_MAP[service];
    if (!envKey) return null;
    const envVal = process.env[envKey];
    // QR-157: trim FIRST, then check — a whitespace-only env var (`'   '`) is
    // truthy but trims to `''`. Returning that empty string is dangerous for
    // consumers that use the credential as an HMAC key (Twilio validateRequest):
    // an empty key is attacker-forgeable. Mirror the keyring/file paths below,
    // which already trim-then-check, so an empty-after-trim value yields null.
    const trimmed = envVal?.trim();
    if (trimmed) return trimmed;
    return null;
  };

  // Unscoped lookups prefer process env, then the private file, before invoking
  // a platform keyring that may block in a headless process.
  const envFirst = options.user === undefined && options.skipEnv !== true;
  if (envFirst) {
    const envVal = lookupEnv();
    if (envVal) return envVal;
  }
  if (options.user === undefined) {
    const fileVal = fileStoreRead(service);
    if (fileVal) return fileVal;
  }

  const lookupEnvAfterKeyringMiss = (): string | null => {
    const envVal = (envFirst || options.skipEnv === true) ? null : lookupEnv();
    if (envVal) return envVal;
    // Terminal fallback: opencode-backed providers store their key in opencode's
    // own auth.json (service id == opencode provider id). An opencode session
    // would authenticate from there, so credential PRESENCE must consult it —
    // otherwise pre-flight emits a false `fallback_credential_missing`. Returns
    // null for any non-opencode service (auth.json won't contain it).
    return readOpenCodeAuthKey(service);
  };

  // Scoped lookups reach this point before env and never consult the unscoped
  // private file. Unscoped lookups reach it only after env and file misses.
  const backend = detectKeyringBackend();

  const services = [
    service,
    ...(options.skipMigrationFallbacks === true ? [] : (SERVICE_MIGRATION_FALLBACKS[service] ?? [])),
  ];
  const secretToolArgs = (candidate: string): string[] => {
    const args = ['lookup', 'service', candidate];
    if (options.user !== undefined) args.push('user', options.user);
    return args;
  };

  if (backend === 'secret-tool') {
    for (const [index, candidate] of services.entries()) {
      try {
        const raw = execFileSync(
          'secret-tool',
          secretToolArgs(candidate),
          keyringReadExecOptions,
        );
        const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
        if (val) return val;
      } catch (err) {
        // Warn on primary candidate failure; migration fallback misses are expected.
        if (index === 0) {
          warnKeyringReadFailure(service, backend, err);
        }
      }
    }
    return lookupEnvAfterKeyringMiss();
  }

  if (backend === 'macos-keychain') {
    try {
      const account = options.user ?? os.userInfo().username;
      for (const [index, candidate] of services.entries()) {
        try {
          const raw = execFileSync(
            'security',
            ['find-generic-password', '-s', candidate, '-a', account, '-w'],
            keyringReadExecOptions,
          );
          const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
          if (val) return val;
        } catch (err) {
          // Warn on primary candidate failure; migration fallback misses are expected.
          if (index === 0) {
            warnKeyringReadFailure(service, backend, err);
          }
        }
      }
    } catch {
      // Account discovery failures preserve the terminal env/OpenCode fallback.
    }
    return lookupEnvAfterKeyringMiss();
  }

  // env-only or platform-keyring miss: scoped env, then terminal OpenCode.
  return lookupEnvAfterKeyringMiss();
}

function warnKeyringReadFailure(service: string, backend: KeyringBackend, err: unknown): void {
  // Source-qualified key: previously this deduped on bare `service`, so a
  // platform-keyring warning suppressed the file-store/opencode warning for the
  // same service (and vice versa) even though they are independent faults.
  const dedupKey = `keyring:${service}`;
  if (warnedKeyringReadServices.has(dedupKey)) return;
  warnedKeyringReadServices.add(dedupKey);
  credentialReadFailures.add(service);
  getLog().warn(
    { service, backend, err: errorMessage(err) },
    'keyring read failed — falling back to env lookup',
  );
}

/** Reset cached backend detection (for testing). */
export function _resetBackendCache(): void {
  _cachedBackend = undefined;
  warnedKeyringReadServices.clear();
  credentialReadFailures.clear();
}

// ─── Typed lookup with closed-id gate (W-1 / Pattern A) ───────────────────────

/**
 * Reason code explaining why a typed credential lookup returned what it did.
 * Mirrors the classification shape recommended by the OpenClaw clean-room
 * comparison audit (Pattern B: credential-state reason-code taxonomy).
 */
export type CredentialLookupReasonCode =
  | 'ok'                // value found
  | 'unknown_service'   // service not in SERVICE_ENV_MAP — closed-id gate rejected it
  | 'not_found'         // service is known but no credential was available
  | 'unreadable';       // a store holding this credential failed to read (EACCES/EIO/corrupt)

/**
 * Typed result from {@link lookupCredentialTyped}. Carries the value (or null)
 * plus a reason code so callers can distinguish "not configured" from "misnamed"
 * without re-deriving it. The `service` field echoes the input for log context.
 */
export interface CredentialLookupResult {
  value: string | null;
  reason: CredentialLookupReasonCode;
  service: string;
}

/**
 * Check whether a service name is in the closed registry (SERVICE_ENV_MAP).
 * This is the Pattern A closed-id gate: only registry-known services can be
 * resolved through the typed API, preventing callers from probing arbitrary
 * service names through the resolver. Mirrors OpenClaw's
 * `isKnownSecretTargetId` / `isKnownCoreSecretTargetId` gate
 * (`src/gateway/server-methods/secrets.ts:134-146`).
 */
export function isKnownService(service: string): boolean {
  return Object.hasOwn(SERVICE_ENV_MAP, service);
}

/**
 * Typed credential lookup with a closed-id gate.
 *
 * Phase W-1 of the env-secret-exposure remediation. Wraps the existing
 * {@link lookupCredential} with:
 *   1. A closed-registry gate: services not in SERVICE_ENV_MAP are rejected
 *      with `reason: 'unknown_service'` (value: null). This extends QR-248's
 *      provider-config exfil guard to ALL resolver calls, not just those that
 *      flow through `providerConfig.apiKeyService`.
 *   2. A typed result: callers get `value` + `reason` instead of `string | null`,
 *      so they can surface "unknown service" vs "known but not configured"
 *      without re-deriving it.
 *
 * Existing callers of {@link lookupCredential} are unaffected — this is a new
 * API. Migrated providers should adopt it as they move through W-2.
 */
export function lookupCredentialTyped(
  service: string,
  options?: CredentialLookupOptions,
): CredentialLookupResult {
  if (!isKnownService(service)) {
    return { value: null, reason: 'unknown_service', service };
  }

  // Clear before the lookup so the flag reflects THIS call only — a failure
  // recorded by an earlier lookup of the same service must not leak into this
  // result. The whole chain below is synchronous, so nothing can interleave.
  credentialReadFailures.delete(service);
  const value = lookupCredential(service, options);
  if (value && value.length > 0) {
    return { value, reason: 'ok', service };
  }
  // A null value with a recorded read failure is NOT "not configured" — a store
  // holding this credential was unreadable (EACCES/EIO/corrupt JSON). Reporting
  // `not_found` here is what drove false `fallback_credential_missing` alerts
  // and could lead an operator to re-store a key that is present but broken.
  if (credentialReadFailures.has(service)) {
    credentialReadFailures.delete(service);
    return { value: null, reason: 'unreadable', service };
  }
  return { value: null, reason: 'not_found', service };
}

// ─── Write path ───────────────────────────────────────────────────────────────

export type KeyringErrorCode =
  | 'KEYRING_LOCKED'
  | 'KEYRING_ACCESS_DENIED'
  | 'KEYRING_WRITE_FAILED'
  | 'KEYRING_WRITE_UNSUPPORTED';

/**
 * Sanitized keyring failure. NEVER constructed from a raw child-process error:
 * those carry `spawnargs` (may include the secret) and `stderr`, which the
 * fleet server's global `log.error({ err })` handler would serialize.
 */
export class KeyringWriteError extends Error {
  readonly code: KeyringErrorCode;
  constructor(code: KeyringErrorCode, message: string) {
    super(message);
    this.name = 'KeyringWriteError';
    this.code = code;
  }
}

/** macOS `security` exit statuses / markers that mean "keychain locked". */
function classifyDarwinWriteError(err: unknown): KeyringErrorCode {
  const status = (err as { status?: number } | null)?.status;
  const stderr = String((err as { stderr?: Buffer | string } | null)?.stderr ?? '');
  if (status === 36 || /interaction is not allowed/i.test(stderr)) return 'KEYRING_LOCKED';
  if (status === 45 || /errSecAuthFailed|write permissions/i.test(stderr)) return 'KEYRING_ACCESS_DENIED';
  return 'KEYRING_WRITE_FAILED';
}

export interface CredentialWriteResult { backend: KeyringBackend }

/**
 * Store a credential in the platform keyring (create or overwrite).
 * Throws KeyringWriteError (sanitized — safe to log) on failure.
 */
export function writeCredential(
  service: string,
  value: string,
  options: { user?: string } = {},
): CredentialWriteResult {
  if (!isValidCredentialService(service)) {
    throw new KeyringWriteError('KEYRING_WRITE_FAILED', 'credential write failed for invalid service');
  }
  const backend = detectKeyringBackend();
  const account = options.user ?? os.userInfo().username;

  if (backend === 'macos-keychain') {
    try {
      // CRED-1: never put the secret on argv (world-visible via `ps -ww` for the exec
      // lifetime). `-w` as the LAST option makes `security` prompt for the password on
      // stdin; it asks twice (enter + retype), so the value is sent twice. Integration-
      // verified on macOS (readback matches). NOTE: no `--` separators here — `security
      // add-generic-password` consumes `--` as the value of `-s`/`-a` and fails (rc=2);
      // execFileSync already passes args as an array, so option-arguments cannot be
      // reinterpreted as flags and `--` is both unnecessary and breaking. The same `--`
      // removal is applied to the read (find-generic-password) and delete paths below —
      // all three were broken against a real keychain (item-not-found / rc=2), masked by
      // execFileSync mocks; integration-verified by round-trip on macOS.
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', service, '-a', account, '-w'],
        {
          ...keyringExecOptions,
          input: `${value}\n${value}\n`,
          stdio: ['pipe', 'ignore', 'pipe'],
        },
      );
    } catch (err) {
      throw new KeyringWriteError(classifyDarwinWriteError(err), `keychain write failed for service ${service}`);
    }
    if (options.user === undefined) {
      try {
        fileStoreWrite(service, value);
      } catch {
        fileStoreDelete(service);
        throw new KeyringWriteError('KEYRING_WRITE_FAILED', `credential mirror failed for service ${service}`);
      }
    }
    return { backend };
  }
  if (backend === 'secret-tool') {
    try {
      execFileSync('secret-tool', ['store', `--label=whatsoup ${service}`, 'service', service], {
        ...keyringExecOptions,
        input: value,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      return { backend };
    } catch {
      throw new KeyringWriteError('KEYRING_WRITE_FAILED', `secret-tool store failed for service ${service}`);
    }
  }
  // env-only host: per-service 0600 file store (token-storage.ts precedent).
  try {
    fileStoreWrite(service, value);
    return { backend };
  } catch {
    throw new KeyringWriteError('KEYRING_WRITE_FAILED', `file-store write failed for service ${service}`);
  }
}

// ─── Private credential file store ──────────────────────────────────────────
// Per-service 0600 files mirror the OS keyring's per-entry isolation; the
// directory layout follows the token-storage.ts private-config precedent.
// Unscoped macOS writes mirror here; env-only hosts use it as their durable
// backend. User-scoped operations never access it.

let _fileStoreDirOverride: string | null = null;
/** Test hook — point the file store at a temp dir (null restores default). */
export function _setFileStoreDirForTests(dir: string | null): void {
  _fileStoreDirOverride = dir;
}

function fileStoreDir(): string {
  if (_fileStoreDirOverride) return _fileStoreDirOverride;
  const isDarwin = os.platform() === 'darwin';
  const base = process.env.XDG_CONFIG_HOME
    || (isDarwin
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(base, 'whatsoup', 'credentials');
}

function fileStorePath(service: string): string {
  assertValidFileStoreService(service);
  return path.join(fileStoreDir(), `${service}.key`);
}

function isValidCredentialService(service: string): boolean {
  return service.length > 0 &&
    !service.includes('/') &&
    !service.includes('\\') &&
    !service.includes('\0');
}

function assertValidFileStoreService(service: string): void {
  if (!isValidCredentialService(service)) {
    throw new Error('invalid credential service name');
  }
}

function fileStoreRead(service: string): string | null {
  try {
    const raw = readPrivateFileSync(fileStorePath(service), {
      label: 'credential',
      maxBytes: FILE_STORE_MAX_BYTES,
    });
    const val = raw?.trim();
    return val || null;
  } catch (err) {
    // No errno branching here on purpose: readPrivateFileSync ALREADY returns
    // null for both ENOENT cases (missing directory and missing file) and only
    // throws for a genuine fault — EACCES, EIO, EFBIG, or a private-mode
    // violation. So reaching this catch means "present but unreadable", never
    // "absent". The previous bare `catch { return null }` discarded that
    // distinction the layer below had already made, which is what let a
    // permission flip masquerade as a missing credential.
    recordCredentialReadFailure(service, 'file-store', err);
    return null;
  }
}

let _openCodeAuthDirOverride: string | null = null;

/** Test hook — point the opencode auth-store dir at a temp dir (null restores default). */
export function _setOpenCodeAuthDirForTests(dir: string | null): void {
  _openCodeAuthDirOverride = dir;
}

function openCodeAuthPath(): string {
  if (_openCodeAuthDirOverride) return path.join(_openCodeAuthDirOverride, 'auth.json');
  const base = process.env.XDG_DATA_HOME
    || (isDarwin
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'));
  return path.join(base, 'opencode', 'auth.json');
}

/**
 * Read an API key from opencode's own credential store (`auth.json`), keyed by
 * opencode provider id (== the service name resolveProviderKeyService derives,
 * e.g. `minimax`). Returns the trimmed key or null on any miss/parse error.
 *
 * Why this exists: opencode-backed fallback providers authenticate from this
 * file, not WhatSoup's keyring/env. Without consulting it, credential PRESENCE
 * pre-flight emits a false `fallback_credential_missing` (e.g. minimax) even
 * though the opencode session would authenticate fine. Used as the terminal
 * fallback in lookupCredential so all pre-flight/verify sites benefit.
 */
export function readOpenCodeAuthKey(provider: string): string | null {
  try {
    const raw = fs.readFileSync(openCodeAuthPath(), 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const entry = data[provider];
    if (entry && typeof entry === 'object') {
      const key = (entry as { key?: unknown }).key;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
    return null;
  } catch (err) {
    // Deliberately NOT the same shape as fileStoreRead. This path calls
    // fs.readFileSync directly, with no private-fs layer to normalize absence,
    // so ENOENT arrives here and is legitimate: most services have no opencode
    // auth.json at all, and this is the terminal fallback consulted for every
    // lookup. Treating that as a fault would warn on nearly every credential
    // resolution.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Everything else is a real fault worth surfacing: EACCES/EIO from the read,
    // or a SyntaxError from JSON.parse on a truncated/corrupt store. Note a
    // SyntaxError carries no `.code`, so errno branching alone cannot classify
    // this — the ENOENT check must be an allowlist, not a blocklist of bad codes.
    recordCredentialReadFailure(provider, 'opencode-auth', err);
    return null;
  }
}

function fileStoreWrite(service: string, value: string): void {
  if (Buffer.byteLength(value) > FILE_STORE_MAX_BYTES) {
    throw new Error('credential exceeds file-store maximum size');
  }
  writeAtomicPrivateFileSync(fileStorePath(service), value, 'credential');
}

function fileStoreDelete(service: string): boolean {
  try {
    return deletePrivateFileSync(fileStorePath(service), 'credential');
  } catch (err) {
    // deleteCredential's contract is "never throws on absence", so this keeps
    // returning false rather than propagating. But a backend failure is not an
    // absence: returning a bare false told the caller "there was nothing to
    // delete" when the credential is still on disk and merely unremovable —
    // the dangerous direction for a revocation path.
    //
    // Warn only, with a delete-specific message. Routing this through
    // recordCredentialReadFailure would log "credential read failed — value is
    // present-but-unreadable", which is false for a delete and would send an
    // operator to investigate the read path.
    //
    // It also deliberately does NOT set credentialReadFailures: a failed delete
    // says nothing about whether the value can be READ. That flag could not
    // actually leak into a later typed lookup anyway, since lookupCredentialTyped
    // clears it on entry — so this separation prevents a false log signal, it
    // does not fix a reachable classification bug.
    warnCredentialStoreFailure(service, 'file-store', 'delete', err);
    return false;
  }
}

function fileStoreIsAbsent(service: string): boolean {
  try {
    fs.lstatSync(fileStorePath(service));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Why a delete returned what it did. Completes the reason-code taxonomy the
 * read path already carries ({@link CredentialLookupReasonCode}) and the write
 * path already carries ({@link KeyringErrorCode}); delete was the one remaining
 * unclassified operation.
 *
 * `absent` and `backend_failed` are the distinction that matters: both used to
 * surface as `deleted:false`, and the fleet route mapped that to 404. An
 * operator with a locked keychain was told the credential did not exist.
 */
export type CredentialDeleteReasonCode =
  | 'deleted'          // the credential was present and is now gone
  | 'absent'           // nothing to remove — the legitimate 404
  | 'unknown_service'  // closed-id gate rejected the service name
  | 'backend_failed';  // the store could NOT be consulted — never a 404

export interface CredentialDeleteResult {
  deleted: boolean;
  backend: KeyringBackend;
  reason: CredentialDeleteReasonCode;
  /**
   * Sanitized code when `reason === 'backend_failed'`. Reuses the write-path
   * taxonomy. NEVER a raw child-process error: those carry `spawnargs` (may
   * include the secret) and `stderr`, which the fleet server's global
   * `log.error({ err })` handler would serialize.
   */
  errorCode?: KeyringErrorCode;
}

/**
 * `security delete-generic-password` exits non-zero for BOTH "no such item" and
 * real failures, so absence cannot be inferred from the throw alone. Status 44
 * is errSecItemNotFound; the message check covers locale-stable wording.
 */
function isDarwinItemNotFound(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 44) return true;
  const stderr = String((err as { stderr?: Buffer | string } | null)?.stderr ?? '');
  return /could not be found|SecKeychainSearchCopyNext/i.test(stderr);
}

/**
 * Remove a credential from the platform keyring. Never throws — on absence OR
 * on failure — but the two are now distinguishable via `reason`.
 */
export function deleteCredential(
  service: string,
  options: { user?: string } = {},
): CredentialDeleteResult {
  const backend = detectKeyringBackend();
  if (!isValidCredentialService(service)) {
    return { deleted: false, backend, reason: 'unknown_service' };
  }
  const account = options.user ?? os.userInfo().username;

  if (backend === 'macos-keychain') {
    let keychainDeleted = false;
    let keychainFailure: KeyringErrorCode | null = null;
    try {
      execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], {
        ...keyringExecOptions,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      keychainDeleted = true;
    } catch (err) {
      // Absence is not a failure; anything else is. Classification only —
      // the mirror sweep below still runs either way, because removing what
      // CAN be removed is the long-standing contract of this function.
      if (!isDarwinItemNotFound(err)) keychainFailure = classifyDarwinWriteError(err);
    }
    if (options.user !== undefined) {
      if (keychainDeleted) return { deleted: true, backend, reason: 'deleted' };
      return keychainFailure === null
        ? { deleted: false, backend, reason: 'absent' }
        : { deleted: false, backend, reason: 'backend_failed', errorCode: keychainFailure };
    }

    let fileAbsent = false;
    let mirrorFailed = false;
    try {
      fileStoreDelete(service);
      fileAbsent = fileStoreIsAbsent(service);
    } catch {
      mirrorFailed = true;
    }

    if (keychainFailure !== null) {
      return { deleted: false, backend, reason: 'backend_failed', errorCode: keychainFailure };
    }
    if (mirrorFailed || !fileAbsent) {
      // The mirror may still hold a readable copy, so this is not an "absent".
      return { deleted: false, backend, reason: 'backend_failed', errorCode: 'KEYRING_WRITE_FAILED' };
    }
    return keychainDeleted
      ? { deleted: true, backend, reason: 'deleted' }
      : { deleted: false, backend, reason: 'absent' };
  }

  if (backend === 'secret-tool') {
    try {
      execFileSync('secret-tool', ['clear', 'service', service], {
        ...keyringExecOptions,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return { deleted: true, backend, reason: 'deleted' };
    } catch (err) {
      // `secret-tool clear` exits 0 when nothing matched, so a throw here is a
      // genuine backend failure, not absence.
      return {
        deleted: false,
        backend,
        reason: 'backend_failed',
        errorCode: classifyDarwinWriteError(err),
      };
    }
  }

  const removed = fileStoreDelete(service);
  return { deleted: removed, backend, reason: removed ? 'deleted' : 'absent' };
}
