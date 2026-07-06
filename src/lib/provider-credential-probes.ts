// src/lib/provider-credential-probes.ts
//
// Single source of truth for credential VALIDITY probes. Given a keyring
// service name (SERVICE_ENV_MAP key, provider-key-service.ts), describes how
// to ask that service's upstream "is this key still good?" Two call sites
// consume this map — the agent runtime's fallback arm-time pre-flight
// (src/runtimes/agent/providers/credential-verify.ts) and the fleet's
// POST /api/credentials/:service/verify route (src/fleet/routes/providers.ts,
// consumed by src/fleet/routes/credentials.ts) — so the same key answers the
// same validity question the same way regardless of which path asks.
//
// Qualification rule: only an endpoint PROVEN to return 401/403 on a bad key
// belongs here — a mute probe (200 regardless of key) fails open forever.
// OpenRouter and NVIDIA serve GET /models publicly, so neither qualifies. See
// docs/architecture/provider-credential-services.md for the full extension
// checklist.
//
// Pure, no side effects, no network calls — never add fetch/logging here.

/** Typed auth schemes — never interpolated from free-form config. */
export type CredentialProbeAuth = 'bearer' | 'x-api-key';

export interface CredentialProbeDescriptor {
  /** https literal — never derived from config or request input (no SSRF). */
  url: string;
  method: 'GET' | 'POST';
  auth: CredentialProbeAuth;
  /** Static extra headers some providers require (e.g. anthropic-version). */
  extraHeaders?: Record<string, string>;
  /** JSON body for POST-shaped probes; omitted entirely for GET. */
  body?: unknown;
}

/**
 * Keyed by keyring SERVICE name (matches SERVICE_ENV_MAP), not provider id.
 * Qualification evidence (invalid test key, 2026-07-03/07-05): all four probe
 * endpoints below return 401 cleanly on a bad key.
 */
export const CREDENTIAL_PROBE_DESCRIPTORS: Record<string, CredentialProbeDescriptor> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    method: 'GET',
    auth: 'x-api-key',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
  },
  deepseek: {
    url: 'https://api.deepseek.com/models',
    method: 'GET',
    auth: 'bearer',
  },
  minimax: {
    url: 'https://api.minimax.io/v1/models',
    method: 'GET',
    auth: 'bearer',
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    method: 'GET',
    auth: 'bearer',
  },
};

/** Sorted service keys this map has a validity probe for. */
export function credentialProbeServices(): string[] {
  return Object.keys(CREDENTIAL_PROBE_DESCRIPTORS).sort();
}
