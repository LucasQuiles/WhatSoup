import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';
import { waitForSocket } from '../helpers/wait-for.ts';

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
 * QR-053: send a JSON-RPC line split into two raw TCP chunks at a chosen byte
 * offset, delivered as SEPARATE 'data' events (setImmediate between writes), and
 * return the first response line. Used to split a multibyte UTF-8 char across a
 * read boundary.
 */
function sendSplitAtByte(socketPath: string, msg: unknown, splitByte: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const full = Buffer.from(JSON.stringify(msg) + '\n', 'utf8');
    const a = full.subarray(0, splitByte);
    const b = full.subarray(splitByte);
    const client = createConnection(socketPath, () => {
      client.write(a);
      setTimeout(() => client.write(b), 40);
    });
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (line.trim()) { try { resolve(JSON.parse(line)); client.end(); } catch { /* partial */ } }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000);
  });
}

function sendRawJsonRpcLine(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(line + '\n');
    });
    let settled = false;
    let buf = '';

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      client.setTimeout(0);
      fn();
    };

    client.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const responseLine of lines) {
        if (!responseLine.trim()) continue;
        try {
          const parsed = JSON.parse(responseLine);
          settle(() => {
            resolve(parsed);
            client.end();
          });
        } catch {
          // partial
        }
      }
    });
    client.once('error', (err) => settle(() => reject(err)));
    client.setTimeout(500, () => {
      settle(() => {
        client.destroy();
        reject(new Error('timeout'));
      });
    });
  });
}

/**
 * Wait for the socket file to appear (server ready), then resolve.
 */


function waitForClientConnect(client: Socket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client connect timeout')), timeoutMs);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForClientClose(client: Socket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client close timeout')), timeoutMs);
    client.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('error', () => {
      // Remote destroy may surface as ECONNRESET before close. The close
      // event is the actual signal that the FD is gone, so ignore errors here.
    });
  });
}

function sendJsonRpcMessagesUntilId(socketPath: string, messages: unknown[], targetId: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      for (const msg of messages) {
        client.write(JSON.stringify(msg) + '\n');
      }
    });
    let settled = false;
    let buf = '';

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      client.setTimeout(0);
      fn();
    };

    client.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line) as { id?: unknown };
            if (parsed.id === targetId) {
              settle(() => {
                resolve(parsed);
                client.end();
              });
            }
          } catch {
            // partial
          }
        }
      }
    });
    client.once('error', (err) => settle(() => reject(err)));
    client.setTimeout(3000, () => {
      settle(() => {
        client.destroy();
        reject(new Error('timeout'));
      });
    });
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

  afterEach(() => {
    server?.stop();
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

  it('QR-059: applies a bounded concurrent-connection cap on start (defends against a connection flood)', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    // Before start there is no underlying server → cap reports 0.
    expect(server.maxConnections).toBe(0);

    server.start();
    await waitForSocket(socketPath);

    // After start a bounded positive cap is applied (node drops connections beyond it),
    // instead of the default unbounded acceptance the unfixed server used.
    expect(server.maxConnections).toBeGreaterThan(0);
    expect(server.maxConnections).toBeLessThanOrEqual(1024);

    // A normal single request still succeeds well under the cap.
    const response = await sendJsonRpc(socketPath, { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} }) as { id: number };
    expect(response.id).toBe(7);
  });

  it('treats an explicit id:null as a request (not a notification) and echoes null', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // id:null is not `undefined`, so the notification filter lets it through;
    // `req.id ?? null` then collapses null → null in the response (line 193 nullish arm).
    const response = (await sendRawJsonRpcLine(
      socketPath,
      JSON.stringify({ jsonrpc: '2.0', id: null, method: 'initialize', params: {} }),
    )) as { id: null; result: { protocolVersion: string } };

    expect(response.id).toBeNull();
    expect(response.result.protocolVersion).toBe('2024-11-05');
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

  it('QR-053: a multibyte UTF-8 char split across a socket read boundary is not corrupted', async () => {
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

    const message = 'AB\u{1F600}CD'; // grinning face = 4 bytes F0 9F 98 80
    const req = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo_tool', arguments: { message } } };
    const fullStr = JSON.stringify(req);
    const emojiByteStart = Buffer.byteLength(fullStr.slice(0, fullStr.indexOf('\u{1F600}')), 'utf8');
    const splitByte = emojiByteStart + 2; // split INSIDE the emoji (after 2 of its 4 bytes)

    const response = (await sendSplitAtByte(socketPath, req, splitByte)) as {
      result: { content: Array<{ text: string }> };
    };
    expect(response.result.content[0].text).toBe(`echoed: ${message}`);
  });

  it('QR-042: snapshots the session per request — a concurrent updateActorJid cannot race an in-flight tool', async () => {
    let started = false;
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    let observedActorJid: string | undefined = 'UNSET';

    registry.register(
      makeTool({
        name: 'slow_actor_tool',
        scope: 'global',
        schema: z.object({}),
        handler: async (_params, toolSession) => {
          started = true;
          await blocked;                            // stay in-flight across the racing mutation
          observedActorJid = toolSession.actorJid;  // read AFTER the concurrent updateActorJid
          return 'done';
        },
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, makeSession({ actorJid: 'actor-A' }));
    server.start();
    await waitForSocket(socketPath);

    // Dispatch the tool call; the handler blocks and stays in-flight.
    const callPromise = sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'slow_actor_tool', arguments: {} },
    });
    await vi.waitFor(() => { expect(started).toBe(true); });

    // Next-turn mutation while the previous turn's tool is still in-flight (the QR-042 race window).
    server.updateActorJid('actor-B');

    // Unblock → the handler now reads its session's actorJid.
    release();
    await callPromise;

    // The in-flight tool MUST observe its dispatch-time actor ('actor-A'), not the racing 'actor-B'.
    // Without the per-request snapshot it reads the shared, mutated connSession → 'actor-B'.
    expect(observedActorJid).toBe('actor-A');
  });

  // --- notifications ---

  it('notification (no id field) gets no response', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Send a notification (no id), then a regular request. Only the second should get a response.
    const response = await sendJsonRpcMessagesUntilId(socketPath, [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 99, method: 'initialize', params: {} },
    ], 99) as {
      id: number;
      result: {
        protocolVersion: string;
        capabilities: { tools: Record<string, never> };
        serverInfo: { name: string; version: string };
      };
    };
    expect(response.id).toBe(99);
    expect(response.result).toEqual({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'whatsoup', version: '0.1.0' },
    });
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

  it('malformed JSON returns JSON-RPC parse error -32700', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendRawJsonRpcLine(socketPath, '{"jsonrpc":"2.0","id":1,') as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
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

  // --- SP11: Per-connection session isolation ---

  it('SP11: concurrent connections hold isolated delivery contexts', async () => {
    // Register an injected-mode tool that captures the deliveryJid from the session
    const capturedJids: string[] = [];
    registry.register(
      makeTool({
        name: 'capture_jid',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string() }),
        handler: async (params) => {
          capturedJids.push(params['chatJid'] as string);
          return 'ok';
        },
      }),
    );

    session = makeSession({
      tier: 'chat-scoped',
      conversationKey: 'conv1',
      deliveryJid: 'initial@s.whatsapp.net',
    });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Both connections start with the same deliveryJid
    const [r1, r2] = await Promise.all([
      sendJsonRpc(socketPath, {
        jsonrpc: '2.0', id: 100, method: 'tools/call',
        params: { name: 'capture_jid', arguments: {} },
      }),
      sendJsonRpc(socketPath, {
        jsonrpc: '2.0', id: 101, method: 'tools/call',
        params: { name: 'capture_jid', arguments: {} },
      }),
    ]);

    // Both should have seen the initial JID
    expect(capturedJids).toHaveLength(2);
    expect(capturedJids[0]).toBe('initial@s.whatsapp.net');
    expect(capturedJids[1]).toBe('initial@s.whatsapp.net');
  });

  // --- updateActorJid ---

  it('updateActorJid updates base session actorJid', () => {
    session = makeSession({ tier: 'global' });
    server = new WhatSoupSocketServer(socketPath, registry, session);

    expect(session.actorJid).toBeUndefined();
    server.updateActorJid('user-1@s.whatsapp.net');
    expect(session.actorJid).toBe('user-1@s.whatsapp.net');
  });

  it('updateActorJid undefined clears actorJid', () => {
    session = makeSession({ tier: 'global', actorJid: 'old@s.whatsapp.net' });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.updateActorJid(undefined);
    expect(session).toEqual({ tier: 'global', actorJid: undefined });
  });

  it('updateConversationKey updates the base session', () => {
    session = makeSession({ tier: 'global' });
    server = new WhatSoupSocketServer(socketPath, registry, session);

    server.updateConversationKey('room-a_at_g.us');

    expect(session.conversationKey).toBe('room-a_at_g.us');
  });

  it('updateConversationKey propagates to a live connection and blocks cross-conversation injected calls', async () => {
    registry.register(
      makeTool({
        name: 'bound_send',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => ({ sentTo: params['chatJid'] }),
      }),
    );
    session = makeSession({ tier: 'global' });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);
    await vi.waitFor(() => { expect(server.connectionCount).toBe(1); });

    server.updateConversationKey('room-a_at_g.us');

    const crossConversation = await new Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }>((resolve, reject) => {
      client.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 62,
        method: 'tools/call',
        params: {
          name: 'bound_send',
          arguments: { chatJid: 'room-b@g.us', message: 'nope' },
        },
      }) + '\n');
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try { resolve(JSON.parse(line)); client.end(); } catch { /* partial */ }
        }
      });
      client.on('error', reject);
    });

    client.destroy();

    expect(crossConversation.result.isError).toBe(true);
    expect(crossConversation.result.content[0].text).toMatch(/does not match session conversation/);
  });

  it('SP11: updateDeliveryJid propagates to all active connections', async () => {
    const capturedJids: string[] = [];
    registry.register(
      makeTool({
        name: 'capture_jid2',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string() }),
        handler: async (params) => {
          capturedJids.push(params['chatJid'] as string);
          return 'ok';
        },
      }),
    );

    session = makeSession({
      tier: 'chat-scoped',
      conversationKey: 'conv2',
      deliveryJid: 'before@s.whatsapp.net',
    });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Update the JID after connections would be established
    server.updateDeliveryJid('after@s.whatsapp.net');

    // New connections should see the updated JID
    const r = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 200, method: 'tools/call',
      params: { name: 'capture_jid2', arguments: {} },
    });

    expect(capturedJids).toHaveLength(1);
    expect(capturedJids[0]).toBe('after@s.whatsapp.net');
  });

  it('SP11: connectionCount tracks active connections', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    expect(server.connectionCount).toBe(0);

    server.start();
    await waitForSocket(socketPath);

    // Connect and immediately get a response (which closes the connection)
    await sendJsonRpc(socketPath, { jsonrpc: '2.0', id: 300, method: 'initialize', params: {} });

    await vi.waitFor(() => {
      expect(server.connectionCount).toBe(0);
    });
  });

  it('stop destroys active client connections', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);
    await vi.waitFor(() => {
      expect(server.connectionCount).toBe(1);
    });

    server.stop();

    try {
      await waitForClientClose(client);
    } finally {
      client.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('socket-server.ts uncovered-branch coverage', () => {
  let server: WhatSoupSocketServer;
  let registry: ToolRegistry;
  let session: SessionContext;
  let socketPath: string;

  beforeEach(() => {
    socketPath = makeSocketPath();
    registry = new ToolRegistry();
    session = makeSession();
  });

  afterEach(() => {
    server?.stop();
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  });

  // --- buffer overflow DoS guard (src line 88-92) ---

  it('closes the connection when the receive buffer exceeds 1 MB', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);

    // Send > 1 MB without a newline so the buffer guard fires.
    const oversized = 'x'.repeat(1_024 * 1_024 + 1);
    client.write(oversized);

    await waitForClientClose(client, 2000);
    // Terminal assertion: server recorded no connection after the destroy.
    await vi.waitFor(() => {
      expect(server.connectionCount).toBe(0);
    });
  });

  // --- handleRequest catch -> -32603 Internal error (src line 236-244) ---
  // registry.call swallows tool-handler errors, so we force listTools() to
  // throw by registering a tool whose schema serialisation throws. The
  // resulting synchronous throw bubbles up through handleRequest's try block.

  it('returns JSON-RPC internal error -32603 when the handler throws synchronously', async () => {
    // A schema whose .describe introspection path throws during listTools.
    const throwingSchema = {
      get description() { throw new Error('schema boom'); },
      // satisfy ToolDeclaration.schema typing at runtime; listTools uses zodToJsonSchema
      // which falls through to the fallback branch once it stops matching Zod types,
      // but buildListSchema reads schema.description via withZodDescription first.
    } as unknown as import('zod').ZodType;

    registry.register(
      makeTool({
        name: 'boom_tool',
        description: 'boom',
        schema: throwingSchema,
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: {},
    }) as { id: number; error: { code: number; message: string } };

    expect(response.id).toBe(7);
    expect(response.error.code).toBe(-32603);
    expect(response.error.message).toMatch(/Internal error \[E/);
  });

  // --- tools/call with no name (src line 219 defaulting `name ?? ''`) ---

  it('tools/call with missing name falls back to empty name and yields Unknown tool error', async () => {
    registry.register(makeTool({ name: 'real_tool', description: 'real' }));

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { arguments: {} },
    }) as { result: { content: Array<{ text: string }>; isError: boolean } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Unknown tool:');
  });

  // --- tools/call with no params at all (src line 218-220 defaulting) ---

  it('tools/call without params defaults name and arguments, yielding Unknown tool', async () => {
    registry.register(
      makeTool({
        name: 'noargs_tool',
        scope: 'global',
        targetMode: 'caller-supplied',
        schema: z.object({}),
        handler: async () => 'ok-noargs',
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // No `params` key — handler defaults name='' and arguments={}, which the
    // registry resolves to "Unknown tool" rather than throwing.
    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
    }) as { result: { content: Array<{ text: string }>; isError: boolean } };

    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('Unknown tool:');
  });

  // --- updateDeliveryJid / updateActorJid with no active connections ---
  // Exercises the for...of 0-iteration branch (src lines 174-176, 187-189)
  // alongside a connection to also cover the >=1 iteration branch.

  it('updateDeliveryJid and updateActorJid propagate to base session with no connections', () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();

    server.updateDeliveryJid('15550000000@s.whatsapp.net');
    server.updateActorJid('15550000001@s.whatsapp.net');

    expect(session.deliveryJid).toBe('15550000000@s.whatsapp.net');
    expect(session.actorJid).toBe('15550000001@s.whatsapp.net');
  });

  it('updateActorJid clears actorJid on the base session with no connections', () => {
    session = makeSession({ tier: 'global', actorJid: '15550000002@s.whatsapp.net' });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();

    server.updateActorJid(undefined);

    expect(session).toEqual({ tier: 'global', actorJid: undefined });
  });

  // --- updateDeliveryJid / updateActorJid propagation to an active connection ---
  // Covers src lines 174-176 and 187-189 (the per-session assignment inside the
  // for...of loop, which only runs when connectionSessions is non-empty).

  it('updateDeliveryJid propagates to a live connection session via a tool call', async () => {
    const captured: string[] = [];
    registry.register(
      makeTool({
        name: 'jid_probe',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string() }),
        handler: async (params) => { captured.push(params['chatJid'] as string); return 'ok'; },
      }),
    );
    session = makeSession({
      tier: 'chat-scoped',
      conversationKey: 'probe1',
      deliveryJid: 'old-probe@s.whatsapp.net',
    });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Hold an open connection while we update the JID.
    const client = createConnection(socketPath);
    await waitForClientConnect(client);
    await vi.waitFor(() => { expect(server.connectionCount).toBe(1); });

    server.updateDeliveryJid('new-probe@s.whatsapp.net');

    // Drive the live connection's session through the registry.
    const response = await new Promise<unknown>((resolve, reject) => {
      client.write(JSON.stringify({
        jsonrpc: '2.0', id: 60, method: 'tools/call',
        params: { name: 'jid_probe', arguments: {} },
      }) + '\n');
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try { resolve(JSON.parse(line)); client.end(); } catch { /* partial */ }
        }
      });
      client.on('error', reject);
    });

    client.destroy();

    expect(captured).toEqual(['new-probe@s.whatsapp.net']);
    expect(response).toMatchObject({ id: 60 });
  });

  it('updateActorJid propagates to a live connection session', async () => {
    registry.register(
      makeTool({
        name: 'actor_probe',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string() }),
        handler: async (_params, sess) => { return sess.actorJid ?? '<none>'; },
      }),
    );
    session = makeSession({
      tier: 'chat-scoped',
      conversationKey: 'probe2',
      deliveryJid: '15550000003@s.whatsapp.net',
    });
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);
    await vi.waitFor(() => { expect(server.connectionCount).toBe(1); });

    server.updateActorJid('15550000004@s.whatsapp.net');

    const response = await new Promise<{ result: { content: Array<{ text: string }> } }>((resolve, reject) => {
      client.write(JSON.stringify({
        jsonrpc: '2.0', id: 61, method: 'tools/call',
        params: { name: 'actor_probe', arguments: {} },
      }) + '\n');
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try { resolve(JSON.parse(line)); client.end(); } catch { /* partial */ }
        }
      });
      client.on('error', reject);
    });

    client.destroy();

    expect(response.result.content[0].text).toContain('15550000004@s.whatsapp.net');
  });

  // --- stop() idempotency: stop() before start() (src line 156 `if (this.server)`) ---

  it('stop() before start() is a no-op (server is null)', () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    expect(() => server.stop()).not.toThrow();
    // Re-stop after a started server to also cover the null-out path.
    server.start();
    server.stop();
    expect(() => server.stop()).not.toThrow();
    // Final concrete state check: no connections and socket file cleaned up.
    expect(server.connectionCount).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  });

  // --- stop() unlinkSync catch when socket file already removed (src line 161) ---

  it('stop() tolerates an already-removed socket file', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    // Remove the socket file out from under the server before stop().
    try { unlinkSync(socketPath); } catch { /* ignore */ }

    expect(() => server.stop()).not.toThrow();
    expect(server.connectionCount).toBe(0);
  });

  // --- blank/whitespace lines inside a frame are skipped (src line 99) ---

  it('blank lines embedded between JSON-RPC frames are skipped without response', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpcMessagesUntilId(socketPath, [
      { jsonrpc: '2.0', id: 11, method: 'initialize', params: {} },
      // interleave a literal blank/whitespace line
      '   ',
      '',
      { jsonrpc: '2.0', id: 12, method: 'initialize', params: {} },
    ], 12) as { id: number; result: { protocolVersion: string } };

    expect(response.id).toBe(12);
    expect(response.result.protocolVersion).toBe('2024-11-05');
  });

  // --- multiple JSON-RPC frames in a single data chunk (src line 93 split) ---

  it('parses multiple newline-delimited frames delivered in one chunk', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);

    const batch = [
      JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'initialize', params: {} }),
    ].join('\n') + '\n';

    const responses: Array<{ id: number; result: { protocolVersion: string } }> = await new Promise((resolve, reject) => {
      const seen: Array<{ id: number; result: { protocolVersion: string } }> = [];
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as { id: number; result: { protocolVersion: string } };
            seen.push(parsed);
            if (seen.length === 3) resolve(seen);
          } catch { /* partial */ }
        }
      });
      client.on('error', reject);
      client.write(batch);
    });

    client.destroy();

    const ids = responses.map((r) => r.id).sort();
    expect(ids).toEqual([20, 21, 22]);
    expect(responses.every((r) => r.result.protocolVersion === '2024-11-05')).toBe(true);
  });

  // --- partial-then-complete frame (buffer reassembly, src line 95 `?? ''`) ---

  it('reassembles a frame split across two data chunks', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const client = createConnection(socketPath);
    await waitForClientConnect(client);

    const full = JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'initialize', params: {} });
    const half = Math.floor(full.length / 2);

    const response = await new Promise<{ id: number; result: { protocolVersion: string } }>((resolve, reject) => {
      client.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.trim()) continue;
          try {
            resolve(JSON.parse(line));
          } catch { /* partial */ }
        }
      });
      client.on('error', reject);
      // Write first half (no newline), then second half with newline on the
      // next event-loop tick so the server sees two separate data chunks.
      client.write(full.slice(0, half));
      setImmediate(() => client.write(full.slice(half) + '\n'));
    });

    client.destroy();

    expect(response.id).toBe(30);
    expect(response.result.protocolVersion).toBe('2024-11-05');
  });

  // --- start() unlinkSync no-op when socket file absent (src line 60) ---

  it('start() is harmless when the target socket path does not exist yet', async () => {
    server = new WhatSoupSocketServer(socketPath, registry, session);
    expect(() => server.start()).not.toThrow();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 40, method: 'initialize', params: {},
    }) as { result: { protocolVersion: string } };

    expect(response.result.protocolVersion).toBe('2024-11-05');
  });

  // --- tools/call handler rejection surfaces as ToolError, not -32603 ---
  // Guards against regression: registry.call catches handler throws, so the
  // socket layer returns a ToolError payload (isError: true) rather than the
  // JSON-RPC internal-error envelope.

  it('tools/call whose handler rejects yields an isError result, not a JSON-RPC error', async () => {
    registry.register(
      makeTool({
        name: 'reject_tool',
        scope: 'global',
        targetMode: 'caller-supplied',
        schema: z.object({}),
        handler: async () => { throw new Error('handler failure'); },
      }),
    );

    server = new WhatSoupSocketServer(socketPath, registry, session);
    server.start();
    await waitForSocket(socketPath);

    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 50, method: 'tools/call',
      params: { name: 'reject_tool', arguments: {} },
    }) as { id: number; result: { content: Array<{ text: string }>; isError: boolean }; error?: unknown };

    expect(response.id).toBe(50);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('handler failure');
  });
});
