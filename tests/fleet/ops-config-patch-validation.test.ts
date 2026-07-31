/**
 * PATCH /api/lines/:name/config — shared-validator coverage tests.
 *
 * Closes the validation gaps documented in issues #244 (healthPort) and #249
 * (agentOptions). Every test here exercises a code path that previously
 * accepted invalid input and bricked the instance on next service restart.
 *
 * The round-trip invariant test (bottom of file) is the cheapest insurance
 * against future drift between handleConfigUpdate, validateInstance, and
 * fleet/discovery.ts:validateConfig.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleConfigUpdate } from '../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';

vi.mock('../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

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

/** Build a real, writable agent cwd under $HOME so the route-level
 *  resolveAndValidateAgentCwd guard passes during these tests. */
function makeAgentCwd(label: string): string {
  const dir = path.join(os.homedir(), '.whatsoup-test-fixtures', `${label}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const FIXTURES_HOME_DIR = path.join(os.homedir(), '.whatsoup-test-fixtures');

describe('handleConfigUpdate PATCH healthPort validation (#244)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-port-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function writeConfig(name: string, data: Record<string, unknown> = {}): string {
    const dir = path.join(tmpDir, 'whatsoup', 'instances', name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ name, type: 'chat', healthPort: 9095, accessMode: 'self_only', adminPhones: ['15551230006'], ...data }));
    return cfg;
  }

  it('rejects healthPort below 1024 with 400', async () => {
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 80 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/healthPort must be between 1024 and 65535/);
  });

  it('rejects healthPort above 65535 with 400', async () => {
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 65536 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/healthPort must be between 1024 and 65535/);
  });

  it('rejects healthPort that is not a number with 400', async () => {
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 'abc' })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/healthPort must be (an integer|between)/);
  });

  it('rejects healthPort already used by a sibling instance with 409', async () => {
    writeConfig('sibling', { healthPort: 9100 });
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 9100 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).message).toMatch(/healthPort 9100 is already in use/);
  });

  it('accepts a healthPort change to a valid, unused port', async () => {
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 9200 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body).healthPort).toBe(9200);
  });

  it('rejects healthPort that collides with a legacy sibling using the runtime default', async () => {
    writeConfig('sibling', { healthPort: undefined });
    const cfg = writeConfig('test-line');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 9090 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).message).toMatch(/healthPort 9090 is already in use/);
  });

  it('fails closed and preserves config when healthPort sibling inventory is unreadable', async () => {
    const siblingDir = path.join(tmpDir, 'whatsoup', 'instances', 'bad-sibling');
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'config.json'), '{bad json');
    const cfg = writeConfig('test-line');
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ healthPort: 9200 })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      error: 'healthPort inventory unavailable: failed to read instance config',
      instance: 'bad-sibling',
    });
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('rejects type changes with 400 and leaves the file untouched', async () => {
    const cfg = writeConfig('test-line');
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ type: 'passive' })),
      res, makeDeps(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/type is immutable/);
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });
});

describe('handleConfigUpdate PATCH agentOptions validation (#249)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-ao-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(FIXTURES_HOME_DIR, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function writeAgentConfig(name = 'test-agent'): string {
    const dir = path.join(tmpDir, 'whatsoup', 'instances', name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name,
      type: 'agent',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
      agentOptions: {
        sessionScope: 'per_chat',
        cwd: makeAgentCwd(name),
      },
    }));
    return cfg;
  }

  it('rejects bogus sessionScope with 400', async () => {
    const cfg = writeAgentConfig();
    const inst = fakeInstance(cfg, { name: 'test-agent', type: 'agent' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { sessionScope: 'bogus' } })),
      res, makeDeps(inst), { name: 'test-agent' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/sessionScope must be (single|one of)/);
  });

  it('rejects sandboxPerChat true when merged sessionScope is not per_chat', async () => {
    const cfg = writeAgentConfig();
    const inst = fakeInstance(cfg, { name: 'test-agent', type: 'agent' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        agentOptions: { sessionScope: 'shared', sandboxPerChat: true },
      })),
      res, makeDeps(inst), { name: 'test-agent' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/sandboxPerChat requires sessionScope "per_chat"/);
  });

  it('rejects empty provider string with 400 (registry enum, #447)', async () => {
    const cfg = writeAgentConfig();
    const inst = fakeInstance(cfg, { name: 'test-agent', type: 'agent' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { provider: '' } })),
      res, makeDeps(inst), { name: 'test-agent' },
    );
    expect(res._status).toBe(400);
    // #447: provider is now validated against the shared PROVIDER_IDS registry,
    // so the error enumerates the valid set. Empty string is still rejected.
    expect(JSON.parse(res._body).message).toMatch(/provider must be one of:/);
    expect(JSON.parse(res._body).message).toMatch(/claude-cli/);
  });

  it('rejects providerConfig that is an array with 400', async () => {
    const cfg = writeAgentConfig();
    const inst = fakeInstance(cfg, { name: 'test-agent', type: 'agent' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { providerConfig: [] } })),
      res, makeDeps(inst), { name: 'test-agent' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/providerConfig must be an object/);
  });

  it('rejects non-string instructionsPath with 400', async () => {
    const cfg = writeAgentConfig();
    const inst = fakeInstance(cfg, { name: 'test-agent', type: 'agent' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { instructionsPath: 42 } })),
      res, makeDeps(inst), { name: 'test-agent' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/instructionsPath must be a string/);
  });

  it('rejects systemPrompt on passive instance with 400', async () => {
    const dir = path.join(tmpDir, 'whatsoup', 'instances', 'test-passive');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name: 'test-passive',
      type: 'passive',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
    }));
    const inst = fakeInstance(cfg, { name: 'test-passive', type: 'passive' });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ systemPrompt: 'You are a helpful assistant.' })),
      res, makeDeps(inst), { name: 'test-passive' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toMatch(/Passive instances must not have a systemPrompt/);
  });
});

describe('handleConfigUpdate PATCH Pinecone project guard validation', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-pinecone-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  function writeChatConfig(name = 'test-line'): string {
    const dir = path.join(tmpDir, 'whatsoup', 'instances', name);
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name,
      type: 'chat',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
    }));
    return cfg;
  }

  it('rejects non-q Pinecone config without a project guard and leaves the file untouched', async () => {
    const cfg = writeChatConfig();
    const before = fs.readFileSync(cfg, 'utf-8');
    const inst = fakeInstance(cfg);
    const res = mockRes();

    await handleConfigUpdate(
      mockReq(JSON.stringify({
        memory: {
          pinecone: {
            apiKeyEnv: 'PINECONE_MINI3_KEY',
            index: 'whatsapp-bot',
          },
        },
      })),
      res, makeDeps(inst), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).message).toContain(
      'non-q instances with Pinecone config must set memory.pinecone.projectId or memory.pinecone.expectedHostSuffix',
    );
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });
});

describe('handleConfigUpdate PATCH round-trip invariant (#244 #249)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-roundtrip-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(FIXTURES_HOME_DIR, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('a 200 PATCH produces a config that the loader validator accepts', async () => {
    const agentCwd = makeAgentCwd('rt-positive');
    const dir = path.join(tmpDir, 'whatsoup', 'instances', 'roundtrip');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name: 'roundtrip',
      type: 'agent',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    }));
    const inst = fakeInstance(cfg, { name: 'roundtrip', type: 'agent' });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({
        agentOptions: { sessionScope: 'shared', provider: 'claude-cli' },
      })),
      res, makeDeps(inst), { name: 'roundtrip' },
    );
    expect(res._status).toBe(200);
    const responseBody = JSON.parse(res._body);

    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.agentOptions.sessionScope).toBe('shared');
    expect(persisted.agentOptions.provider).toBe('claude-cli');
    expect(persisted.healthPort).toBe(9095);
    expect(persisted.accessMode).toBe('self_only');
    const loadErr = validateInstanceConfig(persisted, { name: 'roundtrip', mode: 'load' });
    expect(loadErr).toBeNull();
    expect(responseBody.agentOptions.provider).toBe('claude-cli');
  });

  it('rejects a PATCH that would render the instance unloadable and leaves the file untouched', async () => {
    const agentCwd = makeAgentCwd('rt-negative');
    const dir = path.join(tmpDir, 'whatsoup', 'instances', 'roundtrip-neg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    const original = {
      name: 'roundtrip-neg',
      type: 'agent',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    };
    fs.writeFileSync(cfg, JSON.stringify(original));
    const inst = fakeInstance(cfg, { name: 'roundtrip-neg', type: 'agent' });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { sessionScope: 'bogus' } })),
      res, makeDeps(inst), { name: 'roundtrip-neg' },
    );
    expect(res._status).toBe(400);
    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.agentOptions.sessionScope).toBe('per_chat');
    expect(persisted).toEqual(original);
  });

  it('persists a valid BYOK providerConfig + fallbacks patch (positive round-trip)', async () => {
    const agentCwd = makeAgentCwd('rt-byok');
    const dir = path.join(tmpDir, 'whatsoup', 'instances', 'roundtrip-byok');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({
      name: 'roundtrip-byok',
      type: 'agent',
      accessMode: 'self_only',
      adminPhones: ['15551230006'],
      healthPort: 9095,
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    }));
    const inst = fakeInstance(cfg, { name: 'roundtrip-byok', type: 'agent' });

    const providerConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };
    const fallbacks = [{ provider: 'openai-api', model: 'llama-3.3-70b-versatile' }];

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ agentOptions: { provider: 'claude-cli', providerConfig, fallbacks } })),
      res, makeDeps(inst), { name: 'roundtrip-byok' },
    );
    expect(res._status, 'patch must succeed: ' + res._body).toBe(200);

    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.agentOptions.providerConfig).toEqual(providerConfig);
    expect(persisted.agentOptions.fallbacks).toEqual(fallbacks);
    // Deep-merge must not clobber untouched agentOptions siblings.
    expect(persisted.agentOptions.sessionScope).toBe('per_chat');
    expect(persisted.agentOptions.cwd).toBe(agentCwd);
  });
});
