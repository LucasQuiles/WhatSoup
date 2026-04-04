// ---------------------------------------------------------------------------
//  Provider constants — hardcoded to match backend ProviderDescriptors
//  See: src/runtimes/agent/providers/types.ts
// ---------------------------------------------------------------------------

export interface ProviderDef {
  id: string;
  displayName: string;
  type: 'cli' | 'api';
}

export interface ConfigFieldDef {
  key: string;
  label: string;
  placeholder: string;
  inputType: 'text' | 'number';
}

export const DEFAULT_PROVIDER_ID = 'claude-cli';

export const PROVIDERS: ProviderDef[] = [
  { id: 'claude-cli',    displayName: 'Claude Code',    type: 'cli' },
  { id: 'codex-cli',     displayName: 'Codex CLI',      type: 'cli' },
  { id: 'gemini-cli',    displayName: 'Gemini CLI',     type: 'cli' },
  { id: 'opencode-cli',  displayName: 'OpenCode',       type: 'cli' },
  { id: 'openai-api',    displayName: 'OpenAI API',     type: 'api' },
  { id: 'anthropic-api', displayName: 'Anthropic API',  type: 'api' },
];

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
