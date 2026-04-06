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

export type KeyringBackend = 'secret-tool' | 'macos-keychain' | 'env-only';

/** Map service names to their conventional env var names. */
const SERVICE_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  pinecone: 'PINECONE_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  whatsoup_health: 'WHATSOUP_HEALTH_TOKEN',
};

let _cachedBackend: KeyringBackend | undefined;

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
  } catch {
    _cachedBackend = 'env-only';
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
 * Returns the trimmed value, or null if unavailable.
 */
export function lookupCredential(service: string): string | null {
  // 1. Check environment variable first
  const envKey = SERVICE_ENV_MAP[service];
  if (envKey) {
    const envVal = process.env[envKey];
    if (envVal) return envVal.trim();
  }

  // 2. Try platform keyring
  const backend = detectKeyringBackend();

  if (backend === 'secret-tool') {
    try {
      const raw = execFileSync('secret-tool', ['lookup', 'service', service], { timeout: 5_000 });
      const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
      return val || null;
    } catch {
      return null;
    }
  }

  if (backend === 'macos-keychain') {
    try {
      const username = os.userInfo().username;
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', service, '-a', username, '-w'],
        { timeout: 5_000 },
      );
      const val = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
      return val || null;
    } catch {
      return null;
    }
  }

  // env-only — already checked above
  return null;
}

/** Reset cached backend detection (for testing). */
export function _resetBackendCache(): void {
  _cachedBackend = undefined;
}
