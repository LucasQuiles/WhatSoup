/**
 * Tests for src/fleet/routes/ops.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleSend,
  handleAccessUpdate,
  handleRestart,
  handleConfigUpdate,
} from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

// Mock mcpCall and proxyToInstance
vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import { proxyToInstance } from '../../../src/fleet/http-proxy.ts';
import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(body = '', url = '/'): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = url;
  (stream as any).method = 'POST';
  // Write body async so readBody can consume it
  process.nextTick(() => {
    (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    end(data?: string) {
      if (data) res._body = data;
    },
  };
  return res as any;
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpsDeps> = {}): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleSend
// ---------------------------------------------------------------------------

describe('handleSend', () => {
  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleSend(mockReq('{}'), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('routes passive instances through mcpCall', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

    const res = mockRes();
    await handleSend(mockReq(JSON.stringify({ chatJid: '123', text: 'hi' })), res, deps, { name: 'test-line' });

    expect(mcpCall).toHaveBeenCalledWith('/state/test-line/whatsoup.sock', 'send_message', { chatJid: '123', text: 'hi' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).success).toBe(true);
  });

  it('routes agent instances through mcpCall', async () => {
    const inst = fakeInstance({ type: 'agent', socketPath: '/state/agent/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: {} });

    const res = mockRes();
    await handleSend(mockReq('{"text":"hello"}'), res, deps, { name: 'test-line' });
    expect(mcpCall).toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it('returns 502 when mcpCall fails', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(mcpCall).mockResolvedValue({ success: false, error: 'timeout' });

    const res = mockRes();
    await handleSend(mockReq('{"text":"hi"}'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(502);
  });

  it('returns 400 for invalid JSON body on mcp route', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(mockReq('not json'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/invalid JSON/);
  });

  it('routes chat instances through proxyToInstance', async () => {
    const inst = fakeInstance({ type: 'chat' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });

    const res = mockRes();
    await handleSend(mockReq('{"text":"hi"}'), res, deps, { name: 'test-line' });
    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/send', 'POST', '{"text":"hi"}', 'tok123');
    expect(res._status).toBe(200);
  });

  it('returns 422 when no route is available', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: null });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(mockReq('{}'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(422);
    expect(JSON.parse(res._body).error).toMatch(/no send route/);
  });
});

// ---------------------------------------------------------------------------
// handleAccessUpdate
// ---------------------------------------------------------------------------

describe('handleAccessUpdate', () => {
  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleAccessUpdate(mockReq('{}'), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('proxies access update to the instance', async () => {
    const inst = fakeInstance();
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"updated":true}' });

    const res = mockRes();
    await handleAccessUpdate(mockReq('{"action":"approve"}'), res, deps, { name: 'test-line' });
    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/access', 'POST', '{"action":"approve"}', 'tok123');
    expect(res._status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// handleRestart
// ---------------------------------------------------------------------------

describe('handleRestart', () => {
  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleRestart(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('calls systemctl and returns 202 on success', async () => {
    const inst = fakeInstance();
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(null);
      return undefined as any;
    });

    const res = mockRes();
    await handleRestart(mockReq(), res, deps, { name: 'test-line' });
    expect(execFile).toHaveBeenCalledWith(
      'systemctl', ['--user', 'restart', 'whatsoup@test-line'],
      expect.any(Function),
    );
    expect(res._status).toBe(202);
    expect(JSON.parse(res._body).status).toBe('restart_requested');
  });

  it('returns 500 when systemctl fails', async () => {
    const inst = fakeInstance();
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(new Error('unit not found'));
      return undefined as any;
    });

    const res = mockRes();
    await handleRestart(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/unit not found/);
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate
// ---------------------------------------------------------------------------

describe('handleConfigUpdate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleConfigUpdate(mockReq('{}'), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns 400 for invalid JSON body', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}');
    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(mockReq('not json'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/invalid JSON/);
  });

  it('returns 400 for array body', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, '{}');
    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(mockReq('[1,2,3]'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/JSON object/);
  });

  it('merges patch into existing config and writes atomically', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ type: 'chat', healthPort: 3010, accessMode: 'self_only' }));

    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'allowlist', newField: true })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.type).toBe('chat');
    expect(body.accessMode).toBe('allowlist');
    expect(body.newField).toBe(true);
    expect(body.healthPort).toBe(3010);

    // Verify file on disk
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(onDisk.accessMode).toBe('allowlist');
    expect(onDisk.newField).toBe(true);

    // Verify no .tmp file left behind
    expect(fs.existsSync(configPath + '.tmp')).toBe(false);
  });

  it('returns 500 when config file cannot be read', async () => {
    const configPath = path.join(tmpDir, 'nonexistent.json');
    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(mockReq('{"x":1}'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/failed to read config/);
  });
});
