/**
 * A per-chat turn whose dispatch creates the chat's session and outbound queue
 * must still store its answer under the turn's own inbound sequence.
 *
 * The turn-queue processor writes that sequence to the queue the chat holds
 * BEFORE the dispatch. When the dispatch then installs a new queue — the mapped
 * session had lost its dispatch owner, or nothing was mapped at all — nothing
 * writes the sequence again. The answer is stored with no source inbound, the
 * delivery proof at finalization rejects the stored op as not belonging to the
 * turn, the finalization is retained, and the turn never settles.
 *
 * Harness: a real AgentRuntime, a real DurabilityEngine on real SQLite, and the
 * real OutboundQueue the runtime builds. Two things are doubled. The provider:
 * `createSessionManager` returns a stub, so `ensureSessionAndQueueSync` itself
 * runs and installs the production queue. The transport: its echo is delivered
 * as soon as the engine records the submission. The stub reports itself active,
 * so the spawn-and-adopt branch of `sendTurnToSession` is not exercised here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { OutboundQueue, type IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import {
  type RuntimeState,
  context,
  perChatToolScopeKey,
  queueStub,
  registerSessionToolScope,
  replyGuaranteeMock,
  sessionStub,
} from './lib/runtime-terminal-coordinator-harness.ts';

// A finalization failure reports through this sink; `durably_queued` is what
// makes the finalizer return a retry-owned incident rather than a sink failure.
const emitAlert = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({
  ok: true,
  channel: 'outbox',
  status: 'durably_queued',
})));

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert,
  emitAlertChecked: emitAlert,
}));

const CONVERSATION_KEY = '15550100188';
const DELIVERY_JID = `${CONVERSATION_KEY}@s.whatsapp.net`;
// A per-chat lane is keyed by the chat's canonical JID (`resolvePerChatMapKey`),
// not by its conversation key. Lookups that carry no key, such as a notice sent
// by chat JID, reach the lane only under that key.
const MAP_KEY = DELIVERY_JID;
const ANSWER_TEXT = 'The pump runs every six hours.';
const LIVE_TEXT = 'Your order ships on Friday.';
const FINALIZATION_ALERT = 'agent_turn_finalization_failed';

type ProviderSession = ReturnType<typeof sessionStub> & {
  bindGenerationOwnership: ReturnType<typeof vi.fn>;
};

/** Private runtime surface this suite drives directly. */
type BoundaryState = Omit<RuntimeState, 'durability'> & {
  durability: DurabilityEngine | null;
  createSessionManager(opts: {
    onEvent: (event: AgentEvent) => void;
    eventToolScopeKey?: string;
  }): ProviderSession;
  resolvePerChatMapKey(chatJid: string): string;
  operationTrackers: Map<string, { shutdown(): void }>;
  runtimeTurnSupervisor: {
    health(): { retainedRetries: number; degradedScopes: number };
    close(): void;
  };
};

function makeTransport() {
  let sent = 0;
  const sendMessage = vi.fn(async (_chatJid: string, _text: string) => ({
    waMessageId: `wa-dispatch-boundary-${++sent}`,
  }));
  const transport: Messenger = {
    sendMessage,
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => undefined),
  };
  return { transport, sendMessage };
}

function makeRuntime(db: Database, transport: Messenger): BoundaryState {
  const runtime = new AgentRuntime(db, transport, 'dispatch-boundary', { sessionScope: 'per_chat' });
  const state = runtime as unknown as BoundaryState;
  state.replyGuarantee = replyGuaranteeMock();
  return state;
}

/** Deliver the transport echo as soon as the engine records a submission. */
function echoOnSubmit(durability: DurabilityEngine): void {
  const markSubmitted = durability.markSubmitted.bind(durability);
  vi.spyOn(durability, 'markSubmitted').mockImplementation((id, waMessageId, logicalAttemptCount) => {
    markSubmitted(id, waMessageId, logicalAttemptCount);
    if (waMessageId !== null) durability.matchEcho(waMessageId);
  });
}

/** Journal one inbound and build the queued turn the processor would be handed. */
function journaledTurn(
  durability: DurabilityEngine,
  logicalTurnId: string,
): { inboundSeq: number; turn: QueuedTurn } {
  const inboundSeq = durability.journalInbound(`wamid-${logicalTurnId}`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
  const runtimeContext: RuntimeTurnContext = context('per_chat', CONVERSATION_KEY, inboundSeq, logicalTurnId);
  return {
    inboundSeq,
    turn: {
      sourceMessageId: runtimeContext.replay.sourceMessageId,
      receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      senderJid: runtimeContext.replay.senderJid,
      senderName: runtimeContext.replay.senderName,
      text: runtimeContext.replay.text,
      isGroup: false,
      contentType: 'text',
      runtimeContext,
      inboundSeq,
    },
  };
}

/**
 * Map a terminated session with no dispatch owner, and that entry's queue.
 * The dispatch evicts the entry and spawns a replacement. Returns the queue
 * the replacement's queue takes the place of.
 */
function installUnownedEntry(state: BoundaryState): IOutboundQueue {
  const stale = sessionStub();
  stale.getStatus.mockReturnValue({
    active: false,
    sessionId: 'session-41',
    pid: null,
    turnInFlight: false,
    providerTerminated: true,
  });
  const staleQueue = queueStub(DELIVERY_JID);
  state.chatSessions.set(MAP_KEY, stale);
  state.chatQueues.set(MAP_KEY, staleQueue);
  // The scope the queued context already holds, as the harness mints it.
  registerSessionToolScope(state, stale, perChatToolScopeKey(CONVERSATION_KEY));
  return staleQueue;
}

/**
 * Double the provider only. The real `createSessionManager` records the
 * session's event tool scope and hands the session its event callback; the
 * stub keeps both, so provider events travel the production route.
 */
function stubProvider(state: BoundaryState) {
  const session: ProviderSession = { ...sessionStub(), bindGenerationOwnership: vi.fn() };
  const provider = {
    session,
    emit: (_event: AgentEvent): void => {
      throw new Error('provider stub emitted before the runtime created its session');
    },
  };
  vi.spyOn(state, 'createSessionManager').mockImplementation((opts) => {
    if (opts.eventToolScopeKey === undefined) {
      throw new Error('per-chat session was created without an event tool scope');
    }
    registerSessionToolScope(state, session, opts.eventToolScopeKey);
    provider.emit = opts.onEvent;
    return session;
  });
  return provider;
}

function storedOps(db: Database): Array<{ text: string; sourceInboundSeq: number | null; status: string }> {
  const rows = db.raw
    .prepare('SELECT payload, source_inbound_seq, status FROM outbound_ops ORDER BY id')
    .all() as Array<{ payload: string; source_inbound_seq: number | null; status: string }>;
  return rows.map((row) => ({
    text: (JSON.parse(row.payload) as { text: string }).text,
    sourceInboundSeq: row.source_inbound_seq,
    status: row.status,
  }));
}

async function teardown(state: BoundaryState, db: Database): Promise<void> {
  // A retained finalization holds a retry timer, the session's operation tracker
  // holds stall timers, and a real queue holds typing and pacing timers. Release
  // all three before the database goes away.
  state.runtimeTurnSupervisor.close();
  for (const tracker of state.operationTrackers.values()) tracker.shutdown();
  for (const queue of state.chatQueues.values()) {
    if (!(queue instanceof OutboundQueue)) continue;
    queue.abortTurn();
    await queue.shutdown().catch(() => undefined);
  }
  db.close();
}

afterEach(() => {
  vi.restoreAllMocks();
  emitAlert.mockClear();
});

describe('per-chat dispatch that creates the session and queue', () => {
  it.each([
    ['a terminated session entry with no dispatch owner is mapped', 'unowned'],
    ['no session and no queue are mapped', 'released'],
  ] as const)('finalizes the answered turn as replied when %s', async (_label, startingState) => {
    const db = new Database(':memory:');
    db.open();
    const { transport } = makeTransport();
    const state = makeRuntime(db, transport);
    try {
      const durability = new DurabilityEngine(db);
      echoOnSubmit(durability);
      state.durability = durability;
      const { inboundSeq, turn } = journaledTurn(durability, `turn-spawn-path-${startingState}`);
      // The lane key is the one production derives for this chat.
      expect(state.resolvePerChatMapKey(DELIVERY_JID)).toBe(MAP_KEY);
      const staleQueue = startingState === 'unowned' ? installUnownedEntry(state) : null;
      const provider = stubProvider(state);
      // The provider answers from inside the send, which is when a real one
      // does: the turn's context is in the FIFO and not yet retired.
      vi.mocked(provider.session.sendTurn).mockImplementation(async () => {
        provider.emit({ type: 'result', text: ANSWER_TEXT });
      });

      let dispatchSettled = false;
      let dispatchError: unknown;
      void state.processPerChatTurn({ value: MAP_KEY }, turn).then(
        () => { dispatchSettled = true; },
        (error: unknown) => { dispatchSettled = true; dispatchError = error; },
      );
      await vi.waitFor(() => {
        expect(dispatchError).toBeUndefined();
        expect(provider.session.sendTurn).toHaveBeenCalledTimes(1);
      });
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      // Fixture: the dispatch took the spawn path and installed a real queue.
      const liveQueue = state.chatQueues.get(MAP_KEY);
      expect(liveQueue).toBeInstanceOf(OutboundQueue);
      expect(state.chatSessions.get(MAP_KEY)).toBe(provider.session);
      if (staleQueue !== null) {
        // The processor's write landed on the queue the dispatch then replaced.
        expect(liveQueue).not.toBe(staleQueue);
        expect(vi.mocked(staleQueue.setInboundSeq)).toHaveBeenCalledWith(inboundSeq);
      }

      // The stored answer belongs to the turn that produced it.
      expect(storedOps(db).map((op) => op.sourceInboundSeq)).toEqual([inboundSeq]);
      expect(storedOps(db)).toEqual([
        { text: ANSWER_TEXT, sourceInboundSeq: inboundSeq, status: 'echoed' },
      ]);

      // So the delivery proof accepts it and the turn ends as replied.
      expect(db.raw.prepare(
        'SELECT inbound_disposition, delivery_kind FROM turn_terminal_records WHERE inbound_seq = ?',
      ).all(inboundSeq)).toEqual([
        { inbound_disposition: 'finalized_replied', delivery_kind: 'echoed' },
      ]);
      expect(db.raw.prepare(
        'SELECT processing_status, terminal_reason FROM inbound_events WHERE seq = ?',
      ).get(inboundSeq)).toEqual({
        processing_status: 'complete',
        terminal_reason: 'response_echoed',
      });

      // Nothing is left with the supervisor, and the chat's lane is free.
      expect(emitAlert.mock.calls.filter((call) => call.includes(FINALIZATION_ALERT))).toEqual([]);
      expect(state.runtimeTurnSupervisor.health()).toMatchObject({
        retainedRetries: 0,
        degradedScopes: 0,
      });
      expect(state.perChatRuntimeTurnContexts.get(MAP_KEY) ?? []).toEqual([]);
      await vi.waitFor(() => expect(dispatchSettled).toBe(true));
      expect(dispatchError).toBeUndefined();
    } finally {
      await teardown(state, db);
    }
  });

  /**
   * The provider streams live text, then its stdin write times out. The runtime
   * answers the timeout with a notice on the same queue. Returns what was stored.
   */
  async function liveTextThenStdinTimeout(logicalTurnId: string): Promise<{
    inboundSeq: number;
    ops: ReturnType<typeof storedOps>;
  }> {
    const db = new Database(':memory:');
    db.open();
    const { transport, sendMessage } = makeTransport();
    const state = makeRuntime(db, transport);
    try {
      const durability = new DurabilityEngine(db);
      state.durability = durability;
      const { inboundSeq, turn } = journaledTurn(durability, logicalTurnId);
      // The notice is routed by chat JID alone; it must reach this same lane.
      expect(state.resolvePerChatMapKey(DELIVERY_JID)).toBe(MAP_KEY);
      installUnownedEntry(state);
      const provider = stubProvider(state);
      vi.mocked(provider.session.sendTurn).mockImplementation(async () => {
        provider.emit({ type: 'assistant_text', text: LIVE_TEXT });
        throw new Error('STDIN_WRITE_TIMEOUT');
      });

      await expect(state.processPerChatTurn({ value: MAP_KEY }, turn))
        .rejects.toThrow('STDIN_WRITE_TIMEOUT');
      // Two sends, separated by the queue's minimum send gap.
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2), { timeout: 4_000 });
      expect(state.chatQueues.get(MAP_KEY)).toBeInstanceOf(OutboundQueue);
      return { inboundSeq, ops: storedOps(db) };
    } finally {
      await teardown(state, db);
    }
  }

  it('sends live text before the stdin-timeout notice that follows it', async () => {
    const { ops } = await liveTextThenStdinTimeout('turn-spawn-path-stdin-timeout-order');

    expect(ops).toHaveLength(2);
    expect(ops[0]?.text).toBe(LIVE_TEXT);
    expect(ops[1]?.text).toContain('Agent is not responding');
  });

  it('stores live text sent before a stdin timeout under its own turn', async () => {
    const { inboundSeq, ops } = await liveTextThenStdinTimeout('turn-spawn-path-stdin-timeout-attribution');

    expect(ops[0]?.sourceInboundSeq).toBe(inboundSeq);
    expect(ops[0]).toMatchObject({ text: LIVE_TEXT, sourceInboundSeq: inboundSeq });
  });
});
