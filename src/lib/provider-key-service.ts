/**
 * Pure provider→keyring-service mapping. Extracted from keyring.ts so modules
 * with a no-side-effect import constraint (config validator, provider MCP
 * config generation) can consume the single source of truth without pulling
 * the keyring's child_process/logger dependencies into their module graph.
 * keyring.ts re-exports both names — runtime callers keep importing from there.
 */

// Validity-probe coverage: CREDENTIAL_PROBE_DESCRIPTORS in
// src/lib/provider-credential-probes.ts only covers anthropic, deepseek,
// minimax, and openai (endpoints proven to 401/403 on a bad key). Every other
// service below degrades to a presence-only check — the pre-flight returns
// 'unknown' for them, so fallback_credential_invalid can never fire. Adding a
// probe endpoint requires per-provider verification; do not assume parity with
// this map. Full extension checklist (tests that flip, docs to reconcile):
// docs/architecture/provider-credential-services.md.
/**
 * Map service names to their conventional env var names.
 *
 * Fallback-provider entries use opencode's models.dev provider ids as service
 * names (opencode-cli derives the service from the configured model's prefix,
 * e.g. `xai/grok-4` → `xai`) and the env var opencode reads for that provider.
 * Note the catalog ids are `fireworks-ai` and `togetherai` — not `fireworks` /
 * `together` — and `google` accepts GOOGLE_API_KEY (also
 * GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY; we forward the primary).
 */
export const SERVICE_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  glm: 'ZAI_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
  'fireworks-ai': 'FIREWORKS_API_KEY',
  togetherai: 'TOGETHER_API_KEY',
  pinecone: 'PINECONE_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  'whatsoup-health-token': 'WHATSOUP_HEALTH_TOKEN',
  whatsoup_health: 'WHATSOUP_HEALTH_TOKEN',
};

export function resolveProviderKeyService(
  provider: unknown,
  model: unknown,
  providerConfig?: unknown,
): string | null {
  if (providerConfig && typeof providerConfig === 'object' && !Array.isArray(providerConfig)) {
    const service = (providerConfig as Record<string, unknown>)['apiKeyService'];
    if ((provider === 'openai-api' || provider === 'anthropic-api') && typeof service === 'string') {
      if (service.length > 0) return service;
    }
  }
  if (provider === 'opencode-cli') {
    const prefix = typeof model === 'string' ? model.split('/')[0]?.trim() : '';
    return prefix ? prefix.toLowerCase() : null;
  }
  if (provider === 'openai-api') {
    return 'openai';
  }
  if (provider === 'anthropic-api') {
    return 'anthropic';
  }
  return null;
}
