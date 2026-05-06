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
  handleCreateLine,
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
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

const { existsSync: actualExistsSync } = await vi.importActual<typeof import('node:fs')>('node:fs');

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

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function writePermissiveFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o644);
  expect(fileMode(filePath)).toBe(0o644);
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

function mockServiceManager() {
  return {
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    startFire: vi.fn(),
  };
}

function makeDeps(overrides: Partial<OpsDeps> = {}): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
    } as any,
    realtime: { publish: vi.fn() },
    serviceManager: mockServiceManager(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleSend
// ---------------------------------------------------------------------------

describe('handleSend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation(actualExistsSync);
  });

  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(actualExistsSync);
  });

  it('returns 404 for unknown instance', async () => {
    const deps = makeDeps();
    const res = mockRes();
    await handleSend(mockReq('{}'), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('routes passive instances through mcpCall', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

    const res = mockRes();
    await handleSend(mockReq(JSON.stringify({ chatJid: '123', text: 'hi' })), res, deps, { name: 'test-line' });

    expect(mcpCall).toHaveBeenCalledWith('/state/test-line/whatsoup.sock', 'send_message', { chatJid: '123@s.whatsapp.net', text: 'hi' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).success).toBe(true);
  });

  it('routes agent instances through proxyToInstance', async () => {
    const inst = fakeInstance({ type: 'agent', socketPath: '/state/agent/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });

    const res = mockRes();
    // Body must include chatJid or to (post-P1-D xor validation).
    const body = JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hello' });
    await handleSend(mockReq(body), res, deps, { name: 'test-line' });
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/send', 'POST', body, 'tok123');
    expect(res._status).toBe(200);
  });

  it('returns 502 when mcpCall fails', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(mcpCall).mockResolvedValue({ success: false, error: 'timeout' });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' })),
      res, deps, { name: 'test-line' });
    expect(res._status).toBe(502);
  });

  it('returns 400 for invalid JSON body on mcp route', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 400, body: '{"error":"invalid JSON"}' });
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
    // Body must include chatJid or to (post-P1-D xor validation).
    const body = JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' });
    await handleSend(mockReq(body), res, deps, { name: 'test-line' });
    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/send', 'POST', body, 'tok123');
    expect(res._status).toBe(200);
  });

  it('returns 422 when no route is available', async () => {
    // Must have no socketPath AND no healthPort to hit the 422 "no route" case
    const inst = fakeInstance({ type: 'passive', socketPath: null, healthPort: 0 });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    // Body must include chatJid (post-P1-D xor validation) so we reach the
    // route-availability check rather than failing at body validation.
    await handleSend(mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net' })), res, deps, { name: 'test-line' });
    expect(res._status).toBe(422);
    expect(JSON.parse(res._body).error).toMatch(/no send route/);
  });

  // ── P1-D resolver-integration cases ───────────────────────────────────────

  it('forwards body with to (alias) through mcpCall', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ to: 'kio', text: 'hi' })),
      res, deps, { name: 'test-line' });

    // Fleet forwards `to` verbatim; the per-instance MCP layer (P1-E) does the
    // actual alias resolution.
    expect(mcpCall).toHaveBeenCalledWith(
      '/state/test-line/whatsoup.sock', 'send_message',
      { to: 'kio', text: 'hi' });
    expect(res._status).toBe(200);
  });

  it('returns 400 when profile is not a string', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ to: 'kio', text: 'hi', profile: 123 })),
      res,
      deps,
      { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/profile/);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
  });

  it('forwards string profile through mcpCall without resolving at fleet edge', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ to: 'kio', text: 'hi', profile: 'satellite' })),
      res,
      deps,
      { name: 'test-line' },
    );

    expect(mcpCall).toHaveBeenCalledWith(
      '/state/test-line/whatsoup.sock',
      'send_message',
      { to: 'kio', text: 'hi', profile: 'satellite' },
    );
    expect(res._status).toBe(200);
  });

  it('returns 400 when body has both chatJid and to (mutual exclusion)', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net', to: 'kio', text: 'hi' })),
      res, deps, { name: 'test-line' });

    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
    expect(JSON.parse(res._body).error).toMatch(/mutually exclusive/);
  });

  it('returns 400 when body has neither chatJid nor to', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ text: 'hi' })),
      res, deps, { name: 'test-line' });

    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
    expect(JSON.parse(res._body).error).toMatch(/chatJid.*to|to.*chatJid/);
  });

  it('propagates 502 when instance reports unknown alias not found', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    vi.mocked(fs.existsSync).mockReturnValue(true);
    // Simulate the per-instance MCP returning an alias-not-found error.
    vi.mocked(mcpCall).mockResolvedValue({
      success: false, error: 'alias not found: unknown',
    });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ to: 'unknown', text: 'hi' })),
      res, deps, { name: 'test-line' });

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body).error).toMatch(/alias not found/);
  });

  // ── P1-D code-review I-1 / I-2 regression guards ──────────────────────────

  it('returns 400 when JSON body parses to null (closes I-1 bypass)', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    // Without the I-1 guard, `JSON.parse('null')` returns null, `parsed.chatJid`
    // throws TypeError, the catch swallows it, and the request falls through
    // to mcpCall with a null payload — bypassing xor entirely.
    await handleSend(mockReq('null'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
    expect(JSON.parse(res._body).error).toMatch(/JSON object/);
  });

  it('returns 400 when JSON body parses to an array', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(mockReq('[]'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
    expect(JSON.parse(res._body).error).toMatch(/JSON object/);
  });

  it('returns 400 when chatJid is whitespace-only (closes I-2 trim gap)', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ chatJid: '   ', text: 'hi' })),
      res, deps, { name: 'test-line' });

    // Whitespace-only count as not-provided after trim; with no `to` present,
    // this is the "neither" branch -> 400.
    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
    expect(JSON.parse(res._body).error).toMatch(/chatJid|to/);
  });

  it('returns 400 when to is whitespace-only', async () => {
    const inst = fakeInstance({ type: 'passive', socketPath: '/tmp/sock' });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleSend(
      mockReq(JSON.stringify({ to: '   ', text: 'hi' })),
      res, deps, { name: 'test-line' });

    expect(res._status).toBe(400);
    expect(mcpCall).not.toHaveBeenCalled();
    expect(proxyToInstance).not.toHaveBeenCalled();
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
    const body = '{"subjectType":"phone","subjectId":"15551234567","action":"allow"}';
    await handleAccessUpdate(mockReq(body), res, deps, { name: 'test-line' });
    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/access', 'POST', body, 'tok123');
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

  it('calls serviceManager.restart and returns 202 on success', async () => {
    const inst = fakeInstance();
    const svc = mockServiceManager();
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any, serviceManager: svc });

    const res = mockRes();
    await handleRestart(mockReq(), res, deps, { name: 'test-line' });
    expect(svc.restart).toHaveBeenCalledWith('test-line');
    expect(res._status).toBe(202);
    expect(JSON.parse(res._body).status).toBe('restart_requested');
  });

  it('returns 500 when serviceManager.restart fails', async () => {
    const inst = fakeInstance();
    const svc = mockServiceManager();
    svc.restart.mockRejectedValueOnce(new Error('unit not found'));
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any, serviceManager: svc });

    const res = mockRes();
    await handleRestart(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/unit not found/);
  });
});

// ---------------------------------------------------------------------------
// handleCreateLine
// ---------------------------------------------------------------------------

describe('handleCreateLine', () => {
  let tmpDir: string;
  let agentCwd: string;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;
  let originalUmask: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-create-mode-test-'));
    const homeTmp = path.join(os.homedir(), '.whatsoup-test-tmp');
    fs.mkdirSync(homeTmp, { recursive: true });
    agentCwd = fs.mkdtempSync(path.join(homeTmp, 'ops-create-mode-'));

    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;
    originalUmask = process.umask(0o022);

    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    process.umask(originalUmask);
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;

    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(agentCwd, { recursive: true, force: true });
  });

  it('creates config.json and CLAUDE.md with private file modes', async () => {
    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'mode-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
        claudeMd: 'Local operating instructions for this instance.\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'mode-agent', 'config.json');
    const claudeMdPath = path.join(agentCwd, '.claude', 'CLAUDE.md');
    const modes = {
      configJson: fileMode(configPath),
      claudeMd: fileMode(claudeMdPath),
    };
    expect(modes).toEqual({ configJson: 0o600, claudeMd: 0o600 });
  });

  it('tightens pre-existing CLAUDE.md and settings.json modes during create', async () => {
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const settingsPath = path.join(claudeDir, 'settings.json');
    writePermissiveFile(claudeMdPath, 'old instructions\n');
    writePermissiveFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }));

    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'mode-agent-existing',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
        claudeMd: 'Updated local operating instructions.\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    expect(fileMode(claudeMdPath)).toBe(0o600);
    expect(fileMode(settingsPath)).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate
// ---------------------------------------------------------------------------

describe('handleConfigUpdate', () => {
  let tmpDir: string;
  let agentCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-config-test-'));
    const homeTmp = path.join(os.homedir(), '.whatsoup-test-tmp');
    fs.mkdirSync(homeTmp, { recursive: true });
    agentCwd = fs.mkdtempSync(path.join(homeTmp, 'ops-config-mode-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(agentCwd, { recursive: true, force: true });
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

  it('replaces a stale permissive config tmp with a private config file', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ type: 'chat', healthPort: 3010, accessMode: 'self_only' }));
    const tmpPath = configPath + '.tmp';
    writePermissiveFile(tmpPath, JSON.stringify({ stale: true }));

    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'allowlist' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fileMode(configPath)).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).accessMode).toBe('allowlist');
  });

  it('tightens pre-existing CLAUDE.md and settings.json modes during config update', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
    }));
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const settingsPath = path.join(claudeDir, 'settings.json');
    writePermissiveFile(claudeMdPath, 'old instructions\n');
    writePermissiveFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }));

    const inst = fakeInstance({ type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        claudeMd: 'Updated local operating instructions.\n',
        settingsJson: {
          permissions: {
            allow: ['Bash'],
            deny: [],
            defaultMode: 'bypassPermissions',
          },
        },
      })),
      res,
      deps,
      { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(fileMode(claudeMdPath)).toBe(0o600);
    expect(fileMode(settingsPath)).toBe(0o600);
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
