/**
 * Pure model→endpoint+key resolver for the background handoff distiller.
 *
 * The distiller summarises an active conversation by calling a small, cheap
 * chat-completions model out-of-band (NOT the agent's primary provider). The
 * model is chosen via WHATSOUP_HANDOFF_DISTILL_MODEL; this module maps that
 * model id to the concrete {provider, endpoint, apiKey} needed to issue the
 * OpenAI-compatible chat-completions request, reading the key from the
 * provider's conventional env var (the single source of truth in
 * {@link SERVICE_ENV_MAP}).
 *
 * Pure over an explicit `env` so the resolution is unit-testable without
 * touching process.env. Returns null when the model is unknown OR no key is
 * present — the caller treats null as "enabled but inert" and does NOT arm the
 * sweep timer, so a misconfigured/keyless distiller is a silent no-op rather
 * than a per-tick failure.
 *
 * Endpoint note: CREDENTIAL_PROBE_DESCRIPTORS (src/lib/provider-credential-probes.ts)
 * are `/models` probe URLs; the distiller needs the chat-completions URL, so
 * the endpoints below are defined here independently (deepseek/minimax/z.ai
 * chat surfaces).
 */

import { SERVICE_ENV_MAP } from '../../lib/provider-key-service.ts';

export interface ResolvedDistillModel {
  /** Logical provider id (used for the artifact's source_provider). */
  provider: string;
  /** The literal model id sent in the chat-completions request body. */
  model: string;
  endpoint: string;
  apiKey: string;
}

/** Internal: provider id → chat-completions endpoint. */
const CHAT_ENDPOINTS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/chat/completions',
  minimax: 'https://api.minimax.io/v1/text/chatcompletion_v2',
  zai: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
};

/**
 * Classify a model id to a provider id by prefix/substring. Returns null for
 * unrecognised models. Case-insensitive.
 */
function providerForModel(modelId: string): string | null {
  const m = modelId.trim().toLowerCase();
  if (!m) return null;
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('minimax')) return 'minimax';
  // GLM / Z.ai coding models (e.g. glm-5.2, zai/...).
  if (m.startsWith('glm') || m.startsWith('zai') || m.startsWith('z.ai')) return 'zai';
  return null;
}

/** Env var name for a provider id. z.ai keys live under the catalog key 'zai'. */
function envVarForProvider(provider: string): string | null {
  if (provider === 'zai') return 'ZAI_API_KEY';
  return SERVICE_ENV_MAP[provider] ?? null;
}

/**
 * Resolve a distill model id to {provider, endpoint, apiKey}, or null when the
 * model is unknown or no API key is present in `env`.
 */
export function resolveDistillModel(
  modelId: string | null | undefined,
  env: Record<string, string | undefined>,
): ResolvedDistillModel | null {
  if (!modelId || !modelId.trim()) return null;
  const provider = providerForModel(modelId);
  if (!provider) return null;
  const endpoint = CHAT_ENDPOINTS[provider];
  if (!endpoint) return null;
  const envVar = envVarForProvider(provider);
  if (!envVar) return null;
  const apiKey = env[envVar]?.trim();
  if (!apiKey) return null;
  return { provider, model: modelId.trim(), endpoint, apiKey };
}
