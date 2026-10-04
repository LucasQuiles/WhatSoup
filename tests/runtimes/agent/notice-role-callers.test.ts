// A notice from a runtime caller is a status op, never the turn's answer.
//
// The runtime and its command, routing, model-pin and poll-bridge collaborators
// send status lines to a chat through one runtime method, sendDirect, which
// hands the text and its role to the chat's queue. Each case drives one caller
// through its real entry point and reads the role in up to three places: the
// role the runtime's sendDirect received (the boundary), the role the queue was
// handed, and, where a turn of the chat is open, the evidence list the queue
// filed the durable op under when the finalizer flushed that turn. A case that
// reads fewer, or calls a host's send itself, says why.
//
// Harness: lib/notice-turn-harness.ts, shared with
// notice-answer-evidence.test.ts. The boundary is read with a call-through spy
// on the runtime instance. The checkpoint-adoption notices of a session's first
// turn are read at the same boundary by lazy-checkpoint-adoption.test.ts, which
// drives them with the module doubles those paths need.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IncomingMessage } from '../../../src/core/types.ts';
import { ensureChatPreferenceSchema } from '../../../src/runtimes/agent/chat-preference-db.ts';
import { ensureHandoffArtifactSchema } from '../../../src/runtimes/agent/handoff-artifact.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  type StopTeardownReport,
  isStopTeardownInFlight,
  runStopCommand,
} from '../../../src/runtimes/agent/runtime-stop-command.ts';
import { ensureStandbyNoticeSchema } from '../../../src/runtimes/agent/standby-notice.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import { context } from './lib/runtime-terminal-coordinator-harness.ts';
import {
  type Turn,
  DIAL,
  EMPTY,
  POLL_OPTIONS,
  POLL_SENT,
  SENDER_JID,
  UNKNOWN_TERMINAL,
  askPoll,
  failed,
  mutableConfig,
  notAnswered,
  noticeFacts,
  openTurn,
  openTurns,
  opsWithText,
  ownSession,
  replyContext,
  rolesPassed,
  settle,
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

const STDIN_TIMEOUT = 'STDIN_WRITE_TIMEOUT: child stdin stalled';
const PIN_RECEIPT = '_This chat now runs on the backup route. Reply keep to make it permanent._';

/** The runtime members the callers' entry points need, beyond the shared harness view. */
type CallerRuntime = Turn['state'] & {
  _handleMessageInner(msg: IncomingMessage): Promise<void>;
  turnChain: Promise<void>;
  resolvePerChatMapKey(chatJid: string): string;
  agentProvider: string;
  handlePendingPollSoftExpiry(mapKey: string, pending: unknown): void;
  handlePendingPollHardExpiry(mapKey: string, pending: unknown): void;
  modelPinHost: { sendDirectWithReceipt(chatJid: string, text: string, role: 'status'): Promise<unknown> };
};

function callers(turn: Turn): CallerRuntime {
  return turn.state as unknown as CallerRuntime;
}

/** The runtime's sendDirect, spied with its real behaviour kept: the boundary every caller goes through. */
function boundary(turn: Turn) {
  return vi.spyOn(turn.runtime as unknown as { sendDirect: (...args: unknown[]) => void }, 'sendDirect');
}

/** The chat and the role of every boundary call whose text contains `fragment`. */
function rolesAt(spy: { mock: { calls: unknown[][] } }, fragment: string): unknown[][] {
  return spy.mock.calls
    .filter((call) => String(call[1]).includes(fragment))
    .map((call) => [call[0], call[2]]);
}

/** Waits until every op whose text contains `fragment` is sent, so no send outlives the case's database. */
async function sent(turn: Turn, fragment: string): Promise<void> {
  await vi.waitFor(() => {
    const ops = opsWithText(turn, fragment);
    if (ops.length === 0 || ops.some((op) => op.status !== 'submitted')) {
      throw new Error(`the ops for "${fragment}" are not sent yet`);
    }
  }, { timeout: 8_000, interval: 10 });
}

/** An inbound text from the turn's chat, as ingest hands it to the runtime. */
function inbound(turn: Turn, content: string): IncomingMessage {
  return {
    messageId: `wamid-${turn.turnId}-inbound`,
    chatJid: turn.jid,
    senderJid: SENDER_JID,
    senderName: null,
    content,
    contentText: null,
    contentType: 'text',
    isFromMe: false,
    isGroup: false,
    mentionedJids: [],
    timestamp: 1_780_000_000,
    quotedMessageId: null,
    isResponseWorthy: true,
  };
}

/**
 * A per-chat turn still open, with the chat's session mapped and owned as a
 * spawn leaves it. A command from the chat finds the session in place, so the
 * runtime's own session-and-queue check creates nothing.
 */
function openCommandTurn(): Turn {
  const turn = openTurn({ scope: 'per_chat' });
  ownSession(turn);
  return turn;
}

/** Runs one step with the routing aliases (/model, /reset) recognized, as agentOptions.nlRouting turns them on. */
async function withRoutingAliases(run: () => Promise<void>): Promise<void> {
  const prior = mutableConfig.nlRouting;
  mutableConfig.nlRouting = true;
  try {
    await run();
  } finally {
    mutableConfig.nlRouting = prior;
  }
}

/**
 * Holds the /stop teardown guard of one scope, as a /stop whose teardown
 * outlived its bounded wait leaves it (runtime-stop-command.test.ts, the
 * isStopTeardownInFlight cases). Returns the release, which waits for the guard
 * to clear.
 */
async function holdStopGuard(scopeKey: string): Promise<() => Promise<void>> {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const outcome = await runStopCommand<object, StopTeardownReport>({
    chatJid: scopeKey,
    sessionScope: 'per_chat',
    scopeKey,
    perChatMapKey: scopeKey,
    teardownTimeoutMs: 5,
    isTurnInFlight: () => true,
    isOutboundQueuePoisoned: () => false,
    isSessionProvablyTerminated: () => true,
    getPerChatSession: () => undefined,
    abortPerChatQueue: () => {},
    disposePerChatSession: async () => {},
    getSingleSession: () => null,
    abortActiveQueue: () => {},
    terminalizeTurnForInterrupt: async () => {
      await gate;
      return {};
    },
    retireTurnQueueAfterInterrupt: async () => {},
    shutdownOperationTracker: () => {},
    cleanupGlobalAutoCompactState: () => {},
    shutdownSingleSession: async () => {},
    clearSingleScopeRefs: () => {},
    clearTurnHadVisibleOutput: () => {},
    sendDirect: () => {},
  });
  if (outcome !== 'uncertain' || !isStopTeardownInFlight(scopeKey)) {
    throw new Error(`the /stop guard of ${scopeKey} is not held (${outcome})`);
  }
  return async () => {
    open();
    await vi.waitFor(() => {
      if (isStopTeardownInFlight(scopeKey)) throw new Error(`the /stop guard of ${scopeKey} is still held`);
    });
  };
}

/** The open shared turn as the shared FIFO holds it before dispatch: its journaled inbound and immutable context. */
function queuedTurn(turn: Turn): QueuedTurn {
  const runtimeContext = context('shared', turn.key, turn.seq, turn.turnId);
  return {
    sourceMessageId: runtimeContext.replay.sourceMessageId,
    receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
    conversationKey: turn.key,
    chatJid: turn.jid,
    senderJid: runtimeContext.replay.senderJid,
    senderName: null,
    text: runtimeContext.replay.text,
    isGroup: false,
    contentType: 'text',
    runtimeContext,
    inboundSeq: turn.seq,
  };
}

/**
 * A single-scope turn journaled but not yet dispatched: the runtime's one queue
 * is new, with no turn evidence begun, and no turn is current. Dispatch begins
 * the turn's evidence under the context it mints for the inbound.
 */
function undispatchedSingleTurn(): Turn {
  const turn = openTurn({ scope: 'singleton' });
  const queue = new OutboundQueue(turn.messenger, turn.jid, { conversationKey: turn.key });
  queue.setDurability(turn.engine);
  turn.watch(queue);
  turn.state.queue = queue;
  turn.state.currentRuntimeTurnContext = null;
  turn.state.currentInboundSeq = undefined;
  turn.state.currentTurnChatJid = null;
  return turn;
}

beforeEach(() => {
  emitAlert.mockClear();
  delete process.env[DIAL];
});

afterEach(() => {
  delete process.env[DIAL];
  vi.restoreAllMocks();
  for (const turn of openTurns.splice(0)) turn.close();
});

describe('a notice about a failed dispatch is a status op of the turn it failed', () => {
  // M-ANS-5703 (commit 2 RT:5704). The shared FIFO dispatches the open turn and
  // the provider's stdin write times out: the runtime tells the chat, and the
  // processor error ends the turn, whose only op is that notice.
  it('shared: the stdin-timeout notice is a status op of the dispatched turn, which ends failed_terminal with a breach', async () => {
    const turn = openTurn({ scope: 'shared' });
    turn.session.sendTurn.mockRejectedValue(new Error(STDIN_TIMEOUT));
    const sendDirect = boundary(turn);

    const admitted = turn.state.turnQueue.enqueue(queuedTurn(turn));
    await turn.state.turnQueue.idle();
    await settle(turn);

    expect({
      admitted,
      boundary: rolesAt(sendDirect, 'Agent is not responding'),
      notice: noticeFacts(turn, 'Agent is not responding'),
    }).toEqual({
      admitted: true,
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-6010 (RT:6011) and M-ANS-4892 (RT:4893). The single-scope runtime
  // dispatches inside its turn chain and the stdin write times out after the
  // turn's evidence opened: the dispatch tells the chat, then the chain's
  // failure handler ends the turn and tells the chat again. The second notice is
  // sent while the finalizer flushes the turn, so only its role is read.
  it('single: the stdin-timeout notice is a status op of the dispatched turn, which ends failed_terminal with a breach, and the turn-chain failure notice passes the status role', async () => {
    const turn = undispatchedSingleTurn();
    turn.session.sendTurn.mockRejectedValue(new Error(STDIN_TIMEOUT));
    const sendDirect = boundary(turn);

    await turn.runtime.handleMessage({
      ...inbound(turn, 'please check my notes'),
      messageId: `wamid-${turn.turnId}`,
      inboundSeq: turn.seq,
      journaledConversationKey: turn.key,
    });
    await callers(turn).turnChain;
    await settle(turn);

    expect({
      boundary: [
        ...rolesAt(sendDirect, 'Agent is not responding'),
        ...rolesAt(sendDirect, 'went wrong processing that message'),
      ],
      dispatchNotice: noticeFacts(turn, 'Agent is not responding'),
      chainNotice: rolesPassed(turn, 'went wrong processing that message'),
    }).toEqual({
      boundary: [[turn.jid, 'status'], [turn.jid, 'status']],
      dispatchNotice: notAnswered('status'),
      chainNotice: ['status'],
    });
  });

  // M-ANS-6306 (RT:6308). A turn whose chat still has no session after the
  // spawn attempt is refused before dispatch, and the chat is told. The wording
  // reads the provider's credential state, so the runtime runs a provider with
  // no keyring service, whose state does not depend on this host's sign-in. In
  // production no turn of the chat is open at that point, so the case reads the
  // boundary and the queue, not the harness turn's evidence.
  it('a chat with no session after the spawn attempt: the session-start notice passes the status role', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    callers(turn).agentProvider = 'codex-cli';
    // The spawn attempt maps no session.
    callers(turn).ensureSessionAndQueueSync = vi.fn();
    const sendDirect = boundary(turn);

    await turn.state.sendTurnPerChat(turn.jid, 'please check my notes', turn.jid, SENDER_JID, replyContext(turn));
    await sent(turn, 'went wrong starting a session');

    expect({
      boundary: rolesAt(sendDirect, 'went wrong starting a session'),
      queued: rolesPassed(turn, 'went wrong starting a session'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      queued: ['status'],
    });
  });
});

describe('a local command reply is a status op of the open turn', () => {
  // M-ANS-5020 (RT:5021). /sessions is admin-gated and no admin is configured.
  it('/sessions from a sender who is not an admin: the refusal is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    const sendDirect = boundary(turn);

    await callers(turn)._handleMessageInner(inbound(turn, '/sessions'));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'Not authorized'),
      notice: noticeFacts(turn, 'Not authorized'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-5228 (RT:5229).
  it('/status: the reply is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    ensureAgentSchema(turn.db);
    const sendDirect = boundary(turn);

    await callers(turn)._handleMessageInner(inbound(turn, '/status'));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'Session active'),
      notice: noticeFacts(turn, 'Session active'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-5270 (RT:5271).
  it('/help: the reply is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    const sendDirect = boundary(turn);

    await callers(turn)._handleMessageInner(inbound(turn, '/help'));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'Any other message is forwarded'),
      notice: noticeFacts(turn, 'Any other message is forwarded'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-5371 (RT:5372). The /status handler's session read throws once.
  it('/status whose handler throws: the command-failure notice is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    turn.session.getStatus.mockImplementationOnce(() => {
      throw new Error('status read failed');
    });
    const sendDirect = boundary(turn);

    await callers(turn)._handleMessageInner(inbound(turn, '/status'));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'went wrong processing that command'),
      notice: noticeFacts(turn, 'went wrong processing that command'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-5039 (RT:5040).
  it('/new while a /stop teardown is unsettled: the refusal is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    const release = await holdStopGuard(callers(turn).resolvePerChatMapKey(turn.jid));
    try {
      const sendDirect = boundary(turn);

      await callers(turn)._handleMessageInner(inbound(turn, '/new'));
      turn.deliver(failed(UNKNOWN_TERMINAL));
      await settle(turn);

      expect({
        boundary: rolesAt(sendDirect, 'its outcome is not yet proven'),
        notice: noticeFacts(turn, 'its outcome is not yet proven'),
      }).toEqual({
        boundary: [[turn.jid, 'status']],
        notice: notAnswered('status'),
      });
    } finally {
      await release();
    }
  });

  // M-ANS-5353 (RT:5354), with M-ANS-5039 again. The refused /new carries a
  // follow-up message, which is refused too.
  it('/new with a follow-up while a /stop teardown is unsettled: the refusal and the follow-up refusal are status ops of the open turn', async () => {
    const turn = openCommandTurn();
    const release = await holdStopGuard(callers(turn).resolvePerChatMapKey(turn.jid));
    try {
      const sendDirect = boundary(turn);

      await callers(turn)._handleMessageInner(inbound(turn, '/new\nsummarize the thread so far'));
      turn.deliver(failed(UNKNOWN_TERMINAL));
      await settle(turn);

      expect({
        boundary: [
          ...rolesAt(sendDirect, 'its outcome is not yet proven'),
          ...rolesAt(sendDirect, 'Your follow-up message was not sent'),
        ],
        refusal: noticeFacts(turn, 'its outcome is not yet proven'),
        followUpRefusal: noticeFacts(turn, 'Your follow-up message was not sent'),
      }).toEqual({
        boundary: [[turn.jid, 'status'], [turn.jid, 'status']],
        refusal: notAnswered('status'),
        followUpRefusal: notAnswered('status'),
      });
    } finally {
      await release();
    }
  });

  // M-PORT-STOP (RT:5155): /stop's host forwards the role its acknowledgement names.
  it('/stop while a /stop teardown is unsettled: the acknowledgement through the stop host is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    const release = await holdStopGuard(callers(turn).resolvePerChatMapKey(turn.jid));
    try {
      const sendDirect = boundary(turn);

      await callers(turn)._handleMessageInner(inbound(turn, '/stop'));
      turn.deliver(failed(UNKNOWN_TERMINAL));
      await settle(turn);

      expect({
        boundary: rolesAt(sendDirect, 'Stop already in progress'),
        notice: noticeFacts(turn, 'Stop already in progress'),
      }).toEqual({
        boundary: [[turn.jid, 'status']],
        notice: notAnswered('status'),
      });
    } finally {
      await release();
    }
  });

  // M-PORT-NEW (RT:5102): /new's host forwards the role its acknowledgement
  // names. The interrupt tears the open turn down and retires the chat's queue
  // before the acknowledgement, which then goes to the transport directly, so
  // only its boundary role can be read. The reset clears the hand-off latches,
  // whose tables the runtime creates at start.
  it('/new mid-turn: the acknowledgement through the new-command host passes the status role', async () => {
    const turn = openCommandTurn();
    ensureStandbyNoticeSchema(turn.db);
    ensureHandoffArtifactSchema(turn.db);
    const sendDirect = boundary(turn);

    await callers(turn)._handleMessageInner(inbound(turn, '/new'));
    await turn.state.runtimeTurnCoordinator.awaitActiveFinalizations();

    expect({
      boundary: rolesAt(sendDirect, 'Interrupted the running task'),
      queued: rolesPassed(turn, 'Interrupted the running task'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      queued: [],
    });
  });

  // M-PORT-MP (RT:2831 and RT:2833): the model-pin host forwards the role each
  // send names. The preference table is created by the runtime at start.
  it('/model status: the route readout through the model-pin host is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    ensureChatPreferenceSchema(turn.db);
    const sendDirect = boundary(turn);

    await withRoutingAliases(() => callers(turn)._handleMessageInner(inbound(turn, '/model status')));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'routing never changes what I am allowed to do'),
      notice: noticeFacts(turn, 'routing never changes what I am allowed to do'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-PORT-MP (RT:2833), by the D-PORT fallback: a pin receipt goes out only
  // after a route switch recycles the live session, so the case calls the
  // model-pin host's receipt send itself. The boundary is the runtime's own
  // receipt send, and the queue path accepts with no message id.
  it('the model-pin host\'s receipt send: the receipt is a status op of the open turn', async () => {
    const turn = openCommandTurn();
    const receipt = vi.spyOn(
      turn.runtime as unknown as { sendDirectWithReceipt: (...args: unknown[]) => Promise<unknown> },
      'sendDirectWithReceipt',
    );

    const outcome = await callers(turn).modelPinHost.sendDirectWithReceipt(turn.jid, PIN_RECEIPT, 'status');
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      outcome,
      boundary: rolesAt(receipt, PIN_RECEIPT),
      notice: noticeFacts(turn, PIN_RECEIPT),
    }).toEqual({
      outcome: { accepted: true, messageId: null },
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-PORT-RO (RT:2969): the routing host forwards the role its confirmation
  // names. Clearing the preference defers a route recycle while the turn is
  // open, and the turn's result would run it against the stub session, so the
  // case does not end the turn: it reads the boundary and the queue.
  it('/reset: the confirmation through the routing host passes the status role', async () => {
    const turn = openCommandTurn();
    ensureChatPreferenceSchema(turn.db);
    const sendDirect = boundary(turn);

    await withRoutingAliases(() => callers(turn)._handleMessageInner(inbound(turn, '/reset')));
    await sent(turn, 'Back to the default route');

    expect({
      boundary: rolesAt(sendDirect, 'Back to the default route'),
      queued: rolesPassed(turn, 'Back to the default route'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      queued: ['status'],
    });
  });
});

describe('a poll-bridge notice is a status op', () => {
  // M-ANS-6180 (RT:6181). The chat's queue was retired while its poll stayed
  // pending, so the clarification goes to the transport directly and only its
  // boundary role can be read.
  it('a low-signal reply to a pending poll whose chat has no queue: the clarification passes the status role', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);
    turn.deliver(EMPTY);
    await settle(turn);
    turn.state.chatQueues.delete(turn.jid);
    const sendDirect = boundary(turn);

    await turn.state.sendTurnPerChat(turn.jid, 'voted', turn.jid, SENDER_JID, replyContext(turn));

    expect({
      boundary: rolesAt(sendDirect, 'waiting for the poll vote'),
      queued: rolesPassed(turn, 'waiting for the poll vote'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      queued: [],
    });
  });

  // M-ANS-PB155 and M-PORT-PB (PB:155, through RT:3107). The answer's
  // continuation cannot be dispatched because the chat has no session, so the
  // bridge abandons it and asks again. The asking turn has ended, so the notice
  // is read at the boundary and the queue.
  it('a poll answer whose continuation cannot be dispatched: the retry notice passes the status role', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);
    turn.deliver(EMPTY);
    await settle(turn);
    const sendDirect = boundary(turn);

    const continuation = await turn.state.sendTurnPerChat(turn.jid, 'Work', turn.jid, SENDER_JID, replyContext(turn))
      .then(() => 'continued', (err: unknown) => (err instanceof Error ? err.message : String(err)));
    await sent(turn, 'could not continue it safely');

    expect({
      continuation,
      boundary: rolesAt(sendDirect, 'could not continue it safely'),
      queued: rolesPassed(turn, 'could not continue it safely'),
    }).toEqual({
      continuation: 'Cannot inject poll answers without a current session',
      boundary: [[turn.jid, 'status']],
      queued: ['status'],
    });
  });

  // M-ANS-PB342 and M-PORT-PB (PB:345). No vote came before the soft expiry, so
  // the bridge asks the question again as text. The agent is still waiting on
  // the answer, so the asking turn is open and the resend is its op.
  it('a poll soft-expiring while the asking turn is open: the resent question is a status op of that turn', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);
    const sendDirect = boundary(turn);

    callers(turn).handlePendingPollSoftExpiry(turn.jid, turn.state.pendingPolls.questions.get(turn.jid));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'I did not receive the poll vote'),
      notice: noticeFacts(turn, 'I did not receive the poll vote'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });

  // M-ANS-PB520 and M-PORT-PB (PB:524).
  it('a poll hard-expiring while the asking turn is open: the expiry notice is a status op of that turn', async () => {
    const turn = openTurn({ scope: 'per_chat' });
    await askPoll(turn, POLL_SENT, POLL_OPTIONS);
    const sendDirect = boundary(turn);

    callers(turn).handlePendingPollHardExpiry(turn.jid, turn.state.pendingPolls.questions.get(turn.jid));
    turn.deliver(failed(UNKNOWN_TERMINAL));
    await settle(turn);

    expect({
      boundary: rolesAt(sendDirect, 'This decision has expired'),
      notice: noticeFacts(turn, 'This decision has expired'),
    }).toEqual({
      boundary: [[turn.jid, 'status']],
      notice: notAnswered('status'),
    });
  });
});
