import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
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
});
