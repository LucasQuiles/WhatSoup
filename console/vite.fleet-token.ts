import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface FleetTokenReaderOptions {
  warn?: (message: string) => void;
}

function validToken(value: unknown): string {
  return typeof value === 'string' && TOKEN_RE.test(value) ? value : '';
}

/**
 * Read the Vite dev-proxy fleet token, preferring the rotatable
 * fleet-tokens.json structure (`{active, accept[], rotatedAt}`) and falling
 * back to the legacy single-token file. If neither yields a usable token,
 * emit a single warning so a missing/malformed credential is not silently
 * masked by a header-less proxy.
 */
export function readFleetTokenForDevProxy(
  // Mirrors xdgDir('XDG_CONFIG_HOME', '.config') in src/fleet/paths.ts — the
  // fleet-path SSOT — which the console tree cannot import across the package
  // boundary. Empty-string XDG_CONFIG_HOME falls back, matching the SSOT.
  configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  options: FleetTokenReaderOptions = {},
): string {
  const warn = options.warn ?? defaultWarn;
  const dir = join(configRoot, 'whatsoup');
  const currentPath = join(dir, 'fleet-tokens.json');
  const legacyPath = join(dir, 'fleet-token');

  if (existsSync(currentPath)) {
    try {
      const parsed = JSON.parse(readFileSync(currentPath, 'utf-8')) as Record<string, unknown>;
      const token = validToken(parsed.active);
      if (token) return token;
      warn(
        `[whatsoup] fleet-tokens.json present at ${currentPath} but \`active\` is missing or malformed; dev proxy will omit Authorization header.`,
      );
      return '';
    } catch (err) {
      warn(
        `[whatsoup] failed to parse fleet-tokens.json at ${currentPath} (${(err as Error).message}); dev proxy will omit Authorization header.`,
      );
      return '';
    }
  }

  if (existsSync(legacyPath)) {
    try {
      const token = validToken(readFileSync(legacyPath, 'utf-8').trim());
      if (token) return token;
      warn(
        `[whatsoup] legacy fleet-token at ${legacyPath} is empty or malformed; dev proxy will omit Authorization header.`,
      );
      return '';
    } catch (err) {
      warn(
        `[whatsoup] failed to read legacy fleet-token at ${legacyPath} (${(err as Error).message}); dev proxy will omit Authorization header.`,
      );
      return '';
    }
  }

  warn(
    `[whatsoup] no fleet-tokens.json or legacy fleet-token under ${dir}; dev proxy will omit Authorization header.`,
  );
  return '';
}

let warnedKeys = new Set<string>();
function defaultWarn(message: string): void {
  // De-dupe identical warnings across rapid per-request reads so a single
  // missing-token state doesn't spam the Vite logger.
  if (warnedKeys.has(message)) return;
  warnedKeys.add(message);
  const logger: { warn: (msg: string) => void } = console;
  logger.warn(message);
}

// Exposed for tests that want to reset de-dupe state.
export function __resetFleetTokenWarnCache(): void {
  warnedKeys = new Set<string>();
}
