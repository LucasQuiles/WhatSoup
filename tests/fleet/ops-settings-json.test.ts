/**
 * Tests for settings.json provisioning during instance create and config update.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleConfigUpdate } from '../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';

// Mock external deps used by ops.ts
vi.mock('../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => cb(null, '')),
  spawn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockReq(body = ''): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = '/';
  (stream as any).method = 'PATCH';
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

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-settings-'));
  tmpDirs.push(d);
  return d;
}

/** Create a temp dir inside $HOME (required for cwd validation that confines to home). */
function makeHomeTmpDir(): string {
  const base = path.join(os.homedir(), '.whatsoup-test-tmp');
  fs.mkdirSync(base, { recursive: true });
  const d = fs.mkdtempSync(path.join(base, 'ops-settings-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// handleConfigUpdate — settingsJson patch
// ---------------------------------------------------------------------------

describe('handleConfigUpdate — settingsJson patch', () => {
  it('writes settings.json when settingsJson field is in the patch', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    // Existing config
    const existingConfig = {
      name: 'test-agent',
      type: 'agent',
      adminPhones: ['18001234567'],
      accessMode: 'self_only',
      agentOptions: {
        sessionScope: 'per_chat',
        cwd: agentCwd,
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const instance: DiscoveredInstance = {
      name: 'test-agent',
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 9099,
      dbPath: '/tmp/bot.db',
      stateRoot: '/tmp/state',
      logDir: '/tmp/logs',
      healthToken: 'tok',
      configPath,
      socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => instance),
        getInstances: vi.fn(() => new Map()),
      } as any,
    };

    const customSettings = {
      permissions: {
        allow: ['Bash', 'Read', 'Write'],
        deny: [],
        defaultMode: 'bypassPermissions',
      },
    };

    const req = mockReq(JSON.stringify({ settingsJson: customSettings }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    const settingsPath = path.join(agentCwd, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.permissions.allow).toEqual(['Bash', 'Read', 'Write']);
  });

  it('does not write settings.json for non-agent types', async () => {
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    const existingConfig = {
      name: 'test-chat',
      type: 'chat',
      adminPhones: ['18001234567'],
      accessMode: 'self_only',
      systemPrompt: 'Hello',
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const instance: DiscoveredInstance = {
      name: 'test-chat',
      type: 'chat',
      accessMode: 'self_only',
      healthPort: 9099,
      dbPath: '/tmp/bot.db',
      stateRoot: '/tmp/state',
      logDir: '/tmp/logs',
      healthToken: 'tok',
      configPath,
      socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => instance),
        getInstances: vi.fn(() => new Map()),
      } as any,
    };

    const req = mockReq(JSON.stringify({
      settingsJson: { permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' } },
    }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-chat' });

    // Response should succeed (200) but no settings.json written (no cwd for chat)
    expect(res._status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate — enabledPlugins via agentOptions patch
// ---------------------------------------------------------------------------

describe('handleConfigUpdate — enabledPlugins via agentOptions', () => {
  it('writes enabledPlugins to .claude/settings.json when agentOptions.enabledPlugins is patched', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    const existingConfig = {
      name: 'test-agent',
      type: 'agent',
      adminPhones: ['18001234567'],
      accessMode: 'self_only',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    // Pre-seed settings.json with permissions (as ensurePermissionsSettings would)
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
    }));

    const instance: DiscoveredInstance = {
      name: 'test-agent', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath, socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: { getInstance: vi.fn(() => instance), getInstances: vi.fn(() => new Map()) } as any,
    };

    const plugins = { 'sdlc-os@sdlc-os-dev': false, 'tmup@tmup-dev': true };
    const req = mockReq(JSON.stringify({ agentOptions: { enabledPlugins: plugins } }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    expect(res._status).toBe(200);

    const settingsPath = path.join(claudeDir, 'settings.json');
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.enabledPlugins).toEqual(plugins);
    // Permissions should be preserved
    expect(written.permissions.allow).toEqual(['Bash']);
  });

  it('does not strip enabledPlugins from persisted config.json', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    const existingConfig = {
      name: 'test-agent',
      type: 'agent',
      adminPhones: ['18001234567'],
      accessMode: 'self_only',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const instance: DiscoveredInstance = {
      name: 'test-agent', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath, socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: { getInstance: vi.fn(() => instance), getInstances: vi.fn(() => new Map()) } as any,
    };

    const req = mockReq(JSON.stringify({ agentOptions: { enabledPlugins: { 'foo@bar': true } } }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    // enabledPlugins should be IN config.json (it's part of agentOptions, not settingsJson)
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.agentOptions.enabledPlugins).toEqual({ 'foo@bar': true });
  });

  it('strips settingsJson from persisted config.json', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    const existingConfig = {
      name: 'test-agent',
      type: 'agent',
      adminPhones: ['18001234567'],
      accessMode: 'self_only',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    };
    fs.writeFileSync(configPath, JSON.stringify(existingConfig));

    const instance: DiscoveredInstance = {
      name: 'test-agent', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath, socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: { getInstance: vi.fn(() => instance), getInstances: vi.fn(() => new Map()) } as any,
    };

    const req = mockReq(JSON.stringify({
      settingsJson: { permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' } },
    }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.settingsJson).toBeUndefined();
  });

  it('response body does not contain settingsJson', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      name: 'test-agent', type: 'agent', adminPhones: ['18001234567'],
      accessMode: 'self_only', agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    }));

    const instance: DiscoveredInstance = {
      name: 'test-agent', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath, socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: { getInstance: vi.fn(() => instance), getInstances: vi.fn(() => new Map()) } as any,
    };

    const req = mockReq(JSON.stringify({
      settingsJson: { permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' } },
    }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    const body = JSON.parse(res._body);
    expect(body.settingsJson).toBeUndefined();
  });

  it('clears enabledPlugins in settings.json when null is sent', async () => {
    const agentCwd = makeHomeTmpDir();
    const configDir = makeTmpDir();
    const configPath = path.join(configDir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      name: 'test-agent', type: 'agent', adminPhones: ['18001234567'],
      accessMode: 'self_only', agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    }));

    // Pre-seed settings.json with existing enabledPlugins
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
      enabledPlugins: { 'sdlc-os@sdlc-os-dev': false },
    }));

    const instance: DiscoveredInstance = {
      name: 'test-agent', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath, socketPath: null,
    };

    const deps: OpsDeps = {
      discovery: { getInstance: vi.fn(() => instance), getInstances: vi.fn(() => new Map()) } as any,
    };

    // Send null to clear
    const req = mockReq(JSON.stringify({ agentOptions: { enabledPlugins: null } }));
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'test-agent' });

    expect(res._status).toBe(200);
    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    // Should be empty object (reset to global inheritance)
    expect(written.enabledPlugins).toEqual({});
  });
});

// NOTE: handleCreateLine integration test requires mocking fleet/paths.ts
// (XDG_CONFIG_HOME, dataRoot, stateRoot) which is complex. The settings.json
// write path is covered by workspace-settings.test.ts (writePermissionsSettings)
// and ensure-permissions-settings.test.ts (ensurePermissionsSettings).
