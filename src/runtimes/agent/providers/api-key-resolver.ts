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
// fail-fast when the env var still has a usable key — fall through to env.
// The fall-through is deliberate (resilience) but NOT silent: it is logged so a
// configured-service miss that silently uses the global env key — breaking
// per-instance account isolation — is observable to operators (QR-104).

import { lookupCredential } from '../../../lib/keyring.ts';
import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('api-key-resolver');

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
    // Service set but lookup miss → fall through to env (do not error). Make the
    // fallback OBSERVABLE: warn only when the env fallback actually yields a key
    // (the silent wrong-account case). An absent env yields '' → a visible
    // missing-key condition downstream, which needs no warning.
    const envFallback = process.env[opts.envVar] ?? '';
    if (envFallback.length > 0) {
      log.warn(
        { service: opts.service, envVar: opts.envVar },
        'apiKeyService configured but keyring lookup missed — falling back to env var; verify account isolation',
      );
    }
    return envFallback;
  }

  return process.env[opts.envVar] ?? '';
}
