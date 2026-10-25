import { describe, expect, it } from 'vitest';
import {
  M365_PLUGIN_KEY,
  M365_USER_FULL_PROFILE,
  resolveM365MutationPolicy,
  m365BridgeCredentialProjectionAllowed,
  type M365BridgeBinding,
} from '../../src/core/m365-bridge-policy.ts';

const binding: M365BridgeBinding = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  accountEmail: 'user@example.test',
  origin: 'http://127.0.0.1:10000',
  profile: M365_USER_FULL_PROFILE,
};

function serviceEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ALLOW_M365_MUTATIONS: '1',
    MS365_AGENT365_BRIDGE: 'true',
    MS365_AGENT365_BASE_URL: binding.origin,
    MS365_AGENT365_API_KEY: 'test-agent365-key',
    MS365_AGENT365_ACCOUNT_EMAIL: binding.accountEmail,
    MS365_TENANT_ID: binding.tenantId,
    MS365_PROFILE: binding.profile,
    MS365_HUB_URL: binding.origin,
    ...overrides,
  };
}

function policy(overrides: Parameters<typeof resolveM365MutationPolicy>[0] = {}) {
  return resolveM365MutationPolicy({
    provider: 'claude-cli',
    allowM365Mutations: true,
    enabledPlugins: { [M365_PLUGIN_KEY]: true },
    binding,
    env: serviceEnv(),
    ...overrides,
  });
}

describe('resolveM365MutationPolicy', () => {
  it('approves only the exact configured Agent365 bridge and emits its bounded child environment', () => {
    const result = policy();

    expect(result).toMatchObject({ status: 'approved' });
    if (result?.status !== 'approved') throw new Error('Expected an approved bridge policy');
    expect(result.childEnv).toEqual({
      ALLOW_M365_MUTATIONS: '1',
      MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: binding.origin,
      MS365_AGENT365_API_KEY: 'test-agent365-key',
      MS365_AGENT365_ACCOUNT_EMAIL: binding.accountEmail,
      MS365_TENANT_ID: binding.tenantId,
      MS365_PROFILE: M365_USER_FULL_PROFILE,
      MS365_HUB_URL: binding.origin,
    });
  });

  it.each([
    ['missing configured plugin', { enabledPlugins: {} }],
    ['missing mutation flag', { allowM365Mutations: false }],
    ['wrong provider', { provider: 'codex-cli' }],
    ['wrong service selector', { env: serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: 'other@custom-domain.example' }) }],
    ['mismatched service tenant', { env: serviceEnv({ MS365_TENANT_ID: 'other-tenant' }) }],
    ['non-loopback service origin', { env: serviceEnv({ MS365_HUB_URL: 'https://example.test' }) }],
  ])('fails closed for a %s', (_case, overrides) => {
    expect(policy(overrides)).toMatchObject({ status: 'rejected' });
  });

  it.each(['COMMON', 'CONSUMERS', 'organizations'])('rejects a non-concrete tenant alias: %s', (tenantId) => {
    expect(policy({
      binding: { ...binding, tenantId },
      env: serviceEnv({ MS365_TENANT_ID: tenantId }),
    })).toMatchObject({ status: 'rejected' });
  });

  it('requires exactly one bound selector without restricting the account email domain', () => {
    expect(policy({ binding: { ...binding, accountId: 'account-1' } })).toMatchObject({ status: 'rejected' });
    expect(policy({ binding: { ...binding, accountEmail: undefined } })).toMatchObject({ status: 'rejected' });
    expect(policy()).toMatchObject({ status: 'approved' });
  });
});


describe('m365BridgeCredentialProjectionAllowed', () => {
  it('permits a qualified credential lookup while runtime mutation still requires the key', () => {
    const options = {
      provider: 'claude-cli',
      allowM365Mutations: true,
      enabledPlugins: { [M365_PLUGIN_KEY]: true },
      binding,
      env: serviceEnv({ MS365_AGENT365_API_KEY: undefined }),
    };
    expect(m365BridgeCredentialProjectionAllowed(options)).toBe(true);
    expect(m365BridgeCredentialProjectionAllowed({ ...options, provider: 'codex-cli' })).toBe(false);
    expect(resolveM365MutationPolicy(options)).toEqual({ status: 'rejected' });
  });
});
