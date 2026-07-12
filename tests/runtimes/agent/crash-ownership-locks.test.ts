// REGRESSION LOCKS — exactly one crash owner and one generation-owned recovery.
import { describe, expect, it, vi } from 'vitest';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { SessionManager } from '../../../src/runtimes/agent/session.ts';
import {
  buildManager,
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

type RespawnTimer = ReturnType<typeof setTimeout>;

class ObservedRespawnTimers extends Set<RespawnTimer> {
  additions = 0;
  deletions = 0;

  override add(value: RespawnTimer): this {
    this.additions += 1;
    return super.add(value);
  }

  override delete(value: RespawnTimer): boolean {
    const deleted = super.delete(value);
    if (deleted) this.deletions += 1;
    return deleted;
  }
}

class ObservedSessionMap extends Map<string, SessionManager> {
  deletions = 0;

  override delete(key: string): boolean {
    const deleted = super.delete(key);
    if (deleted) this.deletions += 1;
    return deleted;
  }
}

async function settleQueuedCallbacks(turns = 2): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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

describe('B2 crash ownership regression locks', () => {
  it('Half A: one real crash owns exactly one manager callback pair', async () => {
    const runId = `b2a-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const crashes: unknown[] = [];
    const notifications: string[] = [];
    let childPid: number | null = null;
    let mgr: SessionManager | null = null;
    const bodyFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];

    try {
      const manager = buildManager({
        db,
        messenger,
        chatJid: `${runId}@s.whatsapp.net`,
        onCrash: (info) => crashes.push(info),
        notifyUser: (message) => notifications.push(message),
        fakeConfig: {
          runId,
          sessionId: `b2a-${runId}`,
          crashAfterMs: 250,
          crashCode: 42,
        },
      }).mgr;
      mgr = manager;
      await manager.spawnSession();
      expect(await waitUntil(() => manager.getStatus().sessionId === `b2a-${runId}-gen1`, 6_000)).toBe(true);
      childPid = manager.getStatus().pid;
      expect(childPid).toBeTypeOf('number');

      expect(
        await waitUntil(
          () => crashes.length >= 1 && notifications.length >= 1 && !isAlive(childPid),
          6_000,
        ),
      ).toBe(true);
      await settleQueuedCallbacks();

      const row = db.raw
        .prepare('SELECT status FROM agent_sessions ORDER BY id DESC LIMIT 1')
        .get() as { status: string } | undefined;
      expect(crashes).toHaveLength(1);
      expect(notifications).toHaveLength(1);
      expect(manager.getStatus().active).toBe(false);
      expect(row?.status).toBe('crashed');
    } catch (error) {
      bodyFailures.push(error);
    } finally {
      try {
        await mgr?.shutdown(false);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        killPid(childPid);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        db.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      rethrowCollectedFailures('B2 Half A', bodyFailures, cleanupFailures);
    }
  }, 30_000);

  it('Half B: one generation-owned respawn reactivates only the still-owned manager', async () => {
    const runId = `b2b-${Date.now().toString(36)}-${process.pid}`;
    const db = makeMemoryDb();
    const { messenger } = makeMessenger();
    const chatJid = `${runId}@s.whatsapp.net`;
    const mapKey = toConversationKey(chatJid);
    const originalBinary = (SessionManager.prototype as any).getProviderBinary;
    const originalArgs = (SessionManager.prototype as any).getProviderArgs;
    let runtime: AgentRuntime | null = null;
    let session: SessionManager | null = null;
    let notificationDeliveryCalls = 0;
    const bodyFailures: unknown[] = [];
    const cleanupFailures: unknown[] = [];

    try {
      runtime = new AgentRuntime(db as any, messenger as any, 'b2-lock', {
        sessionScope: 'per_chat',
        cwd: '/tmp',
      });
      const state = runtime as any;
      const timers = new ObservedRespawnTimers();
      const sessions = new ObservedSessionMap();
      state.pendingRespawnTimers = timers;
      state.chatSessions = sessions;
      state.wirePerChatActorSocket = () => ({
        mcpSocketPath: '/tmp/whatsoup-b2b.sock',
        providerConfigOverride: undefined,
      });
      state.handleCrashNotify = () => {
        notificationDeliveryCalls += 1;
      };

      (SessionManager.prototype as any).getProviderBinary = () => process.execPath;
      let providerGeneration = 0;
      (SessionManager.prototype as any).getProviderArgs = () => {
        providerGeneration += 1;
        return [
          FAKE_PROVIDER,
          JSON.stringify({
            runId,
            sessionId: `b2b-${runId}-gen${providerGeneration}`,
            ...(providerGeneration === 1 ? { crashAfterMs: 250, crashCode: 42 } : {}),
          }),
        ];
      };

      state.ensureSessionAndQueueSync(chatJid, mapKey);
      const createdSession = sessions.get(mapKey);
      if (!createdSession) throw new Error('ensureSessionAndQueueSync did not create the per-chat session');
      session = createdSession;
      expect(state.chatQueues.has(mapKey)).toBe(true);

      await createdSession.spawnSession();
      expect(await waitUntil(() => createdSession.getStatus().sessionId === `b2b-${runId}-gen1`, 6_000)).toBe(true);

      expect(await waitUntil(() => timers.additions === 1 && timers.size === 1, 6_000)).toBe(true);
      expect(notificationDeliveryCalls).toBe(1);

      expect(await waitUntil(() => timers.deletions === 1 && timers.size === 0, 20_000)).toBe(true);
      expect(
        await waitUntil(
          () =>
            sessions.get(mapKey) === createdSession &&
            createdSession.getStatus().active &&
            createdSession.getStatus().sessionId === `b2b-${runId}-gen2`,
          6_000,
        ),
      ).toBe(true);
      await settleQueuedCallbacks();
      expect(timers.additions).toBe(1);
      expect(timers.deletions).toBe(1);
      expect(sessions.deletions).toBe(0);
      expect(notificationDeliveryCalls).toBe(1);
      expect(state.chatQueues.has(mapKey)).toBe(true);
      expect(sessions.has(mapKey)).toBe(true);
      expect(sessions.get(mapKey)).toBe(createdSession);
      expect(createdSession.getStatus().active).toBe(true);
      expect(state.sessionOwnership.get(mapKey)).toEqual(expect.objectContaining({
        generation: 2,
        state: 'active',
        respawnTimer: null,
      }));
    } catch (error) {
      bodyFailures.push(error);
    } finally {
      (SessionManager.prototype as any).getProviderBinary = originalBinary;
      (SessionManager.prototype as any).getProviderArgs = originalArgs;
      try {
        if (runtime) {
          await runtime.shutdown();
        } else {
          await session?.shutdown(false);
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        db.close();
      } catch (error) {
        cleanupFailures.push(error);
      }
      rethrowCollectedFailures('B2 Half B', bodyFailures, cleanupFailures);
    }
  }, 45_000);
});
