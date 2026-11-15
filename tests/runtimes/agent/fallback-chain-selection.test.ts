import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { provisionWorkspace } from '../../../src/core/workspace.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fallbackStateDb from '../../../src/runtimes/agent/fallback-state-db.ts';

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

vi.mock('../../../src/config.ts', () => {
  const config: Record<string, unknown> = {
    // #2192 s4b: provider-fallback tunables live on config (defaults mirror the retired IIFEs).
    fallbackTunables: { noticeDedupMs: 1_800_000, primaryRecheckMs: 300_000, probeStallThreshold: 12, probeStallCeilingMultiple: 10 },
    adminPhones: new Set<string>(),
    controlPeers: new Map<string, string>(),
    toolUpdateMode: 'full',
    toolUpdateRedirectJid: null,
    textAggregateDelayMs: 2_000,
    mediaDir: '/tmp/whatsoup-test-media-fallback-chain-selection/tmp',
    voiceReply: 'never',
    elevenlabs: {
      defaultVoiceId: 'v',
      defaultModel: 'eleven_multilingual_v2',
      stability: 0.5,
      similarityBoost: 0.75,
    },
    agentMaxQueueDepth: 25,
    agentProvider: 'claude-cli',
    agentProviderConfig: undefined,
    agentFallbackProvider: undefined,
    agentFallbackModel: undefined,
    agentFallbacks: undefined,
  };
  (globalThis as Record<string, unknown>)['__fallbackChainTestConfig__'] = config;
  return { config };
});

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

const lookupCredentialMock = vi.fn<(service: string) => string | null>(() => null);
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return {
    ...actual,
    lookupCredential: (service: string) => lookupCredentialMock(service),
  };
});

vi.mock('../../../src/runtimes/agent/providers/credential-verify.ts', () => ({
  verifyFallbackCredential: vi.fn(() => Promise.resolve('unknown')),
}));

vi.mock('../../../src/runtimes/agent/providers/binary-preflight.ts', () => ({
  probeFallbackBinary: vi.fn(() => Promise.resolve({ status: 'unknown', version: null })),
  probeModelCatalog: vi.fn(() => Promise.resolve({ status: 'unknown', suggestion: null })),
}));

import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';
import { ProviderDataPolicyError } from '../../../src/core/provider-data-policy.ts';
import type { AgentRuntimeOptions } from '../../../src/runtimes/agent/runtime-options.ts';
import { m365BridgeCredentialAdmission, m365MutationExceptionAllowed, type M365MutationPolicy } from '../../../src/core/m365-bridge-policy.ts';
import * as microsoft365Adapter from '../../../src/runtimes/agent/microsoft365-adapter.ts';
import { probeFallbackBinary } from '../../../src/runtimes/agent/providers/binary-preflight.ts';
import { buildChildEnv } from '../../../src/runtimes/agent/session.ts';
import { applyRequiredDeny, M365_MUTATION_DENY, REQUIRED_DENY } from '../../../src/core/settings-template.ts';
import type { ChatModelPreference } from '../../../src/runtimes/agent/chat-preference-db.ts';

const sandboxTmp = trackTmpDirs('bridge-sandbox');

function mockConfigRef(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)['__fallbackChainTestConfig__'] as Record<string, unknown>;
}

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
  } as unknown as Messenger;
}

type FallbackEntry = { provider: string; model?: string; dataPolicy?: 'trusted' | 'restricted' };
type ProviderFallbackReason =
  | 'usage-limit'
  | 'rate-limit'
  | 'auth-required'
  | 'model-unavailable'
  | 'server-error'
  | 'empty-output'
  | 'probe-unusable';

function makeRuntime(overrides: {
  agentFallbackProvider?: string;
  agentFallbackModel?: string;
  agentFallbacks?: FallbackEntry[];
  model?: string;
  providerDataPolicy?: 'trusted' | 'restricted' | null;
  providerBoundaryMode?: 'shadow' | 'enforce';
  nlRouting?: boolean;
} = {}, options: AgentRuntimeOptions = {}): AgentRuntime {
  const config = mockConfigRef();
  config['agentProvider'] = 'claude-cli';
  config['agentProviderConfig'] = undefined;
  config['agentFallbackProvider'] = overrides.agentFallbackProvider;
  config['agentFallbackModel'] = overrides.agentFallbackModel;
  config['agentFallbacks'] = overrides.agentFallbacks;
  config['agentProviderDataPolicy'] = overrides.providerDataPolicy ?? null;
  config['agentProviderBoundaryMode'] = overrides.providerBoundaryMode ?? 'shadow';
  config['nlRouting'] = overrides.nlRouting ?? false;
  config['nlRoutingTiers'] = null;
  return new AgentRuntime(makeDb(), makeMessenger(), 'test', {
    model: overrides.model ?? 'claude-opus-4-8[1m]',
    ...options,
  });
}

type FallbackView = {
  fallbackWindow: { activeUntil: number | null };
  effectiveProvider: string;
  effectiveModel: string | undefined;
  activateProviderFallback(
    resetAt: Date | null,
    reason?: ProviderFallbackReason,
  ): {
    primaryProvider: string;
    fallbackProvider: string;
    fallbackModel: string | undefined;
    reason: ProviderFallbackReason;
    resetAt: Date | null;
    activeUntil: number;
    extended: boolean;
    keyPresent: boolean | null;
    recoveryProbeRequired: boolean;
  } | null;
  restorePersistedFallbackWindow(): void;
  getFallbackState(): {
    effectiveProvider: string;
    activeFallbackEntry?: FallbackEntry | null;
    fallbackChain?: Array<FallbackEntry & { eligible: boolean | null }>;
  };
  createSessionManager(opts: {
    chatJid: string;
    cwd: string | undefined;
    actorJid?: string;
    onEvent: () => void;
    onCrash: () => void;
    notifyUser: () => void;
  }): unknown;
  routablePinTargets(): string[];
  // #1977 D1: the preference read lives on the routing coordinator now.
  routing: { loadSenderPreference(chatJid: string, senderJid: string): ChatModelPreference | null };
};

function view(runtime: AgentRuntime): FallbackView {
  return runtime as unknown as FallbackView;
}

/**
 * These runtimes never call start(), so no plugin admission ran and the real re-check rejects a
 * policy with an assignment. Simulate an admitted policy whose native plugin copy is unchanged.
 */
function admittedUnchangedRecheck() {
  return vi.spyOn(microsoft365Adapter, 'recheckMicrosoft365Workflow').mockImplementation((p) => p);
}

/** The withdrawal a changed native plugin copy causes: the assignment is dropped, the bridge stays approved. */
function withdrawAssignment(p: M365MutationPolicy | undefined): M365MutationPolicy | undefined {
  return p?.status === 'approved' ? { status: 'approved', childEnv: p.childEnv } : p;
}

describe('fallback chain selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    lookupCredentialMock.mockReset();
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps legacy single-fallback behavior byte-compatible', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      agentFallbackProvider: 'opencode-cli',
      agentFallbackModel: 'minimax/MiniMax-M2',
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
    });
  });

  it('retains dataPolicy through runtime fallback-window cloning and status snapshots', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'restricted' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-5',
      dataPolicy: 'restricted',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'openai-api', model: 'gpt-5', dataPolicy: 'restricted', eligible: true },
    ]);
  });

  it('runs policy admission with NL routing disabled and rethrows typed enforcement errors', () => {
    const runtime = makeRuntime({
      providerDataPolicy: null,
      providerBoundaryMode: 'enforce',
      nlRouting: false,
    });

    expect(() => view(runtime).createSessionManager({
      chatJid: '15550203@s.whatsapp.net',
      cwd: undefined,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      notifyUser: vi.fn(),
    })).toThrow(ProviderDataPolicyError);
  });

  it('does not let a broad NL route fallback swallow policy enforcement', () => {
    const runtime = makeRuntime({
      providerDataPolicy: null,
      providerBoundaryMode: 'enforce',
      nlRouting: true,
    });
    vi.spyOn(view(runtime), 'routablePinTargets').mockImplementation(() => {
      throw new Error('credential probe unavailable');
    });
    vi.spyOn(view(runtime).routing, 'loadSenderPreference').mockReturnValue({
      chatJid: '15550204@s.whatsapp.net',
      senderJid: '15550205@s.whatsapp.net',
      intent: 'provider_specific',
      requestedProvider: 'codex-cli',
      scope: 'this_thread',
      pinStrict: true,
      fallbackPermitted: false,
      updatedAt: 1,
      expiresAt: 2,
      requestedModel: null,
      validatedProvider: null,
      modelPinVerified: null,
    });

    expect(() => view(runtime).createSessionManager({
      chatJid: '15550204@s.whatsapp.net',
      actorJid: '15550205@s.whatsapp.net',
      cwd: undefined,
      onEvent: vi.fn(),
      onCrash: vi.fn(),
      notifyUser: vi.fn(),
    })).toThrow(ProviderDataPolicyError);
  });

  it('reports configured chain eligibility from credential presence before an arm-time selection pass', () => {
    // Idle eligibility surfaces real credential presence so an uncredentialed
    // fallback tier is visible in /health before any window arms: present key →
    // eligible:true, mapped-but-absent key → eligible:false.
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: false },
    ]);
  });

  it('selects the first later entry with a present key when an earlier keyed entry is missing credentials', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('openai-api');
    expect(view(runtime).effectiveModel).toBe('gpt-4o-mini');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o-mini',
    });
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.stringContaining('entry=0'),
    );
  });

  it.each([
    { sandboxPerChat: false, guarded: false }, { sandboxPerChat: true, guarded: false },
    { sandboxPerChat: false, guarded: true }, { sandboxPerChat: true, guarded: true },
  ])('preserves request-bound authority across a CLI model fallback (sandbox=$sandboxPerChat, guarded=$guarded)', ({ sandboxPerChat, guarded }) => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const origin = 'https://127.0.0.1:10000';
    const accountEmail = 'user@example.test';
    const accountId = 'employee-account';
    const binding = {
      tenantId, origin, profile: 'user-full-v1' as const,
      ...(guarded ? { accountId, workflowAuthority: { accountId, employeeActorJid: '15551230001@s.whatsapp.net' } } : { accountEmail }),
    };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin,
      MS365_TENANT_ID: tenantId, MS365_PROFILE: 'user-full-v1',
      MS365_AGENT365_API_KEY: 'synthetic-key',
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_ID', guarded ? accountId : undefined);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_EMAIL', guarded ? undefined : accountEmail);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true,
      enabledPlugins: { 'microsoft_365@microsoft-365-dev': true },
      binding,
      env: process.env,
    }, process.pid) ?? undefined);
    const recheck = admittedUnchangedRecheck();
    try {
      const provision = (path: string) => provisionWorkspace({
        workspacePath: path, instanceCwd: path,
        sandbox: { allowedPaths: [path], allowedTools: ['Read'], allowedMcpTools: ['mcp__github__create_issue'], bash: { enabled: false } },
        hookPath: '/fixture/agent-sandbox.sh', mcpServerPath: '/fixture/proxy.ts',
      });
      const workspacePath = sandboxPerChat ? sandboxTmp.make('chat') : undefined;
      if (workspacePath) provision(workspacePath);
      const runtime = makeRuntime({
        model: 'primary-model',
        agentFallbacks: [{ provider: 'claude-cli', model: 'fallback-model' }],
      }, {
        sandboxPerChat,
        allowM365Mutations: true,
        enabledPlugins: { 'microsoft_365@microsoft-365-dev': true },
        m365Bridge: binding,
      });
      const session = () => view(runtime).createSessionManager({
        chatJid: 'bridge-test@s.whatsapp.net', cwd: workspacePath,
        onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn(),
      }) as { m365MutationPolicy: M365MutationPolicy; allowM365Mutations?: boolean; getProviderArgs(prompt: string, cwd: string): string[] };
      const primary = session();
      expect(primary.m365MutationPolicy.status).toBe('approved');
      expect(buildChildEnv('claude-cli', primary).MS365_AGENT365_API_KEY).toBe('synthetic-key');
      expect(applyRequiredDeny([], primary.m365MutationPolicy).includes(M365_MUTATION_DENY[0]!)).toBe(!guarded);
      if (workspacePath) {
        // A sandboxed chat's child gets no authority socket, so a guarded native write cannot succeed
        // there: its settings keep the full floor even while the assignment holds.
        const settings = JSON.parse(readFileSync(join(workspacePath, '.claude/settings.json'), 'utf8'));
        expect(settings.permissions.deny).toEqual(REQUIRED_DENY);
        expect(settings.enabledPlugins).toEqual({ 'microsoft_365@microsoft-365-dev': true });
        expect(settings.hooks.PreToolUse).toHaveLength(1);
      }
      vi.mocked(probeFallbackBinary).mockClear();
      view(runtime).activateProviderFallback(null, 'usage-limit');
      expect(view(runtime).effectiveProvider).toBe('claude-cli');
      expect(view(runtime).effectiveModel).toBe('fallback-model');
      const fallback = session();
      expect(fallback.m365MutationPolicy.status).toBe(guarded ? 'approved' : 'rejected');
      if (workspacePath) {
        const settings = JSON.parse(readFileSync(join(workspacePath, '.claude/settings.json'), 'utf8'));
        expect(new Set(settings.permissions.deny)).toEqual(new Set(REQUIRED_DENY));
        expect(settings.hooks.PreToolUse).toHaveLength(1);
      }
      const env = buildChildEnv('claude-cli', fallback);
      if (guarded) expect(env.MS365_AGENT365_ACCOUNT_ID).toBe(accountId);
      else expect(Object.keys(env).filter((key) => key.startsWith('MS365_') || key === 'ALLOW_M365_MUTATIONS')).toEqual([]);
      const fallbackDeny = applyRequiredDeny([], fallback.m365MutationPolicy);
      const args = fallback.getProviderArgs('test', process.cwd());
      if (guarded) {
        expect(M365_MUTATION_DENY.filter((entry) => fallbackDeny.includes(entry))).toEqual([]);
        expect(M365_MUTATION_DENY.filter((entry) => args.includes(entry))).toEqual([]);
      } else {
        expect(fallbackDeny).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
        expect(args).toContain('--disallowedTools');
        expect(args).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
      }
      // A legacy primary still relies on the generated settings floor above.
      expect(primary.getProviderArgs('test', process.cwd())).not.toContain('--disallowedTools');
      expect(vi.mocked(probeFallbackBinary)).toHaveBeenCalledOnce();
      const probeEnv = vi.mocked(probeFallbackBinary).mock.calls[0]![1]!;
      expect(Object.keys(probeEnv).filter((key) => key.startsWith('MS365_') || key === 'ALLOW_M365_MUTATIONS')).toEqual([]);
      if (guarded) {
        // Another sandboxed chat's settings were written while the assignment held.
        const otherWorkspace = workspacePath ? sandboxTmp.make('other-chat') : undefined;
        const otherSettings = () => JSON.parse(readFileSync(join(otherWorkspace!, '.claude/settings.json'), 'utf8'));
        if (otherWorkspace) {
          provision(otherWorkspace);
          view(runtime).createSessionManager({
            chatJid: 'bridge-other@s.whatsapp.net', cwd: otherWorkspace, onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn(),
          });
          expect(otherSettings().permissions.deny).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
        }
        // A new session re-checks the native plugin copy before it writes sandbox settings. Once
        // the copy no longer matches, the session loses the exception and the sandbox floor returns.
        recheck.mockImplementationOnce(withdrawAssignment);
        const rechecked = session();
        expect(m365MutationExceptionAllowed(rechecked.m365MutationPolicy)).toBe(false);
        if (workspacePath && otherWorkspace) {
          const settings = JSON.parse(readFileSync(join(workspacePath, '.claude/settings.json'), 'utf8'));
          expect(settings.permissions.deny).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
          // The withdrawal also rewrote the other chat's file, keeping its sandbox hook.
          expect(otherSettings().permissions.deny).toEqual(expect.arrayContaining([...M365_MUTATION_DENY]));
          expect(otherSettings().hooks.PreToolUse).toHaveLength(1);
        }
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { runtimeScope: 'per_chat' as const, admitted: true },
    // Negative control: the same per_chat admission does not verify for a runtime that defaults to single.
    { runtimeScope: undefined, admitted: false },
  ])('verifies a per_chat launcher admission only in a runtime that normalizes sessionScope the same way ($runtimeScope)', ({ runtimeScope, admitted }) => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const origin = 'https://127.0.0.1:10000';
    const accountId = 'employee-account';
    const binding = {
      tenantId, origin, profile: 'user-full-v1' as const, accountId,
      workflowAuthority: { accountId, employeeActorJid: '15551230001@s.whatsapp.net' },
    };
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    const bridgeEnv = {
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin,
      MS365_TENANT_ID: tenantId, MS365_PROFILE: 'user-full-v1',
      MS365_AGENT365_API_KEY: 'synthetic-key', MS365_AGENT365_ACCOUNT_ID: accountId, MS365_AGENT365_ACCOUNT_EMAIL: undefined,
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    };
    // The launcher reads the raw instance config and issues the admission for this process.
    const configPath = join(sandboxTmp.make('launcher-config'), 'config.json');
    writeFileSync(configPath, JSON.stringify({ name: 'test', type: 'agent', agentOptions: {
      sessionScope: 'per_chat', provider: 'claude-cli', allowM365Mutations: true, enabledPlugins, m365Bridge: binding,
    } }), { mode: 0o600 });
    const launcher = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning', '--experimental-strip-types', resolve('deploy/m365-bridge-credential-projection.ts'),
      'test', configPath, '--credential-admission', String(process.pid),
    ], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...bridgeEnv } });
    expect(launcher.status, launcher.stderr).toBe(0);
    expect(launcher.stdout).toMatch(/^[0-9a-f]{64}$/);
    for (const [key, value] of Object.entries({ ...bridgeEnv, WHATSOUP_M365_LAUNCH_ADMISSION: launcher.stdout })) vi.stubEnv(key, value);
    try {
      // The runtime receives agentOptions.sessionScope as main.ts passes it.
      const runtime = makeRuntime({ model: 'primary-model' }, {
        sessionScope: runtimeScope, allowM365Mutations: true, enabledPlugins, m365Bridge: binding,
      });
      const policy = (runtime as unknown as { m365MutationPolicy: M365MutationPolicy }).m365MutationPolicy;
      expect(policy.status).toBe(admitted ? 'approved' : 'rejected');
      if (admitted) expect(policy).toMatchObject({ workflowAuthority: binding.workflowAuthority });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('publishes no Microsoft 365 authority for a turn whose session fell back to an unsupported provider', () => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const origin = 'https://127.0.0.1:10000';
    const accountId = 'employee-account';
    const workflowAuthority = { accountId, employeeActorJid: '15551230001@s.whatsapp.net' };
    const binding = { tenantId, origin, profile: 'user-full-v1' as const, accountId, workflowAuthority };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin,
      MS365_TENANT_ID: tenantId, MS365_PROFILE: 'user-full-v1',
      MS365_AGENT365_API_KEY: 'synthetic-key', MS365_AGENT365_ACCOUNT_ID: accountId,
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_EMAIL', undefined);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true,
      enabledPlugins: { 'microsoft_365@microsoft-365-dev': true }, binding, env: process.env,
    }, process.pid) ?? undefined);
    admittedUnchangedRecheck();
    try {
      const runtime = makeRuntime({
        model: 'primary-model',
        agentFallbacks: [{ provider: 'codex-cli', model: 'codex-model' }],
      }, { allowM365Mutations: true, enabledPlugins: { 'microsoft_365@microsoft-365-dev': true }, m365Bridge: binding });
      type Published = { workflowAuthority?: unknown; m365RouteProvider?: string; requestRef?: string };
      const internals = runtime as unknown as {
        createSessionManager(opts: Record<string, unknown>): { getProviderId(): string };
        m365ExecutingAuthority(session: unknown, humanRequest: boolean, requestRef: string | undefined): Published;
      };
      const session = () => internals.createSessionManager({
        chatJid: 'bridge-test@s.whatsapp.net', onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn(),
      });
      // Positive control: the admitted claude-cli route publishes the assignment and its provider.
      const primary = session();
      expect(internals.m365ExecutingAuthority(primary, true, 'request-1'))
        .toMatchObject({ requestRef: 'request-1', workflowAuthority, m365RouteProvider: 'claude-cli' });
      expect(internals.m365ExecutingAuthority(primary, false, 'request-1'))
        .toMatchObject({ workflowAuthority: undefined, m365RouteProvider: 'claude-cli' });

      view(runtime).activateProviderFallback(null, 'usage-limit');
      expect(view(runtime).effectiveProvider).toBe('codex-cli');
      const fallback = session();
      expect(fallback.getProviderId()).toBe('codex-cli');
      const published = internals.m365ExecutingAuthority(fallback, true, 'request-1');
      expect(published.workflowAuthority).toBeUndefined();
      expect(published.m365RouteProvider).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses Microsoft 365 authority to a session created before the runtime withdrew the assignment', () => {
    const tenantId = '11111111-2222-3333-4444-555555555555';
    const origin = 'https://127.0.0.1:10000';
    const accountId = 'employee-account';
    const workflowAuthority = { accountId, employeeActorJid: '15551230001@s.whatsapp.net' };
    const binding = { tenantId, origin, profile: 'user-full-v1' as const, accountId, workflowAuthority };
    const enabledPlugins = { 'microsoft_365@microsoft-365-dev': true };
    for (const [key, value] of Object.entries({
      ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true',
      MS365_AGENT365_BASE_URL: origin, MS365_HUB_URL: origin,
      MS365_TENANT_ID: tenantId, MS365_PROFILE: 'user-full-v1',
      MS365_AGENT365_API_KEY: 'synthetic-key', MS365_AGENT365_ACCOUNT_ID: accountId,
      MS365_DURABLE_MAIL_STATE_DIR: '/tmp/whatsoup-m365-durable-mail',
    })) vi.stubEnv(key, value);
    vi.stubEnv('MS365_AGENT365_ACCOUNT_EMAIL', undefined);
    vi.stubEnv('WHATSOUP_M365_LAUNCH_ADMISSION', m365BridgeCredentialAdmission({
      instanceName: 'test', provider: 'claude-cli', allowM365Mutations: true, enabledPlugins, binding, env: process.env,
    }, process.pid) ?? undefined);
    const recheck = admittedUnchangedRecheck();
    try {
      const runtime = makeRuntime({ model: 'primary-model' }, { allowM365Mutations: true, enabledPlugins, m365Bridge: binding });
      type Published = { workflowAuthority?: unknown; workflowAuthorityScope?: string; m365RouteProvider?: string };
      const internals = runtime as unknown as {
        createSessionManager(opts: Record<string, unknown>): { m365MutationPolicy: M365MutationPolicy };
        m365ExecutingAuthority(session: unknown, humanRequest: boolean, requestRef: string | undefined): Published;
      };
      const session = () => internals.createSessionManager({
        chatJid: 'bridge-test@s.whatsapp.net', onEvent: vi.fn(), onCrash: vi.fn(), notifyUser: vi.fn(),
      });
      // Positive control: a session created while approved publishes the assignment and its route provider.
      const existing = session();
      expect(m365MutationExceptionAllowed(existing.m365MutationPolicy)).toBe(true);
      expect(internals.m365ExecutingAuthority(existing, true, 'request-1'))
        .toMatchObject({ workflowAuthority, m365RouteProvider: 'claude-cli' });

      // The native copy changes; the next re-check withdraws the runtime's assignment.
      recheck.mockImplementationOnce(withdrawAssignment);
      session();

      // The existing session keeps its approved snapshot, yet its next turn publishes nothing:
      // the snapshot is narrowed by the current runtime policy, never widened by it.
      expect(m365MutationExceptionAllowed(existing.m365MutationPolicy)).toBe(true);
      const published = internals.m365ExecutingAuthority(existing, true, 'request-2');
      expect(published.workflowAuthority).toBeUndefined();
      expect(published.workflowAuthorityScope).toBeUndefined();
      expect(published.m365RouteProvider).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps same-provider model tiers eligible for usage-limit windows', () => {
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      ],
    });

    view(runtime).activateProviderFallback(null, 'usage-limit');

    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).effectiveModel).toBe('claude-opus-4-8');
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: true },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: true },
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
    ]);
  });

  it('skips same-provider model tiers for auth-required windows and selects an independent provider', () => {
    lookupCredentialMock.mockImplementation((svc) => svc === 'minimax' ? 'mm-key' : null);
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
      ],
    });

    view(runtime).activateProviderFallback(null, 'auth-required');

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true },
    ]);
  });

  it('does not arm auth-required fallback when every configured fallback shares the primary provider', () => {
    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
      ],
    });

    const activation = view(runtime).activateProviderFallback(null, 'auth-required');

    expect(activation).toBeNull();
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
    ]);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_no_independent_provider',
      expect.any(String),
      expect.stringContaining('primaryProvider=claude-cli'),
    );
  });

  it.each(['empty-output', 'probe-unusable'] as const)(
    'does not arm %s fallback when every configured fallback shares the primary provider',
    (reason) => {
      const runtime = makeRuntime({
        model: 'claude-fable-5',
        agentFallbacks: [
          { provider: 'claude-cli', model: 'claude-opus-4-8' },
          { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
        ],
      });

      const activation = view(runtime).activateProviderFallback(null, reason);

      expect(activation).toBeNull();
      expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
      expect(view(runtime).effectiveProvider).toBe('claude-cli');
      expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
      expect(view(runtime).getFallbackState().fallbackChain).toEqual([
        { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
      ]);
      expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
        'test',
        'fallback_no_independent_provider',
        'Fallback requires an independent provider target',
        expect.stringContaining(`reason=${reason}`),
      );
    },
  );

  it('fails open to entry zero when every keyed chain entry is missing credentials', () => {
    lookupCredentialMock.mockReturnValue(null);
    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).activateProviderFallback(null);

    expect(view(runtime).effectiveProvider).toBe('opencode-cli');
    expect(view(runtime).effectiveModel).toBe('minimax/MiniMax-M2');
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: false },
    ]);
  });
});

describe('fallback chain selection — restore path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-12T10:00:00Z'));
    lookupCredentialMock.mockReset();
    vi.mocked(emitAlert).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-runs selection against the current chain on restore — a later eligible entry wins when entry zero lost its key', () => {
    // The persisted row stores only the window, never the selected entry.
    // After a restart with entry[0]'s key gone, restore must pick entry[1].
    lookupCredentialMock.mockImplementation((svc) => svc === 'openai' ? 'oa-key' : null);
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    vi.spyOn(fallbackStateDb, 'saveFallbackState').mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      agentFallbacks: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
        { provider: 'openai-api', model: 'gpt-4o-mini' },
      ],
    });

    view(runtime).restorePersistedFallbackWindow();

    expect(view(runtime).effectiveProvider).toBe('openai-api');
    expect(view(runtime).effectiveModel).toBe('gpt-4o-mini');
    expect(view(runtime).getFallbackState().activeFallbackEntry).toEqual({
      provider: 'openai-api',
      model: 'gpt-4o-mini',
    });
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
      { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
    ]);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_credential_missing',
      expect.any(String),
      expect.stringContaining('entry=0'),
    );
  });

  it('clears the persisted row and stays on the primary when the chain was emptied from config since persist', () => {
    lookupCredentialMock.mockReturnValue('present-key');
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'usage-limit',
      probeAttempts: 0,
      version: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({ agentFallbacks: [] });

    view(runtime).restorePersistedFallbackWindow();

    expect(clearSpy).toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([]);
  });

  it('clears a persisted auth-required window when only same-provider fallbacks remain', () => {
    const now = Date.now();
    vi.spyOn(fallbackStateDb, 'ensureFallbackStateSchema').mockImplementation(() => {});
    vi.spyOn(fallbackStateDb, 'getFallbackState').mockReturnValue({
      activeUntil: now + 60 * 60_000,
      activatedAt: now - 1000,
      reason: 'auth-required',
      probeAttempts: 0,
      version: 0,
      activeEntryProvider: null,
      activeEntryModel: null,
      failedKeys: [],
    });
    const saveSpy = vi
      .spyOn(fallbackStateDb, 'saveFallbackState')
      .mockImplementation(() => {});
    const clearSpy = vi
      .spyOn(fallbackStateDb, 'clearFallbackState')
      .mockImplementation(() => {});

    const runtime = makeRuntime({
      model: 'claude-fable-5',
      agentFallbacks: [
        { provider: 'claude-cli', model: 'claude-opus-4-8' },
        { provider: 'claude-cli', model: 'claude-sonnet-4-6' },
      ],
    });

    view(runtime).restorePersistedFallbackWindow();

    expect(clearSpy).toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(view(runtime).effectiveProvider).toBe('claude-cli');
    expect(view(runtime).fallbackWindow.activeUntil).toBeNull();
    expect(view(runtime).getFallbackState().activeFallbackEntry).toBeNull();
    expect(view(runtime).getFallbackState().fallbackChain).toEqual([
      { provider: 'claude-cli', model: 'claude-opus-4-8', eligible: false },
      { provider: 'claude-cli', model: 'claude-sonnet-4-6', eligible: false },
    ]);
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'test',
      'fallback_no_independent_provider',
      expect.any(String),
      expect.stringContaining('reason=auth-required'),
    );
  });
});
