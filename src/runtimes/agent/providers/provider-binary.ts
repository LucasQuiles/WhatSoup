import {
  PROVIDER_IDS,
  assertNeverProvider,
  isProviderId,
  type ProviderId,
} from './index.ts';

/** Canonical executable name for a CLI-backed provider. */
export function resolveProviderBinary(provider: ProviderId): string {
  switch (provider) {
    case 'claude-cli': return 'claude';
    case 'codex-cli': return 'codex';
    case 'gemini-cli': return 'gemini';
    case 'opencode-cli': return 'opencode';
    case 'openai-api':
    case 'anthropic-api':
      throw new Error(
        `[provider-binary:resolve] ${provider} is a managed-loop provider and does not spawn a binary`,
      );
    default:
      return assertNeverProvider(provider, 'provider-binary:resolve');
  }
}

/** Return a CLI executable name, or null for a managed-loop provider. */
export function getProviderBinary(provider: string): string | null {
  if (!isProviderId(provider)) {
    throw new Error(
      `[provider-binary:get] unknown provider id: ${JSON.stringify(provider)}. `
      + `Valid: ${PROVIDER_IDS.join(', ')}.`,
    );
  }
  return provider === 'openai-api' || provider === 'anthropic-api'
    ? null
    : resolveProviderBinary(provider);
}
