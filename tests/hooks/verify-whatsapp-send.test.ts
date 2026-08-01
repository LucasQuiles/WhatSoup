import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const HOOK = join(process.cwd(), 'deploy/hooks/verify-whatsapp-send.mjs');

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: {
    name?: string;
    arguments?: unknown;
  };
}

interface MockServer {
  dir: string;
  socketPath: string;
  received: JsonRpcRequest[];
  close: () => Promise<void>;
}

const tmp = trackTmpDirs('');
const servers: MockServer[] = [];

function makeTempDir(name: string): string {
  return tmp.make(name);
}

async function runHook(payload: unknown, env: Record<string, string>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function hookEnv(home: string, socketPath: string): Record<string, string> {
  return {
    HOME: home,
    WHATSOUP_INSTANCE: 'ana-bot',
    WHATSOUP_MCP_SOCKET: socketPath,
  };
}

function sessionDir(home: string, sessionId: string): string {
  return join(home, '.claude', 'session-env', sessionId);
}

function readHookJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const jsonStart = line.indexOf('{');
      return JSON.parse(jsonStart >= 0 ? line.slice(jsonStart) : line);
    });
}

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

async function startMockServer(handler: (request: JsonRpcRequest, socket: Socket) => unknown): Promise<MockServer> {
  const dir = makeTempDir('rgp-send-verify-socket');
  const socketPath = join(dir, 'whatsoup.sock');
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
  };

  const mockServer = { dir, socketPath, received, close };
  servers.push(mockServer);
  return mockServer;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('verify-whatsapp-send hook', () => {
  const auditReceipt = '0123456789abcdef0123456789abcdef';

  it('confirms the exact successful receipt without destination fallback', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer(mcpHandler({
      outbound_sends: [{
        id: 42,
        audit_receipt: auditReceipt,
        outcome_code: 'submitted',
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }],
    }));

    const result = await runHook({
      session_id: 'session-a',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us', text: 'hello' },
      tool_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, audit_receipt: auditReceipt }),
        }],
      },
    }, hookEnv(home, server.socketPath));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readHookJsonl(join(sessionDir(home, 'session-a'), 'send-verification.jsonl'))).toEqual([]);
    expect(server.received.map((request) => request.method)).toEqual(['initialize', 'tools/call']);
    expect(server.received[1].params?.name).toBe('read_outbound_sends');
    expect(server.received[1].params?.arguments).toEqual({ limit: 25, auditReceipt });
  });

  it('verifies a successful receipt when the sent text contains failure words', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer(mcpHandler({
      outbound_sends: [{
        audit_receipt: auditReceipt,
        outcome_code: 'submitted',
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }],
    }));

    const result = await runHook({
      session_id: 'session-failure-words',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            text: 'error: the previous attempt failed with invalid parameters and EACCES/ENOENT',
            audit_receipt: auditReceipt,
          }),
        }],
      },
    }, hookEnv(home, server.socketPath));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(server.received.map((request) => request.method)).toEqual(['initialize', 'tools/call']);
    expect(readHookJsonl(
      join(sessionDir(home, 'session-failure-words'), 'verify-whatsapp-send.log'),
    ).at(-1)).toMatchObject({ event: 'verified', auditReceipt });
  });

  it('reports an unverified send once per session/tool/receipt without raw destination', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer(mcpHandler({ outbound_sends: [] }));
    const payload = {
      session_id: 'session-b',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us', text: 'hello' },
      tool_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, audit_receipt: auditReceipt }),
        }],
      },
    };
    const env = hookEnv(home, server.socketPath);

    const first = await runHook(payload, env);
    const second = await runHook(payload, env);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stderr).toContain('could not confirm');
    expect(second.stderr).toBe('');
    const entries = readHookJsonl(join(sessionDir(home, 'session-b'), 'send-verification.jsonl'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'send-unverified',
      sessionId: 'session-b',
      toolName: 'mcp__whatsoup__send_message',
      auditReceipt,
      instance: 'ana-bot',
      reason: 'no outbound_sends rows returned',
    });
    expect(JSON.stringify(entries)).not.toContain('chat@g.us');
  });

  it('skips reply_message because it has no audit receipt contract', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer(mcpHandler({ outbound_sends: [] }));

    const result = await runHook({
      session_id: 'session-c',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__reply_message',
      tool_input: { chatJid: 'chat@g.us', replyTo: 'msg-1', text: 'hello' },
      tool_response: { content: [{ type: 'text', text: JSON.stringify({ sent: true }) }] },
    }, hookEnv(home, server.socketPath));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(server.received).toEqual([]);
    expect(readHookJsonl(join(sessionDir(home, 'session-c'), 'verify-whatsapp-send.log')).at(-1))
      .toMatchObject({
        event: 'skip',
        reason: 'audit-receipt-unavailable',
        toolName: 'mcp__whatsoup__reply_message',
      });
  });

  it('rejects mismatched or ambiguous rows for the requested receipt', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer(mcpHandler({
      outbound_sends: [
        {
          audit_receipt: 'ffffffffffffffffffffffffffffffff',
          outcome_code: 'submitted',
          completed_at: new Date().toISOString(),
        },
        {
          audit_receipt: auditReceipt,
          outcome_code: 'ambiguous',
          completed_at: new Date().toISOString(),
        },
      ],
    }));

    const result = await runHook({
      session_id: 'session-d',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us', text: 'hello' },
      tool_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, audit_receipt: auditReceipt }),
        }],
      },
    }, hookEnv(home, server.socketPath));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not confirm');
    expect(readHookJsonl(join(sessionDir(home, 'session-d'), 'send-verification.jsonl')))
      .toEqual([
        expect.objectContaining({
          auditReceipt,
          reason: 'no recent successful outbound_sends receipt matched',
        }),
      ]);
  });

  it('degrades softly without leaking MCP errors when receipt lookup fails', async () => {
    const home = makeTempDir('rgp-send-verify-home');
    const server = await startMockServer((request) => {
      if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: {} };
      return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'database busy' } };
    });

    const result = await runHook({
      session_id: 'session-c',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__whatsoup__send_message',
      tool_input: { chatJid: 'chat@g.us', text: 'hello' },
      tool_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({ sent: true, audit_receipt: auditReceipt }),
        }],
      },
    }, hookEnv(home, server.socketPath));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(readHookJsonl(join(sessionDir(home, 'session-c'), 'send-verification.jsonl'))).toEqual([]);
    expect(readHookJsonl(join(sessionDir(home, 'session-c'), 'verify-whatsapp-send.log')).at(-1)).toMatchObject({
      event: 'read-failed',
      toolName: 'mcp__whatsoup__send_message',
      auditReceipt,
    });
    expect(JSON.stringify(readHookJsonl(
      join(sessionDir(home, 'session-c'), 'verify-whatsapp-send.log'),
    ))).not.toContain('database busy');
  });
});
