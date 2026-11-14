import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const admission = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  spawn: vi.fn(),
  error: class HostWorkAdmissionError extends Error {
    constructor() {
      super('Host work admission rejected before provider start');
    }
  },
  cleanupError: class HostWorkAdmissionCleanupError extends Error {
    constructor(_cause?: unknown) {
      super('Host work admission cleanup could not be proved');
    }
  },
}));

const processIsolation = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());
vi.mock('node:os', () => ({ homedir: vi.fn(() => '/mock/home'), userInfo: vi.fn(() => ({ username: 'test' })) }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (child: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    child.kill(signal);
  }),
}));
vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  createSession: vi.fn(() => 9), incrementMessageCount: vi.fn(), updateSessionId: vi.fn(),
  updateSessionStatus: vi.fn(), updateTranscriptPath: vi.fn(), backfillSessionProvider: vi.fn(),
  resolveResumableAgentSession: vi.fn(() => null), updateResumedSessionStatus: vi.fn(),
}));
vi.mock('../../../src/runtimes/agent/provider-canary-proof.ts', () => ({
  sha256File: vi.fn(() => 'a'.repeat(64)),
}));
vi.mock('../../../src/runtimes/agent/host-work-admission.ts', () => ({
  isHostWorkAdmissionEnabled: admission.enabled,
  HostWorkAdmissionError: admission.error,
  HostWorkAdmissionCleanupError: admission.cleanupError,
  spawnHostWorkAdmitted: admission.spawn,
}));
vi.mock('../../../src/runtimes/agent/provider-process-isolation.ts', () => ({
  launchIsolatedProviderProcess: processIsolation.launch,
}));
vi.mock('../../../src/lib/keyring.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/keyring.ts')>();
  return { ...actual, lookupCredential: vi.fn(() => null) };
});

import { spawn } from 'node:child_process';
import type { M365MutationPolicy } from '../../../src/core/m365-bridge-policy.ts';
import { M365_ACCOUNT_SELECTION_DENY, M365_MUTATION_DENY } from '../../../src/core/settings-template.ts';
import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';
import { resolveResumableAgentSession, updateResumedSessionStatus } from '../../../src/runtimes/agent/session-db.ts';
import { SessionManager, type SessionManagerOptions } from '../../../src/runtimes/agent/session.ts';
import { ProviderExecutionGate } from '../../../src/runtimes/agent/provider-execution-gate.ts';
import type { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 43001;
  child.stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    write: vi.fn((_payload: string, _encoding?: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
  });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

/** The database handle of the most recent makeSession call, for exact-argument assertions. */
let sessionDb: Database | undefined;

function makeSession(provider = 'claude-cli', extra: Partial<SessionManagerOptions> = {}) {
  const db = {
    assertWritableCompatibility: vi.fn(),
    raw: { prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })), exec: vi.fn() },
  } as unknown as Database;
  sessionDb = db;
  const messenger = {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  } as unknown as Messenger;
  return new SessionManager({
    db,
    messenger,
    chatJid: 'admission@s.whatsapp.net',
    onEvent: vi.fn(),
    provider,
    ...(provider === 'opencode-cli' ? { model: 'glm/test-model' } : {}),
    ...extra,
  });
}

function verifiedCanaryAdmission() {
  return () => ({
    allowed: true,
    required: true,
    resolvedPath: '/verified/provider',
    binarySha256: 'a'.repeat(64),
    proxyScriptSha256: 'b'.repeat(64),
  });
}

function admitPersistentChild(child: ReturnType<typeof makeChild>): void {
  admission.spawn.mockImplementationOnce((options: { onSpawned?: (value: typeof child) => void }) => {
    options.onSpawned?.(child);
    return Promise.resolve(child);
  });
}

describe('SessionManager host work admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    admission.spawn.mockReset();
    admission.enabled.mockReturnValue(true);
    processIsolation.launch.mockReset();
  });

  it('routes spawn-per-turn providers through the checked UID/GID launcher instead of the host-admission or direct-spawn path', async () => {
    const child = makeChild();
    processIsolation.launch.mockResolvedValueOnce(child);
    const isolation = {
      controllerUid: 501,
      controllerGid: 20,
      workerUid: 502,
      workerGid: 502,
      launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
      launcherSha256: 'a'.repeat(64),
      policyPath: '/etc/whatsoup/agent-isolation.policy',
      policySha256: 'b'.repeat(64),
      homeDir: '/var/lib/whatsoup-agent',
      configHome: '/var/lib/whatsoup-agent/.config',
      dataHome: '/var/lib/whatsoup-agent/.local/share',
      protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
    } as const;
    const session = makeSession('opencode-cli', {
      providerProcessIsolation: isolation,
      providerCanaryAdmission: verifiedCanaryAdmission(),
    });

    await session.spawnSession();
    await session.sendTurnAtProviderBoundary('hello');

    expect(processIsolation.launch).toHaveBeenCalledWith(expect.objectContaining({
      isolation,
      binary: '/verified/provider',
      expectedBinarySha256: 'a'.repeat(64),
      env: expect.objectContaining({ HOME: expect.any(String), PATH: expect.any(String) }),
    }));
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('routes persistent providers through the same checked UID/GID launcher', async () => {
    const child = makeChild();
    processIsolation.launch.mockResolvedValueOnce(child);
    const session = makeSession('claude-cli', {
      providerProcessIsolation: {
        controllerUid: 501,
        controllerGid: 20,
        workerUid: 502,
        workerGid: 502,
        launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
        launcherSha256: 'a'.repeat(64),
        policyPath: '/etc/whatsoup/agent-isolation.policy',
        policySha256: 'b'.repeat(64),
        homeDir: '/var/lib/whatsoup-agent',
        configHome: '/var/lib/whatsoup-agent/.config',
        dataHome: '/var/lib/whatsoup-agent/.local/share',
        protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
      },
      providerCanaryAdmission: verifiedCanaryAdmission(),
    });

    await session.spawnSession();
    await session.sendTurn('hello');

    expect(processIsolation.launch).toHaveBeenCalledOnce();
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('does not fall back to host admission when the isolation launcher rejects a provider start', async () => {
    processIsolation.launch.mockRejectedValueOnce(new Error('kernel proof failed'));
    const session = makeSession('opencode-cli', {
      providerProcessIsolation: {
        controllerUid: 501,
        controllerGid: 20,
        workerUid: 502,
        workerGid: 502,
        launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
        launcherSha256: 'a'.repeat(64),
        policyPath: '/etc/whatsoup/agent-isolation.policy',
        policySha256: 'b'.repeat(64),
        homeDir: '/var/lib/whatsoup-agent',
        configHome: '/var/lib/whatsoup-agent/.config',
        dataHome: '/var/lib/whatsoup-agent/.local/share',
        protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
      },
      providerCanaryAdmission: verifiedCanaryAdmission(),
    });

    await session.spawnSession();
    await expect(session.sendTurnAtProviderBoundary('hello')).rejects.toThrow('kernel proof failed');
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('blocks isolated CLI startup before a bare provider name can reach the launcher', async () => {
    const session = makeSession('opencode-cli', {
      providerProcessIsolation: {
        controllerUid: 501,
        controllerGid: 20,
        workerUid: 502,
        workerGid: 502,
        launcherPath: '/usr/local/libexec/whatsoup-agent-isolation-launcher',
        launcherSha256: 'a'.repeat(64),
        policyPath: '/etc/whatsoup/agent-isolation.policy',
        policySha256: 'b'.repeat(64),
        homeDir: '/var/lib/whatsoup-agent',
        configHome: '/var/lib/whatsoup-agent/.config',
        dataHome: '/var/lib/whatsoup-agent/.local/share',
        protectedPaths: ['/var/db/whatsoup/transport-authority.bearer'],
      },
    });

    await session.spawnSession();
    await expect(session.sendTurnAtProviderBoundary('hello')).rejects.toThrow('PROVIDER_PROCESS_ISOLATION_CANARY_REQUIRED');
    expect(processIsolation.launch).not.toHaveBeenCalled();
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('keeps a spawn-per-turn boundary unpublished until the wrapper admits the child', async () => {
    const child = makeChild();
    let admit!: () => void;
    admission.spawn.mockImplementationOnce((options: { onSpawned?: (value: typeof child) => void }) => new Promise((resolve) => {
      options.onSpawned?.(child);
      admit = () => resolve(child);
    }));
    const session = makeSession('opencode-cli');
    await session.spawnSession();
    const boundary = vi.fn();
    const turn = session.sendTurnAtProviderBoundary('hello', boundary);

    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledTimes(1));
    expect(boundary).not.toHaveBeenCalled();

    admit();
    await turn;
    expect(boundary).toHaveBeenCalledTimes(1);
  });

  it('aborts and reaps a queued persistent wrapper during shutdown', async () => {
    const child = makeChild();
    admission.spawn.mockImplementationOnce((options: {
      signal: AbortSignal;
      onSpawned?: (value: typeof child) => void;
      onAbort: (value: typeof child) => Promise<void>;
    }) => new Promise((resolve, reject) => {
      options.onSpawned?.(child);
      options.signal.addEventListener('abort', () => {
        void options.onAbort(child).then(() => reject(new Error('admission aborted')));
      }, { once: true });
    }));
    const session = makeSession();
    await session.spawnSession();
    const starting = session.sendTurn('queued turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledTimes(1));

    await session.shutdown();
    await expect(starting).rejects.toThrow('admission aborted');
    expect(killSessionTree).toHaveBeenCalledWith(child, 'SIGTERM', expect.any(Object));
  });

  it('passes the existing required canary digest to the host admission gate', async () => {
    const child = makeChild();
    let captured: Record<string, unknown> | undefined;
    admission.spawn.mockImplementationOnce((options: Record<string, unknown>) => {
      captured = options;
      (options.onSpawned as ((value: typeof child) => void) | undefined)?.(child);
      return Promise.resolve(child);
    });
    const session = makeSession('claude-cli', {
      providerCanaryAdmission: () => ({
        allowed: true,
        required: true,
        resolvedPath: '/verified/provider',
        binarySha256: 'a'.repeat(64),
        proxyScriptSha256: 'b'.repeat(64),
      }),
    });

    await session.spawnSession();
    await session.sendTurn('canary-boundary');
    expect(captured?.expectedExecutableSha256).toBe('a'.repeat(64));
    await session.shutdown();
  });

  it('gives a queued claude-cli launch the withdrawn Microsoft 365 shape, because the host wrapper fixes its arguments and environment before the lease', async () => {
    // Synthetic credential, assembled at run time.
    const bridgeValue = ['fixture', 'agent365', 'key'].join('-');
    const approved: M365MutationPolicy = {
      status: 'approved',
      workflowAuthority: { accountId: 'employee-account', employeeActorJid: '15551230001@s.whatsapp.net' },
      childEnv: {
        ALLOW_M365_MUTATIONS: '1', MS365_AGENT365_BRIDGE: 'true', MS365_AGENT365_API_KEY: bridgeValue,
        MS365_AGENT365_BASE_URL: 'https://127.0.0.1:10000', MS365_AGENT365_ACCOUNT_ID: 'employee-account',
        MS365_TENANT_ID: '11111111-2222-3333-4444-555555555555', MS365_PROFILE: 'user-full-v1',
        MS365_HUB_URL: 'https://127.0.0.1:10000', MS365_DURABLE_MAIL_STATE_DIR: '/fixture/mail-state',
      },
    };
    const m365SpawnPolicy = vi.fn(() => approved);
    const launched = (args: readonly string[], env: NodeJS.ProcessEnv) => ({
      denied: args.includes('--disallowedTools') ? args.slice(args.indexOf('--disallowedTools') + 1) : [],
      bridgeValue: env.MS365_AGENT365_API_KEY,
      allow: env.ALLOW_M365_MUTATIONS,
      authorityRequired: env.MS365_WORKFLOW_AUTHORITY_REQUIRED,
    });
    // Every Microsoft 365 bridge, mutation or workflow-authority name the child would receive.
    const m365Keys = (env: NodeJS.ProcessEnv) => Object.keys(env)
      .filter((key) => env[key] !== undefined && (key.startsWith('MS365_') || key === 'ALLOW_M365_MUTATIONS'))
      .sort();

    // Positive control: a direct spawn with the same live policy keeps the bridge values and no deny set.
    admission.enabled.mockReturnValue(false);
    vi.mocked(spawn).mockReturnValueOnce(makeChild() as never);
    const direct = makeSession('claude-cli', { m365SpawnPolicy });
    await direct.spawnSession();
    const [, directArgs, directOptions] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(launched(directArgs, directOptions.env)).toEqual({ denied: [], bridgeValue, allow: '1', authorityRequired: '1' });
    expect(m365Keys(directOptions.env)).toEqual(expect.arrayContaining([
      'ALLOW_M365_MUTATIONS', 'MS365_AGENT365_API_KEY', 'MS365_TENANT_ID', 'MS365_WORKFLOW_AUTHORITY_REQUIRED',
    ]));
    await direct.shutdown();

    // Queued: the wrapper receives the arguments and environment now and starts the provider only after its lease,
    // with no later check. The launch is therefore built in the withdrawn shape.
    admission.enabled.mockReturnValue(true);
    m365SpawnPolicy.mockClear();
    const child = makeChild();
    let queued: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    admission.spawn.mockImplementationOnce((options: { args: string[]; env: NodeJS.ProcessEnv; onSpawned?: (value: typeof child) => void }) => {
      queued = options;
      options.onSpawned?.(child);
      return Promise.resolve(child);
    });
    const session = makeSession('claude-cli', { m365SpawnPolicy });
    await session.spawnSession();
    await session.sendTurn('queued-m365');
    // The live policy was read for this launch, and it still carried the assignment.
    expect(m365SpawnPolicy).toHaveBeenCalled();
    expect(m365SpawnPolicy.mock.results.every((result) => result.value === approved)).toBe(true);
    expect(launched(queued!.args, queued!.env)).toEqual({
      denied: [...M365_MUTATION_DENY, ...M365_ACCOUNT_SELECTION_DENY], bridgeValue: undefined, allow: undefined, authorityRequired: undefined,
    });
    // No bridge, mutation or workflow-authority name reaches the queued child at all.
    expect(m365Keys(queued!.env)).toEqual([]);
    expect(JSON.stringify(queued!.env)).not.toContain(bridgeValue);
    await session.shutdown();
  });

  it('retains the execution lease until a later shutdown proves queued cleanup', async () => {
    const child = makeChild();
    admission.spawn.mockImplementationOnce((options: {
      signal: AbortSignal;
      onSpawned?: (value: typeof child) => void;
      onAbort: (value: typeof child) => Promise<void>;
    }) => new Promise((_, reject) => {
      options.onSpawned?.(child);
      options.signal.addEventListener('abort', () => {
        void options.onAbort(child).then(
          () => reject(new Error('admission aborted')),
          (cause: unknown) => reject(new admission.cleanupError(cause)),
        );
      }, { once: true });
    }));
    vi.mocked(killSessionTree).mockRejectedValueOnce(new Error('cleanup unproven'));
    const gate = new ProviderExecutionGate();
    const session = makeSession('opencode-cli', { providerExecutionGate: gate });
    await session.spawnSession();
    const turn = session.sendTurn('queued turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledOnce());

    await expect(session.shutdown()).rejects.toBeInstanceOf(admission.cleanupError);
    await expect(turn).rejects.toBeInstanceOf(admission.cleanupError);
    expect(gate.snapshot()).toMatchObject({ active: true, pending: 0 });

    await session.shutdown();
    expect(gate.snapshot()).toMatchObject({ active: false, pending: 0 });
  });

  it('does not acquire a persistent Claude host admission before a real turn needs it', async () => {
    const session = makeSession('claude-cli');

    await session.spawnSession();

    // A just-created or proactive-resume session is idle work. Holding the host
    // admission here monopolizes the global provider budget without a turn.
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('serializes concurrent deferred Claude starts before either turn owns the provider', async () => {
    const child = makeChild();
    let admit!: () => void;
    admission.spawn.mockImplementationOnce((options: { onSpawned?: (value: typeof child) => void }) => new Promise((resolve) => {
      options.onSpawned?.(child);
      admit = () => resolve(child);
    }));
    const session = makeSession('claude-cli');
    await session.spawnSession();

    const first = session.sendTurn('first turn');
    const second = session.sendTurn('second turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledTimes(1));
    admit();

    await first;
    await expect(second).rejects.toThrow('PROVIDER_TURN_IN_FLIGHT');
    await session.shutdown(false);
  });

  it('/new reaps an admitted old deferred start before it can publish a child', async () => {
    const oldChild = makeChild();
    const freshChild = makeChild();
    const admittedArgs: string[][] = [];
    let admitOld!: () => void;
    admission.spawn.mockImplementation((options: { args: string[]; onSpawned?: (value: typeof oldChild) => void }) => {
      admittedArgs.push(options.args);
      const child = admittedArgs.length === 1 ? oldChild : freshChild;
      options.onSpawned?.(child);
      if (child === oldChild) {
        return new Promise((resolve) => { admitOld = () => resolve(oldChild); });
      }
      return Promise.resolve(freshChild);
    });
    vi.mocked(resolveResumableAgentSession).mockReturnValueOnce({ id: 9 } as never);
    const session = makeSession('claude-cli');
    await session.spawnSession('obsolete-claude', 9);

    const oldTurn = session.sendTurn('old turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledOnce());
    const reset = session.handleNew();
    admitOld();

    await reset;
    await expect(oldTurn).rejects.toThrow('HOST_WORK_ADMISSION_START_INVALIDATED');
    expect(oldChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(session.getStatus()).toMatchObject({ active: false, sessionId: null, providerTerminated: true });

    await session.sendTurn('fresh turn');
    expect(admittedArgs).toHaveLength(2);
    expect(admittedArgs[1]).not.toEqual(expect.arrayContaining(['--resume', 'obsolete-claude']));
  });

  it('/new consumes a proved queued-admission abort and arms a fresh epoch', async () => {
    const oldChild = makeChild();
    const freshChild = makeChild();
    admission.spawn.mockImplementation((options: {
      args: string[];
      signal: AbortSignal;
      onSpawned?: (value: typeof oldChild) => void;
      onAbort: (value: typeof oldChild) => Promise<void>;
    }) => {
      const child = admission.spawn.mock.calls.length === 1 ? oldChild : freshChild;
      options.onSpawned?.(child);
      if (child === freshChild) return Promise.resolve(child);
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          void options.onAbort(oldChild).then(() => reject(new admission.error()));
        }, { once: true });
      });
    });
    const session = makeSession('claude-cli');
    await session.spawnSession();
    const oldTurn = session.sendTurn('old turn');
    void oldTurn.catch(() => {});
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledOnce());

    await expect(session.handleNew()).resolves.toBeUndefined();
    await expect(oldTurn).rejects.toThrow('HOST_WORK_ADMISSION_START_INVALIDATED');
    expect(oldChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.getStatus()).toMatchObject({ active: false, providerTerminated: true });

    await session.sendTurn('fresh turn');
    expect(admission.spawn).toHaveBeenCalledTimes(2);
  });

  it('/new exposes obsolete-child cleanup failure and leaves replacement closed', async () => {
    const oldChild = makeChild();
    let admitOld!: () => void;
    admission.spawn.mockImplementationOnce((options: { onSpawned?: (value: typeof oldChild) => void }) => new Promise((resolve) => {
      options.onSpawned?.(oldChild);
      admitOld = () => resolve(oldChild);
    }));
    vi.mocked(killSessionTree).mockRejectedValueOnce(new Error('obsolete tree still live'));
    const session = makeSession('claude-cli');
    await session.spawnSession();
    const oldTurn = session.sendTurn('old turn');
    void oldTurn.catch(() => {});
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledOnce());
    const reset = session.handleNew();
    admitOld();

    await expect(reset).rejects.toThrow('obsolete admitted child cleanup failed');
    await expect(oldTurn).rejects.toThrow('obsolete admitted child cleanup failed');
    await session.spawnSession();
    await expect(session.sendTurn('replacement turn')).rejects.toThrow('Previous host work provider cleanup remains unproven');
  });

  it('releases a persistent Claude admission when its first provider turn becomes terminal', async () => {
    const child = makeChild();
    admitPersistentChild(child);
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    child.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"claude-turn-a"}\n'));
    expect(session.getStatus().sessionId).toBe('claude-turn-a');
    session.completeProviderTurn();
    await session.suspendHostWorkAdmissionAfterTerminal();

    // This is the real persistent session process, not a shutdown spy. A
    // terminal turn with no successor must release its host-admission child.
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'), { timeout: 500 });
    expect(session.getStatus()).toMatchObject({ active: false, sessionId: null });
  });

  it('resumes the exact Claude identity after a suspended host-admission child is restarted', async () => {
    const first = makeChild();
    const second = makeChild();
    const admittedArgs: string[][] = [];
    admission.spawn.mockImplementation((options: { args: string[]; onSpawned?: (value: typeof first) => void }) => {
      admittedArgs.push(options.args);
      const child = admittedArgs.length === 1 ? first : second;
      options.onSpawned?.(child);
      return Promise.resolve(child);
    });
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    first.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"claude-resume-a"}\n'));
    expect(session.getStatus().sessionId).toBe('claude-resume-a');

    session.completeProviderTurn();
    await session.suspendHostWorkAdmissionAfterTerminal();
    vi.mocked(resolveResumableAgentSession).mockReturnValueOnce({ id: 9 } as never);
    await session.sendTurn('second turn');

    expect(admittedArgs).toHaveLength(2);
    expect(admittedArgs[1]).toEqual(expect.arrayContaining(['--resume', 'claude-resume-a']));
  });

  it('does not republish a suspended Claude identity after /new ends it during cleanup', async () => {
    const first = makeChild();
    const second = makeChild();
    const admittedArgs: string[][] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    vi.mocked(killSessionTree).mockImplementationOnce(() => cleanup);
    admission.spawn.mockImplementation((options: { args: string[]; onSpawned?: (value: typeof first) => void }) => {
      admittedArgs.push(options.args);
      const child = admittedArgs.length === 1 ? first : second;
      options.onSpawned?.(child);
      return Promise.resolve(child);
    });
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    first.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"discard-me"}\n'));
    session.completeProviderTurn();

    const suspension = session.suspendHostWorkAdmissionAfterTerminal();
    await vi.waitFor(() => expect(killSessionTree).toHaveBeenCalledTimes(1));
    const ended = session.shutdown(false);
    releaseCleanup();
    await Promise.all([suspension, ended]);

    await session.spawnSession();
    await session.sendTurn('new turn');
    expect(admittedArgs).toHaveLength(2);
    expect(admittedArgs[1]).not.toEqual(expect.arrayContaining(['--resume', 'discard-me']));
    await session.shutdown(false);
  });

  it('makes ended dominate a concurrent host suspension and persists the captured row once', async () => {
    const child = makeChild();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    vi.mocked(killSessionTree).mockImplementationOnce(() => cleanup);
    admitPersistentChild(child);
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    child.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"end-wins"}\n'));
    session.completeProviderTurn();

    const suspension = session.suspendHostWorkAdmissionAfterTerminal();
    await vi.waitFor(() => expect(killSessionTree).toHaveBeenCalledOnce());
    const ending = session.shutdown(false);
    releaseCleanup();
    await Promise.all([suspension, ending]);

    expect(killSessionTree).toHaveBeenCalledOnce();
    expect(updateResumedSessionStatus).toHaveBeenCalledTimes(1);
    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      sessionDb, 9, 'end-wins', 'claude-cli', 'ended',
    );
  });

  it('ends an already suspended host row instead of leaving it resumable after /new', async () => {
    const child = makeChild();
    admitPersistentChild(child);
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    child.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"suspended-then-ended"}\n'));
    session.completeProviderTurn();
    await session.suspendHostWorkAdmissionAfterTerminal();
    await session.handleNew();

    expect(updateResumedSessionStatus).toHaveBeenLastCalledWith(
      sessionDb, 9, 'suspended-then-ended', 'claude-cli', 'ended',
    );
  });

  it('publishes the missing-identity cleanup barrier before replacement dispatch', async () => {
    const child = makeChild();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    vi.mocked(killSessionTree).mockImplementationOnce(() => cleanup);
    admitPersistentChild(child);
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    session.completeProviderTurn();

    const suspension = session.suspendHostWorkAdmissionAfterTerminal();
    const replacement = session.sendTurn('replacement');
    await vi.waitFor(() => expect(killSessionTree).toHaveBeenCalledTimes(1));
    releaseCleanup();

    await expect(suspension).rejects.toThrow('HOST_WORK_ADMISSION_RESUME_IDENTITY_UNAVAILABLE');
    await expect(replacement).rejects.toThrow('HOST_WORK_ADMISSION_RESUME_IDENTITY_UNAVAILABLE');
    expect(admission.spawn).toHaveBeenCalledTimes(1);
  });

  it('fails closed before a persistent Gemini host-admission spawn', async () => {
    const session = makeSession('gemini-cli');

    await expect(session.spawnSession()).rejects.toThrow('HOST_WORK_ADMISSION_UNSUPPORTED_PROVIDER');
    expect(admission.spawn).not.toHaveBeenCalled();
  });

  it('resumes the exact Codex thread at its next admitted turn boundary', async () => {
    const first = makeChild();
    const second = makeChild();
    admission.spawn.mockImplementation((options: { onSpawned?: (value: typeof first) => void }) => {
      const child = admission.spawn.mock.calls.length === 1 ? first : second;
      options.onSpawned?.(child);
      return Promise.resolve(child);
    });
    const session = makeSession('codex-cli');
    await session.spawnSession();
    const firstTurn = session.sendTurn('first turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledTimes(1));
    first.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"codex-thread-a"}}}\n'));
    await firstTurn;
    session.completeProviderTurn();
    await session.suspendHostWorkAdmissionAfterTerminal();
    vi.mocked(resolveResumableAgentSession).mockReturnValueOnce({ id: 9 } as never);

    const secondTurn = session.sendTurn('second turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledTimes(2));
    expect(second.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"threadId":"codex-thread-a"'));
    second.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"codex-thread-a"}}}\n'));
    await secondTurn;
    await session.shutdown(false);
  });

  it('rejects the waiting admitted Codex turn on exact-resume rejection without starting fresh', async () => {
    const child = makeChild();
    admitPersistentChild(child);
    vi.mocked(resolveResumableAgentSession).mockReturnValueOnce({ id: 9 } as never);
    const session = makeSession('codex-cli');
    await session.spawnSession('codex-old-thread', 9);
    const turn = session.sendTurn('resume turn');
    await vi.waitFor(() => expect(admission.spawn).toHaveBeenCalledOnce());

    const resumeRequest = child.stdin.write.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .find((request) => request.method === 'thread/start');
    expect(resumeRequest).toMatchObject({ params: { threadId: 'codex-old-thread' } });
    child.stdout.emit('data', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: resumeRequest.id, error: { message: 'thread unavailable' },
    }) + '\n'));

    await expect(turn).rejects.toThrow('HOST_WORK_ADMISSION_CODEX_RESUME_REJECTED');
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'), { timeout: 500 });
    expect(child.stdin.write).toHaveBeenCalledTimes(2);
    expect(child.stdin.write).not.toHaveBeenCalledWith(expect.stringContaining('"method":"turn/start"'));
    expect(updateResumedSessionStatus).toHaveBeenCalledWith(
      sessionDb, 9, 'codex-old-thread', 'codex-cli', 'resume_failed',
    );
    expect(session.getStatus()).toMatchObject({ active: false, providerTerminated: true });
  }, 1_000);

  it('keeps replacement closed after persistent host-admission cleanup is unproven', async () => {
    const child = makeChild();
    admitPersistentChild(child);
    const session = makeSession('claude-cli');
    await session.spawnSession();
    await session.sendTurn('first turn');
    vi.mocked(killSessionTree).mockRejectedValueOnce(new Error('tree cleanup unproven'));

    await expect(session.shutdown(true)).rejects.toThrow('tree cleanup unproven');
    await session.spawnSession();
    await expect(session.sendTurn('replacement turn')).rejects.toThrow('Previous host work provider cleanup remains unproven');

    // Existing fail-closed control: a second child cannot overlap an unproven
    // tree while the runtime-level suspension barrier is being added.
    expect(admission.spawn).toHaveBeenCalledTimes(1);
  });
});
