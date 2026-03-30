import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PATH = join(__dirname, '../../deploy/mcp/whatsoup-proxy.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSocketPath(): string {
  return join(tmpdir(), `proxy-test-${process.pid}-${Date.now()}.sock`);
}

/**
 * Start a mock Unix socket server that echoes each newline-delimited JSON line
 * back verbatim.
 */
function startEchoServer(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            conn.write(line + '\n');
          }
        }
      });
      conn.on('error', () => { /* ignore client disconnects */ });
    });

    server.listen(socketPath, () => resolve(server));
    server.on('error', reject);
  });
}

/**
 * Spawn the proxy as a child process with WHATSOUP_SOCKET set.
 */
function spawnProxy(socketPath: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', PROXY_PATH],
    {
      env: { ...process.env, WHATSOUP_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

/**
 * Send a line to the proxy stdin and collect the first non-empty stdout line.
 * Rejects after timeoutMs.
 */
function sendAndReceive(
  proxy: ChildProcessWithoutNullStreams,
  message: unknown,
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timeout waiting for proxy response')), timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          clearTimeout(timer);
          proxy.stdout.off('data', onData);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error(`Invalid JSON from proxy: ${line}`));
          }
          return;
        }
      }
    };

    proxy.stdout.on('data', onData);
    proxy.stdin.write(JSON.stringify(message) + '\n');
  });
}

/**
 * Collect the first non-empty stdout line from the proxy without sending input.
 */
function collectFirstLine(
  proxy: ChildProcessWithoutNullStreams,
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timeout waiting for proxy output')), timeoutMs);

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          clearTimeout(timer);
          proxy.stdout.off('data', onData);
          try {
            resolve(JSON.parse(line));
          } catch {
            reject(new Error(`Invalid JSON from proxy: ${line}`));
          }
          return;
        }
      }
    };

    proxy.stdout.on('data', onData);
  });
}

/**
 * Wait for socket file to appear.
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

describe('whatsoup-proxy', () => {
  let server: Server | null = null;
  let proxy: ChildProcessWithoutNullStreams | null = null;
  let socketPath: string;

  beforeEach(() => {
    socketPath = makeSocketPath();
  });

  afterEach(async () => {
    if (proxy) {
      proxy.stdin.end();
      proxy.kill();
      proxy = null;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    // Brief pause to let OS release the socket
    await new Promise((r) => setTimeout(r, 30));
  });

  it('relays JSON-RPC from stdin to socket and response back to stdout', async () => {
    server = await startEchoServer(socketPath);

    proxy = spawnProxy(socketPath);

    const msg = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
    const response = await sendAndReceive(proxy, msg) as Record<string, unknown>;

    // Echo server returns the same object we sent
    expect(response).toEqual(msg);
  });

  it('relays multiple sequential messages correctly', async () => {
    server = await startEchoServer(socketPath);
    proxy = spawnProxy(socketPath);

    const msg1 = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const msg2 = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'foo' } };

    const r1 = await sendAndReceive(proxy, msg1) as Record<string, unknown>;
    const r2 = await sendAndReceive(proxy, msg2) as Record<string, unknown>;

    expect(r1).toEqual(msg1);
    expect(r2).toEqual(msg2);
  });

  it('outputs JSON-RPC error to stdout on bad socket path', async () => {
    const badSocketPath = join(tmpdir(), 'nonexistent-proxy-test.sock');

    proxy = spawnProxy(badSocketPath);

    const response = await collectFirstLine(proxy) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };

    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    expect(typeof response.error.code).toBe('number');
    expect(typeof response.error.message).toBe('string');
    expect(response.error.message).toMatch(/socket/i);
  });

  it('exits cleanly when stdin closes', async () => {
    server = await startEchoServer(socketPath);
    proxy = spawnProxy(socketPath);

    // Wait for socket to be ready by sending one round-trip
    const msg = { jsonrpc: '2.0', id: 99, method: 'ping', params: {} };
    await sendAndReceive(proxy, msg);

    // Close stdin and expect the proxy to exit
    const exitCode = await new Promise<number | null>((resolve) => {
      proxy!.on('exit', (code) => resolve(code));
      proxy!.stdin.end();
    });

    // Exit code should be 0 or null (signal)
    expect(exitCode === 0 || exitCode === null).toBe(true);
  });

  it('proxy is missing WHATSOUP_SOCKET env — exits with error on stdout', async () => {
    // Spawn without WHATSOUP_SOCKET set
    proxy = spawn(
      process.execPath,
      ['--experimental-strip-types', PROXY_PATH],
      {
        env: { ...process.env, WHATSOUP_SOCKET: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const response = await collectFirstLine(proxy) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };

    expect(response.jsonrpc).toBe('2.0');
    expect(response.error).toBeDefined();
    expect(response.error.message).toMatch(/WHATSOUP_SOCKET/i);
  });
});
