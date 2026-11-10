/**
 * P2: an OpenCode client does not emit a tool-start record before a send_poll
 * await begins.  Its token-attributed socket call must therefore keep only the
 * manager that minted the token alive through the normal hard watchdog.  The
 * destination chat is deliberately another manager: target routing is not
 * ownership evidence.
 *
 * This is intentionally composed: AgentRuntime creates both managers and its
 * own ToolRegistry/poll registrar is reached through a real Unix socket.  The
 * only provider substitute is child_process; neither SessionManager tracking
 * nor evidence bindings are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';

import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { SESSION_TOKEN_NOTIFICATION, type SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';
import type { ToolRegistry } from '../../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import type { ExecutingSessionContext } from '../../../src/mcp/types.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { SessionManager, STALLED_OP_KILL_GRACE_MS, WATCHDOG_HARD_MS } from '../../../src/runtimes/agent/session.ts';
import { assessTreeLiveness } from '../../../src/runtimes/agent/tree-liveness.ts';
import { makeSocketPath } from '../../helpers/socket-rpc.ts';
import { ownedRuntimeCwd } from '../../helpers/runtime-home-fixture.ts';

const OWNER_JID = '15550100401@s.whatsapp.net';
const DESTINATION_JID = '15550100402@s.whatsapp.net';

const { spawnedChildren } = vi.hoisted(() => ({
  spawnedChildren: [] as MockChild[],
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

// The manager remains real.  A dead synthetic PID has no liveness evidence,
// so the hard-watchdog path takes its normal kill branch deterministically.
vi.mock('../../../src/runtimes/agent/tree-liveness.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/runtimes/agent/tree-liveness.ts')>(),
  assessTreeLiveness: vi.fn(async () => null),
}));

vi.mock('../../../src/runtimes/agent/process-tree.ts', () => ({
  killSessionTree: vi.fn(async (child: { kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    child.kill(signal);
  }),
}));

import { spawn } from 'node:child_process';

interface MockChild {
  pid: number;
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  spawnEnv: NodeJS.ProcessEnv | undefined;
  close: (code: number | null, signal: NodeJS.Signals | null) => void;
}

interface RuntimeInternals {
  registry: ToolRegistry;
  sessionTokens: SessionTokenRegistry;
  session: SessionManager | null;
  globalMcpSocketPath: string | null;
  ensureSessionAndQueueSync(chatJid: string, initialMapKey?: string, actorJid?: string): void;
  resolveExecutingGlobalSession(): ExecutingSessionContext;
  handlePollVoteReceived(data: {
    pollMessageId: string; chatJid: string; voterJid: string; selectedOptions: string[];
  }): void;
}

function makeMockChild(pid: number, spawnEnv: NodeJS.ProcessEnv | undefined): MockChild {
  let closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const stdin = new EventEmitter() as MockChild['stdin'];
  stdin.end = vi.fn();
  const stdout = new EventEmitter() as MockChild['stdout'];
  stdout.setEncoding = vi.fn();
  const stderr = new EventEmitter();
  const child: MockChild = {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => child.close(null, signal));
      return true;
    }),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      if (event === 'close') {
        closeListener = listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void;
      }
      return child;
    }),
    spawnEnv,
    close: (code, signal) => closeListener?.(code, signal),
  };
  return child;
}

function makeMessenger(onPollSent: () => void): Messenger & { sendPollMessage: ReturnType<typeof vi.fn> } {
  let nextPollId = 0;
  return {
    sendMessage: vi.fn(async () => ({ waMessageId: null })),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    sendPollMessage: vi.fn(async () => {
      onPollSent();
      nextPollId += 1;
      return { waMessageId: `poll-await-continuity-${nextPollId}`, hasSecret: true };
    }),
  } as Messenger & { sendPollMessage: ReturnType<typeof vi.fn> };
}

function createOpenCodeRuntime(db: Database, messenger: Messenger, cwd: string): AgentRuntime {
  const mutableConfig = config as unknown as { agentProvider: string };
  const previousProvider = mutableConfig.agentProvider;
  mutableConfig.agentProvider = 'opencode-cli';
  try {
    return new AgentRuntime(db, messenger, 'poll-wait-continuity', {
      sessionScope: 'shared',
      model: 'opencode/free',
      cwd,
    });
  } finally {
    mutableConfig.agentProvider = previousProvider;
  }
}

function openAwaitingPoll(
  socketPath: string, token: string | null, timeoutMs = WATCHDOG_HARD_MS * 3,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    const rejectOnce = (error: Error) => {
      client.destroy();
      reject(error);
    };
    client.once('error', rejectOnce);
    client.once('connect', () => {
      if (token !== null) {
        client.write(JSON.stringify({
          jsonrpc: '2.0',
          method: SESSION_TOKEN_NOTIFICATION,
          params: { token },
        }) + '\n');
      }
      client.write(JSON.stringify({
        jsonrpc: '2.0',
        id: token === null ? 2 : 1,
        method: 'tools/call',
        params: {
          name: 'send_poll',
          arguments: {
            chatJid: DESTINATION_JID,
            question: 'Proceed?',
            options: ['Yes', 'No'],
            awaitResult: true,
            // Must remain pending past one ordinary provider hard-watchdog window.
            timeoutMs,
          },
        },
      }) + '\n');
      resolve(client);
    });
  });
}

describe('OpenCode send_poll await continuity', () => {
  let ownerDb: Database | undefined;
  let destinationDb: Database | undefined;
  let ownerRuntime: AgentRuntime | undefined;
  let destinationRuntime: AgentRuntime | undefined;
  let owner!: SessionManager;
  let destination!: SessionManager;
  let server: WhatSoupSocketServer | undefined;
  let clients: Socket[] = [];
  let socketPath: string;
  let ownerMessenger: ReturnType<typeof makeMessenger>;

  async function votePoll(client = clients[0]!, pollMessageId = 'poll-await-continuity-1') {
    const response = new Promise<string>((resolve, reject) => {
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        client.off('data', onData);
        client.off('error', reject);
        resolve(buffer.slice(0, newline));
      };
      client.on('data', onData);
      client.once('error', reject);
    });
    (ownerRuntime as unknown as RuntimeInternals).handlePollVoteReceived({
      pollMessageId, chatJid: DESTINATION_JID,
      voterJid: DESTINATION_JID, selectedOptions: ['Yes'],
    });
    const reply = JSON.parse(await response);
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ sent: true, answer: 'Yes' });
  }

  async function settleOwnerPoll(terminal: 'vote' | 'abort') {
    if (terminal === 'vote') await votePoll();
    else clients[0]!.destroy();
    await vi.waitFor(() => expect(owner.hasPendingTools).toBe(false));
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(assessTreeLiveness).mockReset().mockResolvedValue(null);
    spawnedChildren.length = 0;
    vi.mocked(spawn).mockImplementation((...args) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      const child = makeMockChild(9400 + spawnedChildren.length, options?.env);
      spawnedChildren.push(child);
      return child as never;
    });

    ownerDb = new Database(':memory:');
    destinationDb = new Database(':memory:');
    ownerDb.open();
    destinationDb.open();
    clients = [];

    let resolvePollSends!: () => void;
    const twoPollSends = new Promise<void>((resolve) => { resolvePollSends = resolve; });
    let pollSendCount = 0;
    ownerMessenger = makeMessenger(() => {
      pollSendCount += 1;
      if (pollSendCount === 2) resolvePollSends();
    });

    const ownerCwd = await ownedRuntimeCwd('poll-wait-continuity-owner');
    const destinationCwd = await ownedRuntimeCwd('poll-wait-continuity-destination');
    ownerRuntime = createOpenCodeRuntime(ownerDb, ownerMessenger, ownerCwd);
    destinationRuntime = createOpenCodeRuntime(destinationDb, makeMessenger(() => {}), destinationCwd);

    const ownerState = ownerRuntime as unknown as RuntimeInternals;
    const destinationState = destinationRuntime as unknown as RuntimeInternals;
    socketPath = makeSocketPath();
    ownerState.globalMcpSocketPath = socketPath;

    ownerState.ensureSessionAndQueueSync(OWNER_JID, undefined, OWNER_JID);
    destinationState.ensureSessionAndQueueSync(DESTINATION_JID, undefined, DESTINATION_JID);
    owner = ownerState.session!;
    destination = destinationState.session!;
    await owner.spawnSession();
    await destination.spawnSession();
    await owner.sendTurn('awaiting a quiet poll');
    await destination.sendTurn('unrelated quiet provider turn');

    const ownerToken = spawnedChildren[0]?.spawnEnv?.WHATSOUP_MCP_SESSION_TOKEN;
    expect(ownerToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(owner.getStatus()).toMatchObject({ active: true, turnInFlight: true });
    expect(destination.getStatus()).toMatchObject({ active: true, turnInFlight: true });

    server = new WhatSoupSocketServer(
      socketPath,
      ownerState.registry,
      { tier: 'global', allowedRoot: ownerCwd },
      () => ownerState.resolveExecutingGlobalSession(),
      undefined,
      { sessionTokens: ownerState.sessionTokens },
    );
    await server.startAndWait();

    // The first request is the session's own token; the second is a genuine
    // external await with no token. Neither provider emits a tool-start event.
    clients.push(await openAwaitingPoll(socketPath, ownerToken ?? null));
    clients.push(await openAwaitingPoll(socketPath, null));
    await twoPollSends;
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    const recordCleanupError = (error: unknown) => cleanupErrors.push(error);

    for (const client of clients) {
      try {
        client.destroy();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    try {
      server?.stop();
    } catch (error) {
      recordCleanupError(error);
    }

    // Socket teardown aborts the pending awaits. Clear their fake expiry timers
    // before shutdown, then restore native scheduling so teardown cannot wait
    // on a clock this fixture no longer advances.
    try {
      vi.clearAllTimers();
    } catch (error) {
      recordCleanupError(error);
    }
    try {
      vi.useRealTimers();
    } catch (error) {
      recordCleanupError(error);
    }
    try {
      await ownerRuntime?.shutdown();
    } catch (error) {
      recordCleanupError(error);
    }
    try {
      await destinationRuntime?.shutdown();
    } catch (error) {
      recordCleanupError(error);
    }
    try {
      ownerDb?.close();
    } catch (error) {
      recordCleanupError(error);
    }
    try {
      destinationDb?.close();
    } catch (error) {
      recordCleanupError(error);
    }

    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'poll-wait continuity fixture cleanup failed');
    }
  });

  it('exempts only the token-owning OpenCode manager while an awaited poll is unresolved', async () => {
    const ownerChild = spawnedChildren[0]!;
    const destinationChild = spawnedChildren[1]!;

    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    await Promise.resolve();

    expect(ownerChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(owner.getStatus()).toMatchObject({ active: true, turnInFlight: true });

    // A target JID and an external no-token caller are not owner evidence.
    expect(destinationChild.kill).toHaveBeenCalledWith('SIGKILL');

    await votePoll();
    expect(owner.hasPendingTools).toBe(false);
    expect(owner.getStatus().turnInFlight).toBe(true);
  });

  it('keeps ordinary watchdog recovery for an external await after the owner disconnects', async () => {
    await vi.waitFor(() => expect(owner.hasPendingTools).toBe(true));
    clients[0]!.destroy();
    await vi.waitFor(() => expect(owner.hasPendingTools).toBe(false));

    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);

    expect(spawnedChildren[0]!.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnedChildren[1]!.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it.each(['vote', 'abort'] as const)(
    'restores the hard watchdog after a rearmed poll settles by %s', async (terminal) => {
      const child = spawnedChildren[0]!;
      await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      await settleOwnerPoll(terminal);
      await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS - 1_000);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    },
  );

  it('retains another active wait and restores the hard watchdog after the final vote', async () => {
    const child = spawnedChildren[0]!;
    const token = child.spawnEnv?.WHATSOUP_MCP_SESSION_TOKEN;
    expect(token).toBeDefined();
    const secondClient = await openAwaitingPoll(socketPath, token ?? null, WATCHDOG_HARD_MS * 5);
    clients.push(secondClient);
    await vi.waitFor(() => expect(ownerMessenger.sendPollMessage).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);

    await votePoll();
    expect(owner.hasPendingTools).toBe(true);
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(owner.getStatus().turnInFlight).toBe(true);

    await votePoll(secondClient, 'poll-await-continuity-3');
    expect(owner.hasPendingTools).toBe(false);
    await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it.each(['vote', 'abort'] as const)(
    'preserves an unrelated stalled-operation deadline and liveness evidence after %s', async (terminal) => {
      const child = spawnedChildren[0]!;
      await vi.advanceTimersByTimeAsync(WATCHDOG_HARD_MS + 1);
      vi.mocked(assessTreeLiveness).mockResolvedValueOnce({
        alive: true, cpuDeltaMs: 250, pidChurn: 0, pidCount: 1,
      });
      owner.recoverStalledOperation('unrelated-stall', 'Bash');
      await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS + 1);
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
      const state = owner as unknown as { livenessProgressEpoch: number; longOpGateStartedAt: number | null };
      const epoch = state.livenessProgressEpoch;
      const gateStartedAt = state.longOpGateStartedAt;
      expect(gateStartedAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS / 2);

      await settleOwnerPoll(terminal);
      expect(state.livenessProgressEpoch).toBe(epoch);
      expect(state.longOpGateStartedAt).toBe(gateStartedAt);
      await vi.advanceTimersByTimeAsync(STALLED_OP_KILL_GRACE_MS / 2 + 1);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    },
  );
});
