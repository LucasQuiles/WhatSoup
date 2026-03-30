import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketPath(): string {
  return join(tmpdir(), `whatsoup-test-${process.pid}-${Date.now()}.sock`);
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', ...overrides };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({ message: z.string() }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => ({ echo: params['message'] }),
    ...overrides,
  };
}

/**
 * Connect to the socket, send a JSON-RPC message, and return the first
 * complete response line. Rejects after 3 seconds.
 */
function sendJsonRpc(socketPath: string, msg: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(msg) + '\n');
    });
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line));
            client.end();
          } catch {
            // partial line, keep buffering
          }
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
}

/**
 * Wait for the socket file to appear (server ready), then resolve.
 */
function waitForSocket(socketPath: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(socketPath)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Socket ${socketPath} never appeared`));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatSoupSocketServer', () => {
  let server: WhatSoupSocketServer;
  let registry: ToolRegistry;
  let session: SessionContext;
  let socketPath: string;

  beforeEach(() => {
    socketPath = makeSocketPath();
    registry = new ToolRegistry();
    session = makeSession();
  });

  afterEach(async () => {
    server?.stop();
    // Give the server a moment to close before cleaning up
    await new Promise((r) => setTimeout(r, 50));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  });

  // --- initialize ---

  it('responds to initialize with correct protocol version', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }) as { result: { protocolVersion: string; serverInfo: { name: string; version: string } } };

    expect(response.result.protocolVersion).toBe('2024-11-05');
    expect(response.result.serverInfo.name).toBe('whatsoup');
    expect(response.result.serverInfo.version).toBe('0.1.0');
    expect(response.result).toHaveProperty('capabilities');
  });

  // --- tools/list ---

  it('tools/list returns registered tools', async () => {
    registry.register(makeTool({ name: 'alpha_tool', description: 'Alpha' }));
    registry.register(makeTool({ name: 'beta_tool', description: 'Beta' }));

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }) as { result: { tools: Array<{ name: string; description: string }> } };

    expect(response.result.tools).toHaveLength(2);
    const names = response.result.tools.map((t) => t.name);
    expect(names).toContain('alpha_tool');
    expect(names).toContain('beta_tool');
  });

  // --- tools/call ---

  it('tools/call dispatches to registry and returns result', async () => {
    registry.register(
      makeTool({
        name: 'echo_tool',
        schema: z.object({ message: z.string() }),
        handler: async (params) => `echoed: ${params['message']}`,
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo_tool', arguments: { message: 'hello' } },
    }) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };

    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toContain('echoed: hello');
  });

  // --- notifications ---

  it('notification (no id field) gets no response', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Send a notification (no id), then a regular request. Only the second should get a response.
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const client = createConnection(socketPath, () => {
        // First: notification (no id)
        client.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        // Second: real request
        client.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }) + '\n');
      });
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line) as { id?: unknown };
              // Only resolve on the actual request response (id: 99)
              if (parsed.id === 99) {
                resolve(parsed);
                client.end();
              }
            } catch {
              // partial
            }
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });

    const response = await responsePromise as { id: number; result: unknown };
    expect(response.id).toBe(99);
    expect(response.result).toBeDefined();
  });

  // --- unknown method ---

  it('unknown method returns JSON-RPC error -32601', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 4,
      method: 'no_such_method',
      params: {},
    }) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toMatch(/no_such_method/);
  });

  // --- socket cleanup on startup ---

  it('handles stale socket file and starts successfully (crash recovery)', async () => {
    // Create a stale socket file at the same path
    writeFileSync(socketPath, 'stale-content');
    expect(existsSync(socketPath)).toBe(true);

    // Server should unlink the stale file and bind without error
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Verify the server is functional after cleanup
    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 5,
      method: 'initialize',
      params: {},
    }) as { result: { protocolVersion: string } };

    expect(response.result.protocolVersion).toBe('2024-11-05');
  });

  // --- updateDeliveryJid ---

  it('updateDeliveryJid updates session context', () => {
    session = makeSession({ tier: 'chat-scoped' });
    server = new WhatSoupSocketServer(socketPath, registry, session);

    expect(session.deliveryJid).toBeUndefined();
    server.updateDeliveryJid('18001234567@s.whatsapp.net');
    expect(session.deliveryJid).toBe('18001234567@s.whatsapp.net');
  });

  it('updateDeliveryJid affects tool calls after update', async () => {
    let capturedJid: unknown;
    session = makeSession({ tier: 'chat-scoped', conversationKey: '18001234567', deliveryJid: 'old@s.whatsapp.net' });

    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string() }),
        handler: async (params) => {
          capturedJid = params['chatJid'];
          return 'ok';
        },
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    server.updateDeliveryJid('18001234567@s.whatsapp.net');

    await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'injected_tool', arguments: {} },
    });

    expect(capturedJid).toBe('18001234567@s.whatsapp.net');
  });

  // --- multiple concurrent connections ---

  it('handles multiple concurrent connections independently', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const [r1, r2] = await Promise.all([
      sendJsonRpc(socketPath, { jsonrpc: '2.0', id: 10, method: 'initialize', params: {} }),
      sendJsonRpc(socketPath, { jsonrpc: '2.0', id: 11, method: 'initialize', params: {} }),
    ]) as Array<{ id: number; result: { protocolVersion: string } }>;

    expect(r1.result.protocolVersion).toBe('2024-11-05');
    expect(r2.result.protocolVersion).toBe('2024-11-05');
    // Each connection responded to its own request id
    const ids = [r1.id, r2.id];
    expect(ids).toContain(10);
    expect(ids).toContain(11);
  });
});
