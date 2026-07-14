import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockConfig, mockRuntimeLogger } = vi.hoisted(() => ({
  mockConfig: {
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined as Record<string, unknown> | undefined,
    agentFallbackProvider: undefined as string | undefined,
    agentFallbackModel: undefined as string | undefined,
    agentFallbacks: undefined as Array<{ provider: string; model?: string }> | undefined,
    agentMaxQueueDepth: 100,
    controlPeers: new Map<string, string>(),
    adminPhones: new Set<string>(),
    toolUpdateMode: 'full' as const,
    toolUpdateRedirectJid: null as string | null,
    textAggregateDelayMs: 0,
    mediaDir: '/tmp/whatsoup-test-media',
    pineconeAllowedIndexes: [] as string[],
    voiceReply: 'never' as const,
  },
  mockRuntimeLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { mockSocketServerInstance, MockWhatSoupSocketServer } = vi.hoisted(() => {
  const mockSocketServerInstance = {
    start: vi.fn(),
    stop: vi.fn(),
    updateDeliveryJid: vi.fn(),
    updateActorJid: vi.fn(),
    updateConversationKey: vi.fn(),
  };
  function MockWhatSoupSocketServer() {
    return mockSocketServerInstance;
  }
  return { mockSocketServerInstance, MockWhatSoupSocketServer };
});

vi.mock('../../../src/config.ts', () => ({ config: mockConfig }));
vi.mock('../../../src/logger.ts', () => ({ createChildLogger: () => mockRuntimeLogger }));
vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: vi.fn(() => []),
  getMessagesSince: vi.fn(() => []),
  updateMediaPath: vi.fn(),
  updateTranscription: vi.fn(),
}));
vi.mock('../../../src/core/heal.ts', () => ({
  dequeueNextReport: vi.fn(() => null),
  emitHealReport: vi.fn(),
}));
vi.mock('../../../src/core/durability.ts', () => ({
  sendTracked: vi.fn(),
}));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(),
  clearAlertSourceChecked: vi.fn(() => true),
}));
vi.mock('../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => null),
  resolveProviderKeyService: vi.fn((provider: unknown, model: unknown) => {
    if (provider === 'opencode-cli' && typeof model === 'string') return model.split('/')[0]?.trim().toLowerCase() || null;
    if (provider === 'openai-api') return 'openai';
    if (provider === 'anthropic-api') return 'anthropic';
    return null;
  }),
}));
vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  ensureAgentSchema: vi.fn(),
  createSession: vi.fn(() => 1),
  accumulateSessionTokens: vi.fn(),
  incrementMessageCount: vi.fn(),
  updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(),
  getActiveSession: vi.fn(() => null),
  backfillWorkspaceKeys: vi.fn(),
  markOrphaned: vi.fn(),
  getResumableSessionForChat: vi.fn(() => null),
  backfillSessionProvider: vi.fn(),
  insertTokenEvent: vi.fn(),
  accumulateTokensWithEvent: vi.fn(),
  getSessionTokenSnapshot: vi.fn(() => null),
  markSessionCompacted: vi.fn(),
}));
vi.mock('../../../src/runtimes/agent/fallback-state-db.ts', () => ({
  ensureFallbackStateSchema: vi.fn(),
  saveFallbackState: vi.fn(),
  loadFallbackState: vi.fn(() => null),
  clearFallbackState: vi.fn(),
}));
vi.mock('../../../src/runtimes/agent/session-classifier.ts', () => ({
  classifyActiveSessions: vi.fn(() => []),
}));
vi.mock('../../../src/runtimes/agent/session.ts', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    spawnSession: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => {}),
    handleNew: vi.fn(async () => {}),
    getStatus: vi.fn(() => ({
      active: false,
      pid: null,
      sessionId: null,
      startedAt: null,
      messageCount: 0,
      lastMessageAt: null,
    })),
    shutdown: vi.fn(async () => {}),
    clearTurnWatchdog: vi.fn(),
    tickWatchdog: vi.fn(),
    trackToolStart: vi.fn(),
    trackToolEnd: vi.fn(),
    getDbRowId: vi.fn(() => null),
    setDurability: vi.fn(),
  })),
  formatAge: vi.fn(() => '0s ago'),
  getProviderBinary: vi.fn(() => 'provider-bin'),
}));
vi.mock('../../../src/runtimes/agent/outbound-queue.ts', () => ({
  OutboundQueue: vi.fn().mockImplementation(() => ({
    enqueueText: vi.fn(),
    getSenderToken: () => 'mock-sender-token',
    enqueueStreamingText: vi.fn(),
    enqueueResultText: vi.fn(),
    enqueueToolUpdate: vi.fn(),
    enqueueProgressUpdate: vi.fn(),
    indicateTyping: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    abortTurn: vi.fn(),
    updateDeliveryJid: vi.fn(),
    setInboundSeq: vi.fn(),
    markLastTerminal: vi.fn(),
    clearLastOpId: vi.fn(),
    setToolUpdateMode: vi.fn(),
    setToolUpdateRedirectJid: vi.fn(),
    setTextAggregateDelayMs: vi.fn(),
    enqueuePoll: vi.fn(async (fn: () => Promise<void>) => { await fn(); }),
    hasPendingPoll: vi.fn(() => false),
    setPollPending: vi.fn(),
    targetChatJid: 'test@s.whatsapp.net',
    getLastOpId: vi.fn(() => undefined),
    setDurability: vi.fn(),
  })),
}));
vi.mock('../../../src/runtimes/agent/control-queue.ts', () => ({
  ControlQueue: vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    shutdown: vi.fn(async () => {}),
  })),
}));
vi.mock('../../../src/runtimes/agent/turn-queue.ts', () => ({
  TurnQueue: class {
    setProcessor = vi.fn();
    enqueue = vi.fn();
    shutdown = vi.fn(async () => {});
    closeAndTakePendingTurns = vi.fn(() => []);
    getStatus = vi.fn(() => ({ depth: 0, maxDepth: 100 }));
  },
}));
vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));
vi.mock('../../../src/mcp/register-all.ts', () => ({
  registerAllTools: vi.fn(),
}));
vi.mock('../../../src/mcp/socket-server.ts', () => ({
  WhatSoupSocketServer: MockWhatSoupSocketServer,
}));
vi.mock('../../../src/runtimes/agent/media-bridge.ts', () => ({
  startMediaBridge: vi.fn(),
  setMediaBridgeChat: vi.fn(),
}));
vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => ({ ok: true, version: 'test' })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));
vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));
vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn(() => '/tmp/test.mp3'),
  downloadMedia: vi.fn(),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { writeProviderMcpConfig } from '../../../src/runtimes/agent/providers/mcp-bridge.ts';

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

async function startRuntime(cwd: string, model?: string): Promise<AgentRuntime> {
  const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'dual-write-test', { cwd, model });
  startedRuntimes.add(runtime);
  await runtime.start();
  return runtime;
}

const startedRuntimes = new Set<AgentRuntime>();

describe('AgentRuntime startup MCP config dual-write', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentProviderConfig = undefined;
    mockConfig.agentFallbackProvider = undefined;
    mockConfig.agentFallbackModel = undefined;
    mockConfig.agentFallbacks = undefined;
    tmpDirs = [];
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    const shutdownResults = await Promise.allSettled(
      [...startedRuntimes].map((runtime) => runtime.shutdown()),
    );
    for (const result of shutdownResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    startedRuntimes.clear();
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    tmpDirs = [];
    if (failures.length > 0) {
      throw new AggregateError(failures, 'AgentRuntime test cleanup failed');
    }
  });

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ws-dual-mcp-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('writes claude primary and opencode fallback configs with whatsoup MCP entries', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentProviderConfig = { baseUrl: 'https://primary.example/v1' };
    mockConfig.agentFallbackProvider = 'opencode-cli';
    mockConfig.agentFallbackModel = 'fallback-model';

    await startRuntime(cwd);

    const claude = readJson(join(cwd, '.mcp.json'));
    const opencode = readJson(join(cwd, 'opencode.json'));
    expect((claude.mcpServers as Record<string, unknown>).whatsoup).toBeDefined();
    const opencodeMcp = opencode.mcp as Record<string, Record<string, unknown>>;
    expect(opencodeMcp.whatsoup).toMatchObject({ type: 'local', enabled: true });
    expect(opencodeMcp.whatsoup.environment).toEqual({
      WHATSOUP_SOCKET: join(cwd, '.claude', 'whatsoup.sock'),
    });
    expect(opencode.provider).toBeUndefined();
    expect(opencode.model).toBeUndefined();
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpConfigPaths: [join(cwd, '.mcp.json'), join(cwd, 'opencode.json')],
      }),
      'wrote whatsoup MCP config',
    );
  });

  it('writes .mcp.json for a claude fallback when the primary is openai-api', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'openai-api';
    mockConfig.agentFallbackProvider = 'claude-cli';

    await startRuntime(cwd);

    const claude = readJson(join(cwd, '.mcp.json'));
    expect((claude.mcpServers as Record<string, unknown>).whatsoup).toBeDefined();
  });

  it('keeps the primary shape and warns when primary and fallback share a target', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentFallbackProvider = 'gemini-cli';

    await startRuntime(cwd);

    const claude = readJson(join(cwd, '.mcp.json'));
    expect(claude).toHaveProperty('mcpServers');
    expect(claude).not.toHaveProperty('mcp');
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: 'claude-cli',
        fallback: 'gemini-cli',
        target: join(cwd, '.mcp.json'),
      }),
      expect.stringContaining('primary and fallback providers share an MCP config target'),
    );
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpConfigPaths: [join(cwd, '.mcp.json')],
      }),
      'wrote whatsoup MCP config',
    );
  });

  it('threads baseUrl + apiKeyService from the primary providerConfig into the opencode provider block', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'opencode-cli';
    mockConfig.agentProviderConfig = {
      baseUrl: 'https://api.minimax.example/v1',
      apiKeyService: 'minimax',
    };

    await startRuntime(cwd, 'MiniMax-M2');

    const opencode = readJson(join(cwd, 'opencode.json'));
    const provider = opencode.provider as Record<string, Record<string, unknown>>;
    expect(provider['whatsoup-cloud']).toBeDefined();
    expect(provider['whatsoup-cloud'].options).toEqual({
      baseURL: 'https://api.minimax.example/v1',
      apiKey: '{env:MINIMAX_API_KEY}',
    });
    expect(opencode.model).toBe('whatsoup-cloud/MiniMax-M2');
  });

  it('keeps current single-write behavior when no fallback is configured', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'claude-cli';

    await startRuntime(cwd);

    expect(existsSync(join(cwd, '.mcp.json'))).toBe(true);
    expect(existsSync(join(cwd, 'opencode.json'))).toBe(false);
  });

  it('keeps user-global Claude settings byte-stable while starting a configured workspace', async () => {
    const cwd = tmp();
    const globalClaudeDir = join(homedir(), '.claude');
    const globalSettingsPath = join(globalClaudeDir, 'settings.json');
    const sentinel = '{\n  "hooks": { "PreToolUse": [] },\n  "sentinel": "unchanged"\n}\n';
    mkdirSync(globalClaudeDir, { recursive: true });
    writeFileSync(globalSettingsPath, sentinel);

    const runtime = await startRuntime(cwd);
    await runtime.shutdown();
    startedRuntimes.delete(runtime);

    expect(readFileSync(globalSettingsPath, 'utf8')).toBe(sentinel);
    expect(readJson(join(cwd, '.claude', 'settings.json'))).toHaveProperty('permissions');
  });

  it.each(['non-sandbox', 'sandbox'] as const)(
    'rejects a configured %s cwd alias to HOME before changing user-global Claude artifacts',
    async (mode) => {
      const root = tmp();
      const alias = join(root, 'home-alias');
      const globalClaudeDir = join(homedir(), '.claude');
      const settingsPath = join(globalClaudeDir, 'settings.json');
      const policyPath = join(globalClaudeDir, 'sandbox-policy.json');
      const priorSettings = existsSync(settingsPath) ? readFileSync(settingsPath) : null;
      const priorPolicy = existsSync(policyPath) ? readFileSync(policyPath) : null;
      const sentinel = Buffer.from(`{"sentinel":"${mode}"}\n`);
      mkdirSync(globalClaudeDir, { recursive: true });
      writeFileSync(settingsPath, sentinel);
      rmSync(policyPath, { force: true });
      symlinkSync(homedir(), alias);
      const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'home-alias-test', {
        cwd: alias,
        ...(mode === 'sandbox'
          ? { sandbox: { allowedPaths: [], allowedTools: [], bash: { enabled: false } } }
          : {}),
      });

      try {
        await expect(runtime.start()).rejects.toThrow(/cwd.*home directory/i);
        expect(readFileSync(settingsPath)).toEqual(sentinel);
        expect(existsSync(policyPath)).toBe(false);
      } finally {
        if (priorSettings) writeFileSync(settingsPath, priorSettings);
        else rmSync(settingsPath, { force: true });
        if (priorPolicy) writeFileSync(policyPath, priorPolicy);
        else rmSync(policyPath, { force: true });
      }
    },
  );

  it('attempts every chain target, writes each distinct file once, and warns on the shared-target entry', async () => {
    // Chain: primary claude-cli + [opencode-cli, gemini-cli]. Three targets are
    // attempted; .mcp.json is written once (primary shape — gemini-cli shares it
    // and is skipped with a warn), opencode.json is written for the opencode entry.
    const cwd = tmp();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentFallbacks = [
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      { provider: 'gemini-cli' },
    ];

    await startRuntime(cwd);

    const claude = readJson(join(cwd, '.mcp.json'));
    expect(claude).toHaveProperty('mcpServers');
    expect(claude).not.toHaveProperty('mcp');
    expect((claude.mcpServers as Record<string, unknown>).whatsoup).toBeDefined();

    const opencode = readJson(join(cwd, 'opencode.json'));
    const opencodeMcp = opencode.mcp as Record<string, Record<string, unknown>>;
    expect(opencodeMcp.whatsoup).toMatchObject({ type: 'local', enabled: true });

    expect(mockRuntimeLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: 'claude-cli',
        fallback: 'gemini-cli',
        target: join(cwd, '.mcp.json'),
      }),
      expect.stringContaining('primary and fallback providers share an MCP config target'),
    );
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpConfigPaths: [join(cwd, '.mcp.json'), join(cwd, 'opencode.json')],
      }),
      'wrote whatsoup MCP config',
    );
  });

  it('writes opencode.json once for two opencode chain entries and skips the second via the written-targets set', async () => {
    const cwd = tmp();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentFallbacks = [
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      { provider: 'opencode-cli', model: 'deepseek/deepseek-chat' },
    ];

    await startRuntime(cwd);

    // The first opencode entry wins the write; the second is skipped because
    // opencode.json is already in the written-targets set.
    const opencode = readJson(join(cwd, 'opencode.json'));
    const opencodeMcp = opencode.mcp as Record<string, Record<string, unknown>>;
    expect(opencodeMcp.whatsoup).toMatchObject({ type: 'local', enabled: true });

    expect(mockRuntimeLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: 'claude-cli',
        fallback: 'opencode-cli',
        target: join(cwd, 'opencode.json'),
      }),
      expect.stringContaining('primary and fallback providers share an MCP config target'),
    );
    expect(mockRuntimeLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpConfigPaths: [join(cwd, '.mcp.json'), join(cwd, 'opencode.json')],
      }),
      'wrote whatsoup MCP config',
    );
  });
});

describe('opencode MCP config write hardening', () => {
  let tmpDirs: string[] = [];
  const socketPath = '/tmp/test.sock';
  const proxyScript = '/opt/whatsoup/deploy/mcp/whatsoup-proxy.ts';

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ws-opencode-hardening-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('warns on corrupt user opencode.json, overwrites from a fresh base, and proceeds', () => {
    const dir = tmp();
    const target = join(dir, 'opencode.json');
    writeFileSync(target, '{ not json');
    let fileAtWarn = '';
    mockRuntimeLogger.warn.mockImplementationOnce(() => {
      fileAtWarn = readFileSync(target, 'utf8');
    });

    const written = writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript);

    expect(written).toBe(target);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ target }),
      expect.stringContaining('failed to parse existing opencode.json'),
    );
    expect(fileAtWarn).toBe('{ not json');
    const parsed = readJson(target);
    expect((parsed.mcp as Record<string, unknown>).whatsoup).toBeDefined();
  });

  it('skips symlinked opencode.json with a warning and does not throw', () => {
    const dir = tmp();
    const decoyDir = tmp();
    const decoyTarget = join(decoyDir, 'attacker-opencode.json');
    symlinkSync(decoyTarget, join(dir, 'opencode.json'));

    const written = writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript);

    expect(written).toBeNull();
    expect(existsSync(decoyTarget)).toBe(false);
    expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ target: join(dir, 'opencode.json') }),
      expect.stringContaining('skipping opencode MCP config write'),
    );
  });

  it('removes the managed whatsoup-cloud provider (including its apiKey) and model when baseUrl is no longer configured', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'whatsoup-cloud/old-model',
        provider: {
          'whatsoup-cloud': {
            options: { baseURL: 'https://old.example/v1', apiKey: '{env:MINIMAX_API_KEY}' },
            models: { 'old-model': {} },
          },
          usercloud: {
            options: { baseURL: 'https://user.example/v1' },
            models: { usermodel: {} },
          },
        },
        mcp: {
          custom: { type: 'local', command: ['custom'], enabled: true },
        },
      }),
    );

    writeProviderMcpConfig('opencode-cli', dir, socketPath, proxyScript);

    const parsed = readJson(join(dir, 'opencode.json'));
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.model).toBeUndefined();
    const provider = parsed.provider as Record<string, unknown>;
    expect(provider['whatsoup-cloud']).toBeUndefined();
    expect(provider.usercloud).toEqual({
      options: { baseURL: 'https://user.example/v1' },
      models: { usermodel: {} },
    });
    const mcp = parsed.mcp as Record<string, unknown>;
    expect(mcp.custom).toEqual({ type: 'local', command: ['custom'], enabled: true });
    expect(mcp.whatsoup).toMatchObject({
      type: 'local',
      command: expect.arrayContaining([proxyScript]),
      environment: { WHATSOUP_SOCKET: socketPath },
      enabled: true,
    });
  });
});
