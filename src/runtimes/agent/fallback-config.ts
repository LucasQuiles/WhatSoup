/**
 * fallback-config.ts — provider-config resolution + credential presence for the
 * provider-fallback subsystem.
 *
 * First seam of the BEAD-FALLBACKCORE-6 decomposition: these are pure functions
 * of the agent's own provider identity/config (no `this`, no window state), so
 * they lift cleanly out of AgentRuntime ahead of the densely-woven window /
 * probe-recovery core. AgentRuntime threads its `agentProvider` /
 * `agentProviderConfig` in; `fallbackKeyPresent` stays as a thin AgentRuntime
 * delegator (it has direct test coverage) that forwards here.
 */
import { lookupCredential, resolveProviderKeyService } from '../../lib/keyring.ts';

/**
 * Resolve the providerConfig a fallback execution should receive. OpenCode
 * fallbacks inherit all shared settings except the primary route's custom
 * endpoint fields; those fields would select the primary credential lane and
 * suppress the fallback entry's model argument. Same-provider native routes
 * and managed API siblings keep full inheritance.
 */
export function fallbackProviderConfigFor(
  provider: string | undefined,
  agentProvider: string,
  agentProviderConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (provider === undefined) return undefined;
  if (provider === 'opencode-cli') {
    if (!agentProviderConfig) return undefined;
    const { baseUrl: _baseUrl, apiKeyService: _apiKeyService, ...rest } = agentProviderConfig;
    return rest;
  }
  if (provider === agentProvider) return agentProviderConfig;
  if (provider === 'openai-api' || provider === 'anthropic-api') return agentProviderConfig;
  return undefined;
}

/**
 * Whether the credential for a fallback provider/model is present. Returns
 * `null` when no key service maps (nothing to check). Never logs the value.
 */
export function fallbackKeyPresent(
  provider: string | undefined,
  model: string | undefined,
  agentProvider: string,
  agentProviderConfig: Record<string, unknown> | undefined,
): boolean | null {
  const service = resolveProviderKeyService(
    provider,
    model,
    fallbackProviderConfigFor(provider, agentProvider, agentProviderConfig),
  );
  if (!service) return null;
  return lookupCredential(service) !== null;
}
