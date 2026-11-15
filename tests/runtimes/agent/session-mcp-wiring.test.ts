import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const canary = vi.hoisted(() => ({
  provisioned: vi.fn<(stateRoot: string) => boolean>(),
  read: vi.fn(),
  binary: vi.fn<(provider: string) => string | null>(),
  configArgs: vi.fn<(...args: string[]) => readonly string[]>(),
}));

vi.mock('../../../src/runtimes/agent/provider-canary-proof.ts', () => ({
  canaryStoreProvisioned: canary.provisioned,
  readProviderCanaryAdmission: canary.read,
}));
vi.mock('../../../src/runtimes/agent/session.ts', () => ({ getProviderBinary: canary.binary }));
vi.mock('../../../src/runtimes/agent/providers/mcp-bridge.ts', () => ({ buildProviderMcpConfigArgs: canary.configArgs }));

import {
  buildProviderToolSession,
  providerCanaryAdmissionGate,
  sessionProviderMcpConfigArgs,
  sessionTokenLeaseBinding,
} from '../../../src/runtimes/agent/session-mcp-wiring.ts';

const CANARY_INPUT = {
  providerId: 'codex-cli', proxyScriptPath: '/opt/proxy.ts', stateRoot: '/state', sessionScope: 'per_chat', sandboxPerChat: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildProviderToolSession', () => {
  const base = {
    chatJid: '15550001@s.whatsapp.net',
    deliveryConversationKey: '15550001',
    sessionConversationKey: '15550001',
    turnReplySessionId: 'manager-1',
  };

  it('confines a chat-scoped session to its chat, root and scheduled purpose', () => {
    expect(buildProviderToolSession({
      ...base, chatScoped: true, shared: false, actorJid: 'actor@s.whatsapp.net', cwd: '/ws/a',
      sessionConversationKey: '15550001::scheduled-agent-job',
    })).toEqual({
      tier: 'chat-scoped', conversationKey: '15550001', deliveryJid: base.chatJid, actorJid: 'actor@s.whatsapp.net',
      allowedRoot: '/ws/a', purpose: 'scheduled-agent-job', turnReplySessionId: 'manager-1',
    });
    expect(buildProviderToolSession({ ...base, chatScoped: true, shared: false })).toEqual({
      tier: 'chat-scoped', conversationKey: '15550001', deliveryJid: base.chatJid, turnReplySessionId: 'manager-1',
    });
  });

  it('binds a global session to its conversation only when the runtime is not shared', () => {
    expect(buildProviderToolSession({ ...base, chatScoped: false, shared: false, actorJid: 'actor@s.whatsapp.net' })).toEqual({
      tier: 'global', actorJid: 'actor@s.whatsapp.net', conversationKey: '15550001', turnReplySessionId: 'manager-1',
    });
    expect(buildProviderToolSession({ ...base, chatScoped: false, shared: true, cwd: '/ignored' })).toEqual({
      tier: 'global', turnReplySessionId: 'manager-1',
    });
  });
});

describe('sessionTokenLeaseBinding', () => {
  const binding = (overrides: Partial<Parameters<typeof sessionTokenLeaseBinding>[0]>) => sessionTokenLeaseBinding({
    mcpSocketPath: undefined, globalMcpSocketPath: null, sandboxPerChat: false, cwd: undefined, turnReplySessionId: 'manager-1',
    ...overrides,
  });

  it('binds the session token to the socket its child is given, in precedence order', () => {
    expect(binding({ mcpSocketPath: '/run/actor.sock', globalMcpSocketPath: '/run/global.sock', sandboxPerChat: true, cwd: '/ws/a' }))
      .toEqual({ kind: 'session', socketPath: '/run/actor.sock', turnReplySessionId: 'manager-1' });
    expect(binding({ globalMcpSocketPath: '/run/global.sock', sandboxPerChat: true, cwd: '/ws/a' }).socketPath).toBe('/run/global.sock');
    expect(binding({ sandboxPerChat: true, cwd: '/ws/a' }).socketPath).toBe(join('/ws/a', '.claude', 'whatsoup.sock'));
  });

  it('binds to no socket when the child is given none', () => {
    expect(binding({ cwd: '/ws/a' }).socketPath).toBe('');
    expect(binding({ sandboxPerChat: true }).socketPath).toBe('');
  });
});

describe('sessionProviderMcpConfigArgs', () => {
  it('passes no MCP config without a global socket', () => {
    expect(sessionProviderMcpConfigArgs({ provider: 'claude-cli', cwd: '/ws', globalMcpSocketPath: null, proxyScriptPath: '/opt/proxy.ts' }))
      .toEqual([]);
    expect(canary.configArgs).not.toHaveBeenCalled();
  });

  it('builds the global socket config in the session cwd, else the home directory', () => {
    canary.configArgs.mockReturnValue(['--mcp-config', 'x']);

    expect(sessionProviderMcpConfigArgs({ provider: 'claude-cli', cwd: '/ws', globalMcpSocketPath: '/run/g.sock', proxyScriptPath: '/p' }))
      .toEqual(['--mcp-config', 'x']);
    sessionProviderMcpConfigArgs({ provider: 'claude-cli', cwd: undefined, globalMcpSocketPath: '/run/g.sock', proxyScriptPath: '/p' });

    expect(canary.configArgs.mock.calls).toEqual([
      ['claude-cli', '/ws', '/run/g.sock', '/p'],
      ['claude-cli', homedir(), '/run/g.sock', '/p'],
    ]);
  });
});

describe('providerCanaryAdmissionGate', () => {
  it('builds no gate when no actor socket is required or no canary store is provisioned', () => {
    canary.provisioned.mockReturnValue(true);
    expect(providerCanaryAdmissionGate(false, CANARY_INPUT)).toBeUndefined();
    expect(canary.provisioned).not.toHaveBeenCalled();

    canary.provisioned.mockReturnValue(false);
    expect(providerCanaryAdmissionGate(true, CANARY_INPUT)).toBeUndefined();
    expect(canary.provisioned).toHaveBeenCalledWith('/state');
  });

  it('resolves the binary when the gate runs and returns an allowed admission', async () => {
    canary.provisioned.mockReturnValue(true);
    canary.read.mockReturnValue({ allowed: true });
    const gate = providerCanaryAdmissionGate(true, CANARY_INPUT);
    expect(canary.binary).not.toHaveBeenCalled();
    canary.binary.mockReturnValue('/usr/bin/codex');

    await expect(gate!()).resolves.toEqual({ allowed: true });
    expect(canary.read).toHaveBeenCalledWith({
      providerId: 'codex-cli', binary: '/usr/bin/codex', proxyScriptPath: '/opt/proxy.ts', stateRoot: '/state',
      sessionScope: 'per_chat', sandboxPerChat: false,
    });
  });

  it('refuses the spawn when the canary proof does not allow it, with an empty binary when none resolves', async () => {
    canary.provisioned.mockReturnValue(true);
    canary.read.mockReturnValue({ allowed: false });
    canary.binary.mockReturnValue(null);

    await expect(providerCanaryAdmissionGate(true, CANARY_INPUT)!()).rejects.toThrow('provider MCP canary proof unavailable');
    expect(canary.read).toHaveBeenCalledWith(expect.objectContaining({ binary: '' }));
  });
});
