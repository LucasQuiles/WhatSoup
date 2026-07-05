// src/runtimes/agent/providers/credential-verify.ts
// Validity probe for fallback provider credentials.
//
// Probes whether a given API key actually authenticates against its upstream
// service. This is distinct from key PRESENCE (handled by the keyring); a key
// can be present but revoked, expired, or rotated.
//
// Fail-open contract: anything other than a definitive 401/403 response is
// returned as 'unknown', so transient network errors or unexpected status codes
// never block fallback selection or raise a false alarm. The key is never
// included in log output.

import {
  CREDENTIAL_PROBE_DESCRIPTORS,
  type CredentialProbeDescriptor,
} from '../../../lib/provider-credential-probes.ts';

export type CredentialVerifyResult = 'valid' | 'invalid' | 'unknown';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Build the fetch init for `descriptor`: the typed auth header (bearer or
 * x-api-key, plus any static extraHeaders), the descriptor's method, and a
 * JSON body only when the descriptor declares one.
 */
function buildProbeInit(descriptor: CredentialProbeDescriptor, key: string): RequestInit {
  const headers: Record<string, string> = { ...descriptor.extraHeaders };
  if (descriptor.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
  else headers['x-api-key'] = key;
  const init: RequestInit = {
    method: descriptor.method,
    headers,
    // A 3xx must abort, not forward the auth header to the redirect target
    // (#1056); matches the convention in fleet/routes/credentials.ts.
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  };
  if (descriptor.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(descriptor.body);
  }
  return init;
}

/**
 * Probe whether `key` actually authenticates against `service`. The probe
 * target and auth shape come from CREDENTIAL_PROBE_DESCRIPTORS
 * (src/lib/provider-credential-probes.ts) — the shared SSOT also consumed by
 * the fleet /verify route, so both paths answer "is this key valid?"
 * identically. Services without an entry there get no validity probe: this
 * degrades to a presence-only check.
 * Fail-open: anything other than a definitive 401/403 is 'unknown', so network
 * flakiness never blocks fallback or raises a false alarm. Never logs the key.
 */
export async function verifyFallbackCredential(
  service: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialVerifyResult> {
  const descriptor = CREDENTIAL_PROBE_DESCRIPTORS[service];
  if (!descriptor) return 'unknown';
  try {
    const res = await fetchImpl(descriptor.url, buildProbeInit(descriptor, key));
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (res.ok) return 'valid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
