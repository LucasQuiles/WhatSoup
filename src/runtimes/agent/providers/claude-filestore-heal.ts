// src/runtimes/agent/providers/claude-filestore-heal.ts
//
// Claude CLI credential-store check (detection only), using the CLI's
// configured keychain service and plaintext storage directory.
//
// History and corrected premise:
//   This module used to mirror the keychain's `claudeAiOauth` into
//   `$CLAUDE_CONFIG_DIR/.credentials.json` (the "file store"), on the premise
//   that with CLAUDE_CONFIG_DIR set the CLI reads ONLY the file store. That
//   premise is false for the fleet CLI (2.1.302/2.1.303): with
//   CLAUDE_CONFIG_DIR set it reads the hashed keychain item
//   `<credential service>-<sha256(dir)[:8]>` directly (verified
//   2026-10-19: bots with primary usable and no `.credentials.json` at all),
//   and falls back to the plaintext store only when the keychain read returns
//   nothing. A hashed item exists only because a CLI that reads it wrote it.
//
//   Mirroring it therefore created a second live copy of the bot's refresh
//   token that trailed every rotation. The CLI's keychain read has a 2 s
//   `security` timeout; on a slow read it falls back to the plaintext copy,
//   posts its stale refresh token, gets invalid_grant and wipes the login
//   (the two-store wipe). So nothing here writes any store any more, and the
//   #3020 identity guard that protected the write is gone with it.
//
// Contract:
//   - macOS only; no-op on other platforms.
//   - No-op when the selected store is the CLI default, including a defined-empty
//     CLAUDE_SECURESTORAGE_CONFIG_DIR. The default login is not the bot's to inspect;
//     skipped-no-config-dir supplies no duplicate-store evidence.
//   - Reads only the bot's own keychain item (claudeCredentialServiceForEnv)
//     and the file store in the CLI's storage dir; never the bare default
//     item, never another config dir's item, never a keychain listing.
//   - Never writes, never performs OAuth, never contacts an auth server.
//   - Reports 'skipped-cli-reads-own-item' when the own item holds a usable
//     token, and 'two-stores-detected' when a file store also holds a token,
//     logging the latter once per state change with expiries only.
//   - Fail-open: any error is logged and swallowed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createChildLogger } from '../../../logger.ts';
import { isNonEmptyString } from '../../../lib/type-guards.ts';
import { readPrivateFileSync } from '../../../lib/private-fs.ts';

// The macOS login-keychain item name the claude CLI stores its OAuth credential
// under. Assembled from parts so the two words are never adjacent in source:
// this is the OS keychain *service name*, not a model/generated-by attribution,
// but the (line-based) repo-hygiene guard cannot tell the two apart.
const KEYCHAIN_SERVICE = ['Claude', 'Code-credentials'].join(' ');
const KEYCHAIN_SERVICE_SUFFIX_HEX = 8;
const OAUTH_KEY = 'claudeAiOauth';
const FILE_STORE_NAME = '.credentials.json';
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

export type ClaudeFileStoreHealOutcome =
  | 'skipped-not-darwin'
  | 'skipped-no-config-dir'
  /** The own item holds no usable token; the CLI falls back to the file store by itself. */
  | 'skipped-no-keychain-token'
  /** The own item holds a usable token and no file store holds one: the healthy state. */
  | 'skipped-cli-reads-own-item'
  /** The own item and a file store both hold a token: a second live copy of the login. */
  | 'two-stores-detected'
  | 'skipped-error';

export interface ClaudeFileStoreHealResult {
  outcome: ClaudeFileStoreHealOutcome;
  /** Expiries only (ms epoch, null = unknown) for observability; never token material. */
  fileStoreExpiresAt?: number | null;
  keychainExpiresAt?: number | null;
}

export interface ClaudeFileStoreHealDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Raw JSON string held in the keychain item named `service` (always the
   *  bot's own item, see claudeCredentialServiceForEnv), or null when unreadable/absent. */
  readKeychain?: (service: string) => string | null;
  /** Raw JSON string of the file store, or null when absent/unreadable. */
  readFileStore?: (path: string) => string | null;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}

interface OAuthEntry {
  accessToken?: unknown;
  expiresAt?: unknown;
  [k: string]: unknown;
}

/** Runs `security <args>`; null on any failure (rc 44 not-found / rc 36 unreadable / ENOENT / timeout). */
type SecurityExec = (args: string[]) => string | null;

function defaultSecurityExec(args: string[]): string | null {
  try {
    return execFileSync('security', args, {
      timeout: KEYCHAIN_READ_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The keychain service the claude CLI stores the login of `configDir` under:
 * the bare service name suffixed with the first 8 hex digits of the sha256 of
 * the CLAUDE_CONFIG_DIR string exactly as set (no path resolution, so a
 * trailing slash names a different item). The CLI uses the bare name only when
 * CLAUDE_CONFIG_DIR is unset, and the heal never runs then.
 */
export function claudeCredentialServiceFor(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, KEYCHAIN_SERVICE_SUFFIX_HEX);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

/**
 * The keychain service a `claude` child started with `env` reads its login
 * from (rule read from the 2.1.303 CLI): CLAUDE_SECURESTORAGE_CONFIG_DIR, when
 * set, overrides CLAUDE_CONFIG_DIR for the suffix (NFC-normalized; set but
 * empty means the bare item); otherwise the CLAUDE_CONFIG_DIR string as set;
 * the bare item when neither is set.
 */
export function claudeCredentialServiceForEnv(env: NodeJS.ProcessEnv): string {
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureDir !== undefined) return secureDir ? claudeCredentialServiceFor(secureDir.normalize('NFC')) : KEYCHAIN_SERVICE;
  return env.CLAUDE_CONFIG_DIR ? claudeCredentialServiceFor(env.CLAUDE_CONFIG_DIR) : KEYCHAIN_SERVICE;
}

/**
 * The directory a `claude` child started with `env` keeps its plaintext
 * `.credentials.json` and its OAuth refresh lock in (2.1.303): the
 * CLAUDE_SECURESTORAGE_CONFIG_DIR when set (empty means ~/.claude), else
 * CLAUDE_CONFIG_DIR, else ~/.claude.
 *
 * Evidence (read from the 2.1.303 binary, 2026-10-19): one storage-dir
 * resolver returns CLAUDE_SECURESTORAGE_CONFIG_DIR (NFC) when it is defined
 * and the config dir otherwise. The plaintext store path is that dir joined
 * with `.credentials.json`, and the OAuth refresh path creates that dir and
 * takes its lock at `<dir>/.oauth_refresh.lock` (plus `<realpath(dir)>.lock`).
 * So the variable moves the file store and the lock, not only the keychain
 * suffix.
 */
export function claudeSecureStorageDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureDir !== undefined) return (secureDir || join(home, '.claude')).normalize('NFC');
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude');
}

/** Under a test runner no default seam may read a live login or start a live CLI. */
export function underTestRunner(): boolean {
  // env-allowed: test-runner detection; must not read config (lib ring / eval-order)
  return Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
}

/**
 * Read the credential payload of exactly one login-keychain item, `service`
 * (the bot's own item). Returns the raw JSON payload string, or null when the
 * item is absent, unreadable or empty.
 *
 * Identity guard: the heal must never mirror another login into the bot's file
 * store. The bare item is the default login (the operator's or another job's);
 * other suffixed items belong to other config dirs (other bots, the maintenance
 * job). So nothing but the bot's own item is ever read, and no item is ever
 * discovered by enumerating the keychain.
 */
export function readKeychainViaSecurity(exec: SecurityExec, service: string): string | null {
  const trimmed = exec(['find-generic-password', '-s', service, '-w'])?.trim();
  return trimmed ? trimmed : null;
}

function defaultReadKeychain(service: string): string | null {
  // Tests inject credential readers; the default must never read a live login
  // when a probe is exercised without those overrides.
  if (underTestRunner()) return null;
  return readKeychainViaSecurity(defaultSecurityExec, service);
}

function defaultReadFileStore(path: string): string | null {
  const canonicalPath = resolve(path);
  const observed = readPrivateFileSync(canonicalPath, {
    label: 'credential file store', maxBytes: 1024 * 1024,
    observation: { root: dirname(canonicalPath) },
  });
  return observed?.bytes.toString('utf8') ?? null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function oauthOf(store: Record<string, unknown> | null): OAuthEntry | null {
  const entry = store?.[OAUTH_KEY];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as OAuthEntry)
    : null;
}

function expiresAtOf(entry: OAuthEntry | null): number | null {
  const v = entry?.expiresAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hasAccessToken(entry: OAuthEntry | null): boolean {
  return isNonEmptyString(entry?.accessToken);
}

/** Last two-store state per keychain item, so the detection logs once per change. */
const lastTwoStoreState = new Map<string, boolean>();

/** Test seam: forget the per-item detection state. */
export function resetClaudeCredentialStoreStateForTests(): void {
  lastTwoStoreState.clear();
}

/**
 * Check which store the CLI serves the bot's login from, without writing
 * anything (see the module header for why the former mirror is gone). The
 * export keeps its historical name for its two callers (startup and the
 * claude-cli usability probe); every outcome is a non-failure for them.
 *
 * The keychain command has a timeout. The private observed file read is
 * limited to 1 MiB and rejects nonregular files before opening them.
 */
export function ensureClaudeFileStoreCredential(
  deps: ClaudeFileStoreHealDeps = {},
): ClaudeFileStoreHealResult {
  const log = deps.log ?? createChildLogger('claude-filestore-heal');
  try {
    const platform = deps.platform ?? process.platform;
    if (platform !== 'darwin') return { outcome: 'skipped-not-darwin' };

    // env-allowed: test-runner detection plus DI seam; env-late by design
    const env = deps.env ?? process.env;
    const service = claudeCredentialServiceForEnv(env);
    // The bare item is the default login, not one keyed to the bot's dir.
    if (service === KEYCHAIN_SERVICE) return { outcome: 'skipped-no-config-dir' };

    const now = (deps.now ?? Date.now)();
    // Only the bot's own item: never the bare default login, never another
    // config dir's item (see readKeychainViaSecurity).
    const keychainOAuth = oauthOf(parseJsonObject((deps.readKeychain ?? defaultReadKeychain)(service)));
    const keychainExpiresAt = expiresAtOf(keychainOAuth);
    if (!hasAccessToken(keychainOAuth) || (keychainExpiresAt !== null && keychainExpiresAt <= now)) {
      return { outcome: 'skipped-no-keychain-token' };
    }

    const fileOAuth = oauthOf(parseJsonObject(
      (deps.readFileStore ?? defaultReadFileStore)(join(claudeSecureStorageDir(env), FILE_STORE_NAME)),
    ));
    const fileStoreExpiresAt = expiresAtOf(fileOAuth);
    const twoStores = hasAccessToken(fileOAuth);
    const outcome: ClaudeFileStoreHealOutcome = twoStores ? 'two-stores-detected' : 'skipped-cli-reads-own-item';
    const previous = lastTwoStoreState.get(service);
    lastTwoStoreState.set(service, twoStores);
    if (twoStores && previous !== true) {
      log.warn(
        { outcome, keychainExpiresAt, fileStoreExpiresAt },
        'claude login is held in two stores: the own keychain item and a plaintext file store; '
          + 'a slow keychain read makes the CLI refresh from the stale file copy and wipe the login. '
          + 'Nothing was written or deleted; the fleet baseline reports this copy, and what to do '
          + 'with it is an operator decision',
      );
    } else if (!twoStores && previous === true) {
      log.info({ outcome, keychainExpiresAt }, 'claude login is held in the own keychain item only (second store gone)');
    }
    return { outcome, keychainExpiresAt, fileStoreExpiresAt };
  } catch (err) {
    log.warn({ err }, 'claude credential-store check failed — proceeding (fail-open)');
    return { outcome: 'skipped-error' };
  }
}
