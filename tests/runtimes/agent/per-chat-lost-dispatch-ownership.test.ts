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
  info: ReturnType<typeof vi.fn>;
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
  perChatExecActorQueue: Map<string, Array<{
    actorJid: string | undefined;
    purpose?: 'scheduled-agent-job';
    conversationKey?: string;
  }>>;
  systemTurnExecActors: Map<string, { scopeKey: string; actorJid: string | undefined }>;
  resolveExecutingActorByMapKey(mapKey: string): string | undefined;
  resolvePerChatMapKey(chatJid: string): string;
  createOutboundQueue(chatJid: string, reason: string): { getSenderToken(): string | undefined };
  isSessionProvablyTerminated(session: ReturnType<typeof sessionStub>): boolean;
  abortTurnRecoveryReplay(
    target: {
      scope: 'per_chat';
      mapKey: string;
      managerId: string;
      generation: number;
      session: ReturnType<typeof sessionStub>;
    },
    runtimeContext: RuntimeTurnContext,
  ): Promise<boolean>;
  sweepPerChatSessionsWithoutOwner(): number;
  logHealthStats(): void;
  operationTrackers: Map<string, { shutdown: ReturnType<typeof vi.fn> }>;
  ownedSessionManagers: Map<string, ReturnType<typeof sessionStub>>;
  sessionManagerIds: WeakMap<object, string>;
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
    providerTerminated: true,
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
    // The registry names a DIFFERENT manager. Register it, provably terminated:
    // an ownership record whose manager the index cannot produce is now refused
    // as unproven, so the mismatch shape has to carry a manager whose
    // termination IS proven for recovery to be the correct outcome.
    const strandedOwner = exitedSessionStub();
    const strandedOwnerId = state.managerIdFor(strandedOwner);
    state.ownedSessionManagers.set(strandedOwnerId, strandedOwner);
    state.sessionOwnership.claim(MAP_KEY, strandedOwnerId);
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
  runtimeLogger.info.mockClear();
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

  it('does not release a registered live owner named by the registry', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 509, 'turn-registered-live-owner');
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // The shape the predicate calls "unowned" but that is NOT ours to
      // release: the registry names manager B, whose session is live and
      // registered, while the session map holds a dead session A. Releasing
      // here would orphan B and spawn C — two live children for one chat.
      const liveOwner = sessionStub();
      const liveOwnerId = state.managerIdFor(liveOwner);
      state.ownedSessionManagers.set(liveOwnerId, liveOwner);
      state.sessionOwnership.claim(MAP_KEY, liveOwnerId);
      const deadMapped = exitedSessionStub();
      state.chatSessions.set(MAP_KEY, deadMapped);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      // No release, no spawn, and the live owner is untouched and still owned.
      expect(spawn).not.toHaveBeenCalled();
      expect(vi.mocked(liveOwner.shutdown)).not.toHaveBeenCalled();
      expect(liveOwner.getStatus().active).toBe(true);
      expect(state.ownedSessionManagers.get(liveOwnerId)).toBe(liveOwner);
      expect(state.sessionOwnership.get(MAP_KEY)?.managerId).toBe(liveOwnerId);
      expect(state.chatSessions.get(MAP_KEY)).toBe(deadMapped);
      // Wedged, exactly as it was before this repair existed, but reported.
      expect(state.perChatSessionsWithoutOwner()).toEqual([MAP_KEY]);
    } finally {
      db.close();
    }
  });

  /**
   * The registered-owner proof is a CONJUNCTION — cleared `active`, a released
   * provider handle, and no in-flight turn. The control above holds a default
   * live stub, which fails all three conjuncts at once, so it cannot tell which
   * one is load-bearing: weakening the proof to any single field leaves it
   * green. These controls each fail EXACTLY ONE conjunct, so the guard has to
   * read that conjunct to keep them green.
   */
  it.each([
    {
      label: 'still holds its managed provider handle',
      seq: 513,
      turnId: 'turn-registered-owner-handle-held',
      // Managed-loop shutdown in progress: cleared flag, null pid, handle live.
      status: {
        active: false,
        sessionId: 'session-42',
        pid: null,
        turnInFlight: false,
        providerTerminated: false,
      },
    },
    {
      label: 'still has a turn in flight',
      seq: 514,
      turnId: 'turn-registered-owner-turn-in-flight',
      // Handles released, but provider work is still running for this turn.
      status: {
        active: false,
        sessionId: 'session-42',
        pid: null,
        turnInFlight: true,
        providerTerminated: true,
      },
    },
    {
      label: 'is still active',
      seq: 515,
      turnId: 'turn-registered-owner-still-active',
      // Terminated handles and no in-flight turn, but the session is live.
      status: {
        active: true,
        sessionId: 'session-42',
        pid: null,
        turnInFlight: false,
        providerTerminated: true,
      },
    },
  ])('does not release a registered owner that $label', async ({ seq, turnId, status }) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, seq, turnId);
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // Same mismatch shape as the control above — the registry names manager
      // B while the session map holds a dead session A — but B fails the
      // termination proof on one conjunct only.
      const owner = sessionStub();
      owner.getStatus.mockReturnValue(status);
      const ownerId = state.managerIdFor(owner);
      state.ownedSessionManagers.set(ownerId, owner);
      state.sessionOwnership.claim(MAP_KEY, ownerId);
      const deadMapped = exitedSessionStub();
      state.chatSessions.set(MAP_KEY, deadMapped);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      // No release and no spawn: the wedge is reported, not repaired, because
      // repairing it here would leave two live providers on one conversation.
      expect(vi.mocked(state.ensureSessionAndQueueSync)).not.toHaveBeenCalled();
      expect(vi.mocked(spawned.sendTurn)).not.toHaveBeenCalled();
      expect(vi.mocked(owner.shutdown)).not.toHaveBeenCalled();
      expect(state.ownedSessionManagers.get(ownerId)).toBe(owner);
      expect(state.sessionOwnership.get(MAP_KEY)?.managerId).toBe(ownerId);
      expect(state.chatSessions.get(MAP_KEY)).toBe(deadMapped);
      expect(state.perChatSessionsWithoutOwner()).toEqual([MAP_KEY]);
    } finally {
      db.close();
    }
  });

  it('does not release an ownership record whose manager the index cannot produce', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 532, 'turn-unindexed-registry-owner');
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // The registry names manager B, but the manager index has no entry for
      // it. Nothing here proves B stopped; releasing on that absence would
      // orphan B and spawn a replacement beside it.
      const unindexedOwnerId = state.managerIdFor(sessionStub());
      state.sessionOwnership.claim(MAP_KEY, unindexedOwnerId);
      const deadMapped = exitedSessionStub();
      state.chatSessions.set(MAP_KEY, deadMapped);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      expect(vi.mocked(state.ensureSessionAndQueueSync)).not.toHaveBeenCalled();
      expect(vi.mocked(spawned.sendTurn)).not.toHaveBeenCalled();
      expect(state.sessionOwnership.get(MAP_KEY)?.managerId).toBe(unindexedOwnerId);
      expect(state.chatSessions.get(MAP_KEY)).toBe(deadMapped);
      expect(state.perChatSessionsWithoutOwner()).toEqual([MAP_KEY]);
    } finally {
      db.close();
    }
  });

  it('evicts when the registry names a manager that is itself gone', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 510, 'turn-dead-registered-owner');
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // Same mismatch shape, but the registered owner is provably terminated,
      // so releasing it cannot strand a running child. Recovery must still run
      // — the guard above must not turn every mismatch into a permanent wedge.
      const deadOwner = exitedSessionStub();
      const deadOwnerId = state.managerIdFor(deadOwner);
      state.ownedSessionManagers.set(deadOwnerId, deadOwner);
      state.sessionOwnership.claim(MAP_KEY, deadOwnerId);
      state.chatSessions.set(MAP_KEY, exitedSessionStub());
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      await dispatchTurn(state, runtimeContext);

      expect(state.chatSessions.get(MAP_KEY)).toBe(spawned);
      expect(vi.mocked(spawned.sendTurn)).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('does not evict a managed-provider session mid-shutdown', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 511, 'turn-managed-mid-shutdown');
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // A managed-loop provider never assigns a child, so it reports a null pid
      // for its whole life. `shutdown()` clears `active` before awaiting the
      // managed shutdown, which can time out and force-kill. Cleared flag plus
      // null pid therefore proves nothing here; only the handle release does.
      const managedMidShutdown = sessionStub();
      managedMidShutdown.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-41',
        pid: null,
        turnInFlight: false,
        providerTerminated: false,
      });
      state.chatSessions.set(MAP_KEY, managedMidShutdown);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(managedMidShutdown);
    } finally {
      db.close();
    }
  });

  it('does not evict a terminated session whose turn is still in flight', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 512, 'turn-still-in-flight');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      const busy = sessionStub();
      busy.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-41',
        pid: null,
        turnInFlight: true,
        providerTerminated: true,
      });
      state.chatSessions.set(MAP_KEY, busy);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(busy);
    } finally {
      db.close();
    }
  });

  it('does not evict a session holding an inconclusive durable failure', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 531, 'turn-durable-failure-inconclusive');
      const deliveryJid = runtimeContext.identity.deliveryJid;

      // Handles released and no turn running, but the durable-failure
      // compensation was never confirmed. `assertDurableFailureReconciled`
      // refuses to respawn a manager in that state, so discarding it drops the
      // latch and lets the replacement spawn as if nothing had happened.
      const inconclusive = sessionStub();
      inconclusive.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-42',
        pid: null,
        turnInFlight: false,
        providerTerminated: true,
        durableFailureInconclusive: true,
      });
      state.chatSessions.set(MAP_KEY, inconclusive);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(inconclusive);
    } finally {
      db.close();
    }
  });

  it('completes the eviction when the operation tracker shutdown throws', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 533, 'turn-tracker-shutdown-throws');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      installUnownedSession(state, deliveryJid, false);
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      // Retiring the predecessor's tracker is housekeeping, not the repair. A
      // synchronous throw here must not leave the eviction half-applied, with
      // the session still mapped and the chat still wedged.
      const failing = { shutdown: vi.fn(() => { throw new Error('tracker shutdown failed'); }) };
      state.operationTrackers.set(MAP_KEY, failing);

      await dispatchTurn(state, runtimeContext);

      expect(failing.shutdown).toHaveBeenCalledTimes(1);
      expect(state.operationTrackers.has(MAP_KEY)).toBe(false);
      expect(state.chatSessions.get(MAP_KEY)).toBe(spawned);
      expect(vi.mocked(spawned.sendTurn)).toHaveBeenCalledTimes(1);
      expect(runtimeLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ mapKey: MAP_KEY }),
        expect.stringContaining('operation tracker'),
      );
    } finally {
      db.close();
    }
  });

  it('leaves the outbound queue mapped so the replacement inherits its echo-guard token', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 513, 'turn-echo-guard-token');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      installUnownedSession(state, deliveryJid, false);
      const staleQueue = state.chatQueues.get(MAP_KEY)!;

      // `createOutboundQueue` reads the predecessor's token through
      // `priorSenderTokenForChat`, which looks up this very key. Deleting the
      // entry during eviction would drop the token and let the replacement's
      // first group reply fall inside the predecessor's cooldown.
      let tokenVisibleToReplacement: string | undefined;
      const spawned = sessionStub();
      vi.spyOn(state, 'ensureSessionAndQueueSync').mockImplementation((_chatJid, mapKey) => {
        const key = mapKey ?? MAP_KEY;
        tokenVisibleToReplacement = state.chatQueues.get(key)?.getSenderToken();
        state.sessionOwnership.claim(key, state.managerIdFor(spawned));
        state.chatSessions.set(key, spawned);
        state.chatQueues.set(key, queueStub(deliveryJid));
      });
      vi.mocked(staleQueue.getSenderToken).mockReturnValue('sender-token-1');

      await dispatchTurn(state, runtimeContext);

      expect(vi.mocked(staleQueue.abortTurn)).toHaveBeenCalled();
      expect(tokenVisibleToReplacement).toBe('sender-token-1');
    } finally {
      db.close();
    }
  });

  it('does not evict a cleared session that still holds a pid', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 508, 'turn-cleared-but-live');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      // `active === false` does not prove the child is gone. SessionManager
      // clears the flag before it kills the child, and the failed-start reset
      // clears it while deliberately retaining a child whose kill failed. Both
      // leave a live pid, and detaching there would start a second child.
      const clearedButLive = sessionStub();
      clearedButLive.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-41',
        pid: 4100,
        turnInFlight: false,
        providerTerminated: false,
      });
      state.chatSessions.set(MAP_KEY, clearedButLive);
      state.chatQueues.set(MAP_KEY, queueStub(deliveryJid));
      const spawn = vi.spyOn(state, 'ensureSessionAndQueueSync');

      await expect(dispatchTurn(state, runtimeContext)).rejects.toThrow();

      expect(spawn).not.toHaveBeenCalled();
      expect(state.chatSessions.get(MAP_KEY)).toBe(clearedButLive);
      // Wedged but not silent.
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

  it('leaves no orphaned ownership state when releasing ownership throws', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const session = sessionStub();
      const managerId = state.managerIdFor(session);
      state.sessionOwnership.claim(MAP_KEY, managerId);
      state.ownedSessionManagers.set(managerId, session);
      state.chatSessions.set(MAP_KEY, session);
      vi.spyOn(state.sessionOwnership, 'release').mockImplementation(() => {
        throw new Error('ownership release failed');
      });

      expect(() => state.deleteOwnedPerChatSession(MAP_KEY, session)).toThrow(
        'ownership release failed',
      );

      // Retirement is all-or-nothing across the correlated stores. The unowned
      // sweep iterates chatSessions, so a record left in `closing` with its
      // manager still indexed would be an orphan NO detector can see: the map
      // entry it would be found through is already gone.
      expect(state.chatSessions.has(MAP_KEY)).toBe(false);
      expect(state.sessionOwnership.get(MAP_KEY)).toBeUndefined();
      expect(state.ownedSessionManagers.get(managerId)).toBeUndefined();
      expect(state.perChatSessionsWithoutOwner()).toEqual([]);
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

  it('reports the unowned count in the periodic health payload', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      state.chatSessions.set(MAP_KEY, sessionStub());
      runtimeLogger.info.mockClear();

      state.logHealthStats();

      // Assert the PAYLOAD, not merely that the call did not throw: the
      // earlier version of this test stayed green with the field deleted.
      const healthLine = runtimeLogger.info.mock.calls.find(
        (call) => call[1] === 'agent runtime health stats',
      );
      expect(healthLine, 'no health stats line was logged').toBeDefined();
      const payload = healthLine?.[0] as { perChatSessionsWithoutOwner?: number };
      expect(payload).toHaveProperty('perChatSessionsWithoutOwner');
      expect(payload.perChatSessionsWithoutOwner).toBe(1);
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

/**
 * The eviction guard proves termination with `isSessionProvablyTerminated`
 * (provider-independent: cleared `active`, every provider handle released, no
 * turn in flight). The turn-recovery abort path answered the same question with
 * an older spelling — `!active && pid === null && !turnInFlight` — which a
 * managed-loop provider satisfies for its whole life, because it never assigns
 * a child and so reports a null pid even while its handle is live. Two
 * spellings of one contract disagree exactly where it matters.
 */
describe('turn-recovery abort uses the same termination proof as eviction', () => {
  it('does not report a managed session mid-shutdown as aborted', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 520, 'turn-recovery-managed-mid-shutdown');
      // Managed-loop shutdown in progress: flag cleared, no child was ever
      // spawned, handle still held.
      const managedMidShutdown = sessionStub();
      managedMidShutdown.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-42',
        pid: null,
        turnInFlight: false,
        providerTerminated: false,
      });
      // Not current: the chat holds no entry for this session, so the abort
      // takes its no-shutdown early return and answers from status alone.
      const target = {
        scope: 'per_chat' as const,
        mapKey: MAP_KEY,
        managerId: state.managerIdFor(managedMidShutdown),
        generation: 1,
        session: managedMidShutdown,
      };

      const aborted = await state.abortTurnRecoveryReplay(target, runtimeContext);

      // Identical input, one answer: the eviction proof says "not terminated",
      // so the abort path must not claim the replay is safely stopped.
      expect(state.isSessionProvablyTerminated(managedMidShutdown)).toBe(false);
      expect(aborted).toBe(false);
    } finally {
      db.close();
    }
  });

  it('reports a fully released session as aborted', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 521, 'turn-recovery-released');
      const released = exitedSessionStub();
      const target = {
        scope: 'per_chat' as const,
        mapKey: MAP_KEY,
        managerId: state.managerIdFor(released),
        generation: 1,
        session: released,
      };

      // Positive counterpart: the stricter proof must not turn every abort into
      // an unresolved one.
      expect(state.isSessionProvablyTerminated(released)).toBe(true);
      expect(await state.abortTurnRecoveryReplay(target, runtimeContext)).toBe(true);
    } finally {
      db.close();
    }
  });
});

/**
 * F-STICKY-ACTOR (QR-247) meets lost-ownership recovery.
 *
 * `cleanupPerChatCrashTurnState` clears the WHOLE executing-actor queue on a
 * crash, and its comment says why: a later user turn must not append behind a
 * stale (possibly administrator) head and be served that actor. Eviction
 * deliberately skips `cleanupPerChatState`, so it skipped that clear too, and
 * the guard that drops a stale queue when dispatching to a non-active mapped
 * session cannot cover it — eviction removes the mapped session first, and the
 * replacement is active.
 */
describe('lost-ownership eviction retires the executing-actor queue', () => {
  const ADMIN = '15550100301@s.whatsapp.net';

  it('does not serve a retired administrator actor to a later turn', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makePerChatRuntime(db);
      const runtimeContext = context('per_chat', MAP_KEY, 530, 'turn-retired-admin-actor');
      const deliveryJid = runtimeContext.identity.deliveryJid;
      installUnownedSession(state, deliveryJid, false);
      const spawned = stubSpawnAndClaim(state, deliveryJid);

      // The retired generation's in-flight administrator turn, still at the
      // FIFO head, plus the system-turn binding that names the same scope.
      state.perChatExecActorQueue.set(MAP_KEY, [{
        actorJid: ADMIN,
        purpose: undefined,
        conversationKey: MAP_KEY,
      }]);
      state.systemTurnExecActors.set('lease-retired-admin', {
        scopeKey: MAP_KEY,
        actorJid: ADMIN,
      });

      await dispatchTurn(state, runtimeContext);

      // Recovery still happened.
      expect(state.chatSessions.get(MAP_KEY)).toBe(spawned);
      // The escalation: a sensitive tool call in the replacement's turn must not
      // resolve to the administrator whose session was just retired.
      expect(state.resolveExecutingActorByMapKey(MAP_KEY)).not.toBe(ADMIN);
      expect(state.perChatExecActorQueue.get(MAP_KEY) ?? [])
        .not.toContainEqual(expect.objectContaining({ actorJid: ADMIN }));
      expect(state.systemTurnExecActors.get('lease-retired-admin')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

/**
 * `sandboxPerChat` is supported configuration: the validator requires per-chat
 * session scope for it and rejects it alongside the conversation-bound option.
 * In that mode every per-chat map is keyed by the WORKSPACE key, but the
 * echo-guard token lookup searched only the raw chat id, the canonical chat id
 * and the shared queue — so a replacement queue started with a fresh token and
 * its first group reply could fall inside the predecessor's cooldown.
 */
describe('sandbox per-chat replacement queues inherit the predecessor token', () => {
  it('finds the predecessor queue stored under the workspace key', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makeRuntimeState<OwnershipState>(db, {
        sessionScope: 'per_chat',
        sandboxPerChat: true,
      });
      const chatJid = `${MAP_KEY}@s.whatsapp.net`;
      const workspaceKey = state.resolvePerChatMapKey(chatJid);
      // The premise: the workspace key is not the chat id, so a lookup by chat
      // id does not reach the queue that is actually mapped for this chat.
      expect(workspaceKey).not.toBe(chatJid);

      const predecessor = queueStub(chatJid);
      vi.mocked(predecessor.getSenderToken).mockReturnValue('sender-token-sandbox');
      state.chatQueues.set(workspaceKey, predecessor);
      expect(state.chatQueues.get(chatJid)).toBeUndefined();

      const replacement = state.createOutboundQueue(chatJid, 'sandbox per-chat replacement');

      expect(replacement.getSenderToken()).toBe('sender-token-sandbox');
    } finally {
      db.close();
    }
  });
});
