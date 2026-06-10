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
import { createChildLogger } from '../logger.ts';

export type KeyringBackend = 'secret-tool' | 'macos-keychain' | 'env-only';

// The pure service map + resolver live in provider-key-service.ts (no
// child_process/logger imports) so the config validator and provider MCP
// config generation can consume them. Re-exported here so runtime callers
// keep one import site for everything keyring-shaped.
import { SERVICE_ENV_MAP } from './provider-key-service.ts';

export { SERVICE_ENV_MAP, resolveProviderKeyService } from './provider-key-service.ts';

const SERVICE_MIGRATION_FALLBACKS: Record<string, string[]> = {
  'whatsoup-health-token': ['whatsoup_health'],
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
    _cachedBackend = 'env-only';
    getLog().warn(
      { backend: 'env-only', err: err instanceof Error ? err.message : String(err) },
      'keyring backend probe failed — falling back to env-only credential lookup',
    );
  }
  return _cachedBackend;
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
    if (envFirst || options.skipEnv === true) return null;
    return lookupEnv();
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
              { service, backend, err: err instanceof Error ? err.message : String(err) },
              'keyring read failed — falling back to env lookup',
            );
          }
        }
      }
      return lookupEnvAfterKeyringMiss();
    } catch {
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
              { service, backend, err: err instanceof Error ? err.message : String(err) },
              'keyring read failed — falling back to env lookup',
            );
          }
        }
      }
      return lookupEnvAfterKeyringMiss();
    } catch {
      return lookupEnvAfterKeyringMiss();
    }
  }

  // env-only or scoped keyring miss.
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
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', '--', service, '-a', '--', account, '-w', value],
        { timeout: 5_000, stdio: ['ignore', 'ignore', 'pipe'] },
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
  // file-store backend lands in Task 3.
  throw new KeyringWriteError('KEYRING_WRITE_UNSUPPORTED', `no writable keyring backend (${backend})`);
}
