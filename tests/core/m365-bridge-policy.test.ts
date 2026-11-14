import { describe, expect, it } from 'vitest';
import {
  M365_PLUGIN_KEY,
  M365_USER_FULL_PROFILE,
  resolveM365MutationPolicy,
  m365BridgeCredentialProjectionAllowed,
  m365BridgeCredentialAdmission,
  m365MutationAdmissionGap,
  m365AuthoritySocketWithheld,
  m365MutationExceptionAllowed,
  m365SessionChildPolicy,
  m365TurnAuthority,
  m365WorkflowAuthorityLive,
  narrowM365RoutePolicy,
  withdrawM365WorkflowAuthority,
  type M365BridgeBinding,
  type M365MutationPolicy,
} from '../../src/core/m365-bridge-policy.ts';
import { applyRequiredDeny, M365_MUTATION_DENY } from '../../src/core/settings-template.ts';

const binding: M365BridgeBinding = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  accountEmail: 'user@example.test',
  origin: 'https://127.0.0.1:10000',
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
    MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
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

describe('m365MutationAdmissionGap', () => {
  it('names the first setting that keeps a configured bridge from admission, never a value', () => {
    expect(m365MutationAdmissionGap({ ...configured, env: serviceEnv() })).toBeNull();
    expect(m365MutationAdmissionGap({ ...configured, binding: undefined, env: serviceEnv() })).toBeNull();
    expect(m365MutationAdmissionGap({ ...configured, env: serviceEnv({ MS365_DURABLE_MAIL_STATE_DIR: undefined }) }))
      .toBe('MS365_DURABLE_MAIL_STATE_DIR');
    expect(m365MutationAdmissionGap({ ...configured, env: serviceEnv({ MS365_DURABLE_MAIL_STATE_DIR: 'relative/dir' }) }))
      .toBe('MS365_DURABLE_MAIL_STATE_DIR');
    expect(m365MutationAdmissionGap({ ...configured, provider: 'opencode-cli', env: serviceEnv() })).toBe('agentOptions.provider');
    expect(m365MutationAdmissionGap({ ...configured, env: serviceEnv({ MS365_HUB_URL: 'https://127.0.0.1:10001' }) }))
      .toBe('MS365_HUB_URL');
    expect(m365MutationAdmissionGap({ ...configured, env: serviceEnv({ WHATSOUP_M365_LAUNCH_ADMISSION: undefined }) }))
      .toBe('launch-admission');
    expect(m365MutationAdmissionGap({ ...configured, binding: { ...binding, origin: 'http://127.0.0.1:10000' }, env: serviceEnv() }))
      .toBe('agentOptions.m365Bridge');
  });

  it('agrees with policy resolution on every named gap', () => {
    for (const env of [serviceEnv({ ALLOW_M365_MUTATIONS: '0' }), serviceEnv({ MS365_PROFILE: 'other' }), serviceEnv()]) {
      const options = { ...configured, env };
      const gap = m365MutationAdmissionGap(options);
      expect(resolveM365MutationPolicy(options)?.status).toBe(gap === null ? 'approved' : 'rejected');
    }
  });
});

describe('m365TurnAuthority', () => {
  it('publishes the request reference and assignment only for a human request on an approved policy', () => {
    const workflowAuthority = { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' };
    const approved = { status: 'approved' as const, childEnv: {}, workflowAuthority };
    expect(m365TurnAuthority(approved, true, 'request-1', undefined, 'claude-cli'))
      .toEqual({ requestRef: 'request-1', workflowAuthority, m365RouteProvider: 'claude-cli' });
    expect(m365TurnAuthority(approved, false, 'request-1', undefined, 'claude-cli'))
      .toEqual({ requestRef: undefined, workflowAuthority: undefined, m365RouteProvider: 'claude-cli' });
    expect(m365TurnAuthority({ status: 'rejected' }, true, 'request-1', undefined, 'claude-cli'))
      .toEqual({ requestRef: 'request-1', workflowAuthority: undefined, m365RouteProvider: undefined });
    expect(m365TurnAuthority(undefined, true, undefined, undefined, 'claude-cli')).toEqual({ requestRef: undefined, workflowAuthority: undefined });
  });

  it.each(['codex-cli', 'gemini-cli', 'opencode-cli', undefined])(
    'publishes neither the assignment nor a route provider for a turn on the %s route', (provider) => {
      const workflowAuthority = { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' };
      const approved = { status: 'approved' as const, childEnv: {}, workflowAuthority };
      const published = m365TurnAuthority(approved, true, 'request-1', 'per_chat', provider);
      expect(published.workflowAuthority).toBeUndefined();
      expect(published.workflowAuthorityScope).toBeUndefined();
      expect(published.m365RouteProvider).toBeUndefined();
    },
  );

  it('publishes the session scope with a human request, so the broker can refuse a scope other than per-chat', () => {
    const workflowAuthority = { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' };
    const approved = { status: 'approved' as const, childEnv: {}, workflowAuthority };
    expect(m365TurnAuthority(approved, true, 'request-1', 'per_chat', 'claude-cli'))
      .toEqual({ requestRef: 'request-1', workflowAuthority, workflowAuthorityScope: 'per_chat', m365RouteProvider: 'claude-cli' });
    expect(m365TurnAuthority(approved, true, 'request-1', 'shared', 'claude-cli'))
      .toEqual({ requestRef: 'request-1', workflowAuthority, workflowAuthorityScope: 'shared', m365RouteProvider: 'claude-cli' });
    expect(m365TurnAuthority(approved, false, 'request-1', 'per_chat', 'claude-cli'))
      .toEqual({ requestRef: undefined, workflowAuthority: undefined, workflowAuthorityScope: undefined, m365RouteProvider: 'claude-cli' });
  });

  it('marks a sandboxPerChat turn that publishes the assignment, and adds no key to any other turn', () => {
    const workflowAuthority = { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' };
    const approved = { status: 'approved' as const, childEnv: {}, workflowAuthority };
    // The sandbox turn keeps publishing the assignment and its scope.
    expect(m365TurnAuthority(approved, true, 'request-1', 'per_chat', 'claude-cli', true)).toStrictEqual({
      requestRef: 'request-1', workflowAuthority, workflowAuthorityScope: 'per_chat', m365RouteProvider: 'claude-cli',
      workflowAuthoritySandboxPerChat: true,
    });
    for (const published of [
      m365TurnAuthority(approved, true, 'request-1', 'per_chat', 'claude-cli', false),
      m365TurnAuthority(approved, true, 'request-1', 'per_chat', 'claude-cli'),
      m365TurnAuthority(approved, false, 'request-1', 'per_chat', 'claude-cli', true),
      m365TurnAuthority({ status: 'rejected' }, true, 'request-1', 'per_chat', 'claude-cli', true),
      m365TurnAuthority(approved, true, 'request-1', 'per_chat', 'codex-cli', true),
    ]) expect(published).not.toHaveProperty('workflowAuthoritySandboxPerChat');
  });
});

describe('narrowM365RoutePolicy', () => {
  const childEnv = { ALLOW_M365_MUTATIONS: '1' };
  const current: M365MutationPolicy = {
    status: 'approved', childEnv, workflowAuthority: { accountId: 'account-1', employeeActorJid: '15551230001@s.whatsapp.net' },
  };

  it('publishes the current assignment, never a snapshot that only looks like it', () => {
    const forged: M365MutationPolicy = {
      status: 'approved', childEnv, workflowAuthority: { accountId: 'x', employeeActorJid: '15559990000@s.whatsapp.net' },
    };
    expect(narrowM365RoutePolicy(forged, current)).toBe(current);
    expect(narrowM365RoutePolicy({ ...current }, current)).toBe(current);
    expect(narrowM365RoutePolicy(current, current)).toBe(current);
  });

  it('narrows a snapshot by the current policy and never widens it', () => {
    const withdrawn: M365MutationPolicy = { status: 'approved', childEnv };
    expect(narrowM365RoutePolicy(current, withdrawn)).toEqual({ status: 'rejected' });
    expect(narrowM365RoutePolicy(withdrawn, current)).toBe(withdrawn);
    expect(narrowM365RoutePolicy(current, { status: 'rejected' })).toEqual({ status: 'rejected' });
    expect(narrowM365RoutePolicy(current, undefined)).toBeUndefined();
  });
});

describe('m365SessionChildPolicy', () => {
  const childEnv = { ALLOW_M365_MUTATIONS: '1' };
  const assigned = (): Extract<M365MutationPolicy, { status: 'approved' }> => ({
    status: 'approved', childEnv, workflowAuthority: { accountId: 'account-1', employeeActorJid: '15551230001@s.whatsapp.net' },
  });

  it('withholds the authority socket from a sandbox child and keeps the assignment it must still require', () => {
    const policy = assigned();
    const child = m365SessionChildPolicy(policy, true);
    expect(m365AuthoritySocketWithheld(child)).toBe(true);
    expect(child).toEqual(policy);
    expect(m365AuthoritySocketWithheld(policy)).toBe(false);
    // The copy shares the assignment object, so a mid-run withdrawal reaches the child's policy too.
    expect(child?.status === 'approved' && child.workflowAuthority).toBe(policy.workflowAuthority);
    withdrawM365WorkflowAuthority(policy.workflowAuthority!);
    expect(child?.status === 'approved' && m365WorkflowAuthorityLive(child.workflowAuthority!)).toBe(false);
  });

  it('passes every other policy through unchanged', () => {
    const policy = assigned();
    expect(m365SessionChildPolicy(policy, false)).toBe(policy);
    const unassigned: M365MutationPolicy = { status: 'approved', childEnv };
    const rejected: M365MutationPolicy = { status: 'rejected' };
    for (const other of [unassigned, rejected, undefined]) {
      expect(m365SessionChildPolicy(other, true)).toBe(other);
      expect(m365AuthoritySocketWithheld(other)).toBe(false);
    }
  });
});

describe('validateM365BridgeBinding', () => {
  const withEmployee = (employeeActorJid: string) => ({
    ...binding, accountEmail: undefined, accountId: 'account-1',
    workflowAuthority: { accountId: 'account-1', employeeActorJid },
  });

  it('admits only the canonical phone JID that the broker compares with the executing actor (M365 r5 W7)', async () => {
    const { validateM365BridgeBinding } = await import('../../src/core/m365-bridge-policy.ts');
    expect(validateM365BridgeBinding(withEmployee('15551230001@s.whatsapp.net'))).toBeNull();
    expect(validateM365BridgeBinding(withEmployee('15551230001:7@s.whatsapp.net'))).toEqual({ kind: 'workflow-authority' });
    expect(validateM365BridgeBinding(withEmployee('15551230001@lid'))).toEqual({ kind: 'workflow-authority' });
    expect(validateM365BridgeBinding(withEmployee(' 15551230001@s.whatsapp.net'))).toEqual({ kind: 'workflow-authority' });
  });
});

describe('resolveM365MutationPolicy', () => {
  it.each(['http://127.0.0.1:10000', 'http://[::1]:10000'])(
    'rejects unauthenticated HTTP loopback before credential projection: %s', (origin) => {
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

  it.each(['https://127.0.0.1:10000', 'https://[::1]:10000'])(
    'admits HTTPS loopback with the exact launcher binding: %s', (origin) => {
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

  it.each(['http://localhost:10000', 'http://localhost', 'https://localhost:10000', 'https://localhost'])(
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

  it.each(['MS365_AGENT365_BASE_URL', 'MS365_HUB_URL'])(
    'rejects an HTTP downgrade of %s before credential projection', (key) => {
      const options = { ...configured, env: serviceEnv({ [key]: 'http://127.0.0.1:10000' }) };
      expect(m365BridgeCredentialProjectionAllowed(options)).toBe(false);
      expect(resolveM365MutationPolicy(options)).toEqual({ status: 'rejected' });
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
    const origin = 'https://127.0.0.1:10001';
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
      binding: {
        ...binding,
        accountEmail: undefined,
        accountId,
        workflowAuthority: {
          accountId,
          employeeActorJid: '15551230001@s.whatsapp.net',
          conversationKey: '15551230001',
        },
      },
      env: serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: undefined, MS365_AGENT365_ACCOUNT_ID: accountId }),
    };
    options.env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission(options, process.pid) ?? undefined;
    const result = resolveM365MutationPolicy(options);
    expect(result).toMatchObject({
      status: 'approved', childEnv: { MS365_AGENT365_ACCOUNT_ID: accountId },
    });
    expect(m365MutationExceptionAllowed(result)).toBe(true);
    // Each resolved policy owns its assignment object, so withdrawing one runtime's assignment never marks
    // another policy resolved from the same configured binding.
    const second = resolveM365MutationPolicy(options);
    if (result?.status !== 'approved' || second?.status !== 'approved') throw new Error('expected approved policies');
    expect(result.workflowAuthority).toEqual(options.binding.workflowAuthority);
    expect(result.workflowAuthority).not.toBe(options.binding.workflowAuthority);
    withdrawM365WorkflowAuthority(result.workflowAuthority!);
    expect(m365WorkflowAuthorityLive(result.workflowAuthority)).toBe(false);
    expect(m365WorkflowAuthorityLive(second.workflowAuthority)).toBe(true);
  });

  it('binds the complete workflow assignment, so one admission cannot carry a changed assignment', () => {
    const accountId = 'account-1';
    const employeeActorJid = '15551230001@s.whatsapp.net';
    const accountBinding: M365BridgeBinding = { ...binding, accountEmail: undefined, accountId };
    const env = serviceEnv({ MS365_AGENT365_ACCOUNT_EMAIL: undefined, MS365_AGENT365_ACCOUNT_ID: accountId });
    const admitted = (
      admittedBinding: M365BridgeBinding,
      runtimeBinding: M365BridgeBinding,
      admittedScope: 'per_chat' | 'shared' | 'single' = 'per_chat',
      runtimeScope: 'per_chat' | 'shared' | 'single' = admittedScope,
    ) => {
      const admission = m365BridgeCredentialAdmission(
        { ...configured, binding: admittedBinding, sessionScope: admittedScope, env }, process.pid,
      ) ?? undefined;
      return resolveM365MutationPolicy({
        ...configured, binding: runtimeBinding, sessionScope: runtimeScope, env: { ...env, WHATSOUP_M365_LAUNCH_ADMISSION: admission },
      });
    };
    const assigned: M365BridgeBinding = { ...accountBinding, workflowAuthority: { accountId, employeeActorJid } };
    const restricted: M365BridgeBinding = { ...accountBinding, workflowAuthority: { accountId, employeeActorJid, conversationKey: '15551230001' } };

    // Positive controls: an unchanged binding keeps its admission.
    expect(admitted(accountBinding, accountBinding)?.status).toBe('approved');
    expect(admitted(assigned, assigned)?.status).toBe('approved');
    expect(admitted(restricted, restricted)?.status).toBe('approved');
    // Each single change after admission is refused.
    expect(admitted(accountBinding, assigned)).toEqual({ status: 'rejected' });
    expect(admitted(assigned, accountBinding)).toEqual({ status: 'rejected' });
    expect(admitted(assigned, { ...accountBinding, workflowAuthority: { accountId, employeeActorJid: '15551230002@s.whatsapp.net' } }))
      .toEqual({ status: 'rejected' });
    expect(admitted(assigned, restricted)).toEqual({ status: 'rejected' });
    expect(admitted(restricted, assigned)).toEqual({ status: 'rejected' });
    expect(admitted(restricted, { ...accountBinding, workflowAuthority: { accountId, employeeActorJid, conversationKey: '15551230003' } }))
      .toEqual({ status: 'rejected' });
    expect(admitted(assigned, assigned, 'per_chat', 'shared')).toEqual({ status: 'rejected' });
    expect(admitted(assigned, assigned, 'single', 'per_chat')).toEqual({ status: 'rejected' });
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
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    });
  });

  it.each([
    ['missing', undefined],
    ['blank', ''],
    ['relative', 'whatsoup-m365-durable-mail'],
  ])('rejects a %s durable mail state directory before credential admission', (_case, durableMailStateDir) => {
    const options = { ...configured, env: serviceEnv({ MS365_DURABLE_MAIL_STATE_DIR: durableMailStateDir }) };
    const result = resolveM365MutationPolicy(options);

    expect(m365BridgeCredentialProjectionAllowed(options)).toBe(false);
    expect(m365BridgeCredentialAdmission(options, process.pid)).toBeNull();
    expect(result).toEqual({ status: 'rejected' });
    expect(m365MutationExceptionAllowed(result)).toBe(false);
    expect(applyRequiredDeny([], result)).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
  });

  it('binds a present durable mail state directory to the admission and child projection', () => {
    const options = { ...configured, env: serviceEnv() };
    const admission = m365BridgeCredentialAdmission(options, process.pid);

    expect(m365BridgeCredentialProjectionAllowed(options)).toBe(true);
    expect(admission).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveM365MutationPolicy(options)).toMatchObject({
      status: 'approved', childEnv: { MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail' },
    });
  });

  it('invalidates an admission when the durable mail state directory changes', () => {
    const options = { ...configured, env: serviceEnv({ MS365_DURABLE_MAIL_STATE_DIR: '/tmp/other-mail-state' }) };

    expect(resolveM365MutationPolicy(options)).toEqual({ status: 'rejected' });
    options.env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission(options, process.pid) ?? undefined;
    expect(resolveM365MutationPolicy(options)).toMatchObject({
      status: 'approved', childEnv: { MS365_DURABLE_MAIL_STATE_DIR: '/tmp/other-mail-state' },
    });
  });

  it.each(['openai-api', 'anthropic-api'])('admits the same exact bridge for %s', (provider) => {
    const options = { ...configured, provider, env: serviceEnv() };
    options.env.WHATSOUP_M365_LAUNCH_ADMISSION = m365BridgeCredentialAdmission(options, process.pid) ?? undefined;
    expect(resolveM365MutationPolicy(options)).toMatchObject({ status: 'approved' });
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
    expect(m365MutationExceptionAllowed(policy())).toBe(false);
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
