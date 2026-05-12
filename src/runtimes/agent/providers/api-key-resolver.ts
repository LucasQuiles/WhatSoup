// src/runtimes/agent/providers/api-key-resolver.ts
// Shared API-key resolution for HTTP agent providers (OpenAI, Anthropic).
//
// Resolution order at request time:
//   1. inline apiKey (when non-empty) — caller-supplied
//   2. apiKeyService via lookupCredential() (when service is non-empty)
//   3. process.env[envVar] — last-resort fallback, preserves prior behavior
//   4. '' — missing-key signaling is the caller's responsibility
//
// A misconfigured service (lookupCredential returns null/empty) MUST NOT
// fail-fast when the env var still has a usable key — fall through silently.

import { lookupCredential } from '../../../lib/keyring.ts';

export interface ResolveApiKeyOptions {
  /** Inline API key from caller (typically not used; reserved for future config). */
  inline?: string;
  /** Keyring service name from `providerConfig.apiKeyService`. */
  service?: string;
  /** Conventional env var name to consult as the final fallback. */
  envVar: string;
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

  if (opts.service && opts.service.length > 0) {
    const fromKeyring = lookupCredential(opts.service);
    if (fromKeyring && fromKeyring.length > 0) {
      return fromKeyring;
    }
    // Service set but lookup miss → fall through to env (do not error).
  }

  return process.env[opts.envVar] ?? '';
}
