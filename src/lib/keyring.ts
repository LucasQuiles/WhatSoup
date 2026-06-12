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
