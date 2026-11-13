/**
 * B11 native-copy fix (Opus I1): an existing claude-cli SessionManager that respawns in place must
 * re-check the Microsoft 365 policy at that spawn. The native plugin copy is swapped after the first
 * spawn; nothing else (no new session, no settings write) runs before the auto-respawn path resumes
 * the same manager. The respawned child must get the full M365 deny set as --disallowedTools and no
 * bridge or workflow-authority values, and the turn must publish no assignment.
 *
 * The swap is simulated through the re-check (as fallback-chain-selection.test.ts does); the adapter
 * tests prove that a real changed native copy is detected by that re-check.
 *
 * A startup that admits no guarded plugin (qpi-lab2 review of #3935, finding 1) must give every later
 * claude-cli spawn the same withdrawn shape, because nothing verified the plugin that child loads.
 *
 * A sandboxPerChat session child (qpi-lab2 review 5898990442, finding 2) gets no authority socket, so
 * its guarded plugin fails closed, while it keeps its WhatSoup socket and session token.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    emitObservationChecked: vi.fn(() => true),
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

vi.mock('../../../src/config.ts', () => ({
  config: {
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-m365-respawn/tmp',
    // Absent, so no provider canary store is provisioned.
    stateRoot: '/tmp/whatsoup-test-m365-respawn-state-absent',
    voiceReply: 'never',
    elevenlabs: { defaultVoiceId: 'v', defaultModel: 'eleven_multilingual_v2', stability: 0.5, similarityBoost: 0.75 },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
    agentFallbacks: undefined,
  },
}));

vi.mock('../../../src/mcp/register-all.ts', () => ({ registerAllTools: vi.fn() }));

vi.mock('../../../src/mcp/registry.ts', () => ({
  ToolRegistry: class {
    register = vi.fn();
    listTools = vi.fn(() => []);
    call = vi.fn();
    getChatScopedToolNames = vi.fn(() => []);
    setDurability = vi.fn();
  },
}));

// No keychain or credential-file reads from a test.
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/keyring.ts')>(),
  lookupCredential: () => null,
}));

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { spawn } from 'node:child_process';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { m365BridgeCredentialAdmission, type M365MutationPolicy } from '../../../src/core/m365-bridge-policy.ts';
import { M365_MUTATION_DENY } from '../../../src/core/settings-template.ts';
import * as microsoft365Adapter from '../../../src/runtimes/agent/microsoft365-adapter.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const ORIGIN = 'https://127.0.0.1:10000';
const ACCOUNT_ID = 'employee-account';
const CHAT_JID = '15551230002@s.whatsapp.net';
const ENABLED_PLUGINS = { 'microsoft_365@microsoft-365-dev': true };

function makeDb(): Database {
  return {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })), get: vi.fn(), all: vi.fn(() => []) })), exec: vi.fn() },
  } as unknown as Database;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
}

function fakeChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
}

type SpawnedSession = { spawnSession(sessionId?: string, dbRowId?: number): Promise<void> };
type Published = { workflowAuthority?: unknown; workflowAuthorityScope?: string; m365RouteProvider?: string };
type RuntimeInternals = {
  createSessionManager(opts: Record<string, unknown>): SpawnedSession;
  m365ExecutingAuthority(session: unknown, humanRequest: boolean, requestRef: string | undefined): Published;
  wirePerChatActorSocket(chatJid: string, provider: string): { mcpSocketPath?: string; providerTransitionReady: Promise<void> } | undefined;
  setOwnedPerChatSession(mapKey: string, session: unknown): void;
  resolvePerChatMapKey(chatJid: string): string;
  isSessionProvablyTerminated(session: unknown): boolean;
  sessionOwnership: {
    get(mapKey: string): { managerId: string; generation: number } | undefined;
    transition(mapKey: string, managerId: string, to: string): void;
    setRespawnTimer(mapKey: string, managerId: string, generation: number, timer: ReturnType<typeof setTimeout>): boolean;
  };
  runOwnedPerChatRespawn(args: Record<string, unknown>): Promise<void>;
};

function m365Keys(env: NodeJS.ProcessEnv | undefined): string[] {
  return Object.keys(env ?? {}).filter((key) => key.startsWith('MS365_') || key === 'ALLOW_M365_MUTATIONS');
}

describe('Microsoft 365 authority at an in-place claude-cli respawn', () => {
  beforeEach(() => {
    const binding = {
      tenantId: TENANT_ID, origin: ORIGIN, profile: 'user-full-v1' as const, accountId: ACCOUNT_ID,
      workflowAuthority: { accountId: ACCOUNT_ID, employeeActorJid: '15551230001@s.whatsapp.net' },
    };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: ORIGIN, MS365_HUB_URL: ORIGIN,
      MS365_TENANT_ID: TENANT_ID, MS365_PROFILE: 'user-full-v1',
      MS365_AGENT365_API_KEY: 'synthetic-key', MS365_AGENT365_ACCOUNT_ID: ACCOUNT_ID,
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_EMAIL', undefined);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true, enabledPlugins: ENABLED_PLUGINS,
      binding, sessionScope: 'per_chat', env: process.env,
    }, process.pid) ?? undefined);
    (globalThis as Record<string, unknown>)['__m365RespawnBinding__'] = binding;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('re-checks before the auto-respawn path resumes an existing manager whose native copy changed', async () => {
    const binding = (globalThis as Record<string, unknown>)['__m365RespawnBinding__'] as Record<string, unknown>;
    // These runtimes never call start(); the re-check simulates an admitted copy until the swap below.
    let swapped = false;
    const recheck = vi.spyOn(microsoft365Adapter, 'recheckMicrosoft365Workflow').mockImplementation((p: M365MutationPolicy | undefined) =>
      swapped && p?.status === 'approved' && p.workflowAuthority !== undefined ? { status: 'approved', childEnv: p.childEnv } : p);
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      model: 'primary-model', sessionScope: 'per_chat', allowM365Mutations: true, enabledPlugins: ENABLED_PLUGINS, m365Bridge: binding as never,
    });
    const internals = runtime as unknown as RuntimeInternals;
    vi.spyOn(internals, 'wirePerChatActorSocket').mockReturnValue({ mcpSocketPath: '/fixture/actor.sock', providerTransitionReady: Promise.resolve() });
    vi.mocked(spawn).mockImplementation(() => fakeChild(4242) as never);

    const onCrash = vi.fn();
    const session = internals.createSessionManager({ chatJid: CHAT_JID, onEvent: vi.fn(), onCrash, notifyUser: vi.fn() });
    await session.spawnSession();

    // Positive control: the admitted session's first child keeps the lifted route and the guarded plugin's values.
    const first = vi.mocked(spawn).mock.calls.at(-1)!;
    expect(first[1]).not.toContain('--disallowedTools');
    expect((first[2] as { env?: NodeJS.ProcessEnv }).env?.MS365_WORKFLOW_AUTHORITY_REQUIRED).toBe('1');
    // Outside sandboxPerChat the guarded plugin reaches the broker on the session's own socket.
    expect((first[2] as { env?: NodeJS.ProcessEnv }).env?.MS365_WORKFLOW_AUTHORITY_SOCKET).toBe('/fixture/actor.sock');
    expect((first[2] as { env?: NodeJS.ProcessEnv }).env?.MS365_AGENT365_API_KEY).toBe('synthetic-key');
    expect(internals.m365ExecutingAuthority(session, true, 'request-1')).toMatchObject({ m365RouteProvider: 'claude-cli' });
    expect(internals.m365ExecutingAuthority(session, true, 'request-1').workflowAuthority).toBeDefined();

    // A marketplace update swaps the native copy. No session is created and no settings are written.
    swapped = true;
    const rechecksBefore = recheck.mock.calls.length;

    // The child is killed; the auto-respawn path resumes the SAME manager in place.
    const firstChild = vi.mocked(spawn).mock.results.at(-1)!.value as ReturnType<typeof fakeChild>;
    firstChild.emit('exit', null, 'SIGKILL');
    firstChild.emit('close', null, 'SIGKILL');
    // Wait until the manager has processed the unexpected exit, not for a fixed tick.
    await vi.waitFor(() => expect(onCrash).toHaveBeenCalled());
    const mapKey = internals.resolvePerChatMapKey(CHAT_JID);
    internals.setOwnedPerChatSession(mapKey, session);
    const owner = internals.sessionOwnership.get(mapKey)!;
    internals.sessionOwnership.transition(mapKey, owner.managerId, 'recoverable_dead');
    // An identity token for the ownership record's respawn-timer slot; no real timer is armed.
    const timer = {} as ReturnType<typeof setTimeout>;
    expect(internals.sessionOwnership.setRespawnTimer(mapKey, owner.managerId, owner.generation, timer)).toBe(true);
    vi.spyOn(internals, 'isSessionProvablyTerminated').mockReturnValue(true);
    const spawnsBefore = vi.mocked(spawn).mock.calls.length;
    await internals.runOwnedPerChatRespawn({
      // The child died before its init event, so it has no provider session id to resume.
      timer, session, initialMapKey: mapKey, sessionId: undefined, dbRowId: null,
      managerId: owner.managerId, recoveryGeneration: owner.generation, chatJid: CHAT_JID,
    });

    expect(vi.mocked(spawn).mock.calls.length).toBe(spawnsBefore + 1);
    expect(recheck.mock.calls.length).toBeGreaterThan(rechecksBefore);
    const respawned = vi.mocked(spawn).mock.calls.at(-1)!;
    const args = respawned[1] as string[];
    expect(args).toContain('--disallowedTools');
    expect(M365_MUTATION_DENY.filter((entry) => !args.includes(entry))).toEqual([]);
    expect(m365Keys((respawned[2] as { env?: NodeJS.ProcessEnv }).env)).toEqual([]);
    // The respawned child's turn publishes no assignment and no route provider.
    const published = internals.m365ExecutingAuthority(session, true, 'request-2');
    expect(published.workflowAuthority).toBeUndefined();
    expect(published.workflowAuthorityScope).toBeUndefined();
    expect(published.m365RouteProvider).toBeUndefined();
  }, 15_000);

  it('gives a later claude-cli spawn the withdrawn shape when startup admitted no guarded plugin', async () => {
    const binding = (globalThis as Record<string, unknown>)['__m365RespawnBinding__'] as Record<string, unknown>;
    const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
      model: 'primary-model', sessionScope: 'per_chat', allowM365Mutations: true, enabledPlugins: ENABLED_PLUGINS, m365Bridge: binding as never,
    });
    const internals = runtime as unknown as RuntimeInternals & { m365MutationPolicy: M365MutationPolicy | undefined };
    expect(internals.m365MutationPolicy).toMatchObject({ status: 'approved', workflowAuthority: expect.anything() });
    // What start() does: admission with no guarded plugin under pluginDirs, so no adapter candidate.
    internals.m365MutationPolicy = microsoft365Adapter.admitMicrosoft365Workflow({
      registry: new ToolRegistry(), policy: internals.m365MutationPolicy, pluginDirs: [],
      perChatMcpSocketManager: {} as never, resolvePerChatMapKey: (jid: string) => jid,
      sessionTokens: new SessionTokenRegistry(), sandboxPerChat: false, instanceName: 'test',
    });
    vi.spyOn(internals, 'wirePerChatActorSocket').mockReturnValue({ mcpSocketPath: '/fixture/actor.sock', providerTransitionReady: Promise.resolve() });
    vi.mocked(spawn).mockImplementation(() => fakeChild(4343) as never);

    // A session created after startup spawns its child.
    const session = internals.createSessionManager({ chatJid: CHAT_JID, onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn() });
    await session.spawnSession();

    const spawned = vi.mocked(spawn).mock.calls.at(-1)!;
    const args = spawned[1] as string[];
    const env = (spawned[2] as { env?: NodeJS.ProcessEnv }).env;
    expect(args).toContain('--disallowedTools');
    expect(M365_MUTATION_DENY.filter((entry) => !args.includes(entry))).toEqual([]);
    // No bridge, credential or workflow-authority values reach the unverified plugin.
    expect(m365Keys(env)).toEqual([]);
    expect(env?.MS365_AGENT365_API_KEY).toBeUndefined();
    // Its turns carry no assignment; with no candidate the microsoft365 adapter was never registered.
    expect(internals.m365ExecutingAuthority(session, true, 'request-1').workflowAuthority).toBeUndefined();
  }, 15_000);

  it('gives a sandboxPerChat claude-cli child no authority socket but keeps its WhatSoup socket and session token', async () => {
    const binding = (globalThis as Record<string, unknown>)['__m365RespawnBinding__'] as Record<string, unknown>;
    // These runtimes never call start(); the re-check passes the admitted policy through unchanged.
    vi.spyOn(microsoft365Adapter, 'recheckMicrosoft365Workflow').mockImplementation((p: M365MutationPolicy | undefined) => p);
    const workspace = mkdtempSync(join(tmpdir(), 'whatsoup-m365-sandbox-'));
    try {
      const runtime = new AgentRuntime(makeDb(), makeMessenger(), 'test', {
        model: 'primary-model', sessionScope: 'per_chat', sandboxPerChat: true,
        allowM365Mutations: true, enabledPlugins: ENABLED_PLUGINS, m365Bridge: binding as never,
      });
      const internals = runtime as unknown as RuntimeInternals & { m365MutationPolicy: M365MutationPolicy | undefined };
      expect(internals.m365MutationPolicy).toMatchObject({ status: 'approved', workflowAuthority: expect.anything() });
      // A sandbox session uses its workspace socket, never a per-chat actor socket.
      vi.spyOn(internals, 'wirePerChatActorSocket').mockReturnValue(undefined);
      vi.mocked(spawn).mockImplementation(() => fakeChild(4444) as never);

      const session = internals.createSessionManager({
        chatJid: CHAT_JID, cwd: workspace, mcpSocketPath: join(workspace, '.claude', 'whatsoup.sock'),
        onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn(),
      });
      await session.spawnSession();

      const spawned = vi.mocked(spawn).mock.calls.at(-1)!;
      const env = (spawned[2] as { env?: NodeJS.ProcessEnv }).env;
      // The guarded plugin still requires authority and still gets the bridge, so it fails closed on writes.
      expect(env?.MS365_WORKFLOW_AUTHORITY_REQUIRED).toBe('1');
      expect(env?.MS365_AGENT365_API_KEY).toBe('synthetic-key');
      expect(env).not.toHaveProperty('MS365_WORKFLOW_AUTHORITY_SOCKET');
      // The WhatSoup proxy keeps its socket and the session token that attributes its turn replies.
      expect(env?.WHATSOUP_MCP_SOCKET).toBe(join(workspace, '.claude', 'whatsoup.sock'));
      expect(env?.WHATSOUP_MCP_SESSION_TOKEN).toEqual(expect.any(String));
      expect(env?.WHATSOUP_MCP_SESSION_TOKEN).not.toBe('');
      // The provider arguments are unchanged: the sandbox settings file carries the deny floor.
      expect(spawned[1]).not.toContain('--disallowedTools');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 15_000);
});
