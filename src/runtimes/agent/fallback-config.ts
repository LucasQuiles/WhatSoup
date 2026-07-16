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

/** Whether fallback notice and stand-in reply collapse into one user-facing message. */
export function oneMessageHandoffEnabled(): boolean {
  return process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] === '1';
}

/**
 * Reasons whose failover borrows the auth-required control semantics: the
 * revert is gated on a fresh primary probe and same-provider fallbacks are
 * skipped. Empty-output and probe-unusable remain honest first-class reasons
 * while retaining those control effects.
 */
export function fallbackRequiresIndependentProbe(
  reason: string | null | undefined,
): boolean {
  return reason === 'auth-required' || reason === 'empty-output' || reason === 'probe-unusable';
}

/**
 * Resolve the providerConfig an inbound fallback entry should inherit. A
 * fallback into the agent's own provider (or a managed API sibling) inherits the
 * agent's providerConfig; everything else resolves from its own entry config.
 */
export function fallbackProviderConfigFor(
  provider: string | undefined,
  agentProvider: string,
  agentProviderConfig: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (provider === undefined) return undefined;
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
