import { afterEach, describe, expect, it, vi } from 'vitest';

import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { IncomingMessage } from '../../../src/core/types.ts';
import { ensureHandoffArtifactSchema } from '../../../src/runtimes/agent/handoff-artifact.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import {
  SessionOwnershipRegistry,
  type OwnedGenerationState,
} from '../../../src/runtimes/agent/session-ownership.ts';
import { SessionManager, type SessionCrashInfo } from '../../../src/runtimes/agent/session.ts';
import { ensureStandbyNoticeSchema } from '../../../src/runtimes/agent/standby-notice.ts';
import {
  FAKE_PROVIDER,
  makeMemoryDb,
  makeMessenger,
  waitUntil,
} from './lib/session-harness.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  const mock = loggerMock();
  const logger = mock.createChildLogger();
  return {
    ...mock,
    default: { ...logger, child: () => logger },
    flushLogger: vi.fn(),
  };
});

type RespawnTimer = ReturnType<typeof setTimeout>;

class ObservedRespawnTimers extends Set<RespawnTimer> {
  additions = 0;
  deletions = 0;

  override add(timer: RespawnTimer): this {
    this.additions += 1;
    return super.add(timer);
  }

  override delete(timer: RespawnTimer): boolean {
    const deleted = super.delete(timer);
    if (deleted) this.deletions += 1;
    return deleted;
  }
}

class ObservedOwnershipRegistry extends SessionOwnershipRegistry {
  readonly transitions: Array<{
    mapKey: string;
    managerId: string;
    generation: number;
    state: OwnedGenerationState;
  }> = [];

  override transition(mapKey: string, managerId: string, to: OwnedGenerationState): void {
    super.transition(mapKey, managerId, to);
    const owner = this.get(mapKey);
    if (!owner) throw new Error(`owner disappeared during ${to} transition`);
    this.transitions.push({
      mapKey,
      managerId,
      generation: owner.generation,
      state: owner.state,
    });
  }
}

type RuntimeState = {
  _handleMessageInner: (message: IncomingMessage) => Promise<void>;
  ensureSessionAndQueueSync: (chatJid: string, mapKey: string) => void;
  resolvePerChatMapKey: (chatJid: string) => string;
  wirePerChatActorSocket: () => {
    mcpSocketPath: string;
    providerConfigOverride: undefined;
  };
  chatSessions: Map<string, SessionManager>;
  sessionOwnership: SessionOwnershipRegistry;
  pendingRespawnTimers: Set<RespawnTimer>;
  getCrashCount: (mapKey: string) => number;
  handlePerChatCrash: (
    mapKey: string,
    chatJid: string,
    info: SessionCrashInfo,
    expectedSession?: SessionManager,
  ) => void;
  handleCrashNotify: (message: string, chatJid?: string) => void;
};

const originalBinary = (SessionManager.prototype as any).getProviderBinary;
const originalArgs = (SessionManager.prototype as any).getProviderArgs;

afterEach(() => {
  (SessionManager.prototype as any).getProviderBinary = originalBinary;
  (SessionManager.prototype as any).getProviderArgs = originalArgs;
});

function makeMessage(chatJid: string): IncomingMessage {
  return {
    messageId: `crash-respawn-${Date.now()}`,
    chatJid,
    senderJid: chatJid,
    senderName: 'Crash respawn test',
    content: 'Crash during this turn',
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: Math.floor(Date.now() / 1_000),
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

function rethrowCollectedFailures(
  context: string,
  bodyFailures: unknown[],
  cleanupFailures: unknown[],
): void {
  const failures = [...bodyFailures, ...cleanupFailures];
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, `${context} body and cleanup both failed`);
}

describe('per-chat crash respawn ownership', () => {
  it('delivers the crash notice and reactivates the same canonical owner exactly once', async () => {
    const runId = `crash-respawn-${Date.now().toString(36)}-${process.pid}`;
    const lidJid = 'crash-respawn-lid@lid';
    const canonicalJid = 'crash-respawn-phone@s.whatsapp.net';
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('crash-respawn-lid', canonicalJid);
    const { messenger, sent } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'crash-respawn-test', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    runtime.setDurability(new DurabilityEngine(db));
    const state = runtime as unknown as RuntimeState;
    const ownership = new ObservedOwnershipRegistry();
    const timers = new ObservedRespawnTimers();
    state.sessionOwnership = ownership;
    state.pendingRespawnTimers = timers;
    state.wirePerChatActorSocket = () => ({
      mcpSocketPath: '/tmp/whatsoup-crash-respawn.sock',
      providerConfigOverride: undefined,
    });

    let providerGeneration = 0;
    (SessionManager.prototype as any).getProviderBinary = () => process.execPath;
    (SessionManager.prototype as any).getProviderArgs = () => {
      providerGeneration += 1;
      return [
        FAKE_PROVIDER,
        JSON.stringify({
          runId,
          sessionId: `${runId}-gen${providerGeneration}`,
          ...(providerGeneration === 1 ? { crashAfterMs: 300, crashCode: 42 } : {}),
        }),
      ];
    };

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const bodyFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];

    try {
      const mapKey = state.resolvePerChatMapKey(lidJid);
      expect(mapKey).toBe(canonicalJid);
      expect(mapKey).not.toBe(lidJid);

      await state._handleMessageInner(makeMessage(lidJid));
      const manager = state.chatSessions.get(mapKey);
      if (!manager) throw new Error('initial real per-chat manager was not mapped');
      expect(await waitUntil(() => manager.getStatus().sessionId === `${runId}-gen1`, 6_000)).toBe(true);

      const initialOwner = ownership.get(mapKey);
      if (!initialOwner) throw new Error('initial ownership record is missing');
      expect(initialOwner.state).toBe('active');
      expect(initialOwner.generation).toBe(1);

      const notificationDelivered = await waitUntil(
        () => sent.some(({ jid, text }) => jid === lidJid && text.includes('Agent session ended')),
        8_000,
      );
      const timerCompleted = await waitUntil(
        () => timers.additions >= 1 && timers.deletions >= 1 && timers.size === 0,
        20_000,
      );
      const reactivated = await waitUntil(() => {
        const owner = ownership.get(mapKey);
        return (
          state.chatSessions.get(mapKey) === manager &&
          owner?.managerId === initialOwner.managerId &&
          owner.generation === 2 &&
          owner.state === 'active' &&
          manager.getStatus().active
        );
      }, 6_000);

      const finalOwner = ownership.get(mapKey);
      const sessionDeletedByDeferredNotify = state.chatSessions.get(mapKey) !== manager;
      const observedStates = ownership.transitions.map(({ state: ownerState }) => ownerState);
      const failure =
        `W1-2 lost recovery: sessionDeletedByDeferredNotify=${sessionDeletedByDeferredNotify}, ` +
        `notificationDelivered=${notificationDelivered}, timerCompleted=${timerCompleted}, ` +
        `reactivated=${reactivated}, generation=${finalOwner?.generation ?? 'missing'}`;

      expect(
        {
          sessionDeletedByDeferredNotify,
          notificationDelivered,
          timerAdditions: timers.additions,
          timerDeletions: timers.deletions,
          timerCompleted,
          mappedToSameManager: state.chatSessions.get(mapKey) === manager,
          sameManagerId: finalOwner?.managerId === initialOwner.managerId,
          generation: finalOwner?.generation,
          state: finalOwner?.state,
          reactivated,
          crashCount: state.getCrashCount(mapKey),
          providerGeneration,
        },
        failure,
      ).toEqual({
        sessionDeletedByDeferredNotify: false,
        notificationDelivered: true,
        timerAdditions: 1,
        timerDeletions: 1,
        timerCompleted: true,
        mappedToSameManager: true,
        sameManagerId: true,
        generation: 2,
        state: 'active',
        reactivated: true,
        crashCount: 1,
        providerGeneration: 2,
      });
      expect(observedStates).toContain('recoverable_dead');
      expect(observedStates).toContain('respawning');
    } catch (error) {
      bodyFailures.push(error);
    } finally {
      randomSpy.mockRestore();
      try {
        await runtime.shutdown();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        db.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      rethrowCollectedFailures('crash respawn ownership', bodyFailures, cleanupFailures);
    }
  }, 45_000);

  it('drops a delayed spawn-per-turn crash from a superseded generation of the same manager', async () => {
    const runId = `stale-crash-${Date.now().toString(36)}-${process.pid}`;
    const chatJid = `${runId}@s.whatsapp.net`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'stale-crash-test', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    runtime.setDurability(new DurabilityEngine(db));
    const state = runtime as unknown as RuntimeState;
    const ownership = new ObservedOwnershipRegistry();
    const timers = new ObservedRespawnTimers();
    const notification = vi.fn();
    state.sessionOwnership = ownership;
    state.pendingRespawnTimers = timers;
    state.handleCrashNotify = notification;
    state.wirePerChatActorSocket = () => ({
      mcpSocketPath: '/tmp/whatsoup-stale-crash.sock',
      providerConfigOverride: undefined,
    });

    let manager: SessionManager | null = null;
    const bodyFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];

    try {
      const mapKey = state.resolvePerChatMapKey(chatJid);
      state.ensureSessionAndQueueSync(chatJid, mapKey);
      manager = state.chatSessions.get(mapKey) ?? null;
      if (!manager) throw new Error('spawn-per-turn manager was not mapped');

      (manager as any).provider = 'opencode-cli';
      (manager as any).model = 'glm/test-model';
      (manager as any).getProviderBinary = () => process.execPath;
      (manager as any).buildSpawnPerTurnArgs = () => [
        FAKE_PROVIDER,
        JSON.stringify({
          runId,
          sessionId: `${runId}-generation-1`,
          crashAfterMs: 250,
          crashCode: 42,
        }),
      ];

      await manager.spawnSession();
      const firstOwner = ownership.get(mapKey);
      if (!firstOwner) throw new Error('spawn-per-turn owner record is missing');
      ownership.transition(mapKey, firstOwner.managerId, 'active');

      await manager.sendTurn('exit this spawn-per-turn generation');
      const exitingChild = (manager as any).child as NodeJS.EventEmitter | null;
      if (!exitingChild) throw new Error('spawn-per-turn child was not attached');

      let supersessionError: unknown = null;
      const superseded = new Promise<void>((resolve) => {
        exitingChild.once('exit', () => {
          try {
            ownership.advanceGeneration(mapKey, firstOwner.managerId);
          } catch (error) {
            supersessionError = error;
          } finally {
            resolve();
          }
        });
      });

      await superseded;
      if (supersessionError) throw supersessionError;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      state.handlePerChatCrash(mapKey, chatJid, {
        exitCode: 42,
        signal: null,
        sessionId: null,
        dbRowId: null,
        generationIdentity: {
          managerId: firstOwner.managerId,
          generation: 1,
        },
      }, manager);
      state.handlePerChatCrash(mapKey, chatJid, {
        exitCode: 42,
        signal: null,
        sessionId: null,
        dbRowId: null,
      }, manager);

      const currentOwner = ownership.get(mapKey);
      const failure =
        `stale generation crash mutated current owner: crashCount=${state.getCrashCount(mapKey)}, ` +
        `state=${currentOwner?.state ?? 'missing'}, timers=${timers.size}`;
      expect(
        {
          managerId: currentOwner?.managerId,
          generation: currentOwner?.generation,
          state: currentOwner?.state,
          crashCount: state.getCrashCount(mapKey),
          timerCount: timers.size,
          notificationCount: notification.mock.calls.length,
        },
        failure,
      ).toEqual({
        managerId: firstOwner.managerId,
        generation: 2,
        state: 'active',
        crashCount: 0,
        timerCount: 0,
        notificationCount: 0,
      });
    } catch (error) {
      bodyFailures.push(error);
    } finally {
      if (manager) (manager as any).child = null;
      try {
        await runtime.shutdown();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        db.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      rethrowCollectedFailures('stale spawn-per-turn crash generation', bodyFailures, cleanupFailures);
    }
  }, 15_000);

  it('reactivates an owned spawn-per-turn manager after a signal-only child exit', async () => {
    const runId = `signal-respawn-${Date.now().toString(36)}-${process.pid}`;
    const chatJid = `${runId}@s.whatsapp.net`;
    const db = makeMemoryDb();
    ensureStandbyNoticeSchema(db);
    ensureHandoffArtifactSchema(db);
    const { messenger } = makeMessenger();
    const runtime = new AgentRuntime(db, messenger, 'signal-respawn-test', {
      sessionScope: 'per_chat',
      cwd: '/tmp',
    });
    runtime.setDurability(new DurabilityEngine(db));
    const state = runtime as unknown as RuntimeState;
    const ownership = new ObservedOwnershipRegistry();
    const timers = new ObservedRespawnTimers();
    state.sessionOwnership = ownership;
    state.pendingRespawnTimers = timers;
    state.wirePerChatActorSocket = () => ({
      mcpSocketPath: '/tmp/whatsoup-signal-respawn.sock',
      providerConfigOverride: undefined,
    });

    let manager: SessionManager | null = null;
    let signaledPid: number | null = null;
    let providerGeneration = 0;
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const bodyFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];

    try {
      const mapKey = state.resolvePerChatMapKey(chatJid);
      state.ensureSessionAndQueueSync(chatJid, mapKey);
      manager = state.chatSessions.get(mapKey) ?? null;
      if (!manager) throw new Error('spawn-per-turn manager was not mapped');

      (manager as any).provider = 'opencode-cli';
      (manager as any).model = 'glm/test-model';
      (manager as any).getProviderBinary = () => process.execPath;
      (manager as any).buildSpawnPerTurnArgs = () => {
        providerGeneration += 1;
        return [
          FAKE_PROVIDER,
          JSON.stringify({
            runId,
            sessionId: `${runId}-generation-${providerGeneration}`,
            protocol: 'opencode',
            handleSigterm: false,
          }),
        ];
      };

      await manager.spawnSession();
      const firstOwner = ownership.get(mapKey);
      if (!firstOwner) throw new Error('spawn-per-turn owner record is missing');
      ownership.transition(mapKey, firstOwner.managerId, 'active');

      await manager.sendTurn('signal this spawn-per-turn generation');
      expect(
        await waitUntil(
          () => manager?.getStatus().sessionId === `${runId}-generation-1`,
          6_000,
        ),
      ).toBe(true);
      signaledPid = manager.getStatus().pid;
      if (signaledPid === null) throw new Error('spawn-per-turn child PID was not captured');
      process.kill(signaledPid, 'SIGTERM');

      expect(await waitUntil(() => timers.additions === 1, 6_000)).toBe(true);
      expect(await waitUntil(() => timers.deletions === 1 && timers.size === 0, 20_000)).toBe(true);
      const reactivated = await waitUntil(() => {
        const currentOwner = ownership.get(mapKey);
        return (
          currentOwner?.managerId === firstOwner.managerId &&
          currentOwner.generation === 2 &&
          currentOwner.state === 'active' &&
          manager?.getStatus().active === true &&
          providerGeneration === 2
        );
      }, 6_000);

      const currentOwner = ownership.get(mapKey);
      const failure =
        `signal-only respawn wedged: reactivated=${reactivated}, ` +
        `active=${manager.getStatus().active}, pid=${manager.getStatus().pid ?? 'null'}, ` +
        `state=${currentOwner?.state ?? 'missing'}, generation=${currentOwner?.generation ?? 'missing'}`;
      expect(
        {
          reactivated,
          managerId: currentOwner?.managerId,
          generation: currentOwner?.generation,
          state: currentOwner?.state,
          crashCount: state.getCrashCount(mapKey),
          timerAdditions: timers.additions,
          timerDeletions: timers.deletions,
          timerCount: timers.size,
          providerGeneration,
        },
        failure,
      ).toEqual({
        reactivated: true,
        managerId: firstOwner.managerId,
        generation: 2,
        state: 'active',
        crashCount: 1,
        timerAdditions: 1,
        timerDeletions: 1,
        timerCount: 0,
        providerGeneration: 2,
      });
    } catch (error) {
      bodyFailures.push(error);
    } finally {
      randomSpy.mockRestore();
      try {
        await runtime.shutdown();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        db.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      rethrowCollectedFailures('signal-only spawn-per-turn respawn', bodyFailures, cleanupFailures);
    }
  }, 45_000);
});
