import { createChildLogger } from '../../../logger.ts';
import {
  ensureClaudeFileStoreCredential,
  type ClaudeFileStoreHealDeps,
  type ClaudeFileStoreHealResult,
} from './claude-filestore-heal.ts';
import {
  verifyClaudeAccountIdentity,
  type AccountIdentityVerification,
} from './claude-account-identity.ts';

export interface ExpectedAccountHealOptions {
  expectedAccountDigest: string | null;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  heal?: (deps: ClaudeFileStoreHealDeps) => ClaudeFileStoreHealResult;
  healDeps?: ClaudeFileStoreHealDeps;
  observeNativeIdentity?: (
    expectedDigest: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<AccountIdentityVerification>;
}

export function nativeCredentialStoreEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CLAUDE_CONFIG_DIR: _omitted, ...nativeEnv } = env;
  return nativeEnv;
}

async function observeNativeIdentity(
  expectedDigest: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<AccountIdentityVerification> {
  return verifyClaudeAccountIdentity(expectedDigest, { env }, signal);
}

/**
 * The file-store heal owns the credential write. This wrapper converts the
 * ratified digest into its verifier callback by observing the native store
 * with CLAUDE_CONFIG_DIR removed. A digest is never used as an account ID.
 */
export async function ensureClaudeFileStoreCredentialForExpectedAccount(
  options: ExpectedAccountHealOptions,
): Promise<ClaudeFileStoreHealResult> {
  const log = options.healDeps?.log ?? createChildLogger('claude-filestore-heal');
  const heal = options.heal ?? ensureClaudeFileStoreCredential;
  // env-allowed: native credential verification observes the current credential-store environment.
  const env = options.env ?? options.healDeps?.env ?? process.env;
  const base: ClaudeFileStoreHealDeps = { ...options.healDeps, env };
  if (options.expectedAccountDigest === null) return heal(base);

  let verdict: boolean | null = null;
  try {
    const verification = await (options.observeNativeIdentity ?? observeNativeIdentity)(
      options.expectedAccountDigest,
      nativeCredentialStoreEnv(env),
      options.signal,
    );
    verdict = verification.status === 'match' ? true : verification.status === 'mismatch' ? false : null;
  } catch (error) {
    log.warn({ error }, 'native-store account identity could not be verified before credential heal');
  }

  return heal({
    ...base,
    expectedAccountDigest: options.expectedAccountDigest,
    verifyAccountDigest: () => verdict,
  });
}
