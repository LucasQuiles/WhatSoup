import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  handleMessage,
  resolveAllowedRoot,
  sendToBridge,
  validatePath,
} from '../../deploy/mcp/send-media-server.ts';

interface MockBridge {
  dir: string;
  socketPath: string;
  received: unknown[];
  close: () => Promise<void>;
}

const tmpDirs: string[] = [];
const bridges: MockBridge[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startBridge(response: unknown | ((request: unknown, socket: Socket) => unknown)): Promise<MockBridge> {
  const dir = makeTempDir('send-media-bridge-');
  const socketPath = join(dir, 'media.sock');
  const received: unknown[] = [];
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
        const request = JSON.parse(line);
        received.push(request);
        const payload = typeof response === 'function' ? response(request, socket) : response;
        if (payload !== undefined) socket.write(`${JSON.stringify(payload)}\n`);
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));

  const bridge = {
    dir,
    socketPath,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
  bridges.push(bridge);
  return bridge;
}

function makeResponder() {
  const responses: Array<{ id: unknown; result: unknown }> = [];
  const errors: Array<{ id: unknown; code: number; message: string }> = [];
  return {
    responses,
    errors,
    opts: {
      respondImpl: (id: unknown, result: unknown) => responses.push({ id, result }),
      respondErrorImpl: (id: unknown, code: number, message: string) => errors.push({ id, code, message }),
    },
  };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('send-media MCP stdio server helpers', () => {
  it('resolves the allowed root from sandbox policy and falls back on malformed policy', async () => {
    const home = makeTempDir('send-media-home-');
    const bridgeDir = makeTempDir('send-media-policy-');
    const allowed = join(home, 'workspace');
    mkdirSync(allowed, { recursive: true });
    writeFileSync(join(bridgeDir, 'sandbox-policy.json'), JSON.stringify({ allowedPaths: ['~/workspace'] }));

    await withEnv({ HOME: home }, () => {
      expect(resolveAllowedRoot(join(bridgeDir, 'media.sock'))).toBe(resolve(allowed));
    });

    writeFileSync(join(bridgeDir, 'sandbox-policy.json'), '{not-json');
    expect(resolveAllowedRoot(join(bridgeDir, 'media.sock'))).toBe(process.cwd());
  });

  it('confines media paths to the allowed root', () => {
    const root = makeTempDir('send-media-root-');
    const filePath = join(root, 'image.png');
    writeFileSync(filePath, 'image');

    expect(validatePath(filePath, root)).toEqual({ ok: true, resolved: resolve(filePath) });
    expect(validatePath(root, root)).toEqual({ ok: true, resolved: resolve(root) });
    const outside = validatePath(join(root, '..', 'outside.png'), root);
    if (outside.ok) throw new Error('expected outside path to be rejected');
    expect(outside.error).toContain('path outside allowed directory');
  });

  it('sends bridge requests and surfaces bridge/socket failures without throwing', async () => {
    const bridge = await startBridge({ ok: true });

    const ok = await sendToBridge(bridge.socketPath, {
      path: '/tmp/photo.png',
      caption: 'hello',
      filename: 'photo.png',
    });
    const missing = await sendToBridge(join(bridge.dir, 'missing.sock'), { path: '/tmp/photo.png' });
    const invalidBridge = await startBridge((_request: unknown, socket: Socket) => {
      socket.write('not-json\n');
      return undefined;
    });
    const invalid = await sendToBridge(invalidBridge.socketPath, { path: '/tmp/photo.png' });

    expect(ok).toEqual({ ok: true });
    expect(bridge.received).toEqual([{ path: '/tmp/photo.png', caption: 'hello', filename: 'photo.png' }]);
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain('media bridge socket not found');
    expect(invalid).toEqual({ ok: false, error: 'invalid JSON from bridge' });
  });

  it('handles initialize, tools/list, notifications, and unknown methods', async () => {
    const responder = makeResponder();

    await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, responder.opts);
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, responder.opts);
    await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, responder.opts);
    await handleMessage({ jsonrpc: '2.0', id: 3, method: 'unknown/method' }, responder.opts);
    await handleMessage({ jsonrpc: '2.0', method: 'unknown/notification' }, responder.opts);

    expect(responder.responses[0]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: 'send-media', version: '1.0.0' } },
    });
    expect(responder.responses[1].id).toBe(2);
    expect((responder.responses[1].result as { tools: Array<{ name: string }> }).tools[0].name).toBe('send_media');
    expect(responder.errors).toEqual([
      { id: 3, code: -32601, message: 'Method not found: unknown/method' },
    ]);
  });

  it('handles send_media argument errors, bridge failures, and successful sends', async () => {
    const root = makeTempDir('send-media-root-');
    const filePath = join(root, 'photo.jpg');
    writeFileSync(filePath, 'jpeg');
    const okBridge = await startBridge({ ok: true });
    const failBridge = await startBridge({ ok: false, error: 'upload rejected' });
    const missingPathResponder = makeResponder();
    const outsideResponder = makeResponder();
    const failResponder = makeResponder();
    const okResponder = makeResponder();

    await handleMessage({
      jsonrpc: '2.0',
      id: 'missing-path',
      method: 'tools/call',
      params: { name: 'send_media', arguments: {} },
    }, { ...missingPathResponder.opts, socketPath: okBridge.socketPath, allowedRoot: root });
    await handleMessage({
      jsonrpc: '2.0',
      id: 'outside',
      method: 'tools/call',
      params: { name: 'send_media', arguments: { path: join(root, '..', 'secret.jpg') } },
    }, { ...outsideResponder.opts, socketPath: okBridge.socketPath, allowedRoot: root });
    await handleMessage({
      jsonrpc: '2.0',
      id: 'fail',
      method: 'tools/call',
      params: { name: 'send_media', arguments: { path: filePath } },
    }, { ...failResponder.opts, socketPath: failBridge.socketPath, allowedRoot: root });
    await handleMessage({
      jsonrpc: '2.0',
      id: 'ok',
      method: 'tools/call',
      params: { name: 'send_media', arguments: { path: filePath, caption: 'cap' } },
    }, { ...okResponder.opts, socketPath: okBridge.socketPath, allowedRoot: root });

    expect(missingPathResponder.responses[0].result).toMatchObject({ isError: true });
    expect(JSON.stringify(outsideResponder.responses[0].result)).toContain('path outside allowed directory');
    expect(JSON.stringify(failResponder.responses[0].result)).toContain('upload rejected');
    expect(okResponder.responses[0].result).toEqual({
      content: [{ type: 'text', text: `Sent ${basename(filePath)} to chat` }],
    });
    expect(okBridge.received.at(-1)).toEqual({ path: resolve(filePath), caption: 'cap', filename: basename(filePath) });
  });

  it('rejects unknown tools through the JSON-RPC error channel', async () => {
    const responder = makeResponder();

    await handleMessage({
      jsonrpc: '2.0',
      id: 'unknown-tool',
      method: 'tools/call',
      params: { name: 'not_send_media', arguments: {} },
    }, responder.opts);

    expect(responder.errors).toEqual([
      { id: 'unknown-tool', code: -32601, message: 'Unknown tool: not_send_media' },
    ]);
  });
});
