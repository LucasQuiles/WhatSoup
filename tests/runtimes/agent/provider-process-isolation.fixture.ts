import type { ProviderProcessIsolationConfig } from '../../../src/runtimes/agent/provider-process-isolation.ts';

export function providerProcessIsolationFixture(): ProviderProcessIsolationConfig {
  return {
    controllerUid: 501,
    controllerGid: 20,
    workerUid: 502,
    workerGid: 502,
    launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
    launcherSha256: 'a'.repeat(64),
    policyPath: '/etc/whatsoup/agent-isolation.policy',
    policySha256: 'b'.repeat(64),
    homeDir: '/var/lib/whatsoup-agent',
    configHome: '/var/lib/whatsoup-agent/.config',
    dataHome: '/var/lib/whatsoup-agent/.local/share',
    protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
  };
}
