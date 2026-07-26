import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeMessageIfNew } from '../../../src/core/messages.ts';
import type { IncomingMessage } from '../../../src/core/types.ts';
import { ensureHandoffArtifactSchema } from '../../../src/runtimes/agent/handoff-artifact.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import {
  SessionOwnershipRegistry,
  type OwnedGenerationState,
} from '../../../src/runtimes/agent/session-ownership.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import { ensureStandbyNoticeSchema } from '../../../src/runtimes/agent/standby-notice.ts';
import {
  FAKE_PROVIDER,
  isAlive,
  killPid,
  makeMemoryDb,
  makeMessenger,
  waitUntil,
} from './lib/session-harness.ts';

vi.mock('../../../src/logger.ts', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    default: { ...logger, child: () => logger },
    createChildLogger: () => logger,
    flushLogger: () => Promise.resolve(),
  };
});

type RuntimeState = {
  _handleMessageInner: (msg: IncomingMessage) => Promise<void>;
  resolvePerChatMapKey: (chatJid: string) => string;
  ensureSessionAndQueueSync: (chatJid: string, mapKey: string) => void;
  deleteOwnedPerChatSession: (mapKey: string, expected?: SessionManager) => boolean;
  wirePerChatActorSocket: () => { mcpSocketPath: string; providerConfigOverride: undefined };
  chatSessions: Map<string, SessionManager>;
  chatQueues: Map<string, unknown>;
  operationTrackers: Map<string, unknown>;
  pendingSystemResults: { counts: Map<string, number> };
  perChatExecActorQueue: Map<string, Array<string | undefined>>;
  sessionOwnership: SessionOwnershipRegistry;
};

class ObservedSessionMap extends Map<string, SessionManager> {
  readonly missingDuringDelete: string[] = [];

  override delete(key: string): boolean {
    const deleted = super.delete(key);
    if (deleted && this.get(key) === undefined) this.missingDuringDelete.push(key);
    return deleted;
  }
}

type TransitionObservation = {
  state: OwnedGenerationState;
  generation: number;
  mapped: boolean;
  oldChildAlive: boolean;
};

class ObservedOwnershipRegistry extends SessionOwnershipRegistry {
  readonly transitions: TransitionObservation[] = [];
  probe: (() => { mapped: boolean; oldChildAlive: boolean }) | null = null;

  override transition(mapKey: string, managerId: string, to: OwnedGenerationState): void {
    super.transition(mapKey, managerId, to);
    const owner = this.get(mapKey);
    const observed = this.probe?.() ?? { mapped: false, oldChildAlive: false };
    this.transitions.push({
      state: to,
      generation: owner?.generation ?? -1,
      ...observed,
    });
  }
}

class ObservedReplacementMap<T> extends Map<string, T> {
  readonly sets: Array<{ key: string; ownerState: OwnedGenerationState | undefined; generation: number | undefined }> = [];

  constructor(private readonly ownerFor: (key: string) => ReturnType<SessionOwnershipRegistry['get']>) {
    super();
  }

  override set(key: string, value: T): this {
    const owner = this.ownerFor(key);
    this.sets.push({ key, ownerState: owner?.state, generation: owner?.generation });
    return super.set(key, value);
  }
}

const originalBinary = (SessionManager.prototype as any).getProviderBinary;
const originalArgs = (SessionManager.prototype as any).getProviderArgs;

afterEach(() => {
  (SessionManager.prototype as any).getProviderBinary = originalBinary;
  (SessionManager.prototype as any).getProviderArgs = originalArgs;
});

function makeMessage(chatJid: string, content: string): IncomingMessage {
  return {
    messageId: `lifecycle-${Date.now()}`,
    chatJid,
    senderJid: chatJid,
    senderName: 'Lifecycle test',
    content,
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Date.now(),
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

function makeNewMessage(chatJid: string): IncomingMessage {
  return makeMessage(chatJid, '/new');
}

function installFakeProvider(
  runId: string,
  graceMs: number,
  pidFileForGeneration?: (generation: number) => string | undefined,
): () => number {
  let generation = 0;
  (SessionManager.prototype as any).getProviderBinary = () => process.execPath;
  (SessionManager.prototype as any).getProviderArgs = () => {
    generation += 1;
    return [
      FAKE_PROVIDER,
      JSON.stringify({
        runId,
        sessionId: `${runId}-gen${generation}`,
        graceMs,
        pidFile: pidFileForGeneration?.(generation),
      }),
    ];
  };
  return () => generation;
}

function configureRuntime(runtime: AgentRuntime): {
  state: RuntimeState;
  ownership: ObservedOwnershipRegistry;
  sessions: ObservedSessionMap;
  queues: ObservedReplacementMap<unknown>;
  trackers: ObservedReplacementMap<unknown>;
} {
  const state = runtime as unknown as RuntimeState;
  const ownership = new ObservedOwnershipRegistry();
  const sessions = new ObservedSessionMap();
  const queues = new ObservedReplacementMap((key) => ownership.get(key));
  const trackers = new ObservedReplacementMap((key) => ownership.get(key));
  state.sessionOwnership = ownership;
  state.chatSessions = sessions;
  state.chatQueues = queues;
  state.operationTrackers = trackers;
  state.wirePerChatActorSocket = () => ({
    mcpSocketPath: '/tmp/whatsoup-new-ownership.sock',
    providerConfigOverride: undefined,
  });
  return { state, ownership, sessions, queues, trackers };
}

describe('per-chat /new ownership transition', () => {
  it('keeps one real manager mapped while fencing and replacing its generation', async () => {
    const runId = `new-owner-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db as any, messenger as any, 'new-owner', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    const { state, ownership, sessions, queues, trackers } = configureRuntime(runtime);
    const generationCount = installFakeProvider(runId, 300);
    const chatJid = `${runId}@s.whatsapp.net`;
    const mapKey = state.resolvePerChatMapKey(chatJid);
    let oldPid: number | null = null;
    let replacementPid: number | null = null;
    let manager: SessionManager | null = null;

    try {
      await state._handleMessageInner(makeMessage(chatJid, 'initial real turn'));
      manager = sessions.get(mapKey) ?? null;
      if (!manager) throw new Error('real SessionManager was not created');
      const currentManager = manager;
      expect(await waitUntil(() => currentManager.getStatus().sessionId === `${runId}-gen1`, 6_000)).toBe(true);
      oldPid = currentManager.getStatus().pid;
      const initialOwner = ownership.get(mapKey);
      expect(initialOwner).toMatchObject({ generation: 1, state: 'active' });
      expect(initialOwner?.managerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      const originalQueue = queues.get(mapKey);
      const originalTracker = trackers.get(mapKey);
      ownership.probe = () => ({ mapped: sessions.get(mapKey) === currentManager, oldChildAlive: isAlive(oldPid) });

      await state._handleMessageInner(makeNewMessage(chatJid));
      replacementPid = currentManager.getStatus().pid;

      expect(sessions.missingDuringDelete).toEqual([]);
      expect(sessions.get(mapKey)).toBe(currentManager);
      expect(ownership.get(mapKey)).toMatchObject({
        managerId: initialOwner?.managerId,
        generation: 2,
        state: 'active',
      });
      expect(ownership.transitions.map(({ state }) => state)).toEqual(['active', 'resetting', 'active']);
      expect(ownership.transitions[1]).toMatchObject({ generation: 1, mapped: true });
      expect(ownership.transitions[2]).toMatchObject({ generation: 2, mapped: true, oldChildAlive: false });
      expect(queues.get(mapKey)).not.toBe(originalQueue);
      expect(trackers.get(mapKey)).not.toBe(originalTracker);
      expect(queues.sets.at(-1)).toMatchObject({ key: mapKey, ownerState: 'resetting', generation: 2 });
      expect(trackers.sets.at(-1)).toMatchObject({ key: mapKey, ownerState: 'resetting', generation: 2 });
      expect(generationCount()).toBe(2);
      expect(isAlive(oldPid)).toBe(false);
      expect(replacementPid).not.toBe(oldPid);
      expect(currentManager.getStatus().active).toBe(true);
    } finally {
      await runtime.shutdown();
      await manager?.shutdown(false);
      killPid(oldPid);
      killPid(replacementPid);
      await waitUntil(() => !isAlive(oldPid) && !isAlive(replacementPid), 2_000);
      db.close();
    }
  }, 30_000);

  it('drops a reset that loses ownership during old-child shutdown before replacing keyed resources', async () => {
    const runId = `new-race-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db as any, messenger as any, 'new-race', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    const { state, ownership, sessions, queues, trackers } = configureRuntime(runtime);
    const generationCount = installFakeProvider(runId, 300);
    const chatJid = `${runId}@s.whatsapp.net`;
    const mapKey = state.resolvePerChatMapKey(chatJid);
    let manager: SessionManager | null = null;
    let oldPid: number | null = null;

    try {
      await state._handleMessageInner(makeMessage(chatJid, 'initial real turn'));
      manager = sessions.get(mapKey) ?? null;
      if (!manager) throw new Error('real SessionManager was not created');
      const currentManager = manager;
      expect(await waitUntil(() => currentManager.getStatus().sessionId === `${runId}-gen1`, 6_000)).toBe(true);
      oldPid = currentManager.getStatus().pid;
      const originalQueue = queues.get(mapKey);
      const originalTracker = trackers.get(mapKey);

      const reset = state._handleMessageInner(makeNewMessage(chatJid));
      expect(
        await waitUntil(
          () => ownership.get(mapKey)?.state === 'resetting'
            && ownership.get(mapKey)?.generation === 2
            && isAlive(oldPid),
          2_000,
          10,
        ),
      ).toBe(true);
      expect(state.deleteOwnedPerChatSession(mapKey, currentManager)).toBe(true);
      await reset;

      expect(sessions.has(mapKey)).toBe(false);
      expect(ownership.get(mapKey)).toBeUndefined();
      expect(queues.get(mapKey)).toBe(originalQueue);
      expect(trackers.get(mapKey)).toBe(originalTracker);
      expect(generationCount()).toBe(1);
      expect(isAlive(oldPid)).toBe(false);
      expect(currentManager.getStatus().active).toBe(false);
    } finally {
      await runtime.shutdown();
      await manager?.shutdown(false);
      killPid(oldPid);
      await waitUntil(() => !isAlive(oldPid), 2_000);
      db.close();
    }
  }, 30_000);

  it('activates the same manager generation at its new key when LID rekey lands during spawn', async () => {
    const runId = `new-rekey-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db as any, messenger as any, 'new-rekey', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    const { state, ownership, sessions } = configureRuntime(runtime);
    const generationCount = installFakeProvider(runId, 100);
    const conversationKey = `${runId}-lid`;
    const lidJid = `${conversationKey}@lid`;
    const canonicalJid = `${runId}-phone@s.whatsapp.net`;
    const lidKey = state.resolvePerChatMapKey(lidJid);
    const canonicalKey = state.resolvePerChatMapKey(canonicalJid);
    let manager: SessionManager | null = null;
    let childPid: number | null = null;
    let turn: Promise<void> | null = null;
    let releaseSpawn!: () => void;
    const spawnRelease = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    let reportSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => { reportSpawned = resolve; });
    let releaseContextResult!: () => void;
    const contextResultRelease = new Promise<void>((resolve) => { releaseContextResult = resolve; });

    try {
      storeMessageIfNew(db, {
        chatJid: lidJid,
        conversationKey,
        senderJid: lidJid,
        messageId: `${runId}-history`,
        content: 'history that must be injected after the rekeyed spawn',
        contentType: 'text',
        isFromMe: false,
        timestamp: Math.floor(Date.now() / 1_000) - 1,
      });
      state.ensureSessionAndQueueSync(lidJid, lidKey);
      manager = sessions.get(lidKey) ?? null;
      if (!manager) throw new Error('real SessionManager was not created');
      const currentManager = manager;
      const initialQueue = state.chatQueues.get(lidKey) as { indicateTyping: () => void } | undefined;
      if (!initialQueue) throw new Error('real outbound queue was not created');
      const indicateTyping = vi.spyOn(initialQueue, 'indicateTyping');
      const routedTurns: Array<{ mapKey: string | null; text: string }> = [];
      const realSendTurnAtProviderBoundary = currentManager.sendTurnAtProviderBoundary.bind(currentManager);
      currentManager.sendTurnAtProviderBoundary = async (text: string, onReady?: () => void) => {
        await realSendTurnAtProviderBoundary(text, () => {
          const activeMapKey = sessions.get(canonicalKey) === currentManager
            ? canonicalKey
            : sessions.get(lidKey) === currentManager
              ? lidKey
              : null;
          routedTurns.push({ mapKey: activeMapKey, text });
          onReady?.();
        });
        if (text.includes('[Recent chat context')) {
          void contextResultRelease.then(() => {
            (currentManager as any).onEvent({ type: 'result', text: null });
          });
        }
      };
      const claimedOwner = ownership.get(lidKey);
      if (!claimedOwner) throw new Error('initial owner was not claimed');
      ownership.advanceGeneration(lidKey, claimedOwner.managerId);
      const initialOwner = ownership.get(lidKey);
      if (!initialOwner) throw new Error('advanced owner was not retained');
      const realSpawn = currentManager.spawnSession.bind(currentManager);
      currentManager.spawnSession = async (...args: Parameters<SessionManager['spawnSession']>) => {
        await realSpawn(...args);
        childPid = currentManager.getStatus().pid;
        reportSpawned();
        await spawnRelease;
      };

      turn = state._handleMessageInner(makeMessage(lidJid, 'turn crossing a LID rekey'));
      await spawned;
      runtime.handleJidAliasChanged(conversationKey, canonicalJid);

      expect(sessions.has(lidKey)).toBe(false);
      expect(sessions.get(canonicalKey)).toBe(currentManager);
      expect(ownership.get(canonicalKey)).toMatchObject({
        managerId: initialOwner.managerId,
        generation: initialOwner.generation,
      });

      releaseSpawn();
      expect(await waitUntil(() => routedTurns.length === 1, 2_000)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      // P4: context is merged into the single user turn — no fresh_session_context
      // lease exists, so the rekey-following property is witnessed through the
      // exec-actor queue landing under the ACTIVATED key instead.
      expect(routedTurns).toHaveLength(1);
      expect(state.pendingSystemResults.counts.get(canonicalKey) ?? 0).toBe(0);
      expect(state.perChatExecActorQueue.get(canonicalKey)).toEqual([lidJid]);

      releaseContextResult();
      await turn;
      expect(await waitUntil(() => ownership.get(canonicalKey)?.state === 'active', 2_000)).toBe(true);

      expect(ownership.get(canonicalKey)).toMatchObject({
        managerId: initialOwner.managerId,
        generation: initialOwner.generation,
        state: 'active',
      });
      expect(currentManager.getStatus().active).toBe(true);
      expect(isAlive(childPid)).toBe(true);
      expect(generationCount()).toBe(1);
      expect(state.chatQueues.get(canonicalKey)).toBe(initialQueue);
      expect(state.chatQueues.has(lidKey)).toBe(false);
      expect(indicateTyping).toHaveBeenCalledTimes(1);
      expect(state.pendingSystemResults.counts.get(canonicalKey) ?? 0).toBe(0);
      expect(state.pendingSystemResults.counts.has(lidKey)).toBe(false);
      expect(state.perChatExecActorQueue.get(canonicalKey)).toEqual([lidJid]);
      expect(state.perChatExecActorQueue.has(lidKey)).toBe(false);
      expect(routedTurns).toHaveLength(1);
      expect(routedTurns[0]?.mapKey).toBe(canonicalKey);
      expect(routedTurns[0]?.text).toMatch(/^\[Recent chat context — read before responding\]\n/);
      expect(routedTurns[0]?.text).toMatch(/\n\n\[Current message\]\nturn crossing a LID rekey$/);
    } finally {
      releaseSpawn();
      releaseContextResult();
      await turn?.catch(() => {});
      await runtime.shutdown();
      await manager?.shutdown(false);
      killPid(childPid);
      await waitUntil(() => !isAlive(childPid), 2_000);
      db.close();
    }
  }, 30_000);

  it('keeps a failed replacement mapped in an explicit retryable state with no child', async () => {
    const runId = `new-fail-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db as any, messenger as any, 'new-fail', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    const { state, ownership, sessions } = configureRuntime(runtime);
    const replacementPidFile = join(tmpdir(), `${runId}-replacement-pid.json`);
    installFakeProvider(runId, 100, (generation) => generation === 2 ? replacementPidFile : undefined);
    const chatJid = `${runId}@s.whatsapp.net`;
    const mapKey = state.resolvePerChatMapKey(chatJid);
    let oldPid: number | null = null;
    let replacementPid: number | null = null;
    let manager: SessionManager | null = null;
    let replacementPidReadyBeforeFailure = false;
    const replacementPidReadinessSignal = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
    );

    try {
      state.ensureSessionAndQueueSync(chatJid, mapKey);
      manager = sessions.get(mapKey) ?? null;
      if (!manager) throw new Error('real SessionManager was not created');
      const currentManager = manager;
      await currentManager.spawnSession();
      expect(await waitUntil(() => currentManager.getStatus().sessionId === `${runId}-gen1`, 6_000)).toBe(true);
      oldPid = currentManager.getStatus().pid;

      db.raw.function('fail_after_replacement_fork', () => {
        const deadline = Date.now() + 6_000;
        while (!existsSync(replacementPidFile)) {
          const remainingMs = deadline - Date.now();
          if (remainingMs <= 0) break;
          Atomics.wait(replacementPidReadinessSignal, 0, 0, Math.min(remainingMs, 25));
        }
        replacementPidReadyBeforeFailure = existsSync(replacementPidFile);
        throw new Error('forced replacement spawn failure');
      });
      db.raw.exec(`
        CREATE TRIGGER fail_new_session_insert
        BEFORE INSERT ON agent_sessions
        BEGIN
          SELECT fail_after_replacement_fork();
        END;
      `);

      await state._handleMessageInner(makeNewMessage(chatJid));
      expect(replacementPidReadyBeforeFailure).toBe(true);
      const replacementRecord = JSON.parse(readFileSync(replacementPidFile, 'utf8')) as { provider: number };
      replacementPid = replacementRecord.provider;

      expect(sessions.missingDuringDelete).toEqual([]);
      expect(sessions.get(mapKey)).toBe(currentManager);
      expect(ownership.get(mapKey)).toMatchObject({ generation: 2, state: 'recoverable_dead' });
      expect(currentManager.getStatus()).toMatchObject({ active: false, pid: null });
      expect(isAlive(oldPid)).toBe(false);
      expect(isAlive(replacementPid)).toBe(false);
    } finally {
      await runtime.shutdown();
      await manager?.shutdown(false);
      killPid(oldPid);
      killPid(replacementPid);
      if (existsSync(replacementPidFile)) unlinkSync(replacementPidFile);
      await waitUntil(() => !isAlive(oldPid), 2_000);
      db.close();
    }
  }, 30_000);

  it('kills the known old child before marking a shutdown-persistence failure retryable', async () => {
    const runId = `new-shutdown-fail-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db as any, messenger as any, 'new-shutdown-fail', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    const { state, ownership, sessions } = configureRuntime(runtime);
    const generationCount = installFakeProvider(runId, 300);
    const chatJid = `${runId}@s.whatsapp.net`;
    const mapKey = state.resolvePerChatMapKey(chatJid);
    let manager: SessionManager | null = null;
    let oldPid: number | null = null;

    try {
      await state._handleMessageInner(makeMessage(chatJid, 'initial real turn'));
      manager = sessions.get(mapKey) ?? null;
      if (!manager) throw new Error('real SessionManager was not created');
      const currentManager = manager;
      expect(await waitUntil(() => currentManager.getStatus().sessionId === `${runId}-gen1`, 6_000)).toBe(true);
      oldPid = currentManager.getStatus().pid;

      db.raw.exec(`
        CREATE TRIGGER fail_new_shutdown_update
        BEFORE UPDATE OF status ON agent_sessions
        WHEN NEW.status = 'ended'
        BEGIN
          SELECT RAISE(ABORT, 'forced shutdown persistence failure');
        END;
      `);

      await state._handleMessageInner(makeNewMessage(chatJid));
      expect(await waitUntil(() => ownership.get(mapKey)?.state === 'recoverable_dead', 2_000)).toBe(true);

      expect(sessions.get(mapKey)).toBe(currentManager);
      expect(ownership.get(mapKey)).toMatchObject({ generation: 2, state: 'recoverable_dead' });
      expect(isAlive(oldPid)).toBe(false);
      expect(generationCount()).toBe(1);
    } finally {
      db.raw.exec('DROP TRIGGER IF EXISTS fail_new_shutdown_update');
      await runtime.shutdown();
      await manager?.shutdown(false);
      killPid(oldPid);
      await waitUntil(() => !isAlive(oldPid), 2_000);
      db.close();
    }
  }, 30_000);
});
