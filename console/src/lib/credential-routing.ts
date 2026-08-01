/**
 * Pure key→keyring-service routing for the Add Line wizard's finish step.
 * Cross-vendor writes are forbidden: an explicit providerConfig.apiKeyService
 * only receives the key whose vendor matches the configured provider path
 * (spec: docs/specs/2026-07-05-onboarding-safety-firstrun-design.md).
 */
import { asNonEmptyString } from './type-guards'

export interface CredentialWrite { service: string; value: string }

function explicitService(agentOptions: Record<string, unknown> | undefined): string | null {
  const pc = agentOptions?.providerConfig;
  if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
    const s = (pc as Record<string, unknown>).apiKeyService;
    const trimmed = asNonEmptyString(s);
    if (trimmed !== undefined) return trimmed;
  }
  return null;
}

function providerModelPrefix(agentOptions: Record<string, unknown> | undefined): string {
  const pc = agentOptions?.providerConfig;
  if (pc && typeof pc === 'object' && !Array.isArray(pc)) {
    const m = (pc as Record<string, unknown>).model;
    if (typeof m === 'string') return m.split('/')[0]?.trim().toLowerCase() ?? '';
  }
  return '';
}

export function planCredentialWrites(formData: Record<string, unknown>): CredentialWrite[] {
  const agentOptions = (formData.agentOptions && typeof formData.agentOptions === 'object'
    && !Array.isArray(formData.agentOptions))
    ? formData.agentOptions as Record<string, unknown> : undefined;
  const provider = typeof agentOptions?.provider === 'string' ? agentOptions.provider : '';
  const explicit = explicitService(agentOptions);
  const writes: CredentialWrite[] = [];

  // Anthropic auth can be "Existing Claude session" (authMethod='oauth'), which
  // hides the key input but does NOT clear a previously-typed formData.apiKey —
  // a stale key must not be stored. OpenAI has no session alternative.
  const authMethod = typeof formData.authMethod === 'string' ? formData.authMethod : 'api_key';
  const anthropicKey = typeof formData.apiKey === 'string' ? formData.apiKey.trim() : '';
  if (anthropicKey && authMethod !== 'oauth') {
    writes.push({
      service: provider === 'anthropic-api' && explicit ? explicit : 'anthropic',
      value: anthropicKey,
    });
  }

  const openaiKey = typeof formData.openaiKey === 'string' ? formData.openaiKey.trim() : '';
  if (openaiKey) {
    const openaiCompatible =
      provider === 'openai-api' ||
      (provider === 'opencode-cli' && providerModelPrefix(agentOptions) === 'openai');
    writes.push({
      service: openaiCompatible && explicit ? explicit : 'openai',
      value: openaiKey,
    });
  }

  return writes;
}
