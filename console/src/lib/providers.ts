// ---------------------------------------------------------------------------
//  Provider constants — hardcoded to match backend ProviderDescriptors
//  See: src/runtimes/agent/providers/types.ts
// ---------------------------------------------------------------------------

export type ProviderId = string;

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

export const PROVIDERS: ProviderDef[] = [
  { id: 'claude-cli',    displayName: 'Claude Code',    type: 'cli' },
  { id: 'codex-cli',     displayName: 'Codex CLI',      type: 'cli' },
  { id: 'gemini-cli',    displayName: 'Gemini CLI',     type: 'cli' },
  { id: 'opencode-cli',  displayName: 'OpenCode',       type: 'cli' },
  { id: 'openai-api',    displayName: 'OpenAI API',     type: 'api' },
  { id: 'anthropic-api', displayName: 'Anthropic API',  type: 'api' },
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find(p => p.id === id);
}

/** Config fields that appear in the UI for a given provider. claude-cli needs none (handled by existing UI). */
export function getProviderConfigFields(providerId: string): ConfigFieldDef[] {
  const provider = getProvider(providerId);
  if (!provider) return [];

  // claude-cli is the default — its config is handled by existing agentOptions UI
  if (providerId === 'claude-cli') return [];

  const fields: ConfigFieldDef[] = [];

  // All non-default providers get a model field
  fields.push({ key: 'model', label: 'Model', placeholder: modelPlaceholder(providerId), inputType: 'text' });

  // API providers get additional fields
  if (provider.type === 'api') {
    fields.push({ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.openai.com/v1', inputType: 'text' });
    fields.push({ key: 'apiKeyService', label: 'Keyring Service', placeholder: 'openai', inputType: 'text' });
  }

  // Anthropic-specific
  if (providerId === 'anthropic-api') {
    fields.push({ key: 'maxTokens', label: 'Max Tokens', placeholder: '16384', inputType: 'number' });
  }

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
