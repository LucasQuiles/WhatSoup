import { describe, expect, it } from 'vitest';
import {
  MCP_ENV_KEY_SERVICES,
  PROVIDER_API_KEY_SERVICES,
  SERVICE_ENV_MAP,
} from '../../src/lib/provider-key-service.ts';

// agentOptions.additionalMcpServers[].envFromKeyring may only name services in
// MCP_ENV_KEY_SERVICES. The set is DELIBERATELY DISJOINT from
// PROVIDER_API_KEY_SERVICES: inference keys must never flow into an
// operator-declared local MCP process, and non-provider secrets must never be
// namable as a BYOK endpoint bearer token. Two lists, two threat models.
describe('MCP_ENV_KEY_SERVICES (additionalMcpServers keyring allowlist)', () => {
  it('allows ms365-hub', () => {
    expect(MCP_ENV_KEY_SERVICES.has('ms365-hub')).toBe(true);
  });

  it('maps ms365-hub to MS365_HUB_API_KEY in SERVICE_ENV_MAP', () => {
    expect(SERVICE_ENV_MAP['ms365-hub']).toBe('MS365_HUB_API_KEY');
  });

  it('is disjoint from PROVIDER_API_KEY_SERVICES', () => {
    for (const service of MCP_ENV_KEY_SERVICES) {
      expect(PROVIDER_API_KEY_SERVICES.has(service)).toBe(false);
    }
  });

  it('excludes inference keys and platform secrets', () => {
    for (const service of [
      'anthropic',
      'openai',
      'pinecone',
      'elevenlabs',
      'whatsoup-health-token',
      'whatsoup_health',
    ]) {
      expect(MCP_ENV_KEY_SERVICES.has(service)).toBe(false);
    }
  });
});
