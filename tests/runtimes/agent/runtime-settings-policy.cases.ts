import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime-options.ts';
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

  it.each([
    { sandboxPerChat: false, persistedFallback: false },
    { sandboxPerChat: true, persistedFallback: false },
    { sandboxPerChat: false, persistedFallback: true },
    { sandboxPerChat: true, persistedFallback: true },
  ])('reconciles M365 settings after restoring fallback state ($sandboxPerChat, $persistedFallback)', async ({ sandboxPerChat, persistedFallback }) => {
    const { m365BridgeCredentialAdmission } = await import('../../../src/core/m365-bridge-policy.ts');
    const { ensurePermissionsSettings } = await import('../../../src/core/workspace.ts');
    const fallbackDb = await import('../../../src/runtimes/agent/fallback-state-db.ts');
    const cfg = runtimeConfig;
    const originalFallbacks = cfg.agentFallbacks;
    cfg.agentProvider = 'claude-cli';
    cfg.agentFallbacks = [{ provider: 'claude-cli', model: 'fallback-model' }];
    const binding = {
      tenantId: '11111111-2222-3333-4444-555555555555',
      accountEmail: 'user@example.test', origin: 'https://127.0.0.1:10000',
      profile: 'user-full-v1' as const,
    };
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: binding.origin, MS365_HUB_URL: binding.origin,
      MS365_TENANT_ID: binding.tenantId, MS365_PROFILE: binding.profile,
      MS365_AGENT365_ACCOUNT_EMAIL: binding.accountEmail, MS365_AGENT365_API_KEY: 'synthetic-key',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_ID', undefined);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true,
      enabledPlugins, binding, env: process.env,
    }, process.pid) ?? undefined);
    const stateSpy = vi.spyOn(fallbackDb, 'getFallbackState').mockReturnValue(persistedFallback ? {
      activeUntil: Date.now() + 60_000, activatedAt: Date.now() - 1000,
      reason: 'usage-limit', probeAttempts: 0, version: 0,
      activeEntryProvider: null, activeEntryModel: null, failedKeys: [],
    } : null);
    try {
      const cwd = await ownedRuntimeCwd('m365-startup-policy');
      const runtime = createRuntime({
        cwd, sandboxPerChat, model: 'primary-model', allowM365Mutations: true,
        enabledPlugins, m365Bridge: binding,
      });
      expect(runtime.getM365SettingsPolicy()).toEqual({ status: 'rejected' });
      await runtime.start();
      expect(runtime.getM365SettingsPolicy()?.status).toBe(persistedFallback ? 'rejected' : 'approved');
      expect(ensurePermissionsSettings).toHaveBeenCalledWith(
        join(cwd, '.claude'), 'agent', enabledPlugins,
        { hasSandbox: false, m365MutationPolicy: runtime.getM365SettingsPolicy() },
      );
      if (!persistedFallback) {
        const route = runtime as unknown as {
          activateProviderFallback(resetAt: Date | null, reason: 'usage-limit'): unknown;
        };
        expect(route.activateProviderFallback(null, 'usage-limit')).not.toBeNull();
        expect(runtime.getM365SettingsPolicy()).toEqual({ status: 'rejected' });
      }
    } finally {
      stateSpy.mockRestore();
      if (originalFallbacks === undefined) delete cfg.agentFallbacks;
      else cfg.agentFallbacks = originalFallbacks;
      delete cfg.agentProvider;
      vi.unstubAllEnvs();
    }
  });
}
