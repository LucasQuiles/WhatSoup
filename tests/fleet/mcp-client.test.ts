import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mcpCall } from '../../src/fleet/mcp-client.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory and return a socket path inside it. */
function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-client-test-'));
  return join(dir, 'test.sock');
}

interface MockServerOptions {
  /** Called for each incoming JSON-RPC request. Return the response object to send back. */
  onRequest?: (msg: { jsonrpc: string; id: number | string; method: string; params?: unknown }) => unknown;
  /** If true, accept connections but never respond. */
  silent?: boolean;
  /** If true, close the connection immediately after accept. */
  closeImmediately?: boolean;
}

interface MockServer {
  server: Server;
  /** Destroy all connections and close the server. */
  destroy: () => Promise<void>;
}

/**
 * Start a mock JSON-RPC server on a Unix socket.
 * Returns the server and a destroy function for reliable cleanup.
 */
function startMockServer(
  socketPath: string,
  opts: MockServerOptions = {},
): Promise<MockServer> {
  return new Promise((resolve) => {
    const connections = new Set<Socket>();

    const server = createServer((socket) => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));

      if (opts.closeImmediately) {
        socket.destroy();
        return;
      }

      if (opts.silent) return;

      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            if (opts.onRequest) {
              const response = opts.onRequest(msg);
              if (response !== undefined) {
                socket.write(JSON.stringify(response) + '\n');
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      });
    });

    const destroy = (): Promise<void> => {
      for (const conn of connections) conn.destroy();
      connections.clear();
      return new Promise<void>((res) => server.close(() => res()));
    };

    server.listen(socketPath, () => resolve({ server, destroy }));
  });
}

/**
 * Default mock handler that mimics the WhatSoup MCP socket-server protocol.
 */
function defaultHandler(toolResult: unknown = { content: [{ type: 'text', text: 'ok' }] }) {
  return (msg: { jsonrpc: string; id: number | string; method: string; params?: unknown }) => {
    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'whatsoup', version: '0.1.0' },
          },
        };
      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: toolResult,
        };
      default:
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcpCall', () => {
  const mocks: MockServer[] = [];

  afterEach(async () => {
    await Promise.all(mocks.map((m) => m.destroy()));
    mocks.length = 0;
  });

  // --- successful tool call ---

  it('completes a successful tool call through initialize + tools/call', async () => {
    const socketPath = makeSocketPath();
    const toolResult = { content: [{ type: 'text', text: 'hello from tool' }] };
    const mock = await startMockServer(socketPath, {
      onRequest: defaultHandler(toolResult),
    });
    mocks.push(mock);

    const result = await mcpCall(socketPath, 'send_message', { text: 'hi' });

    expect(result.success).toBe(true);
    expect(result.result).toEqual(toolResult);
  });

  // --- tool call returning error ---

  it('returns error when server responds with JSON-RPC error', async () => {
    const socketPath = makeSocketPath();
    const mock = await startMockServer(socketPath, {
      onRequest: (msg) => {
        if (msg.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'whatsoup', version: '0.1.0' },
            },
          };
        }
        if (msg.method === 'tools/call') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32603, message: 'Internal error: tool exploded' },
          };
        }
        return undefined;
      },
    });
    mocks.push(mock);

    const result = await mcpCall(socketPath, 'broken_tool', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('tool exploded');
  });

  // --- timeout ---

  it('resolves with timeout error when server never responds', async () => {
    const socketPath = makeSocketPath();
    const mock = await startMockServer(socketPath, { silent: true });
    mocks.push(mock);

    const result = await mcpCall(socketPath, 'any_tool', {}, 200);

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
  });

  // --- connection error ---

  it('resolves with error when socket does not exist', async () => {
    const socketPath = makeSocketPath(); // no server listening

    const result = await mcpCall(socketPath, 'any_tool', {}, 1_000);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  // --- server closes connection unexpectedly ---

  it('resolves with error when server closes connection immediately', async () => {
    const socketPath = makeSocketPath();
    const mock = await startMockServer(socketPath, { closeImmediately: true });
    mocks.push(mock);

    const result = await mcpCall(socketPath, 'any_tool', {}, 2_000);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
