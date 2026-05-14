import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-expect-error -- hook libraries are JavaScript modules imported by Node hooks; expires 2026-08-14
import { callTool } from '../../deploy/hooks/lib/whatsoup-mcp-call.mjs';

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface MockServer {
  dir: string;
  socketPath: string;
  received: JsonRpcRequest[];
  close: () => Promise<void>;
}

const servers: MockServer[] = [];

function makeSocketPath(): { dir: string; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rgp-mcp-call-'));
  return { dir, socketPath: join(dir, 'whatsoup.sock') };
}

async function startMockServer(
  handler: (request: JsonRpcRequest, socket: Socket) => unknown,
): Promise<MockServer> {
  const { dir, socketPath } = makeSocketPath();
  const received: JsonRpcRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as JsonRpcRequest;
        received.push(request);
        const response = handler(request, socket);
        if (response !== undefined) {
          socket.write(`${JSON.stringify(response)}\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  };

  return { dir, socketPath, received, close };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function mcpHandler(toolResult: unknown) {
  return (request: JsonRpcRequest) => {
    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'whatsoup', version: '0.1.0' },
        },
      };
    }
    if (request.method === 'tools/call') {
      return { jsonrpc: '2.0', id: request.id, result: toolResult };
    }
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'not found' } };
  };
}

describe('whatsoup-mcp-call', () => {
  it('returns ok=false for a missing socket path without throwing', async () => {
    const { socketPath, dir } = makeSocketPath();
    rmSync(dir, { recursive: true, force: true });

    const result = await callTool({ socketPath, name: 'send_message', args: {}, timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/socket missing|ENOENT|connect/i);
  });

  it('returns ok=false when socketPath is empty', async () => {
    const result = await callTool({ socketPath: '', name: 'send_message', args: {}, timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/socketPath/i);
  });

  it('performs initialize before tools/call on a real Unix socket', async () => {
    const server = await startMockServer(mcpHandler({ content: [{ type: 'text', text: 'sent' }] }));
    servers.push(server);

    const result = await callTool({
      socketPath: server.socketPath,
      name: 'send_message',
      args: { chatJid: 'chat@g.us', text: 'hi' },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ ok: true, result: { content: [{ type: 'text', text: 'sent' }] } });
    expect(server.received.map((request) => request.method)).toEqual(['initialize', 'tools/call']);
    expect((server.received[1].params as { name?: string }).name).toBe('send_message');
    expect((server.received[1].params as { arguments?: unknown }).arguments).toEqual({ chatJid: 'chat@g.us', text: 'hi' });
  });

  it('surfaces MCP tool-level isError separately from transport failure', async () => {
    const server = await startMockServer(mcpHandler({ isError: true, content: [{ type: 'text', text: 'invalid params' }] }));
    servers.push(server);

    const result = await callTool({ socketPath: server.socketPath, name: 'send_message', args: {}, timeoutMs: 1_000 });

    expect(result).toMatchObject({ ok: true, toolError: true });
  });

  it('returns ok=false for JSON-RPC errors', async () => {
    const server = await startMockServer((request) => {
      if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: {} };
      return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'tool exploded' } };
    });
    servers.push(server);

    const result = await callTool({ socketPath: server.socketPath, name: 'send_message', args: {}, timeoutMs: 1_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('tool exploded');
  });

  it('times out when the server does not return a tools/call response', async () => {
    const server = await startMockServer((request) => {
      if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: {} };
      return undefined;
    });
    servers.push(server);

    const result = await callTool({ socketPath: server.socketPath, name: 'send_message', args: {}, timeoutMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });

  it('treats malformed JSON from the server as a bounded transport failure', async () => {
    const server = await startMockServer((request, socket) => {
      if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: {} };
      socket.write('not-json\n');
      return undefined;
    });
    servers.push(server);

    const result = await callTool({ socketPath: server.socketPath, name: 'send_message', args: {}, timeoutMs: 1_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/malformed JSON-RPC response/i);
  });
});
