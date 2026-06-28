/**
 * Cross-platform credential storage abstraction.
 *
 * Supports:
 *  - Linux: GNOME Keyring via secret-tool
 *  - macOS: Keychain via security CLI
 *  - Fallback: environment variables
 */
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createChildLogger } from '../logger.ts';

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
  // Note: secret-tool has no --version flag (exits 2). GLib intercepts --help
  // before custom dispatch and exits 0, making it a reliable presence probe.
  try {
    execFileSync('secret-tool', ['--help'], { timeout: 2_000, stdio: 'ignore' });
    _cachedBackend = 'secret-tool';
  } catch (err) {
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

/**
 * Look up a credential by service name.
 *
 * Resolution order:
 *  1. Environment variable (if mapped)
 *  2. Platform keyring (secret-tool or macOS Keychain)
 *
 * User-scoped lookups invert that order so a shared process env var cannot
 * shadow an instance-specific keyring entry.
 *
 * Returns the trimmed value, or null if unavailable.
 */
export function lookupCredential(service: string, options: CredentialLookupOptions = {}): string | null {
  const lookupEnv = (): string | null => {
    const envKey = SERVICE_ENV_MAP[service];
    if (!envKey) return null;
    const envVal = process.env[envKey];
    if (envVal) return envVal.trim();
    return null;
  };

  // 1. Check environment variable first for normal service-wide lookups.
  const envFirst = options.user === undefined && options.skipEnv !== true;
  if (envFirst) {
    const envVal = lookupEnv();
    if (envVal) return envVal;
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

  // 2. Try platform keyring
  const backend = detectKeyringBackend();

  const services = [
    service,
    ...(options.skipMigrationFallbacks === true ? [] : (SERVICE_MIGRATION_FALLBACKS[service] ?? [])),
  ];
  const secretToolArgs = (candidate: string, includeOptions: boolean): string[] => {
    const args = ['lookup', 'service', candidate];
    if (includeOptions && options.user) args.push('user', options.user);
    return args;
  };

  if (backend === 'secret-tool') {
    try {
      for (const [index, candidate] of services.entries()) {
        try {
          const raw = execFileSync('secret-tool', secretToolArgs(candidate, index === 0), { timeout: 5_000 });
          const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
          if (val) return val;
        } catch (err) {
          // Warn on primary candidate failure; migration fallback misses are expected.
          if (index === 0) {
            getLog().warn(
              { service, backend, err: errorMessage(err) },
              'keyring read failed — falling back to env lookup',
            );
          }
        }
      }
      const fileVal1 = fileStoreRead(service);
      if (fileVal1) return fileVal1;
      return lookupEnvAfterKeyringMiss();
    } catch {
      const fileVal2 = fileStoreRead(service);
      if (fileVal2) return fileVal2;
      return lookupEnvAfterKeyringMiss();
    }
  }

  if (backend === 'macos-keychain') {
    try {
      const username = os.userInfo().username;
      for (const [index, candidate] of services.entries()) {
        try {
          const account = index === 0 && options.user ? options.user : username;
          const raw = execFileSync(
            'security',
            ['find-generic-password', '-s', candidate, '-a', account, '-w'],
            { timeout: 5_000 },
          );
          const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
          if (val) return val;
        } catch (err) {
          // Warn on primary candidate failure; migration fallback misses are expected.
          if (index === 0) {
            getLog().warn(
              { service, backend, err: errorMessage(err) },
              'keyring read failed — falling back to env lookup',
            );
          }
        }
      }
      const fileVal3 = fileStoreRead(service);
      if (fileVal3) return fileVal3;
      return lookupEnvAfterKeyringMiss();
    } catch {
      const fileVal4 = fileStoreRead(service);
      if (fileVal4) return fileVal4;
      return lookupEnvAfterKeyringMiss();
    }
  }

  // env-only or scoped keyring miss: consult the file store, then env.
  const fileVal = fileStoreRead(service);
  if (fileVal) return fileVal;
  return lookupEnvAfterKeyringMiss();
}

/** Reset cached backend detection (for testing). */
export function _resetBackendCache(): void {
  _cachedBackend = undefined;
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
        { timeout: 5_000, input: `${value}\n${value}\n`, stdio: ['pipe', 'ignore', 'pipe'] },
      );
      return { backend };
    } catch (err) {
      throw new KeyringWriteError(classifyDarwinWriteError(err), `keychain write failed for service ${service}`);
    }
  }
  if (backend === 'secret-tool') {
    try {
      execFileSync('secret-tool', ['store', `--label=whatsoup ${service}`, 'service', service], {
        timeout: 5_000,
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

// ─── File-store backend (hosts with no OS keyring) ───────────────────────────
// Per-service 0600 files mirror the OS keyring's per-entry isolation; the
// directory layout follows the token-storage.ts precedent (0600 under
// ~/.config/whatsoup/). Used ONLY when detectKeyringBackend() === 'env-only'.

let _fileStoreDirOverride: string | null = null;
/** Test hook — point the file store at a temp dir (null restores default). */
export function _setFileStoreDirForTests(dir: string | null): void {
  _fileStoreDirOverride = dir;
}

function fileStoreDir(): string {
  if (_fileStoreDirOverride) return _fileStoreDirOverride;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'whatsoup', 'credentials');
}

function fileStorePath(service: string): string {
  return path.join(fileStoreDir(), `${service}.key`);
}

function fileStoreRead(service: string): string | null {
  try {
    const val = fs.readFileSync(fileStorePath(service), 'utf-8').trim();
    return val || null;
  } catch {
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
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
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
  } catch {
    return null;
  }
}

function fileStoreWrite(service: string, value: string): void {
  const dir = fileStoreDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = fileStorePath(service);
  // Sibling temp file — same directory, so renameSync can never hit EXDEV.
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function fileStoreDelete(service: string): boolean {
  try {
    fs.unlinkSync(fileStorePath(service));
    return true;
  } catch {
    return false;
  }
}

export interface CredentialDeleteResult { deleted: boolean; backend: KeyringBackend }

/** Remove a credential from the platform keyring. Never throws on absence. */
export function deleteCredential(
  service: string,
  options: { user?: string } = {},
): CredentialDeleteResult {
  const backend = detectKeyringBackend();
  const account = options.user ?? os.userInfo().username;

  if (backend === 'macos-keychain') {
    try {
      execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], {
        timeout: 5_000,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return { deleted: true, backend };
    } catch {
      return { deleted: false, backend };
    }
  }
  if (backend === 'secret-tool') {
    try {
      execFileSync('secret-tool', ['clear', 'service', service], { timeout: 5_000, stdio: ['ignore', 'ignore', 'pipe'] });
      return { deleted: true, backend };
    } catch {
      return { deleted: false, backend };
    }
  }
  return { deleted: fileStoreDelete(service), backend };
}
