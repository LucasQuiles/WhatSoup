// src/lib/api-key-resolver.ts
// Shared API-key resolution for HTTP providers (agent OpenAI/Anthropic, chat
// OpenAI). Neutral home in src/lib/ so both the agent runtime and the chat
// runtime can depend on it without either importing the other's internals
// (see src/runtimes/chat/providers/openai.ts).
//
// Resolution order at request time:
//   1. inline apiKey (when non-empty) — caller-supplied
//   2. apiKeyService via lookupCredential() (when service is non-empty)
//   3. process.env[envVar] — last-resort fallback (when allowEnvFallback !== false)
//   4. '' — missing-key signaling is the caller's responsibility
//
// A misconfigured service (lookupCredential returns null/empty) MUST NOT
// fail-fast when the env var still has a usable key — fall through to env.
// The fall-through is deliberate (resilience) but NOT silent: it is logged so a
// configured-service miss that silently uses the global env key — breaking
// per-instance account isolation — is observable to operators (QR-104).
//
// W-3 (Phase C): callers can set `allowEnvFallback: false` to restrict the
// resolver to the keyring only (no env fallback). This is the precedence
// reversal described in docs/security-handoffs/2026-05-09-env-secret-exposure.md
// Phase C: "Env fallback should be explicit and restricted to development/test
// call sites." The default is `true` (backward-compatible) so existing callers
// are unaffected until they opt in.

import { lookupCredential } from './keyring.ts';
import { createChildLogger } from '../logger.ts';

const log = createChildLogger('api-key-resolver');

const CANONICAL_SERVICE_BY_ENV_VAR: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  PINECONE_API_KEY: 'pinecone',
  DEEPSEEK_API_KEY: 'deepseek',
  MINIMAX_API_KEY: 'minimax',
  GEMINI_API_KEY: 'google',
  GOOGLE_API_KEY: 'google',
};

export interface ResolveApiKeyOptions {
  /** Inline API key from caller (typically not used; reserved for future config). */
  inline?: string;
  /** Keyring service name from `providerConfig.apiKeyService`. */
  service?: string;
  /** Conventional env var name to consult as the final fallback. */
  envVar: string;
  /**
   * When `false`, the resolver skips the env-var fallback path and returns ''
   * if no keyring hit is found. Use this in production call sites where env
   * fallback is not desired (W-3 precedence reversal). Default: `true`
   * (backward-compatible — preserves the prior env-fallback behavior).
   */
  allowEnvFallback?: boolean;
}

/**
 * Resolve an API key for an HTTP provider using the precedence chain above.
 * Returns empty string when nothing is configured; callers decide how to surface
 * a missing-key condition (e.g. by omitting the Authorization header).
 */
export function resolveApiKey(opts: ResolveApiKeyOptions): string {
  if (opts.inline && opts.inline.length > 0) {
    return opts.inline;
  }

  // W-3: when env fallback is explicitly disabled, the resolver consults the
  // keyring ONLY. A missing keyring hit returns '' (visible missing-key
  // downstream) rather than silently falling back to the process env.
  const allowEnvFallback = opts.allowEnvFallback !== false;
  const effectiveService = opts.service === undefined
    ? CANONICAL_SERVICE_BY_ENV_VAR[opts.envVar]
    : opts.service;

  if (effectiveService && effectiveService.length > 0) {
    const fromKeyring = lookupCredential(effectiveService);
    if (fromKeyring && fromKeyring.length > 0) {
      return fromKeyring;
    }
    if (!allowEnvFallback) {
      // Keyring miss + env fallback disabled → return '' (no env consultation).
      // This is the W-3 strict mode: the resolver does not read process.env.
      return '';
    }
    // Service set but lookup miss → fall through to env (do not error). Make the
    // fallback OBSERVABLE: warn only when the env fallback actually yields a key
    // (the silent wrong-account case). An absent env yields '' → a visible
    // missing-key condition downstream, which needs no warning.
    const envFallback = process.env[opts.envVar] ?? '';
    if (envFallback.length > 0) {
      log.warn(
        { service: effectiveService, envVar: opts.envVar },
        'apiKeyService configured but keyring lookup missed — falling back to env var; verify account isolation',
      );
    }
    return envFallback;
  }

  // No service configured. If env fallback is disabled and there's no service
  // to look up, return '' — there's nothing to resolve.
  if (!allowEnvFallback) {
    return '';
  }
  return process.env[opts.envVar] ?? '';
}
