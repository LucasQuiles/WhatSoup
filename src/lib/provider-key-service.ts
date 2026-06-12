/**
 * Pure provider→keyring-service mapping. Extracted from keyring.ts so modules
 * with a no-side-effect import constraint (config validator, provider MCP
 * config generation) can consume the single source of truth without pulling
 * the keyring's child_process/logger dependencies into their module graph.
 * keyring.ts re-exports both names — runtime callers keep importing from there.
 */

// Probe URLs for fallback credential pre-flight live in src/runtimes/agent/providers/credential-verify.ts (PROBE_ENDPOINTS) — keep services in sync.
/** Map service names to their conventional env var names. */
export const SERVICE_ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
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
