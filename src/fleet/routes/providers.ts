// src/fleet/routes/providers.ts
// GET /api/providers — server-side provider catalog (discovery / observability).
//
// The id list is derived from the backend SSOT (PROVIDER_IDS, #447) so this
// route never maintains a second provider-id list. Picker display/capability
// metadata lives here so remote clients consume the server's current contract;
// console-local metadata remains only for non-picker presentation.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { systemClock } from '../../lib/clock.ts';
import { jsonResponse } from '../../lib/http.ts';
import type { ProviderCatalogEntry } from '../../lib/provider-catalogue-contract.d.ts';
import { PROVIDER_IDS, isProviderId, type ProviderId } from '../../runtimes/agent/providers/index.ts';
import { resolveModelCatalogue } from '../../runtimes/agent/model-catalogue-resolver.ts';
import { getProviderBinary } from '../../runtimes/agent/session.ts';
import {
  CREDENTIAL_PROBE_DESCRIPTORS,
  type CredentialProbeDescriptor,
} from '../../lib/provider-credential-probes.ts';

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
  /** Keyring service this provider's key lives under (null = native auth). */
  credentialService: string | null;
}

const PROVIDER_META: Record<ProviderId, ProviderCatalogMeta> = {
  'claude-cli':    { displayName: 'Claude CLI', type: 'cli', needsApiKey: false, credentialService: null },
  'codex-cli':     { displayName: 'Codex',      type: 'cli', needsApiKey: false, credentialService: null },
  'gemini-cli':    { displayName: 'Gemini',     type: 'cli', needsApiKey: false, credentialService: null },
  // opencode-cli resolves its service from the model prefix at runtime
  // (deepseek/minimax — see resolveProviderKeyService); the catalog advertises null
  // and the console offers the full allowlist for opencode fallback models.
  'opencode-cli':  { displayName: 'OpenCode',   type: 'cli', needsApiKey: true,  credentialService: null },
  'openai-api':    { displayName: 'OpenAI',     type: 'api', needsApiKey: true,  credentialService: 'openai' },
  'anthropic-api': { displayName: 'Anthropic',  type: 'api', needsApiKey: true,  credentialService: 'anthropic' },
};

export type {
  ProviderCatalogEntry,
  ProviderModelsListing,
} from '../../lib/provider-catalogue-contract.d.ts';

/**
 * General-console providerConfig fields per provider. Advanced runtime-only
 * keys are intentionally outside this form surface. The default provider has
 * no fields here; every other provider exposes `model`, API providers also
 * expose `baseUrl` and `apiKeyService`, and the Anthropic adapter exposes
 * `maxTokens`. The browser renders this server-owned list rather than deriving
 * its own provider-specific field set.
 */
function providerConfigFields(id: ProviderId, type: 'cli' | 'api'): string[] {
  if (id === 'claude-cli') return [];
  const fields = ['model'];
  if (type === 'api') fields.push('baseUrl', 'apiKeyService');
  if (id === 'anthropic-api') fields.push('maxTokens');
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
      credentialService: meta.credentialService,
      providerConfig: providerConfigFields(id, meta.type),
    };
  });
}

/** Typed auth schemes — never interpolated from strings. Alias of the shared probe module's shape. */
export type VerifyAuth = CredentialProbeDescriptor['auth'];
export type VerifyDescriptor = CredentialProbeDescriptor;

/**
 * Keyed by KEYRING SERVICE (not provider id) — verify is a fleet-level,
 * key-centric operation. Re-exports the shared credential-probe SSOT
 * (src/lib/provider-credential-probes.ts) so this route and the agent
 * runtime's arm-time pre-flight (credential-verify.ts) answer "is this key
 * valid?" identically — see tests/fleet/credential-probe-lists.test.ts. A
 * service absent from the shared map yields verify status 'unsupported'.
 */
export const PROVIDER_VERIFY_DESCRIPTORS: Record<string, VerifyDescriptor> = CREDENTIAL_PROBE_DESCRIPTORS;

/** GET /api/providers — return the provider catalog. */
export function handleGetProviders(_req: IncomingMessage, res: ServerResponse): void {
  jsonResponse(res, 200, buildProviderCatalog());
}

export interface ProviderModelsDeps {
  resolveModelCatalogue: typeof resolveModelCatalogue;
  getProviderBinary: typeof getProviderBinary;
  nowMs: () => number;
}

const DEFAULT_PROVIDER_MODELS_DEPS: ProviderModelsDeps = {
  resolveModelCatalogue,
  getProviderBinary,
  nowMs: () => systemClock.now(),
};

/** GET /api/providers/:name/models — return the provider-native live catalogue.
 * Unknown execution providers are rejected before any probe. Managed-loop API
 * providers do not have a binary, so their validated provider id is passed as
 * the unused resolver discriminator rather than inventing a command. */
export async function handleGetProviderModels(
  _req: IncomingMessage,
  res: ServerResponse,
  params: { name: string },
  deps: ProviderModelsDeps = DEFAULT_PROVIDER_MODELS_DEPS,
): Promise<void> {
  if (!isProviderId(params.name)) {
    jsonResponse(res, 404, { error: `unknown provider '${params.name}'` });
    return;
  }

  const binary = deps.getProviderBinary(params.name) ?? params.name;
  const listing = await deps.resolveModelCatalogue(params.name, binary, { nowMs: deps.nowMs() });
  jsonResponse(res, 200, listing);
}
