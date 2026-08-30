import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { noExecutingSession, type SessionContext } from '../../src/mcp/types.ts';
import { createProviderMcpBridge } from '../../src/runtimes/agent/providers/mcp-bridge.ts';

describe('executing-session resolver type boundary (#3429)', () => {
  it('requires every socket and provider bridge to name its read-time resolver', () => {
    const registry = new ToolRegistry();
    const session = { tier: 'global' as const };

    if (false) {
      // @ts-expect-error -- permanent negative fixture: socket construction without the mandatory executing-session resolver must not compile; expires 2099-12-31
      new WhatSoupSocketServer('/tmp/unused.sock', registry, session);
      // @ts-expect-error -- permanent negative fixture: provider bridge construction without the mandatory executing-session resolver must not compile; expires 2099-12-31
      createProviderMcpBridge(registry, session);
    }

    expect(registry).toBeInstanceOf(ToolRegistry);
  });

  it('makes a non-executing surface deny every mutable authorization field explicitly', () => {
    expect(noExecutingSession()).toEqual({
      actorJid: undefined,
      purpose: undefined,
      conversationKey: undefined,
    });
  });

  it('rejects raw session contexts at the registry authorization boundary', async () => {
    const registry = new ToolRegistry();
    const rawSession: SessionContext = { tier: 'global' };

    if (false) {
      // @ts-expect-error -- permanent negative fixture: listTools requires a resolved session snapshot; expires 2099-12-31
      registry.listTools(rawSession);
      // @ts-expect-error -- permanent negative fixture: call requires a resolved session snapshot; expires 2099-12-31
      await registry.call('unused', {}, rawSession);
    }

    expect(registry).toBeInstanceOf(ToolRegistry);
  });
});
