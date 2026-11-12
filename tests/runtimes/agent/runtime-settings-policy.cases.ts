import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime-options.ts';
import type { M365BridgeBinding } from '../../../src/core/m365-bridge-policy.ts';
import { ownedRuntimeCwd } from '../../helpers/runtime-home-fixture.ts';

export function registerRuntimeSettingsPolicyTests(
  createRuntime: (options?: AgentRuntimeOptions) => AgentRuntime,
  runtimeConfig: Record<string, unknown>,
): void {
  it('start() calls ensurePermissionsSettings with agent type', async () => {
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const runtime = createRuntime();
    await runtime.start();

    expect(ensurePermissionsSettings).toHaveBeenCalledWith(
      expect.stringContaining('.claude'),
      'agent',
      undefined, // no enabledPlugins configured
      { hasSandbox: false }, // no sandbox config → reconciler strips any orphaned sandbox hook
    );
  });

  // `admitted` means the guarded plugin was admitted at start. Only then does a
  // guarded binding keep the mutation exception on the fallback route.
  it.each([
    { sandboxPerChat: false, persistedFallback: false, guarded: false, admitted: false },
    { sandboxPerChat: true, persistedFallback: false, guarded: false, admitted: false },
    { sandboxPerChat: false, persistedFallback: true, guarded: false, admitted: false },
    { sandboxPerChat: true, persistedFallback: true, guarded: false, admitted: false },
    { sandboxPerChat: false, persistedFallback: true, guarded: true, admitted: true },
    { sandboxPerChat: true, persistedFallback: false, guarded: true, admitted: true },
    { sandboxPerChat: false, persistedFallback: true, guarded: true, admitted: false },
    { sandboxPerChat: true, persistedFallback: false, guarded: true, admitted: false },
  ])('reconciles M365 settings after restoring fallback state ($sandboxPerChat, $persistedFallback, $guarded, $admitted)', async ({ sandboxPerChat, persistedFallback, guarded, admitted }) => {
    const { m365BridgeCredentialAdmission, m365MutationExceptionAllowed } = await import('../../../src/core/m365-bridge-policy.ts');
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const fallbackDb = await import('../../../src/runtimes/agent/fallback-state-db.ts');
    const adapter = await import('../../../src/runtimes/agent/microsoft365-adapter.ts');
    const exception = guarded && admitted;
    const cfg = runtimeConfig;
    const originalFallbacks = cfg.agentFallbacks;
    cfg.agentProvider = 'claude-cli';
    cfg.agentFallbacks = [{ provider: 'claude-cli', model: 'fallback-model' }];
    const binding: M365BridgeBinding = {
      tenantId: '11111111-2222-3333-4444-555555555555',
      origin: 'https://127.0.0.1:10000',
      ...(guarded ? {
        accountId: 'employee-account',
        workflowAuthority: { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' },
      } : { accountEmail: 'user@example.test' }),
      profile: 'user-full-v1' as const,
    };
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: binding.origin, MS365_HUB_URL: binding.origin,
      MS365_TENANT_ID: binding.tenantId, MS365_PROFILE: binding.profile,
      MS365_AGENT365_API_KEY: 'synthetic-key',
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_ID', binding.accountId);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_EMAIL', binding.accountEmail);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true,
      enabledPlugins, binding, env: process.env,
    }, process.pid) ?? undefined);
    const stateSpy = vi.spyOn(fallbackDb, 'getFallbackState').mockReturnValue(persistedFallback ? {
      activeUntil: Date.now() + 60_000, activatedAt: Date.now() - 1000,
      reason: 'usage-limit', probeAttempts: 0, version: 0,
      activeEntryProvider: null, activeEntryModel: null, failedKeys: [],
    } : null);
    // runtime.test.ts mocks node:fs reads, so no plugin manifest can load here.
    // An admitted row stubs the admission export the runtime calls; the other
    // rows run the real admission, which finds no plugin and withdraws authority.
    const admitSpy = vi.spyOn(adapter, 'admitMicrosoft365Workflow');
    if (admitted) admitSpy.mockImplementation(options => options.policy);
    try {
      const cwd = await ownedRuntimeCwd('m365-startup-policy');
      const runtime = createRuntime({
        cwd, sandboxPerChat, model: 'primary-model', allowM365Mutations: true,
        enabledPlugins, m365Bridge: binding,
      });
      expect(runtime.getM365SettingsPolicy()).toEqual({ status: 'rejected' });
      await runtime.start();
      expect(admitSpy).toHaveBeenCalledTimes(1);
      // The admission sees this runtime's own plugin directories, scope mode and name (for its log lines).
      expect(admitSpy).toHaveBeenCalledWith(expect.objectContaining({ pluginDirs: [], sandboxPerChat, instanceName: 'test' }));
      expect(runtime.getM365SettingsPolicy()?.status).toBe(persistedFallback && !exception ? 'rejected' : 'approved');
      expect(m365MutationExceptionAllowed(runtime.getM365SettingsPolicy())).toBe(exception);
      expect(ensurePermissionsSettings).toHaveBeenCalledWith(
        join(cwd, '.claude'), 'agent', enabledPlugins,
        { hasSandbox: false, m365MutationPolicy: runtime.getM365SettingsPolicy() },
      );
      if (!persistedFallback) {
        const route = runtime as unknown as {
          activateProviderFallback(resetAt: Date | null, reason: 'usage-limit'): unknown;
        };
        expect(route.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
        expect(runtime.getM365SettingsPolicy()?.status).toBe(exception ? 'approved' : 'rejected');
      }
    } finally {
      admitSpy.mockRestore();
      stateSpy.mockRestore();
      if (originalFallbacks === undefined) delete cfg.agentFallbacks;
      else cfg.agentFallbacks = originalFallbacks;
      delete cfg.agentProvider;
      vi.unstubAllEnvs();
    }
  });
}
