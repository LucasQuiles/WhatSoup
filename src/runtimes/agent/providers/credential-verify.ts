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

export type CredentialVerifyResult = 'valid' | 'invalid' | 'unknown';

// WhatSoup never configures opencode provider baseUrls (opencode resolves its
// own endpoints), so probe targets are hardcoded. Only endpoints PROVEN to
// return 401/403 on a bad key belong here (a mute probe fails open forever).
// Qualification evidence (2026-07-03, invalid test key): groq, openrouter,
// and nvidia all 401 cleanly on POST chat/completions, but GET /models is
// PUBLIC (HTTP 200 regardless of key) on openrouter and nvidia — only groq's
// /models discriminates. A /models-shaped probe for a public-catalog endpoint
// never detects a bad key. Record the 401/403 proof in
// docs/specs/2026-07-03-openai-compatible-byok-providers-design.md before
// adding an entry.
// This is deliberately a SUBSET of SERVICE_ENV_MAP in
// src/lib/provider-key-service.ts (re-exported by src/lib/keyring.ts):
// services without an entry here get no validity probe — verifyFallbackCredential
// returns 'unknown' and the pre-flight degrades to a presence-only check.
const PROBE_ENDPOINTS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/models',
  minimax: 'https://api.minimax.io/v1/models',
  openai: 'https://api.openai.com/v1/models',
};

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe whether `key` actually authenticates against `service`.
 * Fail-open: anything other than a definitive 401/403 is 'unknown', so network
 * flakiness never blocks fallback or raises a false alarm. Never logs the key.
 */
export async function verifyFallbackCredential(
  service: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CredentialVerifyResult> {
  const url = PROBE_ENDPOINTS[service];
  if (!url) return 'unknown';
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
      // A 3xx must abort, not forward the bearer header to the redirect target
      // (#1056); matches the convention in fleet/routes/credentials.ts.
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    if (res.ok) return 'valid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
