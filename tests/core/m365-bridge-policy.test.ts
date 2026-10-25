import { describe, expect, it } from 'vitest';
import {
  M365_PLUGIN_KEY,
  M365_USER_FULL_PROFILE,
  resolveM365MutationPolicy,
  m365BridgeCredentialProjectionAllowed,
  m365BridgeCredentialAdmission,
  type M365BridgeBinding,
} from '../../src/core/m365-bridge-policy.ts';

const binding: M365BridgeBinding = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  accountEmail: 'user@example.test',
  origin: 'http://127.0.0.1:10000',
  profile: M365_USER_FULL_PROFILE,
};

const configured = {
  instanceName: 'bridge-agent',
  provider: 'claude-cli',
  allowM365Mutations: true,
  enabledPlugins: { [M365_PLUGIN_KEY]: true },
  binding,
};

function serviceEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
    ALLOW_M365_MUTATIONS: '1',
    MS365_AGENT365_BRIDGE: 'true',
    MS365_AGENT365_BASE_URL: binding.origin,
    MS365_AGENT365_API_KEY: 'test-agent365-key',
    MS365_AGENT365_ACCOUNT_EMAIL: binding.accountEmail,
    MS365_TENANT_ID: binding.tenantId,
    MS365_PROFILE: binding.profile,
    MS365_HUB_URL: binding.origin,
  };
  return {
    ...env,
    WHATSOUP_M365_LAUNCH_ADMISSION: m365BridgeCredentialAdmission({ ...configured, env }, process.pid) ?? undefined,
    ...overrides,
  };
}

function policy(overrides: Parameters<typeof resolveM365MutationPolicy>[0] = {}) {
  return resolveM365MutationPolicy({
    ...configured,
    env: serviceEnv(),
    ...overrides,
  });
}

describe('resolveM365MutationPolicy', () => {
  it.each(['http://localhost:10000', 'http://localhost'])(
    'rejects a hostname-based bridge origin before credential projection: %s', (origin) => {
      const options = {
        ...configured,
        binding: { ...binding, origin },
        env: serviceEnv({ MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin }),
      };
      expect(m365BridgeCredentialProjectionAllowed(options)).toBe(false);
      expect(m365BridgeCredentialAdmission(options, process.pid)).toBeNull();
      expect(resolveM365MutationPolicy(options)).toEqual({ status: 'rejected' });
    },
  );

  it.each(['http://127.0.0.1:10000', 'http://[::1]:10000'])(
    'admits an exact numeric loopback bridge: %s', (origin) => {
      const options = {
        ...configured,
        binding: { ...binding, origin },
        env: serviceEnv({ MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin }),
      };
      options.env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission(options, process.pid) ?? undefined;
      expect(m365BridgeCredentialProjectionAllowed(options)).toBe(true);
      expect(resolveM365MutationPolicy(options)).toMatchObject({
        status: 'approved', childEnv: { MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin },
      });
    },
  );

  it('rejects an ambient key without launcher admission', () => {
    expect(policy({ env: serviceEnv({ WHATSOUP_M365_LAUNCH_ADMISSION: undefined }) })).toEqual({ status: 'rejected' });
  });

  it('rejects malformed launcher admissions without decoding a partial digest', () => {
    const admission = serviceEnv().WHATSOUP_M365_LAUNCH_ADMISSION;
    expect(policy({ env: serviceEnv({ WHATSOUP_M365_LAUNCH_ADMISSION: `${admission}00` }) })).toEqual({ status: 'rejected' });
    expect(policy({ env: serviceEnv({ WHATSOUP_M365_LAUNCH_ADMISSION: 'z'.repeat(64) }) })).toEqual({ status: 'rejected' });
  });

  it('rejects an admission inherited from a different process', () => {
    const env = serviceEnv();
    env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission({ ...configured, env }, process.pid + 1) ?? undefined;
    expect(policy({ env })).toEqual({ status: 'rejected' });
  });

  it('rejects an admission reused for another instance', () => {
    expect(policy({ instanceName: 'second-agent' })).toEqual({ status: 'rejected' });
  });

  it('rejects replacement of the admitted key', () => {
    expect(policy({ env: serviceEnv({ MS365_AGENT365_API_KEY: 'replacement-key' }) })).toEqual({ status: 'rejected' });
  });

  it('rejects an admission after the configured and service account both change', () => {
    const accountEmail = 'other@example.test';
    expect(policy({
      binding: { ...binding, accountEmail },
      env: serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: accountEmail }),
    })).toEqual({ status: 'rejected' });
  });

  it('rejects an admission after the configured and service tenant both change', () => {
    const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(policy({
      binding: { ...binding, tenantId },
      env: serviceEnv({ MS365_TENANT_ID: tenantId }),
    })).toEqual({ status: 'rejected' });
  });

  it('rejects an admission after the configured and service origins both change', () => {
    const origin = 'http://127.0.0.1:10001';
    expect(policy({
      binding: { ...binding, origin },
      env: serviceEnv({ MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin }),
    })).toEqual({ status: 'rejected' });
  });

  it('rejects switching an admitted email binding to an account-id selector', () => {
    expect(policy({
      binding: { ...binding, accountEmail: undefined, accountId: 'other-account' },
      env: serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: undefined, MS365_AGENT365_ACCOUNT_ID: 'other-account' }),
    })).toEqual({ status: 'rejected' });
  });

  it('approves a launcher admission bound to an account-id selector', () => {
    const accountId = 'account-1';
    const options = {
      ...configured,
      binding: { ...binding, accountEmail: undefined, accountId },
      env: serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: undefined, MS365_AGENT365_ACCOUNT_ID: accountId }),
    };
    options.env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission(options, process.pid) ?? undefined;
    expect(resolveM365MutationPolicy(options)).toMatchObject({
      status: 'approved', childEnv: { MS365_AGENT365_ACCOUNT_ID: accountId },
    });
  });

  it('does not issue an admission without an exact instance, process and resolved credential', () => {
    const options = { ...configured, env: serviceEnv() };
    expect(m365BridgeCredentialAdmission({ ...options, instanceName: undefined }, process.pid)).toBeNull();
    expect(m365BridgeCredentialAdmission(options, 0)).toBeNull();
    expect(m365BridgeCredentialAdmission(options, 1.5)).toBeNull();
    expect(m365BridgeCredentialAdmission({ ...options, env: serviceEnv({ MS365_AGENT365_API_KEY: undefined }) }, process.pid)).toBeNull();
    expect(m365BridgeCredentialAdmission({ ...options, provider: 'codex-cli' }, process.pid)).toBeNull();
  });

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
