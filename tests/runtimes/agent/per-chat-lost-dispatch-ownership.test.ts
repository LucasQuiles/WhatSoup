/**
 * A per-chat chat can end up holding an entry in `chatSessions` whose dispatch
 * ownership record is missing, or is held by a different manager. Every turn
 * then throws at `rebindRuntimeTurnForDispatch`, and because BOTH repair routes
 * in `sendTurnPerChat` are gated on the session map MISSING the key, nothing
 * ever repairs it: the chat rejects every inbound turn for the process
 * lifetime.
 *
 * These tests pin the recovery contract (evict the stale entry, fall through to
 * spawn-and-claim), the fail-closed guards around it, and the atomicity of the
 * teardown paths that are supposed to keep the two maps in step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  type RuntimeState,
  context,
  makeRuntimeState,
  queueStub,
  sessionStub,
} from './lib/runtime-terminal-coordinator-harness.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

import { createChildLogger } from '../../../src/logger.ts';

const runtimeLogger = createChildLogger('test') as unknown as {
  warn: ReturnType<typeof vi.fn>;
};

/** Private runtime surface this suite drives directly. */
type OwnershipState = RuntimeState & {
  controlSession: unknown;
  perChatRuntimeTurnCompletions: Map<string, { resolve(): void }>;
  ensureSessionAndQueueSync(chatJid: string, mapKey?: string, actorJid?: string): void;
  deleteOwnedPerChatSession(
    mapKey: string,
    expected?: ReturnType<typeof sessionStub>,
  ): boolean;
  perChatSessionsWithoutOwner(): string[];
  sweepPerChatSessionsWithoutOwner(): number;
  logHealthStats(): void;
  operationTrackers: Map<string, { shutdown: ReturnType<typeof vi.fn> }>;
  getHealthSnapshot(): { status: string; details: Record<string, unknown> };
  sessionOwnership: RuntimeState['sessionOwnership'] & {
    get(mapKey: string): { managerId: string } | undefined;
    release(mapKey: string, managerId: string): void;
  };
};

type SendTurnPerChat = (
  this: OwnershipState,
  chatJid: string,
  text: string,
  mapKey: string,
  actorJid: string,
  runtimeContext: RuntimeTurnContext,
) => Promise<void>;

const MAP_KEY = '15550100199';

/**
 * Drive one per-chat turn to the provider boundary.
 *
 * A dispatched runtime turn parks on its completion promise until a terminal
 * arrives. Settling that promise directly keeps the test on the admission path
 * under test instead of dragging in the whole finalization pipeline; the
 * dispatch's own rejection is still what surfaces when admission fails.
 */
async function dispatchTurn(
  state: OwnershipState,
  runtimeContext: RuntimeTurnContext,
): Promise<void> {
  const sendTurnPerChat = state.sendTurnPerChat as unknown as SendTurnPerChat;
  const dispatch = sendTurnPerChat.call(
    state,
    runtimeContext.identity.deliveryJid,
    runtimeContext.replay.text,
    MAP_KEY,
    runtimeContext.replay.senderJid,
    runtimeContext,
  );
  let settled = false;
  void dispatch.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => {
    expect(settled || state.perChatRuntimeTurnCompletions.has(MAP_KEY)).toBe(true);
  });
  state.perChatRuntimeTurnCompletions.get(MAP_KEY)?.resolve();
  await dispatch;
  // Emulate the terminal cleanup the real finalization path performs, so the
  // next turn in this chat starts from an empty FIFO.
  state.perChatRuntimeTurnContexts.delete(MAP_KEY);
  state.perChatRuntimeTurnCompletions.delete(MAP_KEY);
}

function makePerChatRuntime(db: Database) {
  return makeRuntimeState<OwnershipState>(db, { sessionScope: 'per_chat' });
}

function exitedSessionStub(): ReturnType<typeof sessionStub> {
  const session = sessionStub();
  // The field state is a provider child that exited: auto-respawn exhausted,
  // then `session: ended`. Eviction is gated on exactly that.
  session.getStatus.mockReturnValue({
    active: false,
    sessionId: 'session-41',
    pid: null,
    turnInFlight: false,
  });
  return session;
}

/**
 * Install a session entry that has no valid dispatch owner — the state the
 * runtime must treat as stale. `ownedByOtherManager` picks between the two
 * shapes `rebindRuntimeTurnForDispatch` rejects: no ownership record at all,
 * and a record held by a manager that is not the mapped session's.
 */
function installUnownedSession(
  state: OwnershipState,
  deliveryJid: string,
  ownedByOtherManager: boolean,
): ReturnType<typeof sessionStub> {
  const session = exitedSessionStub();
  if (ownedByOtherManager) {
    const strandedOwner = state.managerIdFor(sessionStub());
    state.sessionOwnership.claim(MAP_KEY, strandedOwner);
  }
  state.chatSessions.set(MAP_KEY, session);
  state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
  return session;
}

/** Mimic what a real spawn does: claim ownership, then map session and queue. */
function stubSpawnAndClaim(state: OwnershipState, deliveryJid: string) {
  const spawned = sessionStub();
  vi.spyOn(state, 'ensureSessionAndQueueSync').mockImplementation((_chatJid, mapKey) => {
    const key = mapKey ?? MAP_KEY;
    state.sessionOwnership.claim(key, state.managerIdFor(spawned));
    state.chatSessions.set(key, spawned);
    state.chatQueues.set(key, queueStub(deliveryJid));
  });
  return spawned;
}

afterEach(() => {
  vi.restoreAllMocks();
  runtimeLogger.warn.mockClear();
});

describe('per-chat session entry whose dispatch ownership was lost', () => {
  it.each([
    ['no ownership record', false],
    ['an ownership record held by another manager', true],
  ])('recovers on the next turn when the entry has %s', async (_label, ownedByOtherManager) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const first = context('per_chat', MAP_KEY, 501, 'turn-lost-ownership-1');
      const deliveryJid = first.identity.deliveryJid;
      const stale = installUnownedSession(state, deliveryJid, ownedByOtherManager);
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      await dispatchTurn(state, first);

      // The stale entry is gone, the spawned session owns the chat, and the
      // turn reached the provider rather than being rejected at admission.
      expect(state.chatSessions.get(MAP_KEY)).toBe(spawned);
      expect(state.chatSessions.get(MAP_KEY)).not.toBe(stale);
      expect(vi.mocked(spawned.sendTurn)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(stale.sendTurn)).not.toHaveBeenCalled();
      expect(state.sessionOwnership.get(MAP_KEY)?.managerId)
        .toBe(state.managerIdFor(spawned));

      // Recovery is durable: the chat is not merely un-wedged for one turn.
      await dispatchTurn(state, context('per_chat', MAP_KEY, 502, 'turn-lost-ownership-2'));
      expect(vi.mocked(spawned.sendTurn)).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it('leaves a correctly owned session untouched', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 503, 'turn-owned-normal');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      const session = sessionStub();
      state.sessionOwnership.claim(MAP_KEY, state.managerIdFor(session));
      state.chatSessions.set(MAP_KEY, session);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await dispatchTurn(state, runtimeContext);

      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(session);
      expect(vi.mocked(session.sendTurn)).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('retires the stale outbound queue and operation tracker it detaches', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 506, 'turn-companion-cleanup');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      installUnownedSession(state, deliveryJid, false);
      const staleQueue = state.chatQueues.get(MAP_KEY)!;
      const staleTracker = { shutdown: vi.fn() };
      state.operationTrackers.set(MAP_KEY, staleTracker);
      stubSpawnAndClaim(state, deliveryJid);

      await dispatchTurn(state, runtimeContext);

      // The replacement overwrites both maps, so the old pair must be retired
      // rather than orphaned — an abandoned tracker keeps its timers armed.
      expect(staleTracker.shutdown).toHaveBeenCalledTimes(1);
      expect(state.operationTrackers.get(MAP_KEY)).not.toBe(staleTracker);
      expect(vi.mocked(staleQueue.abortTurn)).toHaveBeenCalled();
      expect(state.chatQueues.get(MAP_KEY)).not.toBe(staleQueue);
    } finally {
      db.close();
    }
  });

  it('does not evict while the provider child is still alive', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 507, 'turn-live-child');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      // Unowned, but its child never exited. Detaching here would let the
      // spawn below run a second child for one conversation.
      const live = sessionStub();
      state.chatSessions.set(MAP_KEY, live);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow(
        'no current dispatch owner',
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(live);
      // Still wedged, but no longer silent.
      expect(state.perChatSessionsWithoutOwner()).toEqual([MAP_KEY]);
    } finally {
      db.close();
    }
  });

  it('does not evict while a published context owns the per-chat FIFO', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const inFlight = context('per_chat', MAP_KEY, 504, 'turn-fifo-in-flight');
      const deliveryJid = inFlight.identity.deliveryJid;
      const stale = installUnownedSession(state, deliveryJid, false);
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');
      // A concurrent turn in the same chat already owns the FIFO.
      state.perChatRuntimeTurnContexts.set(MAP_KEY, [inFlight]);

      const next = context('per_chat', MAP_KEY, 505, 'turn-fifo-follower');
      await expect(dispatchTurn(state, next)).rejects.toThrow();

      // Fail closed: the in-flight turn keeps its session entry and the
      // follower is rejected, exactly as the FIFO invariant requires.
      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(stale);
      expect(state.perChatRuntimeTurnContexts.get(MAP_KEY)).toEqual([inFlight]);
    } finally {
      db.close();
    }
  });
});

describe('per-chat ownership teardown atomicity', () => {
  it('removes the session entry even if releasing ownership throws', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const session = sessionStub();
      state.sessionOwnership.claim(MAP_KEY, state.managerIdFor(session));
      state.chatSessions.set(MAP_KEY, session);
      vi.spyOn(state.sessionOwnership, 'release').mockImplementation(() => {
        throw new Error('ownership release failed');
      });

      expect(() => state.deleteOwnedPerChatSession(MAP_KEY, session)).toThrow(
        'ownership release failed',
      );
      // A retained entry with no owner is the wedge this whole suite is about.
      expect(state.chatSessions.has(MAP_KEY)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('clears both the session entry and the ownership record on the normal path', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const session = sessionStub();
      state.sessionOwnership.claim(MAP_KEY, state.managerIdFor(session));
      state.chatSessions.set(MAP_KEY, session);

      expect(state.deleteOwnedPerChatSession(MAP_KEY, session)).toBe(true);
      expect(state.chatSessions.has(MAP_KEY)).toBe(false);
      expect(state.sessionOwnership.get(MAP_KEY)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('does not touch a session entry owned by a different manager than expected', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const mapped = sessionStub();
      state.sessionOwnership.claim(MAP_KEY, state.managerIdFor(mapped));
      state.chatSessions.set(MAP_KEY, mapped);

      expect(state.deleteOwnedPerChatSession(MAP_KEY, sessionStub())).toBe(false);
      expect(state.chatSessions.get(MAP_KEY)).toBe(mapped);
      expect(state.sessionOwnership.get(MAP_KEY)).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe('unowned per-chat session sweep', () => {
  it('counts and warns for a chat holding a session entry with no current owner', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const owned = sessionStub();
      state.sessionOwnership.claim('15550100200', state.managerIdFor(owned));
      state.chatSessions.set('15550100200', owned);
      state.chatSessions.set(MAP_KEY, sessionStub());

      expect(state.sweepPerChatSessionsWithoutOwner()).toBe(1);
      const warned = runtimeLogger.warn.mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('no current dispatch owner'),
      );
      expect(warned).toBeDefined();
      expect((warned?.[0] as { mapKey: string }).mapKey).toBe(MAP_KEY);
    } finally {
      db.close();
    }
  });

  it('ignores the heal control session, which is mapped without an ownership record', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const control = sessionStub();
      state.controlSession = control;
      state.chatSessions.set('control@heal.internal', control);

      expect(state.sweepPerChatSessionsWithoutOwner()).toBe(0);
    } finally {
      db.close();
    }
  });

  it('reports the unowned count on the periodic health line', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      state.chatSessions.set(MAP_KEY, sessionStub());
      expect(() => state.logHealthStats()).not.toThrow();
      expect(state.perChatSessionsWithoutOwner()).toEqual([MAP_KEY]);
    } finally {
      db.close();
    }
  });

  it('degrades the polled health surface, and reads it without logging', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      state.chatSessions.set(MAP_KEY, sessionStub());

      const health = state.getHealthSnapshot();
      expect(health.status).toBe('degraded');
      expect(health.details.degradedReasons)
        .toContain('per_chat_session_without_owner');
      expect(health.details.perChatSessionsWithoutOwner).toBe(1);
      // The snapshot is polled, so reading it must not warn per poll.
      const warned = runtimeLogger.warn.mock.calls.filter(
        (call) => typeof call[1] === 'string' && call[1].includes('no current dispatch owner'),
      );
      expect(warned).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('reports a healthy per-chat runtime when every session is owned', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const session = sessionStub();
      state.sessionOwnership.claim(MAP_KEY, state.managerIdFor(session));
      state.chatSessions.set(MAP_KEY, session);

      const health = state.getHealthSnapshot();
      expect(health.details.degradedReasons)
        .not.toContain('per_chat_session_without_owner');
      expect(health.details.perChatSessionsWithoutOwner).toBe(0);
    } finally {
      db.close();
    }
  });
});
