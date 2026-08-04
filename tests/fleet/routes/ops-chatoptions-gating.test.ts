/**
 * chatOptions (openaiProviderConfig — QR-218 PR-2) route-gating coverage.
 *
 * chatOptions is chat-only and, unlike agentOptions, is NOT a PASSTHROUGH_FIELDS
 * entry — it has its own dedicated CREATE-time gate
 * (`type === 'chat' && body.chatOptions != null`) so an agent/passive config can
 * never carry an unvalidated chat-shaped block (src/fleet/routes/ops.ts). PATCH
 * mirrors this: deepMergeRecords has no type awareness, so handleConfigUpdate
 * drops chatOptions from the merged config when its type is not 'chat' (same
 * drop-not-reject behavior as CREATE) before persisting. A malformed
 * openaiProviderConfig on an actual type: 'chat' instance is still caught by
 * the shared validator (validateChatOptions in
 * src/core/agent-config-validator.ts), which runs for every type: 'chat'
 * instance. Neither the CREATE gate nor the PATCH drop had a direct test
 * before this file. Harness mirrors ops-create-byok-roundtrip.test.ts (CREATE)
 * and ops-config-patch-validation.test.ts (PATCH) — same temp dirs, real
 * handlers, config.json readback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { handleCreateLine, handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

function successDeps(): OpsDeps {
  return makeDeps<any>({});
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
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'chatopts-roundtrip',
          type: 'chat',
          adminPhones: ['15551234567'],
          chatOptions: { openaiProviderConfig },
        }),
      }),
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
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'chatopts-agent-drop',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { cwd: agentCwd, sessionScope: 'single' },
          chatOptions: {
            openaiProviderConfig: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyService: 'groq' },
          },
        }),
      }),
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

  it('persists a valid transcriptionOptions.openaiProviderConfig for type: agent', async () => {
    const agentCwd = fs.mkdtempSync(path.join(process.env.HOME!, 'transcription-agent-cwd-'));
    const openaiProviderConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'transcription-agent-roundtrip',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { cwd: agentCwd, sessionScope: 'single' },
          transcriptionOptions: { openaiProviderConfig },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);

    const cfgPath = path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'transcription-agent-roundtrip', 'config.json',
    );
    const persisted = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    expect(persisted.type).toBe('agent');
    expect(persisted.transcriptionOptions).toEqual({ openaiProviderConfig });
  });

  it('rejects malformed transcriptionOptions.openaiProviderConfig on CREATE before writing config.json', async () => {
    const agentCwd = fs.mkdtempSync(path.join(process.env.HOME!, 'transcription-agent-cwd-'));
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'transcription-agent-invalid',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { cwd: agentCwd, sessionScope: 'single' },
          transcriptionOptions: {
            openaiProviderConfig: { baseUrl: 'not-a-url' },
          },
        }),
      }),
      res,
      successDeps(),
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(
      /transcriptionOptions\.openaiProviderConfig\.baseUrl must be a valid URL/,
    );
    const cfgPath = path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'transcription-agent-invalid', 'config.json',
    );
    expect(fs.existsSync(cfgPath)).toBe(false);
  });
});

describe('handleConfigUpdate PATCH chatOptions validation (QR-218 PR-2)', () => {
  let tmpDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let agentCwd: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-patch-chatopts-'));
    originalEnv = { ...process.env };
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'whatsoup', 'instances'), { recursive: true });
    agentCwd = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (agentCwd) fs.rmSync(agentCwd, { recursive: true, force: true });
    process.env = originalEnv;
  });

  /** Build a real, writable agent cwd under $HOME so the route-level
   *  resolveAndValidateAgentCwd guard passes (mirrors
   *  ops-config-patch-validation.test.ts's makeAgentCwd). */
  function makeAgentCwd(label: string): string {
    const dir = path.join(os.homedir(), '.whatsoup-test-fixtures', `chatopts-patch-${label}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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

  function depsFor(instance: DiscoveredInstance): OpsDeps {
    return makeDeps<any>({ discovery: { getInstance: vi.fn(() => instance) } as any });
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
      mockReq({
        method: 'PATCH',
        body: JSON.stringify({
          chatOptions: { openaiProviderConfig: { baseUrl: 'not-a-url' } },
        }),
      }),
      res, depsFor(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('validation_failed');
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('preserves a valid chatOptions.openaiProviderConfig on a chat-instance PATCH', async () => {
    // The chat-only PATCH gate (merged.type !== 'chat' -> drop) must NOT strip
    // chatOptions from a genuine chat instance. Guards against a future
    // inversion of that condition silently dropping valid config.
    const cfg = writeChatConfig();
    const openaiProviderConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ chatOptions: { openaiProviderConfig } }) }),
      res, depsFor(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.type).toBe('chat');
    expect(persisted.chatOptions).toEqual({ openaiProviderConfig });
  });

  it('replaces chatOptions.openaiProviderConfig on PATCH so omitted apiKeyService is removed', async () => {
    const cfg = writeChatConfig('test-line', {
      chatOptions: {
        openaiProviderConfig: {
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKeyService: 'groq',
        },
      },
    });
    const res = mockRes();

    await handleConfigUpdate(
      mockReq({
        method: 'PATCH',
        body: JSON.stringify({
          chatOptions: {
            openaiProviderConfig: {
              baseUrl: 'https://api.openrouter.ai/v1',
            },
          },
        }),
      }),
      res, depsFor(fakeInstance(cfg)), { name: 'test-line' },
    );

    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.chatOptions).toEqual({
      openaiProviderConfig: {
        baseUrl: 'https://api.openrouter.ai/v1',
      },
    });
  });

  it('rejects an unknown chatOptions.openaiProviderConfig.apiKeyService with 400 and leaves the file untouched', async () => {
    const cfg = writeChatConfig();
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({
        method: 'PATCH',
        body: JSON.stringify({
          chatOptions: {
            openaiProviderConfig: {
              baseUrl: 'https://api.groq.com/openai/v1',
              apiKeyService: 'not-a-real-service',
            },
          },
        }),
      }),
      res, depsFor(fakeInstance(cfg)), { name: 'test-line' },
    );
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('validation_failed');
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('drops chatOptions when the merged config type is not chat (PATCH mirrors the CREATE gate)', async () => {
    // deepMergeRecords has no type awareness, so without a PATCH-side gate a
    // chatOptions block merged onto a non-chat instance would never reach
    // validateChatOptions (gated to type === 'chat') and would be persisted
    // unvalidated. Mirrors handleCreateLine's `type === 'chat' &&
    // body.chatOptions != null` gate: drop, don't reject.
    agentCwd = makeAgentCwd('drop');
    const cfg = writeChatConfig('test-agent-chatopts', {
      type: 'agent',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({
        method: 'PATCH',
        body: JSON.stringify({
          chatOptions: { openaiProviderConfig: { baseUrl: 'not-a-url' } },
        }),
      }),
      res, depsFor(fakeInstance(cfg, { type: 'agent', name: 'test-agent-chatopts' })),
      { name: 'test-agent-chatopts' },
    );
    expect(res._status, 'drop, not reject: ' + res._body).toBe(200);

    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect('chatOptions' in persisted).toBe(false);
    // Prove this is a genuine, correctly-populated agent config (not an empty
    // object that would vacuously lack chatOptions).
    expect(persisted.type).toBe('agent');
    expect(persisted.agentOptions.cwd).toBe(agentCwd);
  });

  it('preserves a valid transcriptionOptions.openaiProviderConfig on an agent-instance PATCH', async () => {
    agentCwd = makeAgentCwd('transcription-preserve');
    const cfg = writeChatConfig('test-agent-transcriptionopts', {
      type: 'agent',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    });
    const openaiProviderConfig = {
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyService: 'groq',
    };
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ transcriptionOptions: { openaiProviderConfig } }) }),
      res,
      depsFor(fakeInstance(cfg, { type: 'agent', name: 'test-agent-transcriptionopts' })),
      { name: 'test-agent-transcriptionopts' },
    );
    expect(res._status, res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(persisted.type).toBe('agent');
    expect(persisted.transcriptionOptions).toEqual({ openaiProviderConfig });
  });

  it('rejects a malformed transcriptionOptions.openaiProviderConfig.baseUrl with 400 and leaves the file untouched', async () => {
    agentCwd = makeAgentCwd('transcription-invalid');
    const cfg = writeChatConfig('agent-bad-transcription', {
      type: 'agent',
      agentOptions: { sessionScope: 'per_chat', cwd: agentCwd },
    });
    const before = fs.readFileSync(cfg, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({
        method: 'PATCH',
        body: JSON.stringify({
          transcriptionOptions: { openaiProviderConfig: { baseUrl: 'not-a-url' } },
        }),
      }),
      res,
      depsFor(fakeInstance(cfg, { type: 'agent', name: 'agent-bad-transcription' })),
      { name: 'agent-bad-transcription' },
    );
    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('validation_failed');
    expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
  });
});
