// src/fleet/routes/providers.ts
// GET /api/providers — server-side provider catalog (discovery / observability).
//
// The id list is derived from the backend SSOT (PROVIDER_IDS, #447) so this
// route never maintains a second provider-id list. Per-id display metadata
// mirrors the console catalog (console/src/lib/providers.ts) but lives here
// because the console bundles separately and cannot import the backend module.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonResponse } from '../../lib/http.ts';
import { PROVIDER_IDS, type ProviderId } from '../../runtimes/agent/providers/index.ts';

/** Static per-provider display + capability metadata (keyed by ProviderId). */
interface ProviderCatalogMeta {
  displayName: string;
  type: 'cli' | 'api';
  /**
   * Whether the provider type generically requires an API key.
   * - api providers (openai-api, anthropic-api) and opencode-cli: true
   * - native/subscription-auth CLIs (claude-cli, codex-cli, gemini-cli): false
   *
   * NOTE: this is the catalog-level capability flag. It is distinct from the
   * per-instance keyring-service resolution used by the provider-status route,
   * where model prefixes and providerConfig.apiKeyService can change which
   * service is checked.
   */
  needsApiKey: boolean;
}

const PROVIDER_META: Record<ProviderId, ProviderCatalogMeta> = {
  'claude-cli': { displayName: 'Claude CLI', type: 'cli', needsApiKey: false },
  'codex-cli': { displayName: 'Codex', type: 'cli', needsApiKey: false },
  'gemini-cli': { displayName: 'Gemini', type: 'cli', needsApiKey: false },
  'opencode-cli': { displayName: 'OpenCode', type: 'cli', needsApiKey: true },
  'openai-api': { displayName: 'OpenAI', type: 'api', needsApiKey: true },
  'anthropic-api': { displayName: 'Anthropic', type: 'api', needsApiKey: true },
};

/** A single provider entry in the catalog response. */
export interface ProviderCatalogEntry {
  id: ProviderId;
  displayName: string;
  type: 'cli' | 'api';
  needsApiKey: boolean;
  /** Accepted providerConfig keys an operator may set for this provider. */
  providerConfig: string[];
}

/**
 * Accepted providerConfig fields per provider. The default provider
 * (claude-cli) has no overridable providerConfig fields; every other provider
 * accepts a `model` override, and api providers additionally accept `baseUrl`
 * and `apiKeyService`. Mirrors the console field derivation
 * (getProviderConfigFields) without importing the console module.
 */
function providerConfigFields(id: ProviderId, type: 'cli' | 'api'): string[] {
  if (id === 'claude-cli') return [];
  const fields = ['model'];
  if (type === 'api') fields.push('baseUrl', 'apiKeyService');
  return fields;
}

/** Build the provider catalog, deriving the id list from PROVIDER_IDS (SSOT). */
export function buildProviderCatalog(): ProviderCatalogEntry[] {
  return PROVIDER_IDS.map((id) => {
    const meta = PROVIDER_META[id];
    return {
      id,
      displayName: meta.displayName,
      type: meta.type,
      needsApiKey: meta.needsApiKey,
      providerConfig: providerConfigFields(id, meta.type),
    };
  });
}

/** GET /api/providers — return the provider catalog. */
export function handleGetProviders(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 200, buildProviderCatalog());
}
