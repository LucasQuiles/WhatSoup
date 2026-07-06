/**
 * chatOptions (openaiProviderConfig — QR-218 PR-2) route-gating coverage.
 *
 * chatOptions is chat-only and, unlike agentOptions, is NOT a PASSTHROUGH_FIELDS
 * entry — it has its own dedicated CREATE-time gate
 * (`type === 'chat' && body.chatOptions != null`) so an agent/passive config can
 * never carry an unvalidated chat-shaped block (src/fleet/routes/ops.ts). On
 * PATCH there is no type gate on the merge itself; a malformed
 * openaiProviderConfig is instead caught by the shared validator
 * (validateChatOptions in src/core/agent-config-validator.ts), which runs for
 * every type: 'chat' instance. Neither the CREATE gate nor the PATCH rejection
 * had a direct test before this file. Harness mirrors
 * ops-create-byok-roundtrip.test.ts (CREATE) and
 * ops-config-patch-validation.test.ts (PATCH) — same temp dirs, real handlers,
 * config.json readback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { handleCreateLine, handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

function mockReq(body = '', method = 'POST'): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = '/';
  (stream as any).method = method;
  process.nextTick(() => {
    (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { if (data) res._body = data; },
  };
  return res as any;
}

function successDeps(): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
      scan: vi.fn(),
    } as any,
    realtime: { publish: vi.fn() },
    serviceManager: {
      enable: vi.fn().mockResolvedValue(undefined),
      disable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      startFire: vi.fn(),
    },
  };
}

describe('handleCreateLine — chatOptions gating (QR-218 PR-2)', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-chatopts-create-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;

    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a valid chatOptions.openaiProviderConfig to config.json for type: chat', async () => {
    const openaiProviderConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };

    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'chatopts-roundtrip',
        type: 'chat',
        adminPhones: ['15551234567'],
        chatOptions: { openaiProviderConfig },
      })),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);

    const cfgPath = path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'chatopts-roundtrip', 'config.json',
    );
    expect(fs.existsSync(cfgPath), 'config.json must be written').toBe(true);
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(persisted.chatOptions).toEqual({ openaiProviderConfig });
  });

  it('drops chatOptions for type: agent (chat-only CREATE gate)', async () => {
    const agentCwd = fs.mkdtempSync(path.join(process.env.HOME!, 'chatopts-agent-cwd-'));
    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'chatopts-agent-drop',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'single' },
        chatOptions: {
          openaiProviderConfig: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyService: 'groq' },
        },
      })),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);

    const cfgPath = path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'chatopts-agent-drop', 'config.json',
    );
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    // Prove this is a genuine, correctly-populated agent config (not an empty
    // object that would vacuously lack chatOptions) with chatOptions specifically
    // excluded by the CREATE gate.
    expect(persisted.type).toBe('agent');
    expect(persisted.agentOptions.cwd).toBe(agentCwd);
    expect('chatOptions' in persisted).toBe(false);
  });
});

describe('handleConfigUpdate PATCH chatOptions validation (QR-218 PR-2)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-chatopts-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function fakeInstance(configPath: string, overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
    return {
      name: 'test-line',
      type: 'chat',
      accessMode: 'self_only',
      healthPort: 9095,
      dbPath: '/data/test-line/bot.db',
      stateRoot: '/state/test-line',
      logDir: '/data/test-line/logs',
      healthToken: 'tok123',
      configPath,
      socketPath: null,
      ...overrides,
    };
  }

  function makeDeps(instance: DiscoveredInstance): OpsDeps {
    return {
      discovery: {
        getInstance: vi.fn(() => instance),
        getInstances: vi.fn(() => new Map()),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: { restart: vi.fn(), stop: vi.fn(), disable: vi.fn(), enable: vi.fn() } as any,
    };
  }

  function writeChatConfig(name = 'test-line', data: Record<string, unknown> = {}): string {
    const dir = path.join(tmpDir, 'whatsoup', 'instances', name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name, type: 'chat', healthPort: 9095, accessMode: 'self_only',
      adminPhones: ['15551230006'], ...data,
    }));
    return cfg;
  }

  it('rejects a malformed chatOptions.openaiProviderConfig.baseUrl with 400 and leaves the file untouched', async () => {
    const cfg = writeChatConfig();
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        chatOptions: { openaiProviderConfig: { baseUrl: 'not-a-url' } },
      }), 'PATCH'),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/chatOptions\.openaiProviderConfig\.baseUrl must be a valid URL/);
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('rejects an unknown chatOptions.openaiProviderConfig.apiKeyService with 400 and leaves the file untouched', async () => {
    const cfg = writeChatConfig();
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        chatOptions: {
          openaiProviderConfig: {
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKeyService: 'not-a-real-service',
          },
        },
      }), 'PATCH'),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(
      /chatOptions\.openaiProviderConfig\.apiKeyService .* is not a known keyring service/,
    );
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });
});
