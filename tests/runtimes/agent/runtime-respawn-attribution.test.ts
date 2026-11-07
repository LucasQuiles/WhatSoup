import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import { TurnRecoverySupervisor } from '../../../src/runtimes/agent/turn-recovery-supervisor.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { SendAmbiguousError } from '../../../src/transport/contract/errors.ts';
import { config } from '../../../src/config.ts';
import { makeRuntimeState, sessionStub, replyGuaranteeMock, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';
import type { SessionOwnershipRegistry } from '../../../src/runtimes/agent/session-ownership.ts';
import type { PendingSystemResultTracker } from '../../../src/runtimes/agent/pending-system-result-tracker.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
type CrashRuntimeState = Omit<RuntimeState, 'durability' | 'pendingSystemResults' | 'sessionOwnership'> & {
  durability: DurabilityEngine;
  pendingSystemResults: PendingSystemResultTracker;
  sessionOwnership: SessionOwnershipRegistry;
  operationTrackers: Map<string, OperationTracker>;
  createOperationTracker(session: ReturnType<typeof sessionStub>, queue: () => OutboundQueue): OperationTracker | null;
  emitCrashHealReport(): void;
  handleEventPerChat(session: ReturnType<typeof sessionStub>, event: AgentEvent, toolScopeKey: string): void;
};
vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const logger = singletonLoggerMock();
  return { default: { ...logger, child: () => logger }, createChildLogger: () => logger, flushLogger: () => Promise.resolve() };
});
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => ({ status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => ({ status: 'durably_queued' })),
  clearAlertSourceChecked: vi.fn(() => true),
}));
describe('runtime crash respawn with real queue evidence', () => {
  let dir: string;
  let db: Database;
  let queue: OutboundQueue;
  let state: CrashRuntimeState;
  const priorTrackerConfig = { ...config.operationTracker };
  const key = '15550190112';
  const jid = `${key}@s.whatsapp.net`;
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(config.operationTracker, { enabled: true, thinkingLongMs: 10, thinkingStallMs: 60000 });
    dir = mkdtempSync(join(tmpdir(), 'runtime-respawn-'));
    db = new Database(join(dir, 'store.db'));
    db.open();
  });
  afterEach(() => {
    queue?.abortTurn();
    state?.pendingSystemResults.clearScope(key);
    for (const tracker of state?.operationTrackers.values() ?? [])
      tracker.shutdown();
    const timers = vi.getTimerCount();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.assign(config.operationTracker, priorTrackerConfig);
    db?.close();
    rmSync(dir, { recursive: true, force: true });
    expect(timers, 'pending timers after explicit fixture cleanup').toBe(0);
  });
  it.each([
    { name: 'friendly-held-safe', mode: 'friendly', hold: true, safe: true, stale: false, dispatch: 0 },
    { name: 'friendly-held-unsafe', mode: 'friendly', hold: true, safe: false, stale: false, dispatch: 0 },
    { name: 'friendly-no-hold', mode: 'friendly', hold: false, safe: true, stale: false, dispatch: 0 },
    { name: 'friendly-stale-generation', mode: 'friendly', hold: true, safe: true, stale: true, dispatch: 0 },
    { name: 'minimal-explicit-status', mode: 'minimal', hold: true, safe: true, stale: false, dispatch: 0 },
    { name: 'friendly-prior-echo', mode: 'friendly', hold: true, safe: false, stale: false, dispatch: 0, priorAnswer: true },
    { name: 'friendly-consume-before-echo', mode: 'friendly', hold: true, safe: true, stale: false, dispatch: 0, consumeBeforeEcho: true },
    { name: 'friendly-held-result', mode: 'friendly', hold: true, safe: true, stale: false, dispatch: 0, resultOnly: true },
    { name: 'minimal-held-result', mode: 'minimal', hold: true, safe: true, stale: false, dispatch: 0, resultOnly: true },
  ])('$name', async (c) => {
    const durability = new DurabilityEngine(db);
    const source = `source-${c.name}`;
    const seq = durability.journalInbound(source, key, jid, 'agent');
    state = makeRuntimeState(db, { sessionScope: 'per_chat' }).runtime as unknown as CrashRuntimeState;
    state.durability = durability;
    state.replyGuarantee = replyGuaranteeMock();
    const session = sessionStub();
    let active = false;
    session.getStatus.mockImplementation(() => ({ active, providerTerminated: !active, turnInFlight: false, sessionId: 'controlled-session', pid: null }));
    session.spawnSession.mockImplementation(async () => { active = true; });
    const managerId = state.managerIdFor(session);
    const owner = state.sessionOwnership.claim(key, managerId);
    state.sessionOwnership.transition(key, managerId, 'active');
    state.chatSessions.set(key, session);
    const toolScope = `${key}#1`;
    state.sessionEventToolScopes.set(session, toolScope);
    const context = createRuntimeTurnContext({
      identity: { scope: 'per_chat', conversationKey: key, deliveryJid: jid, inboundSeq: seq, logicalTurnId: c.name, managerId, generation: owner.generation },
      recoveryOwner: { logicalTurnId: `recovery-${c.name}`, managerId: 'recovery-manager', generation: 1 },
      replay: { sourceMessageId: source, receivedAtUnixSeconds: Math.floor(Date.now() / 1000), replaySafe: c.safe, senderJid: jid, senderName: null, text: 'controlled request', isGroup: false },
      contentType: 'text', toolScopeKey: toolScope,
    });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const effects: string[] = [];
    const messenger = {
      sendMessage: vi.fn(async (_jid: string, text: string) => {
        if (text.includes('thinking') || text === 'explicit status')
          await gate;
        effects.push(text);
        if (text === 'continuation answer')
          throw new SendAmbiguousError({ message: 'synthetic effect then ambiguity', phase: 'provider_call_started', channelId: makeChannelId('whatsapp', 'probe'), operation: 'send_text', correlationId: c.name, scope: 'request' });
        return { waMessageId: `effect-${effects.length}` };
      }), sendMedia: vi.fn(async () => ({ waMessageId: null })), setTyping: vi.fn(async () => { }),
    };
    queue = new OutboundQueue(messenger, jid);
    queue.setDurability(durability);
    queue.setToolUpdateMode(c.mode as 'friendly' | 'minimal');
    queue.setInboundSeq(seq);
    queue.beginTurnEvidence(c.name, { conversationKey: key, chatJid: jid });
    state.chatQueues.set(key, queue);
    state.perChatRuntimeTurnContexts.set(key, [context]);
    state.perChatInboundSeqQueue.set(key, [seq]);
    // Suppress only the separate control-chat report; crash, respawn, owner checks and event admission stay real.
    vi.spyOn(state, 'emitCrashHealReport').mockImplementation(() => { });
    session.sendTurn.mockImplementation(async (input) => {
      expect(String(input)).toContain('session resumed after crash');
      if (!c.resultOnly)
        state.handleEventPerChat(session, { type: 'assistant_text', text: 'continuation answer' }, toolScope);
      state.handleEventPerChat(session, { type: 'result', text: c.resultOnly ? 'continuation answer' : null }, toolScope);
    });
    if (c.priorAnswer) {
      queue.enqueueText('original answer', 'answer');
      await vi.advanceTimersByTimeAsync(2000);
      await queue.flush();
      const originalOp = queue.getLastOpId();
      expect(originalOp).toBeDefined();
      durability.markEchoed(originalOp!);
    }
    if (c.hold) {
      if (c.mode === 'friendly') {
        const tracker = state.createOperationTracker(session, () => queue);
        expect(tracker).not.toBeNull();
        if (!tracker)
          throw new Error('Expected configured operation tracker');
        state.operationTrackers.set(key, tracker);
        tracker.onAnyActivity();
        await vi.advanceTimersByTimeAsync(11);
      }
      else {
        queue.enqueueText('explicit status', 'status');
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(messenger.sendMessage).toHaveBeenCalledTimes(c.priorAnswer ? 2 : 1);
    }
    state.handlePerChatCrash(key, jid, { exitCode: 1, signal: null, sessionId: 'controlled-session', dbRowId: 41, generationIdentity: { managerId, generation: owner.generation } }, session);
    if (c.stale)
      state.sessionOwnership.advanceGeneration(key, managerId);
    await vi.advanceTimersByTimeAsync(6000);
    expect(session.sendTurn).toHaveBeenCalledTimes(c.stale ? 0 : 1);
    const beforeRelease = db.raw.prepare('SELECT COUNT(*) n FROM turn_terminal_records').get() as {
      n: number;
    };
    expect(beforeRelease.n).toBe(c.hold ? 0 : 1);
    expect(state.chatQueues.get(key)).toBe(queue);
    const liveContext = state.perChatRuntimeTurnContexts.get(key)?.[0];
    if (c.hold)
      expect(liveContext?.replay.replaySafe).toBe(c.resultOnly ? false : c.safe);
    release();
    await vi.advanceTimersByTimeAsync(6000);
    await queue.flush();
    await state.runtimeTurnCoordinator.awaitActiveFinalizations();
    const evidence = await queue.flushTurnEvidence(c.name);
    const rows = db.raw.prepare('SELECT id,status,source_inbound_seq,is_terminal,payload FROM outbound_ops ORDER BY id').all() as Array<{
      id: number;
      status: string;
      source_inbound_seq: number;
      is_terminal: number;
      payload: string;
    }>;
    const answer = rows.find(r => JSON.parse(r.payload).text === 'continuation answer');
    expect(evidence.answerOpIds).toEqual(c.priorAnswer ? [1] : []);
    expect(evidence.statusOpIds).toHaveLength(c.hold ? 1 : 0);
    if (!c.stale) {
      expect(answer?.status).toBe('maybe_sent');
      expect(answer?.source_inbound_seq).toBe(seq);
      expect(answer?.is_terminal).toBe(0);
    }
    expect(db.raw.prepare('SELECT continuity_candidate_reason FROM inbound_events WHERE seq=?').get(seq))
      .toEqual({ continuity_candidate_reason: 'runtime_fault_no_terminal_outbound' });
    if (answer) {
      db.raw.prepare("UPDATE outbound_ops SET ambiguity_at=datetime('now','-45 seconds') WHERE id=?").run(answer.id);
      durability.reconcileLiveMaybeSent();
    }
    let dispatches = 0;
    const supervisor = new TurnRecoverySupervisor({ instanceName: 'probe', durability: () => durability, freshOwnerIdentity: () => ({ logicalTurnId: 'replay', managerId: 'replay-manager', generation: 1 }), dispatchReplay: async () => { dispatches++; durability.completeInbound(seq, 'response_sent'); return { kind: 'delivered' }; } });
    await supervisor.scanOnce();
    expect(dispatches).toBe(c.dispatch);
    expect(effects.filter(x => x === 'continuation answer')).toHaveLength(c.stale ? 0 : 1);
    expect(db.raw.prepare('SELECT state FROM turn_recovery_jobs').all()).toEqual([]);
    if (c.consumeBeforeEcho)
      expect(durability.reconcileContinuityCandidates().reconciled).toBe(1);
    if (answer) {
      durability.markEchoed(answer.id);
      await supervisor.scanOnce();
      expect(dispatches).toBe(0);
      expect(db.raw.prepare('SELECT status,is_terminal FROM outbound_ops WHERE id=?').get(answer.id))
        .toEqual({ status: 'echoed', is_terminal: 0 });
    }
    expect(db.raw.prepare('SELECT inbound_disposition FROM turn_terminal_records').get()).toEqual({ inbound_disposition: 'failed_terminal' });
    // The existing consumer settles a candidate covered by any terminal record;
    // neither a late echo nor the candidate itself creates a recovery obligation.
    expect(durability.reconcileContinuityCandidates().reconciled).toBe(c.consumeBeforeEcho ? 0 : 1);
    expect(durability.getUnconsumedContinuityCandidates()).toEqual([]);
    expect(durability.reconcileContinuityCandidates().reconciled).toBe(0);
    await supervisor.scanOnce();
    expect(dispatches).toBe(0);
  });
});
