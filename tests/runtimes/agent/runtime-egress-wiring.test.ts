/**
 * AgentRuntime egress-proxy lifecycle wiring (#1607).
 *
 * The sandbox policy (`SandboxPolicy.allowedEgress`) is the seam: when a
 * PRESENT `allowedEgress` array — including `[]` (deny-all, F1) — is set,
 * `start()` boots a loopback `EgressProxy` after writing
 * `.claude/sandbox-policy.json` (so the proxy's own policy re-reads land on a
 * file that already contains the allowlist), and `shutdown()` tears the proxy
 * down. Only an ABSENT/undefined `allowedEgress` is byte-identical to
 * pre-#1607 behavior: no proxy, no env injection, no `allowedEgress` key
 * written to the policy file.
 *
 * Mocks mirror tests/runtimes/agent/mcp-config-dual-write.test.ts, the
 * neighboring runtime test that also runs a REAL `start()` against a real
 * temp cwd with `core/workspace.ts` unmocked (so `writeSandboxArtifacts`
 * really writes `.claude/sandbox-policy.json` to disk) while mocking
 * `session.ts` (so no real provider subprocess ever spawns).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

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
    // Required since the C5 restart-loop guard (#1929) merged into main: start()
    // and the health snapshot deref config.restartLoopGuard / config.stateRoot.
    stateRoot: '/tmp/whatsoup-test-state-egress-wiring',
    restartLoopGuard: { enabled: true, maxRestarts: 3, windowMs: 300_000 },
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
  getFallbackState: vi.fn(() => null),
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
    completeProviderTurn: vi.fn(),
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

// Test-only observability hook — `AgentRuntime.egressProxyPortForTest` (see
// runtime.ts near the `egressProxy` field) is the only thing outside the
// class that can see whether a proxy is live without reaching into private
// state.
type RuntimeWithEgressTestHook = AgentRuntime & { egressProxyPortForTest?: number };

// Waits for a refused (or otherwise errored) connect to a closed loopback
// port — proves the OS-level listener is actually gone, not just that a
// reference was dropped.
function expectConnectionRefused(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`expected connection to port ${port} to be refused, but it connected`));
    });
    socket.once('error', () => {
      resolve();
    });
  });
}

// Sends an absolute-URI forward-proxy GET through `proxyPort` and resolves the
// HTTP status. A denied host returns 403 before any upstream connect, so
// `targetHost:targetPort` need not be reachable.
function forwardGetStatus(proxyPort: number, targetHost: string, targetPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://${targetHost}:${targetPort}/`,
        headers: { Host: `${targetHost}:${targetPort}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('AgentRuntime egress proxy lifecycle (#1607)', () => {
  const startedRuntimes = new Set<AgentRuntime>();
  // Registered FIRST → under vitest's default "stack" sequence, afterEach
  // hooks run in REVERSE registration order, so this one runs LAST — i.e.
  // AFTER the shutdown-only afterEach below. This reproduces the original
  // combined hook's shutdown-then-cleanup order. Do not move this below the
  // afterEach() call — verified from @vitest/runner's own source
  // (chunk-artifact.js getSuiteHooks, "stack" sequence default in
  // coverage.DM_a_rWm.js) for hooks registered in the SAME describe scope;
  // this guarantee has not been verified for cross-scope (module-level vs.
  // describe-level) hook ordering, so this placement — not module scope — is
  // the one to keep.
  const tmp = trackTmpDirs('');

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.agentProvider = 'claude-cli';
    mockConfig.agentProviderConfig = undefined;
    mockConfig.agentFallbackProvider = undefined;
    mockConfig.agentFallbackModel = undefined;
    mockConfig.agentFallbacks = undefined;
  });

  // Registered SECOND → runs FIRST under "stack" ordering.
  afterEach(async () => {
    const failures: unknown[] = [];
    const shutdownResults = await Promise.allSettled(
      [...startedRuntimes].map((runtime) => runtime.shutdown()),
    );
    for (const result of shutdownResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    startedRuntimes.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'AgentRuntime egress-wiring test cleanup failed');
    }
  });

  function tmpCwd(): string {
    return tmp.make('ws-egress-wiring');
  }

  it('sandbox WITHOUT allowedEgress starts no proxy and writes no allowedEgress key (opt-out preserved)', async () => {
    const cwd = tmpCwd();
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'egress-off-test', {
      cwd,
      sandbox: { allowedPaths: [], allowedTools: [], bash: { enabled: false } },
    }) as RuntimeWithEgressTestHook;
    startedRuntimes.add(runtime);

    await runtime.start();

    expect(runtime.egressProxyPortForTest).toBeUndefined();
    const policy = readJson(join(cwd, '.claude', 'sandbox-policy.json'));
    expect(policy).not.toHaveProperty('allowedEgress');
  });

  it('sandbox with an empty allowedEgress array STARTS the proxy and denies all (deny-all, F1)', async () => {
    // An empty array is the documented deny-all: a PRESENT allowlist must run
    // the proxy (only absent/undefined opts out). Pre-fix the start gate had
    // `.length > 0`, so `[]` started NO proxy → the child got no HTTP_PROXY →
    // UNBOUNDED egress, the exact opposite of the documented guarantee.
    const cwd = tmpCwd();
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'egress-empty-test', {
      cwd,
      sandbox: { allowedPaths: [], allowedTools: [], bash: { enabled: false }, allowedEgress: [] },
    }) as RuntimeWithEgressTestHook;
    startedRuntimes.add(runtime);

    await runtime.start();

    const port = runtime.egressProxyPortForTest;
    expect(typeof port).toBe('number');
    expect(port as number).toBeGreaterThan(0);

    // deny-all: any host is refused with 403 (adjudicated against []), and the
    // upstream is never contacted — so an unreachable target port is fine.
    const status = await forwardGetStatus(port as number, '127.0.0.1', 9);
    expect(status).toBe(403);

    const policy = readJson(join(cwd, '.claude', 'sandbox-policy.json'));
    expect(policy.allowedEgress).toEqual([]);
  });

  it('sandbox WITH a non-empty allowedEgress starts a proxy, writes the policy file, and shutdown closes it', async () => {
    const cwd = tmpCwd();
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'egress-on-test', {
      cwd,
      sandbox: {
        allowedPaths: [],
        allowedTools: [],
        bash: { enabled: false },
        allowedEgress: ['api.anthropic.com'],
      },
    }) as RuntimeWithEgressTestHook;
    startedRuntimes.add(runtime);

    await runtime.start();

    const port = runtime.egressProxyPortForTest;
    expect(typeof port).toBe('number');
    expect(port as number).toBeGreaterThan(0);

    const policy = readJson(join(cwd, '.claude', 'sandbox-policy.json'));
    expect(policy.allowedEgress).toEqual(['api.anthropic.com']);

    await runtime.shutdown();
    startedRuntimes.delete(runtime);

    await expectConnectionRefused(port as number);
  });
});
