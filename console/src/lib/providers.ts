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
//  Display metadata (names, colors, placeholders) stays console-local in
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

// Precomputed maps for O(1) lookups and stable references
const _providerMap = new Map<string, ProviderDef>(PROVIDERS.map(p => [p.id, p]));
const _configFieldsCache = new Map<string, ConfigFieldDef[]>();

export function getProvider(id: string): ProviderDef | undefined {
  return _providerMap.get(id);
}

/** Config fields for the UI per provider. Default provider returns [] (handled by existing agentOptions UI). */
export function getProviderConfigFields(providerId: string): ConfigFieldDef[] {
  const cached = _configFieldsCache.get(providerId);
  if (cached) return cached;

  const provider = getProvider(providerId);
  if (!provider || providerId === DEFAULT_PROVIDER_ID) {
    const empty: ConfigFieldDef[] = [];
    _configFieldsCache.set(providerId, empty);
    return empty;
  }

  const fields: ConfigFieldDef[] = [];
  fields.push({ key: 'model', label: 'Model', placeholder: modelPlaceholder(providerId), inputType: 'text' });

  if (provider.type === 'api') {
    fields.push({ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1', inputType: 'text' });
    fields.push({ key: 'apiKeyService', label: 'Keyring Service', placeholder: 'openai', inputType: 'text' });
  }

  if (providerId === 'anthropic-api') {
    fields.push({ key: 'maxTokens', label: 'Max Tokens', placeholder: '16384', inputType: 'number' });
  }

  _configFieldsCache.set(providerId, fields);
  return fields;
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

function modelPlaceholder(providerId: string): string {
  switch (providerId) {
    case 'codex-cli':     return 'gpt-5.4';
    case 'gemini-cli':    return 'gemini-2.5-pro';
    case 'opencode-cli':  return 'claude-sonnet-4-6';
    case 'openai-api':    return 'gpt-4o';
    case 'anthropic-api': return 'claude-sonnet-4-6';
    default:              return '';
  }
}
