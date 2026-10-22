// A user-facing notice is never a turn's answer evidence.
//
// The finalizer reads only a turn's answer ops to decide whether the user was
// answered. A notice the runtime sends about a turn (a failure notice, a
// hand-off, a compaction notice, a direct-send status line) must be recorded as
// a status or lifecycle op. A turn whose only op is a notice then ends
// failed_terminal with a reply-guarantee breach, instead of being booked as
// replied or handed to recovery as if its answer were in flight.
//
// Harness: REAL AgentRuntime result handlers, REAL runtime turn coordinator and
// finalizer, REAL OutboundQueue and REAL SQLite durability. The runtime's
// private turn state is set through the coordinator integration harness
// (lib/runtime-terminal-coordinator-harness.ts). The doubles are the provider
// session, the transport, the logger and the alert sink. The transport returns
// a message id for each send; an echo is recorded only where a case asks for
// one, so a notice otherwise stays submitted when the turn finalizes.
//
// Each case reads the role in two places: the role argument the producing site
// passed to the queue, and the evidence list the queue filed the durable op
// under when the finalizer flushed the turn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureStandbyNoticeSchema } from '../../../src/runtimes/agent/standby-notice.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import { stashHandoffNotice } from '../../../src/runtimes/agent/handoff-notice-prefix.ts';
import { emitManagedLoopDegradedNotice } from '../../../src/runtimes/agent/managed-loop-disclosure.ts';
import { runSessionsCommand } from '../../../src/runtimes/agent/runtime-session-lifecycle.ts';
import {
  type ResultEvent,
  type TurnContext,
  ALIAS_KEY,
  ANSWER,
  AUTH_REQUIRED,
  AUTO_SWITCH,
  CONTEXT_OVERFLOW,
  DIAL,
  EMPTY,
  HELD_FIRST_LINE,
  MODEL_UNAVAILABLE,
  NARRATION,
  OTHER_CHAT,
  POLL_DETAILED_OPTIONS,
  POLL_NOT_SENT,
  POLL_OPTIONS,
  POLL_QUESTION,
  POLL_SENT,
  RATE_LIMIT,
  SENDER_JID,
  SERVER_ERROR,
  SOCKET_DROP,
  UNKNOWN_TERMINAL,
  USAGE_LIMIT,
  activation,
  askPoll,
  breaches,
  evidenceOf,
  exitOf,
  failed,
  inMinimalMode,
  mutableConfig,
  nextKey,
  notAnswered,
  noticeFacts,
  openTurn,
  openTurns,
  opsMatching,
  opsOf,
  opsWithText,
  ownSession,
  policyBlocking,
  rebuildQueue,
  recoveryJobStatesOf,
  recoveryJobsOf,
  replyContext,
  rolesPassed,
  settle,
  terminalOf,
  withNlRouting,
} from './lib/notice-turn-harness.ts';

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
  emitObservationChecked: vi.fn(() => true),
}));

beforeEach(() => {
  emitAlert.mockClear();
  delete process.env[DIAL];
});

afterEach(() => {
  delete process.env[DIAL];
  vi.restoreAllMocks();
  for (const turn of openTurns.splice(0)) turn.close();
});

describe('a notice sent for a turn is not that turn\'s answer', () => {
  interface Cell {
    readonly label: string;
    readonly scope: 'per_chat' | 'shared';
    readonly dial: boolean;
    readonly event: ResultEvent;
    readonly notice: string;
    /** A provider-fallback window is open, which the per-chat empty-reply notice requires. */
    readonly window?: boolean;
    readonly echo?: boolean;
  }

  // Every result-path notice, through each entry point and both registry
  // dispatch settings. With dispatch on, a class with a provider kind goes to
  // the shared provider-failure handler; server-error and transient-network
  // (no provider kind), an unknown terminal (no workflow) and an empty result
  // (no text) stay on their own branch.
  const cells: Cell[] = [
    { label: 'scoped usage-limit, no fallback', scope: 'per_chat', dial: false, event: failed(USAGE_LIMIT), notice: 'add credits' },
    { label: 'scoped server-error, no fallback', scope: 'per_chat', dial: false, event: failed(SERVER_ERROR), notice: 'temporary error and automatic retry' },
    { label: 'scoped rate-limit, no fallback', scope: 'per_chat', dial: false, event: failed(RATE_LIMIT), notice: 'Primary model is rate limited' },
    { label: 'scoped model-unavailable, no fallback', scope: 'per_chat', dial: false, event: failed(MODEL_UNAVAILABLE), notice: 'Primary model is unavailable on this host' },
    { label: 'scoped auth-required, no fallback', scope: 'per_chat', dial: false, event: failed(AUTH_REQUIRED), notice: 're-authentication' },
    { label: 'scoped context overflow', scope: 'per_chat', dial: false, event: failed(CONTEXT_OVERFLOW), notice: 'Context limit reached' },
    { label: 'scoped transient network drop', scope: 'per_chat', dial: false, event: failed(SOCKET_DROP), notice: 'temporary connection problem' },
    { label: 'scoped unknown terminal error', scope: 'per_chat', dial: false, event: failed(UNKNOWN_TERMINAL), notice: 'automatic recovery failed' },
    { label: 'scoped empty reply in a fallback window', scope: 'per_chat', dial: false, event: EMPTY, notice: 'backup model returned no reply', window: true },
    { label: 'scoped empty reply in a fallback window, notice echoed', scope: 'per_chat', dial: false, event: EMPTY, notice: 'backup model returned no reply', window: true, echo: true },
    { label: 'global usage-limit, no fallback', scope: 'shared', dial: false, event: failed(USAGE_LIMIT), notice: 'add credits' },
    { label: 'global server-error, no fallback', scope: 'shared', dial: false, event: failed(SERVER_ERROR), notice: 'temporary error and automatic retry' },
    { label: 'global rate-limit, no fallback', scope: 'shared', dial: false, event: failed(RATE_LIMIT), notice: 'Primary model is rate limited' },
    { label: 'global model-unavailable, no fallback', scope: 'shared', dial: false, event: failed(MODEL_UNAVAILABLE), notice: 'Primary model is unavailable on this host' },
    { label: 'global auth-required, no fallback', scope: 'shared', dial: false, event: failed(AUTH_REQUIRED), notice: 're-authentication' },
    { label: 'global context overflow', scope: 'shared', dial: false, event: failed(CONTEXT_OVERFLOW), notice: 'Context limit reached' },
    { label: 'global transient network drop', scope: 'shared', dial: false, event: failed(SOCKET_DROP), notice: 'temporary connection problem' },
    { label: 'global unknown terminal error', scope: 'shared', dial: false, event: failed(UNKNOWN_TERMINAL), notice: 'automatic recovery failed' },
    { label: 'global empty reply', scope: 'shared', dial: false, event: EMPTY, notice: 'no response' },
    { label: 'global empty reply, notice echoed', scope: 'shared', dial: false, event: EMPTY, notice: 'no response', echo: true },
    { label: 'scoped server-error, dispatch on', scope: 'per_chat', dial: true, event: failed(SERVER_ERROR), notice: 'temporary error and automatic retry' },
    { label: 'scoped transient network drop, dispatch on', scope: 'per_chat', dial: true, event: failed(SOCKET_DROP), notice: 'temporary connection problem' },
    { label: 'scoped unknown terminal error, dispatch on', scope: 'per_chat', dial: true, event: failed(UNKNOWN_TERMINAL), notice: 'automatic recovery failed' },
    { label: 'scoped empty reply in a fallback window, dispatch on', scope: 'per_chat', dial: true, event: EMPTY, notice: 'backup model returned no reply', window: true },
    { label: 'scoped provider failure: usage-limit', scope: 'per_chat', dial: true, event: failed(USAGE_LIMIT), notice: 'add credits' },
    { label: 'scoped provider failure: context overflow', scope: 'per_chat', dial: true, event: failed(CONTEXT_OVERFLOW), notice: 'Context limit reached' },
    { label: 'scoped provider failure: rate-limit', scope: 'per_chat', dial: true, event: failed(RATE_LIMIT), notice: 'Primary model is rate limited' },
    { label: 'scoped provider failure: model-unavailable', scope: 'per_chat', dial: true, event: failed(MODEL_UNAVAILABLE), notice: 'Primary model is unavailable on this host' },
    { label: 'scoped provider failure: auth-required', scope: 'per_chat', dial: true, event: failed(AUTH_REQUIRED), notice: 're-authentication' },
    { label: 'global server-error, dispatch on', scope: 'shared', dial: true, event: failed(SERVER_ERROR), notice: 'temporary error and automatic retry' },
    { label: 'global transient network drop, dispatch on', scope: 'shared', dial: true, event: failed(SOCKET_DROP), notice: 'temporary connection problem' },
    { label: 'global unknown terminal error, dispatch on', scope: 'shared', dial: true, event: failed(UNKNOWN_TERMINAL), notice: 'automatic recovery failed' },
    { label: 'global empty reply, dispatch on', scope: 'shared', dial: true, event: EMPTY, notice: 'no response' },
    { label: 'global provider failure: usage-limit', scope: 'shared', dial: true, event: failed(USAGE_LIMIT), notice: 'add credits' },
    { label: 'global provider failure: context overflow', scope: 'shared', dial: true, event: failed(CONTEXT_OVERFLOW), notice: 'Context limit reached' },
    { label: 'global provider failure: rate-limit', scope: 'shared', dial: true, event: failed(RATE_LIMIT), notice: 'Primary model is rate limited' },
    { label: 'global provider failure: model-unavailable', scope: 'shared', dial: true, event: failed(MODEL_UNAVAILABLE), notice: 'Primary model is unavailable on this host' },
    { label: 'global provider failure: auth-required', scope: 'shared', dial: true, event: failed(AUTH_REQUIRED), notice: 're-authentication' },
  ];

  // The label goes through %s so the title is the label verbatim: a $label
  // title is quoted and cut at the display width, which makes some cells share a title.
  it.each(cells.map((cell): [string, Cell] => [cell.label, cell]))(
    '%s: the notice is a status op and the turn ends failed_terminal',
    async (_label, cell) => {
      const turn = openTurn({ scope: cell.scope, ...(cell.echo === true ? { echo: true } : {}) });
      if (cell.window === true) vi.spyOn(turn.state.fallbackWindow, 'isActive').mockReturnValue(true);
      if (cell.dial) process.env[DIAL] = '1';

      turn.deliver(cell.event);
      await settle(turn);

      expect(noticeFacts(turn, cell.notice)).toEqual(notAnswered('status', cell.echo === true ? 'echoed' : 'submitted'));
    },
  );

  it('a pending hand-off notice flushed by an empty turn is a lifecycle op, and the turn ends failed_terminal', async () => {
    const prior = mutableConfig.oneMessageHandoff;
    mutableConfig.oneMessageHandoff = true;
    try {
      const turn = openTurn({ scope: 'per_chat' });
      ensureStandbyNoticeSchema(turn.db);
      expect(stashHandoffNotice(turn.db, turn.jid, '_The backup model is standing in for this chat._', Date.now()))
        .toBe(true);

      turn.deliver(EMPTY);
      await settle(turn);

      expect(noticeFacts(turn, 'standing in for this chat')).toEqual(notAnswered('lifecycle'));
    } finally {
      mutableConfig.oneMessageHandoff = prior;
    }
  });

  it('a fallback activation notice with no continuation is a lifecycle op, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    turn.state.notifyProviderFallbackActivated(turn.queue, activation(), { replayScheduled: false });

    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'usage/quota limit')).toEqual(notAnswered('lifecycle'));
  });

  it.each(['per_chat', 'shared'] as const)(
    '%s: a compaction notice is a lifecycle op, and the failed turn ends failed_terminal',
    async (scope) => {
      const turn = openTurn({ scope });
      // Recording the compaction baseline writes columns the runtime adds at start.
      ensureAgentSchema(turn.db);
      turn.deliver({ type: 'compact_boundary' });
      turn.deliver(failed(UNKNOWN_TERMINAL));
      await settle(turn);

      expect(noticeFacts(turn, 'Context compacted')).toEqual(notAnswered('lifecycle'));
    },
  );

  // Minimal mode defers narration streamed before a tool call. Any message that
  // reaches the user drops it, a notice included, so the failed turn's end does
  // not resend the narration as an answer.
  it('minimal mode: a compaction notice drops the deferred narration and is a lifecycle op, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    // Recording the compaction baseline writes columns the runtime adds at start.
    ensureAgentSchema(turn.db);
    await inMinimalMode(turn, async () => {
      turn.deliver({ type: 'assistant_text', text: NARRATION });
      turn.deliver({ type: 'tool_use', toolName: 'Read', toolId: 'tool-pen-1', toolInput: { file_path: 'notes.md' } });
      turn.deliver({ type: 'compact_boundary' });
      turn.deliver(failed(UNKNOWN_TERMINAL));
      await settle(turn);
    });

    expect({
      notice: noticeFacts(turn, 'Context compacted'),
      narrationOps: opsMatching(turn, 'look that up in your notes').length,
    }).toEqual({
      notice: notAnswered('lifecycle'),
      narrationOps: 0,
    });
  });

  it('a crash notice sent while the turn is open is a status op, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    turn.state.handleCrashNotify(
      'Agent session ended (exited with code 1). Send any message to start a new session.',
      turn.jid,
    );

    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'exited with code 1')).toEqual(notAnswered('status'));
  });

  it('a degraded-capabilities disclosure is a status op, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    emitManagedLoopDegradedNotice({
      queue: turn.queue,
      recentNotices: new Map<string, number>(),
      noticeDedupMs: 60_000,
      capDedupeMap: () => {},
    });

    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'reduced abilities')).toEqual(notAnswered('status'));
  });

  it('a direct-send notice to the chat during the turn is a status op, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    turn.state.noticeExpiredSession(turn.jid, { deferDuringStartup: false });

    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'Previous session expired')).toEqual(notAnswered('status'));
  });

  it('a session-lifecycle reply passes its status role and force flag through, and makes no queue op', () => {
    const turn = openTurn({ scope: 'per_chat' });
    const sendDirect = vi.spyOn(
      turn.runtime as unknown as { sendDirect: (...args: unknown[]) => void },
      'sendDirect',
    );

    runSessionsCommand(turn.state.sessionLifecycleHost, turn.jid);

    expect({ calls: sendDirect.mock.calls, enqueued: turn.enqueued }).toEqual({
      calls: [[turn.jid, '_No active sessions._', 'status', true]],
      enqueued: [],
    });
  });

  it('control: the re-auth path of a scheduled turn sends no notice and still alerts', () => {
    const turn = openTurn({ scope: 'per_chat' });

    turn.state.fallback.emitNoFallbackReauthNotice(turn.queue, true);

    expect({
      enqueued: turn.enqueued,
      ops: opsOf(turn),
      alerts: emitAlert.mock.calls.map((call) => call[1]),
    }).toEqual({
      enqueued: [],
      ops: [],
      alerts: ['provider_auth_required_no_fallback'],
    });
  });

  // The same path through the real runtime. With registry dispatch on, the
  // shared provider-failure handler hands the turn's scheduled flag to the
  // runtime's host, which forwards it to the fallback controller.
  it('control: a scheduled turn\'s auth-required provider failure through the runtime sends no notice and still alerts', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    turn.state.pendingTurnPurpose.set(turn.jid, 'scheduled-agent-job');
    process.env[DIAL] = '1';

    turn.deliver(failed(AUTH_REQUIRED));
    await settle(turn);

    expect({
      enqueued: turn.enqueued,
      ops: opsOf(turn),
      reauthAlerts: emitAlert.mock.calls.filter((call) => call[1] === 'provider_auth_required_no_fallback').length,
    }).toEqual({
      enqueued: [],
      ops: [],
      reauthAlerts: 1,
    });
  });
});

describe('a failed fallback replay', () => {
  it('ends the held turn failed_terminal with a breach and no recovery job when its only ops are notices', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    const markContinuity = vi.spyOn(turn.engine, 'markContinuityCandidateIfNoTerminalOutbound');
    const replay = vi.spyOn(turn.state, 'replayTurnOnFallback')
      .mockRejectedValue(new Error('fallback spawn failed'));

    expect(turn.state.scheduleFallbackReplay({
      activation: activation(),
      chatJid: turn.jid,
      mapKey: turn.jid,
      oldSession: null,
      hadToolActivity: false,
    })).toBe(true);
    expect(replay).toHaveBeenCalledOnce();
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      notice: noticeFacts(turn, 'backup model could not continue'),
      continuityMarks: markContinuity.mock.calls.map((call) => call[0]),
    }).toEqual({
      notice: notAnswered('status'),
      continuityMarks: [turn.seq],
    });
  });

  // The queue the replay notice goes to can carry a key or chat the turn does
  // not: a queue made under an alias key, the single-scope queue made for another
  // chat, or a queue rebuilt for the replay. Each holds the turn's attributed
  // evidence, so the notice is that turn's op, and its role decides the outcome.
  it('an alias-keyed queue: the replay notice is a status op of the held turn, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'per_chat', queueOwner: { key: ALIAS_KEY } });
    vi.spyOn(turn.state, 'replayTurnOnFallback').mockRejectedValue(new Error('fallback spawn failed'));

    expect(turn.state.scheduleFallbackReplay({
      activation: activation(),
      chatJid: turn.jid,
      mapKey: turn.jid,
      oldSession: null,
      hadToolActivity: false,
    })).toBe(true);
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'backup model could not continue')).toEqual(notAnswered('status'));
  });

  it('a second chat on the single-scope queue: the replay notice is a status op of that chat\'s held turn, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'singleton', queueOwner: OTHER_CHAT });
    vi.spyOn(turn.state, 'replayTurnOnFallback').mockRejectedValue(new Error('fallback spawn failed'));

    expect(turn.state.scheduleFallbackReplay({
      activation: activation(),
      chatJid: turn.jid,
      oldSession: null,
      hadToolActivity: false,
    })).toBe(true);
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'backup model could not continue')).toEqual(notAnswered('status'));
  });

  it('a rebuilt queue: the replay notice is a status op of the held turn resumed there, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    vi.spyOn(turn.state, 'replayTurnOnFallback').mockImplementation(async (args) => {
      // The replay replaces the session and its queue, then fails to spawn.
      rebuildQueue(turn, (args as { runtimeContext: TurnContext }).runtimeContext);
      throw new Error('fallback spawn failed');
    });

    expect(turn.state.scheduleFallbackReplay({
      activation: activation(),
      chatJid: turn.jid,
      mapKey: turn.jid,
      oldSession: null,
      hadToolActivity: false,
    })).toBe(true);
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      rebuilt: turn.state.chatQueues.get(turn.jid) !== turn.queue,
      notice: noticeFacts(turn, 'backup model could not continue'),
    }).toEqual({
      rebuilt: true,
      notice: notAnswered('status'),
    });
  });

  // The recovery consumer replays a turn only from its recovery job. The failed
  // turn's notices leave it no job, so even once their sends have failed for good
  // and the chat has a live owned session, the consumer claims and dispatches
  // nothing. The dispatch is counted, not run.
  // The supervisor's first scan waits SCAN_INTERVAL_MS (15 s) after setDurability, past the 10 s test timeout.
  it('the recovery consumer: the failed turn leaves no recovery job, so nothing is claimed or dispatched again', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    vi.spyOn(turn.state, 'replayTurnOnFallback').mockRejectedValue(new Error('fallback spawn failed'));

    expect(turn.state.scheduleFallbackReplay({
      activation: activation(),
      chatJid: turn.jid,
      mapKey: turn.jid,
      oldSession: null,
      hadToolActivity: false,
    })).toBe(true);
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);
    const jobs = recoveryJobStatesOf(turn);

    turn.db.raw.prepare("UPDATE outbound_ops SET status = 'failed_permanent' WHERE source_inbound_seq = ?")
      .run(turn.seq);
    ownSession(turn);
    turn.state.sessionEventToolScopes.set(turn.session, turn.jid);
    const dispatch = vi.spyOn(turn.state.runtimeTurnCoordinator, 'processPerChatTurn').mockResolvedValue(undefined);
    const scan = await turn.state.turnRecoverySupervisor.scanOnce();

    expect({
      jobs,
      claimed: scan.claimed,
      dispatches: dispatch.mock.calls.length,
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      jobs: [],
      claimed: 0,
      dispatches: 0,
      terminal: { disposition: 'failed_terminal', delivery: 'none' },
      breaches: 1,
    });
  });

  it('control: a completed turn whose real answer is still submitted is transferred to a recovery owner', async () => {
    const turn = openTurn({ scope: 'per_chat' });

    turn.deliver({ type: 'result', text: ANSWER });
    await settle(turn);

    const answer = opsMatching(turn, 'full answer you asked for');
    expect({
      answer: answer.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
      recoveryJobs: recoveryJobsOf(turn),
    }).toEqual({
      answer: [{ status: 'submitted', evidence: 'answer' }],
      terminal: { disposition: 'transferred_to_recovery_owner', delivery: 'flushed' },
      breaches: 0,
      recoveryJobs: 1,
    });
  });

  it('control: the recovery job of a transferred answer completes when the answer echoes', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    turn.deliver({ type: 'result', text: ANSWER });
    await settle(turn);

    const [answer] = opsMatching(turn, 'full answer you asked for');
    const sent = turn.db.raw.prepare('SELECT wa_message_id AS wa FROM outbound_ops WHERE id = ?')
      .get(answer?.id ?? -1) as { wa: string | null } | undefined;
    turn.engine.matchEcho(sent?.wa ?? 'no message id');

    expect({
      answer: opsMatching(turn, 'full answer you asked for').map((op) => op.status),
      jobs: turn.db.raw.prepare(
        'SELECT state, completion_kind AS completion FROM turn_recovery_jobs WHERE source_inbound_seq = ?',
      ).all(turn.seq),
      inbound: turn.db.raw.prepare(
        'SELECT processing_status AS status, terminal_reason AS reason FROM inbound_events WHERE seq = ?',
      ).get(turn.seq),
    }).toEqual({
      answer: ['echoed'],
      jobs: [{ state: 'completed', completion: 'echo' }],
      inbound: { status: 'complete', reason: 'response_echoed' },
    });
  });
});

// A provider exit of the session serving the active fallback entry moves the
// fallback chain on, and the chat gets a chain-advance notice. Which entry the
// session served is the fallback controller's attribution, which reads the
// configured chain and its stored credentials, so these cases supply its result
// and check that the exit asks for it exactly once, for the exited session, with
// the exit's code and signal as evidence. That attribution, and whether the
// chain advances, is pinned by fallback-process-failure-advance.test.ts.
// Every other gate of the exit path is the runtime's own state: the session
// mapped and owned, the exit naming that manager's generation, and one
// published turn.
describe('a chain-advance notice after a fallback session exits', () => {
  it('advanced to another entry: the notice is a lifecycle op of the exited turn, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    const owner = ownSession(turn);
    const attribution = vi.spyOn(turn.state.fallback, 'recordFallbackTurnProcessFailure').mockReturnValue({
      advanced: true,
      activation: activation(),
      fromProvider: 'codex-cli',
      fromModel: null,
    });
    // The replacement dispatch the advance schedules is not under test.
    vi.spyOn(turn.state, 'scheduleFallbackReplay').mockReturnValue(false);

    turn.state.handlePerChatCrash(turn.jid, turn.jid, exitOf(owner), turn.session);
    await settle(turn);

    expect(noticeFacts(turn, 'is unavailable. Switching to')).toEqual(notAnswered('lifecycle'));
    expect(attribution).toHaveBeenCalledExactlyOnceWith(turn.session, 'process_exit code=1 signal=none');
  });

  it('no alternate entry: the notice is a lifecycle op of the exited turn, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    const owner = ownSession(turn);
    const attribution = vi.spyOn(turn.state.fallback, 'recordFallbackTurnProcessFailure').mockReturnValue({
      advanced: false,
      activation: null,
      fromProvider: 'codex-cli',
      fromModel: null,
    });

    turn.state.handlePerChatCrash(turn.jid, turn.jid, exitOf(owner), turn.session);
    await settle(turn);

    expect(noticeFacts(turn, 'no alternate backup is configured')).toEqual(notAnswered('lifecycle'));
    expect(attribution).toHaveBeenCalledExactlyOnceWith(turn.session, 'process_exit code=1 signal=none');
  });
});

describe('a notice beside a real answer', () => {
  it.each([
    { echo: true, terminal: { disposition: 'finalized_replied', delivery: 'echoed' }, recoveryJobs: 0 },
    { echo: false, terminal: { disposition: 'transferred_to_recovery_owner', delivery: 'flushed' }, recoveryJobs: 1 },
  ])('leaves the answer the only answer evidence, and the outcome follows it (echo=$echo)', async (expected) => {
    const turn = openTurn({ scope: 'per_chat', echo: expected.echo });
    turn.state.noticeExpiredSession(turn.jid, { deferDuringStartup: false });

    turn.deliver({ type: 'result', text: ANSWER });
    await settle(turn);

    const [notice] = opsMatching(turn, 'Previous session expired');
    const [answer] = opsMatching(turn, 'full answer you asked for');
    expect({
      ops: opsOf(turn).length,
      notice: notice === undefined ? 'no notice op' : evidenceOf(turn, notice.id),
      answerOpIds: turn.evidence.at(-1)?.answerOpIds,
      terminal: terminalOf(turn),
      recoveryJobs: recoveryJobsOf(turn),
    }).toEqual({
      ops: 2,
      notice: 'status',
      answerOpIds: [answer?.id],
      terminal: expected.terminal,
      recoveryJobs: expected.recoveryJobs,
    });
  });

  it('a streamed auto-switch notice is a lifecycle op beside the turn\'s answer', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true });

    turn.deliver({ type: 'assistant_text', text: AUTO_SWITCH });
    turn.deliver({ type: 'result', text: ANSWER });
    await settle(turn);

    const answer = opsMatching(turn, 'full answer you asked for');
    expect({
      notice: noticeFacts(turn, 'Model auto-switched'),
      answer: answer.map((op) => evidenceOf(turn, op.id)),
    }).toEqual({
      notice: {
        roles: ['lifecycle'],
        ops: [{ status: 'echoed', evidence: 'lifecycle' }],
        terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
        breaches: 0,
        recoveryJobs: 0,
      },
      answer: ['answer'],
    });
  });

  it('an auto-switch notice on the result path is a lifecycle op', async () => {
    const turn = openTurn({ scope: 'per_chat' });

    turn.deliver({ type: 'result', text: AUTO_SWITCH });
    await settle(turn);

    const facts = noticeFacts(turn, 'Model auto-switched');
    expect({ roles: facts.roles, ops: facts.ops }).toEqual({
      roles: ['lifecycle'],
      ops: [{ status: 'submitted', evidence: 'lifecycle' }],
    });
  });
});

describe('answers stay answers', () => {
  const answerCases: ['per_chat' | 'shared', 'streamed' | 'result'][] = [
    ['per_chat', 'streamed'],
    ['per_chat', 'result'],
    ['shared', 'streamed'],
    ['shared', 'result'],
  ];
  it.each(answerCases)('control, %s %s answer: answer evidence, and the echoed turn is replied', async (scope, kind) => {
    const turn = openTurn({ scope, echo: true });

    if (kind === 'streamed') {
      turn.deliver({ type: 'assistant_text', text: ANSWER });
      turn.deliver(EMPTY);
    } else {
      turn.deliver({ type: 'result', text: ANSWER });
    }
    await settle(turn);

    const answer = opsMatching(turn, 'full answer you asked for');
    expect({
      answer: answer.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      answer: [{ status: 'echoed', evidence: 'answer' }],
      terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
      breaches: 0,
    });
  });

  it.each(['per_chat', 'shared'] as const)(
    'control, %s minimal-mode streamed answer: answer evidence, and the echoed turn is replied',
    async (scope) => {
      const turn = openTurn({ scope, echo: true });
      await inMinimalMode(turn, async () => {
        turn.deliver({ type: 'assistant_text', text: ANSWER });
        turn.deliver(EMPTY);
        await settle(turn);
      });

      const answer = opsMatching(turn, 'full answer you asked for');
      expect({
        answer: answer.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
        terminal: terminalOf(turn),
        breaches: breaches(),
      }).toEqual({
        answer: [{ status: 'echoed', evidence: 'answer' }],
        terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
        breaches: 0,
      });
    },
  );

  // NL routing holds a first line that could still be a route marker. A reply
  // that never completes the line is flushed by the turn's result as the answer.
  it.each(['per_chat', 'shared'] as const)(
    'control, %s: a first line held for a route marker and flushed at turn end is answer evidence, and the echoed turn is replied',
    async (scope) => {
      const turn = openTurn({ scope, echo: true });
      await withNlRouting(turn, async () => {
        turn.deliver({ type: 'assistant_text', text: HELD_FIRST_LINE });
        turn.deliver(EMPTY);
        await settle(turn);
      });

      const tail = opsMatching(turn, 'unfinished marker line');
      expect({
        tail: tail.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
        terminal: terminalOf(turn),
        breaches: breaches(),
      }).toEqual({
        tail: [{ status: 'echoed', evidence: 'answer' }],
        terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
        breaches: 0,
      });
    },
  );

  // A scheduled job on a final-text provider holds its streamed text and
  // delivers the final answer once, at the turn's result.
  it('control: a scheduled turn\'s final answer is answer evidence, and the echoed turn is replied', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true });
    turn.session.getProviderId.mockReturnValue('opencode-cli');
    turn.state.pendingTurnPurpose.set(turn.jid, 'scheduled-agent-job');

    turn.deliver({ type: 'assistant_text', text: ANSWER });
    turn.deliver(EMPTY);
    await settle(turn);

    const answer = opsMatching(turn, 'full answer you asked for');
    expect({
      answer: answer.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      answer: [{ status: 'echoed', evidence: 'answer' }],
      terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
      breaches: 0,
    });
  });

  it('control: an echoed partial answer from a failed attempt does not make the turn replied', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true });

    turn.deliver({ type: 'assistant_text', text: 'Here is the first part of the answer you asked for.' });
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    const partial = opsMatching(turn, 'first part of the answer');
    expect({
      partial: partial.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
      recoveryJobs: recoveryJobsOf(turn),
    }).toEqual({
      partial: [{ status: 'echoed', evidence: 'answer' }],
      terminal: { disposition: 'failed_terminal', delivery: 'none' },
      breaches: 1,
      recoveryJobs: 0,
    });
  });
});

// The poll bridge sends the agent's AskUserQuestion. The text it sends to the
// chat, the details before a poll or the whole question when the poll cannot be
// sent, is the agent's answer, not a notice.
describe('the agent\'s poll question stays an answer', () => {
  it('control: the agent\'s poll question sent as text is answer evidence, and the echoed turn is replied', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true });
    await askPoll(turn, POLL_NOT_SENT, POLL_OPTIONS);

    turn.deliver(EMPTY);
    await settle(turn);

    const question = opsMatching(turn, POLL_QUESTION);
    expect({
      question: question.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      question: [{ status: 'echoed', evidence: 'answer' }],
      terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
      breaches: 0,
    });
  });

  it('control: the details sent before the agent\'s poll are answer evidence, and the echoed turn is replied', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true });
    await askPoll(turn, POLL_SENT, POLL_DETAILED_OPTIONS);

    turn.deliver(EMPTY);
    await settle(turn);

    const details = opsMatching(turn, 'Details for poll');
    expect({
      details: details.map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      details: [{ status: 'echoed', evidence: 'answer' }],
      terminal: { disposition: 'finalized_replied', delivery: 'echoed' },
      breaches: 0,
    });
  });
});

// A low-signal reply ("voted") while a poll is pending gets a clarification.
// The asking turn has normally ended by then, so the clarification belongs to
// no open turn. If a turn's evidence is still open, the clarification is a
// status op of that turn.
describe('a poll-status clarification is a status line', () => {
  it('a poll-status clarification after the asking turn ended passes the status role', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);
    turn.deliver(EMPTY);
    await settle(turn);

    await turn.state.sendTurnPerChat(turn.jid, 'voted', turn.jid, SENDER_JID, replyContext(turn));

    expect({
      roles: rolesPassed(turn, 'waiting for the poll vote'),
      evidence: opsWithText(turn, 'waiting for the poll vote').map((op) => evidenceOf(turn, op.id)),
    }).toEqual({
      roles: ['status'],
      evidence: ['outside the turn'],
    });
  });

  it('a poll-status clarification while the asking turn is open is a status op of that turn, and the failed turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);

    await turn.state.sendTurnPerChat(turn.jid, 'voted', turn.jid, SENDER_JID, replyContext(turn));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect(noticeFacts(turn, 'waiting for the poll vote')).toEqual(notAnswered('status'));
  });
});

describe('the client output policy counts withheld answers only', () => {
  it('control: a completed turn whose only answer the policy withholds ends finalized_no_reply_policy', async () => {
    const turn = openTurn({ scope: 'per_chat', policy: policyBlocking('zebracorn', nextKey()) });

    turn.deliver({ type: 'result', text: 'Your zebracorn summary is ready.' });
    await settle(turn);

    expect({
      withheld: turn.evidence.at(-1)?.withheldAnswerCount,
      ops: opsOf(turn),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      withheld: 1,
      ops: [],
      terminal: { disposition: 'finalized_no_reply_policy', delivery: 'none' },
      breaches: 0,
    });
  });

  it('a notice the policy withholds is not counted, so the empty turn ends failed_terminal', async () => {
    const turn = openTurn({ scope: 'shared', policy: policyBlocking('response', nextKey()) });

    turn.deliver(EMPTY);
    await settle(turn);

    expect({
      roles: rolesPassed(turn, 'no response'),
      withheld: turn.evidence.at(-1)?.withheldAnswerCount,
      ops: opsOf(turn),
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      roles: ['status'],
      withheld: 0,
      ops: [],
      terminal: { disposition: 'failed_terminal', delivery: 'none' },
      breaches: 1,
    });
  });

  it('control: a withheld answer on a failed attempt does not make the turn a policy outcome', async () => {
    const turn = openTurn({ scope: 'per_chat', echo: true, policy: policyBlocking('zebracorn', nextKey()) });

    turn.deliver({ type: 'assistant_text', text: 'The zebracorn draft is half done.' });
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      withheld: turn.evidence.at(-1)?.withheldAnswerCount,
      terminal: terminalOf(turn),
      breaches: breaches(),
    }).toEqual({
      withheld: 1,
      terminal: { disposition: 'failed_terminal', delivery: 'none' },
      breaches: 1,
    });
  });
});
