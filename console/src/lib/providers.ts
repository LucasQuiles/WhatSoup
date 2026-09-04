// ---------------------------------------------------------------------------
//  Provider constants — ID list shared with the backend registry.
//
//  Single source of truth for provider IDs (shared JSON, imported here AND
//  by the backend registry src/runtimes/agent/providers/index.ts, #447):
//    src/lib/provider-ids.json
//
//  Backend descriptor shape:
//    src/runtimes/agent/providers/types.ts → ProviderDescriptor
//
//  Non-picker display metadata (names and colors) stays console-local in
//  PROVIDER_META below. A backend ID without metadata still renders (the ID
//  doubles as its display name) so the console can never *omit* a provider
//  the backend accepts — the drift guard
//  tests/console/provider-catalog-drift.test.ts pins the ID lists together.
// ---------------------------------------------------------------------------

import providerIdsJson from '../../../src/lib/provider-ids.json';
import type { ProviderId } from '../../../src/lib/provider-ids.ts';
import { PROVIDER_API_KEY_SERVICES } from '../../../src/lib/provider-key-service.ts';

const PROVIDER_IDS = providerIdsJson as readonly ProviderId[];

export interface ProviderDef {
  id: ProviderId;
  displayName: string;
  shortName: string;
  type: 'cli' | 'api';
}

export interface ConfigFieldDef {
  key: string;
  label: string;
  placeholder: string;
  inputType: 'text' | 'number';
}

export const DEFAULT_PROVIDER_ID: ProviderId = 'claude-cli';

export const CHAT_API_KEY_SERVICE_OPTIONS: readonly string[] = Array.from(PROVIDER_API_KEY_SERVICES);

/** Console-local display metadata; membership and order come from the JSON. */
const PROVIDER_META: ProviderDef[] = [
  { id: 'claude-cli',    displayName: 'Claude Code',    shortName: 'Claude',    type: 'cli' },
  { id: 'codex-cli',     displayName: 'Codex',          shortName: 'CDX',       type: 'cli' },
  { id: 'gemini-cli',    displayName: 'Gemini',         shortName: 'Gemini',    type: 'cli' },
  { id: 'opencode-cli',  displayName: 'OpenCode',       shortName: 'OC',        type: 'cli' },
  { id: 'openai-api',    displayName: 'OpenAI',         shortName: 'OAI',       type: 'api' },
  { id: 'anthropic-api', displayName: 'Anthropic',      shortName: 'Anth',      type: 'api' },
];

const _metaById = new Map<string, ProviderDef>(PROVIDER_META.map((p) => [p.id, p]));

export const PROVIDERS: ProviderDef[] = PROVIDER_IDS.map(
  (id) =>
    _metaById.get(id) ?? {
      // New backend ID without console metadata yet: degrade gracefully
      // rather than hide a provider the backend accepts. The `-api` suffix
      // convention is part of the canonical ID format (see backend registry
      // header).
      id,
      displayName: id,
      shortName: id,
      type: id.endsWith('-api') ? 'api' : 'cli',
    },
);

// Precomputed map for O(1) lookups and stable references
const _providerMap = new Map<string, ProviderDef>(PROVIDERS.map(p => [p.id, p]));

const CONFIG_FIELD_META: Readonly<Record<string, ConfigFieldDef>> = {
  model: { key: 'model', label: 'Model', placeholder: 'Runtime default, or type a model ID', inputType: 'text' },
  baseUrl: { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1', inputType: 'text' },
  apiKeyService: { key: 'apiKeyService', label: 'Keyring Service', placeholder: 'openai', inputType: 'text' },
  maxTokens: { key: 'maxTokens', label: 'Max Tokens', placeholder: '16384', inputType: 'number' },
};

export function getProvider(id: string): ProviderDef | undefined {
  return _providerMap.get(id);
}

/**
 * Config controls for a provider. A server-advertised key list wins so a new
 * adapter does not require another console option table. The local derivation
 * remains a render fallback while the provider catalogue is loading.
 */
export function getProviderConfigFields(
  providerId: string,
  advertisedFields?: readonly string[],
): ConfigFieldDef[] {
  if (advertisedFields) {
    return advertisedFields.map((key) => CONFIG_FIELD_META[key] ?? {
      key,
      label: key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' '),
      placeholder: key,
      inputType: 'text',
    });
  }
  const provider = getProvider(providerId);
  if (!provider || providerId === DEFAULT_PROVIDER_ID) {
    return [];
  }

  const keys = ['model'];

  if (provider.type === 'api') {
    keys.push('baseUrl', 'apiKeyService');
  }

  if (providerId === 'anthropic-api') {
    keys.push('maxTokens');
  }

  return keys.map((key) => CONFIG_FIELD_META[key]);
}

export type ProviderColor = Readonly<{ stroke: string; fill: string }>;

const UNKNOWN_PROVIDER_COLOR: ProviderColor = {
  stroke: 'var(--provider-unknown)',
  fill: 'var(--text-3)',
};

export const PROVIDER_COLORS: Readonly<Record<ProviderId, ProviderColor>> = {
  'claude-cli':    { stroke: 'var(--provider-claude-fg)',    fill: 'var(--provider-claude-fg)' },
  'codex-cli':     { stroke: 'var(--provider-codex-fg)',     fill: 'var(--provider-codex-fg)' },
  'gemini-cli':    { stroke: 'var(--provider-gemini-fg)',    fill: 'var(--provider-gemini-fg)' },
  'openai-api':    { stroke: 'var(--provider-openai-fg)',    fill: 'var(--provider-openai-fg)' },
  'anthropic-api': { stroke: 'var(--provider-anthropic-fg)', fill: 'var(--provider-anthropic-fg)' },
  'opencode-cli':  { stroke: 'var(--provider-opencode-fg)',  fill: 'var(--provider-opencode-fg)' },
};

function isKnownProviderId(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

export function getProviderColor(id: string): ProviderColor {
  return isKnownProviderId(id) ? PROVIDER_COLORS[id] : UNKNOWN_PROVIDER_COLOR;
}
