/**
 * capability-decision-dropped-on-retry: a capability decision derived for a
 * turn whose first terminal write failed must reach the supervisor's retry,
 * and must not keep the turn retained.
 *
 * The first finalization applies the decision atomically inside C3 (D4). Every
 * supervisor retry carries the retained decision in best-effort mode:
 * savepoint 1 writes the real decision; if that fails, savepoint 2 records
 * `not_created_decision_lost_on_retry`; if that fails too, the error log line
 * is the only record. The terminal commits in each case, unless the failure
 * ended C3 itself, in which case nothing commits and the turn stays retained.
 *
 * Real SQLite throughout, except T1 (mocked durability).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const emitAlert = vi.hoisted(() => vi.fn(() => ({ status: 'durably_queued' })));
const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));
const clearAlertSourceChecked = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert,
  emitAlertChecked,
  clearAlertSourceChecked,
  emitObservationChecked: vi.fn(() => true),
}));

// Only the durability component's logger is captured: the decision-loss line
// is asserted there, and P6 makes its error() throw. The capture bypasses the
// production sanitizer, so P7 runs the captured line through its hook. Other
// components keep the real logger.
const durabilityLogger = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);
vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/logger.ts')>();
  const { componentLoggerMock } = await import('../../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('durability', actual.createChildLogger);
  Object.assign(durabilityLogger, log);
  return { ...actual, createChildLogger };
});

import type { CapabilityDecisionParams } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { sanitizingLogHook } from '../../../src/lib/log-sanitizer.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  createRuntimeTurnContext,
  type RuntimeTurnContext,
} from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  RuntimeTurnCoordinator,
  type RuntimeTurnCoordinatorPort,
} from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { RuntimeTurnSupervisor } from '../../../src/runtimes/agent/runtime-turn-supervisor.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeTurnFinalizerDurability,
} from '../../../src/runtimes/agent/turn-finalizer.ts';
import { coordinatorPortDouble } from './lib/runtime-turn-coordinator-port-double.ts';

const INSTANCE = 'decision-retry-test';
const CONVERSATION_KEY = '15550100002';
const DELIVERY_JID = '15550100002@s.whatsapp.net';
const LOSS_LOG = 'capability decision lost on retry';

type RetainInput = Parameters<RuntimeTurnSupervisor<unknown>['retain']>[0];

interface EventRow {
  action: string;
  reason_code: string | null;
  obligation_id: number | null;
  source_hash: string | null;
  detail: string | null;
}

function turnContext(inboundSeq: number, logicalTurnId: string): RuntimeTurnContext {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      inboundSeq,
      logicalTurnId,
      managerId: 'manager-primary',
      generation: 2,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'manager-recovery',
      generation: 3,
    },
    replay: {
      sourceMessageId: `msg-${logicalTurnId}`,
      receivedAtUnixSeconds: 1_780_000_000,
      replaySafe: true,
      senderJid: '15550100003@s.whatsapp.net',
      senderName: null,
      text: 'https://youtu.be/abc',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: `${CONVERSATION_KEY}#1`,
  });
}

/** A conclusive create decision, as decision.ts derives it (reason conclusive_no_effect). */
function decision(
  sourceInboundSeq: number,
  sourceMessageId: string,
  over: Partial<Record<string, unknown>> = {},
): CapabilityDecisionParams {
  return {
    auditEvent: {
      action: 'obligation.create',
      actorType: 'runtime',
      reasonCode: 'conclusive_no_effect',
      sourceHash: 'aa'.repeat(32),
    },
    obligation: {
      sourceInboundSeq,
      sourceMessageId,
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      senderJid: '15550100003@s.whatsapp.net',
      senderName: 'Test Sender',
      isGroup: false,
      groupName: null,
      scope: 'per_chat',
      originRecoveryJobId: null,
      replayText: 'https://youtu.be/abc',
      contentTypeHint: 'text',
      contractVersion: 'test-instance/1',
      requiredCapability: 'child_process_tools',
      capabilityParams: '{"skill":"watch"}',
      inputDigest: 'aa'.repeat(32),
      sourceDigest: 'bb'.repeat(32),
      sourceToken: 'https://youtu.be/abc',
      retainedMedia: null,
      creationReason: 'harness_capability_gap',
      ...over,
    } as CapabilityDecisionParams['obligation'],
  };
}

function durableFailure(
  turn: RuntimeTurnContext,
): Extract<FinalizeRuntimeTurnResult, { kind: 'durable_failure_incident' }> {
  return {
    kind: 'durable_failure_incident',
    identity: turn.identity,
    affectedScope: { scope: turn.identity.scope, conversationKey: turn.identity.conversationKey },
    failureStage: 'terminal_finalize',
    incidentStatus: 'durably_queued',
    mayAdvance: false,
    retryOwned: true,
  };
}

describe('capability decision on supervisor retry', () => {
  let db: Database;
  let durability: DurabilityEngine;
  let supervisor: RuntimeTurnSupervisor<unknown>;
  let spies: Array<MockInstance>;

  beforeEach(() => {
    vi.useFakeTimers();
    for (const value of Object.values(durabilityLogger)) {
      if (vi.isMockFunction(value)) value.mockReset();
    }
    emitAlert.mockClear();
    db = new Database(':memory:');
    db.open();
    durability = new DurabilityEngine(db);
    supervisor = new RuntimeTurnSupervisor<unknown>(INSTANCE, () => durability, vi.fn());
    spies = [];
  });

  afterEach(() => {
    supervisor.close();
    for (const spy of spies) spy.mockRestore();
    db.close();
    vi.useRealTimers();
  });

  function seedEchoedTurn(messageId: string): { inboundSeq: number; opId: number } {
    const inboundSeq = durability.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    const opId = durability.createOutboundOp({
      conversationKey: CONVERSATION_KEY,
      chatJid: DELIVERY_JID,
      opType: 'send_text',
      payload: '{"text":"refusal"}',
      replayPolicy: 'safe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(opId);
    durability.markSubmitted(opId, `wa-${messageId}`);
    durability.markEchoed(opId);
    return { inboundSeq, opId };
  }

  const counts = () => ({
    terminals: (db.raw.prepare('SELECT COUNT(*) c FROM turn_terminal_records').get() as { c: number }).c,
    obligations: (db.raw.prepare('SELECT COUNT(*) c FROM capability_obligations').get() as { c: number }).c,
    events: (db.raw.prepare('SELECT COUNT(*) c FROM capability_obligation_events').get() as { c: number }).c,
  });

  const events = (): EventRow[] => db.raw
    .prepare(
      'SELECT action, reason_code, obligation_id, source_hash, detail FROM capability_obligation_events ORDER BY id',
    )
    .all() as unknown as EventRow[];

  const inboundStatus = (seq: number): string => (
    db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
    }
  ).processing_status;

  function lossLogs(): Array<Record<string, unknown>> {
    return durabilityLogger['error']!.mock.calls
      .filter(([, message]) => message === LOSS_LOG)
      .map(([fields]) => fields as Record<string, unknown>);
  }

  /** The coordinator's first finalization: no mode, so the decision is atomic in C3. */
  function firstAttempt(
    ctx: RuntimeTurnContext,
    opId: number,
    decisionParams: CapabilityDecisionParams,
  ): FinalizeRuntimeTurnResult {
    return finalizeRuntimeTurn({
      instanceName: INSTANCE,
      durability,
      identity: ctx.identity,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'ready', opIds: [opId] },
      recoveryOwner: ctx.recoveryOwner,
      replay: ctx.replay,
      bookkeeping: {},
      capabilityDecision: decisionParams,
    });
  }

  /** Retain a failed first attempt with the record shape the coordinator retains. */
  function retainFailedTurn(
    ctx: RuntimeTurnContext,
    opId: number,
    decisionParams: CapabilityDecisionParams,
    first: FinalizeRuntimeTurnResult,
  ): void {
    if (first.kind === 'terminal' || first.kind === 'reclaimed_by_sweep') {
      throw new Error(`first attempt unexpectedly reached ${first.kind}`);
    }
    const record = {
      context: ctx,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'ready', opIds: [opId] },
      bookkeeping: {},
      postEffects: {},
      capabilityDecision: decisionParams,
    } as RetainInput;
    supervisor.retain(record, first);
  }

  function failFirstTerminalWriteOnce(): void {
    spies.push(
      vi.spyOn(durability, 'finalizeTurnTerminal').mockImplementationOnce(() => {
        throw new Error('injected: first terminal write failed');
      }),
    );
  }

  /** Prepares one retained turn whose first attempt failed. */
  function retainedTurn(
    name: string,
    failFirstAttempt: () => void,
    over: Partial<Record<string, unknown>> = {},
  ): { ctx: RuntimeTurnContext; inboundSeq: number; decision: CapabilityDecisionParams } {
    const messageId = `msg-${name}`;
    const seed = seedEchoedTurn(messageId);
    const ctx = turnContext(seed.inboundSeq, name);
    const decisionParams = decision(seed.inboundSeq, messageId, over);
    failFirstAttempt();
    const first = firstAttempt(ctx, seed.opId, decisionParams);
    expect(first.kind).toBe('durable_failure_incident');
    expect(counts()).toEqual({ terminals: 0, obligations: 0, events: 0 });
    retainFailedTurn(ctx, seed.opId, decisionParams, first);
    expect(supervisor.health().retainedRetries).toBe(1);
    return { ctx, inboundSeq: seed.inboundSeq, decision: decisionParams };
  }

  function lostEventDetail(): Record<string, unknown> {
    const rows = events();
    expect(rows.map((row) => [row.action, row.reason_code, row.obligation_id])).toEqual([
      ['obligation.not_created', 'not_created_decision_lost_on_retry', null],
    ]);
    expect(rows[0]!.source_hash).toBe('aa'.repeat(32));
    return JSON.parse(rows[0]!.detail!) as Record<string, unknown>;
  }

  it('T1: every retry forwards the retained decision in best_effort mode (mocked durability)', async () => {
    const ctx = turnContext(7, 'turn-t1');
    const decisionParams = decision(7, 'msg-turn-t1');
    let calls = 0;
    const finalizeTurnTerminal = vi.fn((_params: unknown) => {
      calls += 1;
      if (calls < 3) throw new Error('terminal still unavailable');
      return {
        applied: true,
        winnerMatchesRequest: true,
        recordId: 1,
        duplicateFinalizeCount: 0,
        replyGuaranteeDisarmed: true,
        effectiveReplyGuaranteeDisarmed: true,
      };
    });
    const mockDurability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal,
    } as unknown as RuntimeTurnFinalizerDurability;
    const mocked = new RuntimeTurnSupervisor<unknown>(INSTANCE, () => mockDurability, vi.fn());
    const record = {
      context: ctx,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'ready', opIds: [] },
      bookkeeping: {},
      postEffects: {},
      capabilityDecision: decisionParams,
    } as RetainInput;
    mocked.retain(record, durableFailure(ctx));

    await mocked.retryAll();
    await mocked.retryAll();
    await mocked.retryAll();

    const forwarded = finalizeTurnTerminal.mock.calls.map(([params]) => {
      const sent = params as { capabilityDecision?: unknown; capabilityDecisionMode?: unknown };
      return { decision: sent.capabilityDecision, mode: sent.capabilityDecisionMode };
    });
    expect(forwarded).toEqual([
      { decision: decisionParams, mode: 'best_effort' },
      { decision: decisionParams, mode: 'best_effort' },
      { decision: decisionParams, mode: 'best_effort' },
    ]);
    expect(mocked.health().retainedRetries).toBe(0);
    mocked.close();
  });

  it('T2: a transient first-attempt fault leads to the real decision on retry 1', async () => {
    retainedTurn('turn-t2', failFirstTerminalWriteOnce);

    await supervisor.retryAll();

    expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
    expect(events().map((row) => [row.action, row.reason_code])).toEqual([
      ['obligation.create', 'conclusive_no_effect'],
    ]);
    expect(lossLogs()).toEqual([]);
    expect(supervisor.health()).toMatchObject({ retainedRetries: 0, retryAttempts: 1, retryExhaustions: 0 });
  });

  it('T2c: an audit-write fault on the first attempt only leads to the real decision on retry 1', async () => {
    let appendSpy!: MockInstance;
    retainedTurn('turn-t2c', () => {
      appendSpy = vi.spyOn(durability.capabilityObligations, 'appendEventWithinCallerTransaction')
        .mockImplementationOnce(() => {
          throw new Error('injected audit failure');
        });
      spies.push(appendSpy);
    });
    expect(appendSpy).toHaveBeenCalledTimes(1);

    await supervisor.retryAll();

    expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
    expect(events().map((row) => [row.action, row.reason_code])).toEqual([
      ['obligation.create', 'conclusive_no_effect'],
    ]);
    expect(lossLogs()).toEqual([]);
    expect(supervisor.health().retainedRetries).toBe(0);
  });

  it('T2e: a fault lasting through retry 1 records one loss there and needs no retry 2', async () => {
    let insertSpy!: MockInstance;
    retainedTurn('turn-t2e', () => {
      insertSpy = vi.spyOn(durability.capabilityObligations, 'insertWithinCallerTransaction')
        .mockImplementationOnce(() => {
          throw new Error('injected obligation insert failure (attempt 1)');
        })
        .mockImplementationOnce(() => {
          throw new Error('injected obligation insert failure (retry 1)');
        });
      spies.push(insertSpy);
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);

    await supervisor.retryAll();

    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
    expect(lostEventDetail()).toEqual({
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      error: { name: 'Error', errcode: null },
    });
    expect(supervisor.health()).toMatchObject({ retainedRetries: 0, retryAttempts: 1, retryExhaustions: 0 });
  });

  it('P1: a persistent obligation-insert fault commits the terminal with one lost event on retry 1', async () => {
    let insertSpy!: MockInstance;
    const { ctx, inboundSeq } = retainedTurn('turn-p1', () => {
      insertSpy = vi.spyOn(durability.capabilityObligations, 'insertWithinCallerTransaction')
        .mockImplementation(() => {
          throw new Error('injected obligation insert failure');
        });
      spies.push(insertSpy);
    });
    const insertsBefore = insertSpy.mock.calls.length;

    await supervisor.retryAll();

    expect(insertSpy.mock.calls.length).toBeGreaterThan(insertsBefore);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
    expect(lostEventDetail()).toEqual({
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      error: { name: 'Error', errcode: null },
    });
    expect(lossLogs()).toEqual([{
      logicalTurnId: 'turn-p1',
      inboundSeq,
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      errorClass: 'Error',
      errcode: null,
    }]);
    // One pass, no exhaustion, and the chat accepts turns again.
    expect(supervisor.canAccept(ctx)).toBe(true);
    expect(supervisor.health()).toEqual({
      retainedRetries: 0,
      degradedScopes: 0,
      retryAttempts: 1,
      retryRecoveries: 1,
      retryExhaustions: 0,
    });
  });

  it('P2: when the lost event cannot be written either, the terminal still commits and the log is the record', async () => {
    let appendSpy!: MockInstance;
    retainedTurn('turn-p2', () => {
      appendSpy = vi.spyOn(durability.capabilityObligations, 'appendEventWithinCallerTransaction')
        .mockImplementation(() => {
          throw new Error('injected audit failure');
        });
      spies.push(appendSpy);
    });
    const appendsBefore = appendSpy.mock.calls.length;

    await supervisor.retryAll();

    // Savepoint 1 (the real decision) and savepoint 2 (the lost event) both reached the fault.
    expect(appendSpy.mock.calls.length - appendsBefore).toBe(2);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 0 });
    expect(lossLogs()).toHaveLength(1);
    expect(lossLogs()[0]).toMatchObject({ logicalTurnId: 'turn-p2', derivedAction: 'obligation.create' });
    expect(supervisor.health()).toMatchObject({ retainedRetries: 0, retryAttempts: 1, retryExhaustions: 0 });
  });

  it('P3: a fault that ends C3 inside savepoint 1 commits nothing and leaves the turn retained', async () => {
    const { inboundSeq } = retainedTurn('turn-p3', failFirstTerminalWriteOnce);
    const statusBefore = inboundStatus(inboundSeq);
    // Only savepoint 1's write ends the transaction; a later write (the
    // fallback, if the guard were missing) is allowed to succeed.
    const appendSpy = vi.spyOn(durability.capabilityObligations, 'appendEventWithinCallerTransaction')
      .mockImplementationOnce(() => {
        db.raw.exec('ROLLBACK');
        throw new Error('injected: storage fault rolled back C3');
      });
    spies.push(appendSpy);

    await supervisor.retryAll();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(counts()).toEqual({ terminals: 0, obligations: 0, events: 0 });
    expect(inboundStatus(inboundSeq)).toBe(statusBefore);
    expect(lossLogs()).toHaveLength(1);
    expect(lossLogs()[0]).toMatchObject({ logicalTurnId: 'turn-p3', derivedAction: 'obligation.create' });
    expect(supervisor.health()).toMatchObject({ retainedRetries: 1, retryAttempts: 1 });
  });

  it('P3b: a fault that ends C3 inside savepoint 2 commits nothing and leaves the turn retained', async () => {
    const { inboundSeq } = retainedTurn('turn-p3b', failFirstTerminalWriteOnce);
    const statusBefore = inboundStatus(inboundSeq);
    const appendSpy = vi.spyOn(durability.capabilityObligations, 'appendEventWithinCallerTransaction')
      .mockImplementationOnce(() => {
        throw new Error('injected audit failure (C3 still active)');
      })
      .mockImplementationOnce(() => {
        db.raw.exec('ROLLBACK');
        throw new Error('injected: storage fault rolled back C3');
      });
    spies.push(appendSpy);

    await supervisor.retryAll();

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual({ terminals: 0, obligations: 0, events: 0 });
    expect(inboundStatus(inboundSeq)).toBe(statusBefore);
    expect(lossLogs()).toHaveLength(1);
    expect(supervisor.health()).toMatchObject({ retainedRetries: 1, retryAttempts: 1 });
  });

  it('P4b: a malformed retained decision is recorded as lost on retry 1 instead of failing before C3', async () => {
    // Atomic validation rejects it on the first attempt (normalize), so the turn is retained.
    const { inboundSeq } = retainedTurn('turn-p4b', () => {}, { replayText: '' });
    const applySpy = vi.spyOn(durability.capabilityObligations, 'applyDecisionWithinCallerTransaction');
    spies.push(applySpy);

    await supervisor.retryAll();

    // The malformed decision reached the store in savepoint 1 and was rejected
    // there; savepoint 2 then wrote the lost event.
    expect(applySpy.mock.calls.map(([applied]) => applied.auditEvent.reasonCode)).toEqual([
      'conclusive_no_effect',
      'not_created_decision_lost_on_retry',
    ]);
    expect(applySpy.mock.results.map((outcome) => outcome.type)).toEqual(['throw', 'return']);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
    expect(lostEventDetail()).toEqual({
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      error: { name: 'Error', errcode: null },
    });
    expect(lossLogs()).toEqual([{
      logicalTurnId: 'turn-p4b',
      inboundSeq,
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      errorClass: 'Error',
      errcode: null,
    }]);
    expect(supervisor.health()).toMatchObject({ retainedRetries: 0, retryAttempts: 1, retryExhaustions: 0 });
  });

  it('P6: a throwing logger cannot turn the decision loss into a wedge', async () => {
    let insertSpy!: MockInstance;
    retainedTurn('turn-p6', () => {
      insertSpy = vi.spyOn(durability.capabilityObligations, 'insertWithinCallerTransaction')
        .mockImplementation(() => {
          throw new Error('injected obligation insert failure');
        });
      spies.push(insertSpy);
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);
    durabilityLogger['error']!.mockImplementation(() => {
      throw new Error('injected: logger unavailable');
    });

    await supervisor.retryAll();

    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(lossLogs()).toHaveLength(1);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
    expect(lostEventDetail()).toMatchObject({ derivedAction: 'obligation.create' });
    expect(supervisor.health()).toMatchObject({ retainedRetries: 0, retryAttempts: 1, retryExhaustions: 0 });
  });

  it('P7: the loss log keeps the error class and errcode through the production log sanitizer', async () => {
    let insertSpy!: MockInstance;
    const { inboundSeq } = retainedTurn('turn-p7', () => {
      insertSpy = vi.spyOn(durability.capabilityObligations, 'insertWithinCallerTransaction')
        .mockImplementation(() => {
          throw Object.assign(new Error('injected constraint failure'), { name: 'SqliteFault', errcode: 19 });
        });
      spies.push(insertSpy);
    });
    expect(insertSpy).toHaveBeenCalledTimes(1);

    await supervisor.retryAll();

    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
    expect(lostEventDetail()).toEqual({
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      error: { name: 'SqliteFault', errcode: 19 },
    });
    // The capture bypasses the sanitizer; the production logger runs every
    // line through this hook before any sink.
    const sunk: unknown[][] = [];
    for (const fields of lossLogs()) {
      sanitizingLogHook.call(null, [fields, LOSS_LOG], (...args: unknown[]) => {
        sunk.push(args);
      }, 50);
    }
    expect(sunk).toEqual([[{
      logicalTurnId: 'turn-p7',
      inboundSeq,
      derivedAction: 'obligation.create',
      derivedReasonCode: 'conclusive_no_effect',
      errorClass: 'SqliteFault',
      errcode: 19,
    }, LOSS_LOG]]);
  });

  describe('coordinator (first attempt)', () => {
    function queueWithoutAnswers(): IOutboundQueue {
      return {
        flushTurnEvidence: vi.fn(async (turnId: string) => ({
          turnId,
          answerOpIds: [],
          lifecycleOpIds: [],
          statusOpIds: [],
        })),
        clearLastOpId: vi.fn(),
      } as unknown as IOutboundQueue;
    }

    function coordinatorDeriving(decisionParams: CapabilityDecisionParams): RuntimeTurnCoordinator {
      return new RuntimeTurnCoordinator(coordinatorPortDouble({
        instanceName: INSTANCE,
        durability: durability as unknown as RuntimeTurnCoordinatorPort['durability'],
        runtimeTurnSupervisor: supervisor as unknown as RuntimeTurnCoordinatorPort['runtimeTurnSupervisor'],
        deriveCapabilityDecision: vi.fn(async () => decisionParams),
      }));
    }

    it('C1 (control): a first attempt that commits records its decision and is not retained', async () => {
      const inboundSeq = durability.journalInbound('msg-turn-c1', CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const ctx = turnContext(inboundSeq, 'turn-c1');
      const decisionParams = decision(inboundSeq, 'msg-turn-c1');
      // The coordinator retains a turn whose first terminal write fails (T3),
      // so this spy can see a wrong retention.
      const retainSpy = vi.spyOn(supervisor, 'retain');
      spies.push(retainSpy);

      const result = await coordinatorDeriving(decisionParams).finalizeRuntimeTurnContext({
        context: ctx,
        queue: queueWithoutAnswers(),
        attemptOutcome: { kind: 'completed' },
        session: null,
      });

      expect(result.kind).toBe('terminal');
      expect(retainSpy).not.toHaveBeenCalled();
      expect(supervisor.health()).toMatchObject({ retainedRetries: 0, degradedScopes: 0 });
      expect(lossLogs()).toEqual([]);
      expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
    });

    it('T3: a failed first terminal write retains the derived decision with the turn', async () => {
      const inboundSeq = durability.journalInbound('msg-turn-t3', CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const ctx = turnContext(inboundSeq, 'turn-t3');
      const decisionParams = decision(inboundSeq, 'msg-turn-t3');
      failFirstTerminalWriteOnce();
      const retainSpy = vi.spyOn(supervisor, 'retain');
      spies.push(retainSpy);

      const result = await coordinatorDeriving(decisionParams).finalizeRuntimeTurnContext({
        context: ctx,
        queue: queueWithoutAnswers(),
        attemptOutcome: { kind: 'completed' },
        session: null,
      });

      expect(result.kind).toBe('durable_failure_incident');
      expect(retainSpy).toHaveBeenCalledTimes(1);
      const retained = retainSpy.mock.calls[0]![0] as { capabilityDecision?: unknown };
      expect(retained.capabilityDecision).toEqual(decisionParams);

      // The retained decision is then written by the first retry.
      await supervisor.retryAll();
      expect(counts()).toEqual({ terminals: 1, obligations: 1, events: 1 });
    });

    it('P4: a derived decision that fails validation becomes producer_error on the first attempt', async () => {
      const inboundSeq = durability.journalInbound('msg-turn-p4', CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const ctx = turnContext(inboundSeq, 'turn-p4');
      const invalid = decision(inboundSeq, 'msg-turn-p4', { replayText: '' });

      const result = await coordinatorDeriving(invalid).finalizeRuntimeTurnContext({
        context: ctx,
        queue: queueWithoutAnswers(),
        attemptOutcome: { kind: 'completed' },
        session: null,
      });

      expect(result.kind).toBe('terminal');
      expect(supervisor.canAccept(ctx)).toBe(true);
      expect(supervisor.health()).toMatchObject({ retainedRetries: 0, degradedScopes: 0 });
      expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 1 });
      expect(events().map((row) => [row.action, row.reason_code])).toEqual([
        ['obligation.not_created', 'not_created_decision_producer_error'],
      ]);
    });

    it('C2 (control): an undispatched turn derives no decision and records no event', async () => {
      const inboundSeq = durability.journalInbound('msg-turn-c2', CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const ctx = turnContext(inboundSeq, 'turn-c2');
      const derive = vi.fn(async () => decision(inboundSeq, 'msg-turn-c2'));
      const coordinator = new RuntimeTurnCoordinator(coordinatorPortDouble({
        instanceName: INSTANCE,
        durability: durability as unknown as RuntimeTurnCoordinatorPort['durability'],
        runtimeTurnSupervisor: supervisor as unknown as RuntimeTurnCoordinatorPort['runtimeTurnSupervisor'],
        deriveCapabilityDecision: derive,
      }));

      const result = await coordinator.finalizeUndispatchedRuntimeTurn(ctx, undefined, {
        kind: 'admission_rejected',
        class: 'queue_closed',
      });

      expect(result.kind).toBe('terminal');
      expect(derive).not.toHaveBeenCalled();
      expect(supervisor.health().retainedRetries).toBe(0);
      expect(counts()).toEqual({ terminals: 1, obligations: 0, events: 0 });
    });
  });
});
