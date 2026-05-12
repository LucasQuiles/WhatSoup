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
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const { existsSync: actualExistsSync } = actualFs;

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
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;
  let originalUmask: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-create-mode-test-'));
    const homeTmp = path.join(os.homedir(), '.whatsoup-test-tmp');
    fs.mkdirSync(homeTmp, { recursive: true });
    agentCwd = fs.mkdtempSync(path.join(homeTmp, 'ops-create-mode-'));

    originalCwd = process.cwd();
    originalHome = process.env.HOME;
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
    process.chdir(originalCwd);
    vi.mocked(fs.existsSync).mockImplementation(actualExistsSync);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

  it('defaults an empty agent cwd to a home-confined workspace during create', async () => {
    const homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'default-agent', 'workspace');
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
        name: 'default-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: '', sessionScope: 'per_chat' },
        claudeMd: 'Local operating instructions for this instance.\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'default-agent', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('expands a wizard tilde cwd to the home directory before writing CLAUDE.md during create', async () => {
    const homeDir = path.join(tmpDir, 'home-tilde');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    process.chdir(homeDir);
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'tilde-agent', 'workspace');
    const literalTildeCwd = path.join(homeDir, '~', '.local', 'share', 'whatsoup', 'instances', 'tilde-agent', 'workspace');
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
        name: 'tilde-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: '~/.local/share/whatsoup/instances/tilde-agent/workspace', sessionScope: 'per_chat' },
        claudeMd: 'Local operating instructions for this instance.\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'tilde-agent', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(literalTildeCwd, '.claude', 'CLAUDE.md'))).toBe(false);
  });


  it('defaults a missing agentOptions.cwd to a home-confined workspace during create', async () => {
    const homeDir = path.join(tmpDir, 'home-missing-cwd');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'no-cwd-agent', 'workspace');
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
        name: 'no-cwd-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { sessionScope: 'per_chat' },
        claudeMd: 'instructions\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'no-cwd-agent', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
  });

  it('defaults omitted agentOptions to a per-chat home-confined workspace during create', async () => {
    const homeDir = path.join(tmpDir, 'home-omitted-agent-options');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'omitted-agent-options', 'workspace');
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
        name: 'omitted-agent-options',
        type: 'agent',
        adminPhones: ['15551234567'],
        claudeMd: 'instructions\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'omitted-agent-options', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions).toEqual({ cwd: expectedCwd, sessionScope: 'per_chat' });
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('treats whitespace-only agentOptions.cwd as missing during create', async () => {
    const homeDir = path.join(tmpDir, 'home-ws-cwd');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'ws-cwd-agent', 'workspace');
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
        name: 'ws-cwd-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: '   ', sessionScope: 'per_chat' },
        claudeMd: 'instructions\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(201);
    const configPath = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'ws-cwd-agent', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
  });

  it('rejects a non-string agentOptions.cwd with 400 during create', async () => {
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
        name: 'bad-cwd-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: 123, sessionScope: 'per_chat' },
        claudeMd: 'instructions\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/cwd must be a string/);
  });

  it('rejects an array agentOptions with 400 during create', async () => {
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
        name: 'array-opts-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: ['unexpected'],
        claudeMd: 'instructions\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/agentOptions must be an object/);
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

  it('returns 409 without overwriting when config dir appears during create', async () => {
    const name = 'race-line';
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', name);
    const configPath = path.join(configDir, 'config.json');
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify({ sentinel: true, healthPort: 3101 }) + '\n');
    vi.mocked(fs.existsSync).mockImplementation((target) => {
      if (target === configDir) return false;
      return actualExistsSync(target);
    });

    const svc = mockServiceManager();
    const deps = makeDeps({
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      serviceManager: svc,
    });

    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name,
        type: 'chat',
        // Real-shaped phone — the shared validator (added for #244/#249)
        // now rejects unparseable strings that normalize to empty.
        adminPhones: ['18459780919'],
        healthPort: 3201,
      })),
      res,
      deps,
    );

    expect(res._status).toBe(409);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).sentinel).toBe(true);
    expect(svc.enable).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate
// ---------------------------------------------------------------------------

describe('handleConfigUpdate', () => {
  let tmpDir: string;
  let agentCwd: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-config-test-'));
    const homeTmp = path.join(os.homedir(), '.whatsoup-test-tmp');
    fs.mkdirSync(homeTmp, { recursive: true });
    agentCwd = fs.mkdtempSync(path.join(homeTmp, 'ops-config-mode-'));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    vi.mocked(fs.existsSync).mockImplementation(actualExistsSync);
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

  it('returns 500 and preserves config when settingsJson cannot be written during config update', async () => {
    const originalConfig = {
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
    };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(originalConfig));
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'settings.json'), { recursive: true });

    const inst = fakeInstance({ type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        accessMode: 'allowlist',
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

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/failed to write settings\.json/);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(originalConfig);
    expect(fs.existsSync(configPath + '.tmp')).toBe(false);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it('returns 500 and preserves config when enabledPlugins cannot be written during config update', async () => {
    const originalConfig = {
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
    };
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(originalConfig));
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'settings.json'), { recursive: true });

    const inst = fakeInstance({ type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        accessMode: 'allowlist',
        agentOptions: {
          enabledPlugins: { github: true },
        },
      })),
      res,
      deps,
      { name: 'test-line' },
    );

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/failed to write enabledPlugins/);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual(originalConfig);
    expect(fs.existsSync(configPath + '.tmp')).toBe(false);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
  });

  it('defaults an existing empty agent cwd before writing CLAUDE.md during config update', async () => {
    const homeDir = path.join(tmpDir, 'home');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'test-line', 'workspace');
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'test-line',
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: '', sessionScope: 'per_chat' },
    }));
    const inst = fakeInstance({ name: 'test-line', type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ claudeMd: 'Updated local operating instructions.\n' })),
      res,
      deps,
      { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('expands an existing tilde agent cwd before writing CLAUDE.md during config update', async () => {
    const homeDir = path.join(tmpDir, 'home-update-tilde');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    process.chdir(homeDir);
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'tilde-update', 'workspace');
    const literalTildeCwd = path.join(homeDir, '~', '.local', 'share', 'whatsoup', 'instances', 'tilde-update', 'workspace');
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'tilde-update',
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: '~/.local/share/whatsoup/instances/tilde-update/workspace', sessionScope: 'per_chat' },
    }));
    const inst = fakeInstance({ name: 'tilde-update', type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ claudeMd: 'Updated local operating instructions.\n' })),
      res,
      deps,
      { name: 'tilde-update' },
    );

    expect(res._status).toBe(200);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions.cwd).toBe(expectedCwd);
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(literalTildeCwd, '.claude', 'CLAUDE.md'))).toBe(false);
  });


  it('defaults omitted agentOptions before writing CLAUDE.md during config update', async () => {
    const homeDir = path.join(tmpDir, 'home-update-omitted-agent-options');
    fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    process.env.HOME = homeDir;
    const expectedCwd = path.join(homeDir, '.local', 'share', 'whatsoup', 'instances', 'update-no-agent-options', 'workspace');
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'update-no-agent-options',
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
    }));
    const inst = fakeInstance({ name: 'update-no-agent-options', type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ claudeMd: 'Updated local operating instructions.\n' })),
      res,
      deps,
      { name: 'update-no-agent-options' },
    );

    expect(res._status).toBe(200);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.agentOptions).toEqual({ cwd: expectedCwd, sessionScope: 'per_chat' });
    expect(fs.existsSync(path.join(expectedCwd, '.claude', 'CLAUDE.md'))).toBe(true);
  });


  it('rejects an array agentOptions with 400 during config update', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    }));
    const inst = fakeInstance({ name: 'arr-update', type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: ['unexpected'] })),
      res,
      deps,
      { name: 'arr-update' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/agentOptions must be an object/);
  });

  it('does not follow config tmp symlinks during config update', async () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ type: 'chat', healthPort: 3010, accessMode: 'self_only' }));
    const targetPath = path.join(tmpDir, 'tmp-target.json');
    fs.writeFileSync(targetPath, 'keep me');
    fs.symlinkSync(targetPath, configPath + '.tmp');

    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'allowlist' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/failed to write config/);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('keep me');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).accessMode).toBe('self_only');
  });

  it('does not write config updates through a symlinked config directory', async () => {
    const targetDir = path.join(tmpDir, 'config-target');
    const linkDir = path.join(tmpDir, 'config-link');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(targetDir, linkDir, 'dir');
    const configPath = path.join(linkDir, 'config.json');
    const targetConfigPath = path.join(targetDir, 'config.json');
    fs.writeFileSync(targetConfigPath, JSON.stringify({ type: 'chat', healthPort: 3010, accessMode: 'self_only' }));

    const inst = fakeInstance({ configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'allowlist' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toMatch(/failed to write config/);
    expect(JSON.parse(fs.readFileSync(targetConfigPath, 'utf-8')).accessMode).toBe('self_only');
    expect(actualExistsSync(path.join(targetDir, 'config.json.tmp'))).toBe(false);
  });

  it('rejects agent cwd symlinks that resolve outside home', async () => {
    const outsideCwd = path.join(tmpDir, 'outside-cwd');
    fs.mkdirSync(outsideCwd, { recursive: true });
    const symlinkCwd = path.join(agentCwd, 'cwd-link');
    fs.symlinkSync(outsideCwd, symlinkCwd, 'dir');

    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: symlinkCwd, sessionScope: 'per_chat' },
    }));
    const inst = fakeInstance({ type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ accessMode: 'self_only' })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/cwd.*home directory/);
  });

  it('rejects pluginDirs symlinks that resolve outside home', async () => {
    const outsidePluginDir = path.join(tmpDir, 'outside-plugin-dir');
    fs.mkdirSync(outsidePluginDir, { recursive: true });
    const symlinkPluginDir = path.join(agentCwd, 'plugin-link');
    fs.symlinkSync(outsidePluginDir, symlinkPluginDir, 'dir');

    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      type: 'agent',
      healthPort: 3010,
      accessMode: 'self_only',
      agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
    }));
    const inst = fakeInstance({ type: 'agent', configPath });
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { pluginDirs: [symlinkPluginDir] } })),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/pluginDirs.*home directory/);
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
