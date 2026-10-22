/**
 * Shared harness for the notice-role suites, notice-answer-evidence.test.ts and
 * notice-role-callers.test.ts.
 *
 * One journaled user turn on a REAL AgentRuntime, with the REAL runtime turn
 * coordinator and finalizer, a REAL OutboundQueue and REAL SQLite durability,
 * and the readers that report what a turn's notices left behind. The runtime's
 * private turn state is set through the coordinator integration harness
 * (runtime-terminal-coordinator-harness.ts).
 *
 * Hoisted mocks and vi.mock declarations stay in each test file (Vitest
 * hoisting requirement). Each file mocks src/lib/emit-alert.ts so that
 * emitAlert and emitAlertChecked are one mock, which breaches() reads.
 */
import { vi } from 'vitest';

import { Database } from '../../../../src/core/database.ts';
import { DurabilityEngine } from '../../../../src/core/durability.ts';
import type { Messenger } from '../../../../src/core/types.ts';
import { GLOBAL_CONVERSATION_KEY } from '../../../../src/core/conversation-key.ts';
import {
  parseClientOutputPolicies,
  type ClientOutputPolicyRegistry,
} from '../../../../src/core/client-output-policy-config.ts';
import { emitAlertChecked } from '../../../../src/lib/emit-alert.ts';
import { OutboundQueue, type TurnDeliveryEvidence } from '../../../../src/runtimes/agent/outbound-queue.ts';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { runSessionsCommand } from '../../../../src/runtimes/agent/runtime-session-lifecycle.ts';
import {
  type RuntimeState,
  context,
  makeRuntimeState,
  replyGuaranteeMock,
  sessionStub,
} from './runtime-terminal-coordinator-harness.ts';

// The test file's mock of emit-alert.ts, where emitAlert and emitAlertChecked
// are the same function, so every alert the runtime raised is recorded here.
const emitAlert = vi.mocked(emitAlertChecked);

// The one-message hand-off flag, the tool update mode and the NL routing flag
// live on the real config object; the cases that need them flip the field
// directly and restore it.
import { config as runtimeConfig } from '../../../../src/config.ts';

export const mutableConfig = runtimeConfig as unknown as {
  oneMessageHandoff: boolean;
  toolUpdateMode: 'full' | 'friendly' | 'minimal';
  nlRouting: boolean;
};

export const DIAL = 'WHATSOUP_RESPONSE_REGISTRY_DISPATCH';
const BREACH_SOURCE = 'agent_reply_guarantee_breach';
const SETTLE = { timeout: 8_000, interval: 10 };

// Provider texts each failure class is classified from.
export const USAGE_LIMIT = 'Claude usage limit reached. Your limit will reset at 3pm.';
export const SERVER_ERROR = 'API Error 503: Service temporarily unavailable. overloaded_error';
export const RATE_LIMIT = 'API Error 429: rate limit exceeded';
export const MODEL_UNAVAILABLE = "There's an issue with the selected model (missing-model). It may not exist or you may not have access to it.";
export const AUTH_REQUIRED = 'Authentication required. Sign in to continue.';
export const CONTEXT_OVERFLOW = 'Error: prompt is too long for the context window';
export const SOCKET_DROP = 'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';
export const UNKNOWN_TERMINAL = 'Unexpected provider explosion exposing internal-detail-xyz';
export const AUTO_SWITCH = 'Switched to Opus 4.7 due to high demand for Opus 4.8';
export const ANSWER = 'Here is the full answer you asked for, with the figures checked.';
export const NARRATION = 'Let me look that up in your notes before I reply.';
// A first line that could still grow into a route marker, so the scan holds it
// until the turn's result flushes it.
export const HELD_FIRST_LINE = '[[wa-route: unfinished marker line, then the answer you asked for';
export const SENDER_JID = '15550190002@s.whatsapp.net';
// A second key for the turn's own chat (an alias), and a second chat. Each owns a
// queue that the turn did not create.
export const ALIAS_KEY = '15550190004';
export const OTHER_CHAT = { key: '15550190003', jid: '15550190003@s.whatsapp.net' };

// The agent's AskUserQuestion. The detailed options carry a multi-line
// description, so the poll bridge sends a details text before the poll.
export const POLL_QUESTION = 'Which notebook should I file this under?';
export const POLL_OPTIONS = [
  { label: 'Work', description: 'Projects and meetings' },
  { label: 'Home', description: 'Household and family' },
];
export const POLL_DETAILED_OPTIONS = [
  { label: 'Work', description: 'Projects and meetings' },
  { label: 'Archive', description: 'Everything finished this year,\nfiled by month so it stays searchable later.' },
];
/** The transport's answer to a poll send: a sent poll, or a failed one (the bridge then asks in text). */
type PollSend = { waMessageId: string | null; hasSecret: boolean };
export const POLL_SENT: PollSend = { waMessageId: 'wa-poll-1', hasSecret: true };
export const POLL_NOT_SENT: PollSend = { waMessageId: null, hasSecret: false };

export type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

export const failed = (text: string): ResultEvent => ({ type: 'result', text, isError: true });
export const EMPTY: ResultEvent = { type: 'result', text: null };

export type TurnContext = ReturnType<typeof context>;

/** What the fallback controller reports when the session serving its active entry exits. */
type ProcessFailure = {
  advanced: boolean;
  activation: ReturnType<typeof activation> | null;
  fromProvider: string;
  fromModel: string | null;
};

// The runtime members these cases reach, beyond the harness view.
type NoticeRuntime = RuntimeState & {
  session: ReturnType<typeof sessionStub> | null;
  fallbackWindow: { isActive(): boolean };
  fallback: {
    emitNoFallbackReauthNotice(queue: OutboundQueue, scheduled?: boolean): void;
    recordFallbackTurnProcessFailure(session: unknown, evidence: string): ProcessFailure | null;
  };
  noticeExpiredSession(chatJid: string, opts: { deferDuringStartup: boolean }): void;
  handleCrashNotify(msg: string, chatJid?: string): void;
  sessionLifecycleHost: Parameters<typeof runSessionsCommand>[0];
  /** The transport the poll bridge sends polls through. */
  messenger: { sendPollMessage?: (...args: unknown[]) => Promise<PollSend> };
  pendingPolls: { questions: Map<string, { hardExpiryTimer?: unknown }> };
  deletePendingPollQuestions(mapKey: string): void;
  perChatRouteMarkerHold: Map<string, string>;
  currentTurnRouteMarkerHold: string | null;
  pendingTurnPurpose: Map<string, string>;
  /** The single-scope session's one queue, and the text a fallback replay of its turn resends. */
  queue: OutboundQueue | null;
  currentTurnReplayText: string | null;
  runtimeTurnCoordinator: {
    resumeRuntimeTurnOnRebuiltQueue(queue: OutboundQueue, turnContext: TurnContext): void;
    /** The per-chat dispatch a recovery replay goes through. */
    processPerChatTurn(...args: unknown[]): Promise<void>;
  };
  /** The recovery consumer: one scan claims and replays every eligible recovery job. */
  turnRecoverySupervisor: { scanOnce(): Promise<{ claimed: number }> };
};

/** The single/shared event entry, which takes the source session first. */
type GlobalEventEntry = { handleEvent(sourceSession: object, event: AgentEvent): void };

/** One text the runtime handed the queue, with the role argument it passed. */
type Enqueued = { text: string; role: string };

type OpRow = { id: number; status: string; text: string };

interface TurnOptions {
  readonly scope: 'per_chat' | 'shared' | 'singleton';
  /** Record the transport's echo as soon as a send is submitted. */
  readonly echo?: boolean;
  readonly policy?: ClientOutputPolicyRegistry;
  /**
   * The key and chat the turn's queue was made for, when they are not the
   * turn's own (an omitted chat is the turn's). A queue's key is fixed when it is
   * made; dispatch retargets it to the turn's chat and begins the turn's
   * evidence under the turn's own key and chat.
   */
  readonly queueOwner?: { readonly key: string; readonly jid?: string };
}

let keyOrdinal = 0;
export const openTurns: Array<{ close(): void }> = [];

function keyFor(ordinal: number): string {
  return `15550194${String(ordinal).padStart(3, '0')}`;
}

/** The key the next openTurn will mint, for a policy that must exist before the queue. */
export function nextKey(): string {
  return keyFor(keyOrdinal + 1);
}

/**
 * One journaled user turn, dispatched and still open: its evidence is begun on
 * a real queue that the runtime routes the turn's output to.
 */
export function openTurn(options: TurnOptions) {
  keyOrdinal += 1;
  const key = keyFor(keyOrdinal);
  const jid = `${key}@s.whatsapp.net`;
  const turnId = `turn-notice-${keyOrdinal}`;
  const db = new Database(':memory:');
  db.open();
  const engine = new DurabilityEngine(db);
  const seq = engine.journalInbound(`wamid-${turnId}`, key, jid, 'agent');
  if (options.echo === true) {
    const markSubmitted = engine.markSubmitted.bind(engine);
    vi.spyOn(engine, 'markSubmitted').mockImplementation((id, waMessageId, logicalAttemptCount) => {
      markSubmitted(id, waMessageId, logicalAttemptCount);
      if (waMessageId !== null) engine.matchEcho(waMessageId);
    });
  }
  let sends = 0;
  const messenger: Messenger = {
    sendMessage: vi.fn(async () => {
      sends += 1;
      return { waMessageId: `wa-${key}-${sends}` };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
  };
  const queue = new OutboundQueue(messenger, options.queueOwner?.jid ?? jid, {
    conversationKey: options.queueOwner?.key ?? key,
    ...(options.policy === undefined ? {} : { clientOutputPolicies: options.policy }),
  });
  queue.setDurability(engine);
  queue.setInboundSeq(seq);
  if (options.queueOwner === undefined) {
    queue.beginTurnEvidence(turnId);
  } else {
    queue.updateDeliveryJid(jid);
    queue.beginTurnEvidence(turnId, { conversationKey: key, chatJid: jid });
  }

  const { runtime, state } = makeRuntimeState<NoticeRuntime>(
    db,
    options.scope === 'per_chat'
      ? { sessionScope: 'per_chat' }
      : options.scope === 'shared' ? { shared: true } : undefined,
  );
  runtime.setDurability(engine);
  state.replyGuarantee = replyGuaranteeMock();
  // The tool-use cases need the session's tool tracking, which the shared stub leaves out.
  const session = { ...sessionStub(), trackToolStart: vi.fn(), trackToolEnd: vi.fn() };
  const turnContext = context(options.scope, key, seq, turnId);
  if (options.scope === 'per_chat') {
    // A per-chat map key is the canonical chat JID, so a direct send to the
    // chat resolves the same queue.
    state.chatQueues.set(jid, queue);
    state.perChatRuntimeTurnContexts.set(jid, [turnContext]);
    state.perChatInboundSeqQueue.set(jid, [seq]);
    state.pendingTurnText.set(jid, turnContext.replay.text);
  } else {
    state.session = session;
    state.sessionEventToolScopes.set(session, GLOBAL_CONVERSATION_KEY);
    state.currentRuntimeTurnContext = {
      ...turnContext,
      identity: { ...turnContext.identity, managerId: state.managerIdFor(session), generation: 1 },
    };
    state.currentInboundSeq = seq;
    state.currentTurnChatJid = jid;
    state.activeChatJid = jid;
    state.turnHadVisibleOutput = false;
    if (options.scope === 'shared') {
      state.outboundQueues.set(jid, queue);
    } else {
      state.queue = queue;
      state.currentTurnReplayText = turnContext.replay.text;
    }
  }

  // The evidence the finalizer read, captured as each queue hands it over.
  const evidence: TurnDeliveryEvidence[] = [];
  // Every text the runtime hands a queue, with its role argument. A queue
  // forwards a result text to its own enqueueText; that forward is not a second
  // text from the runtime, so it is not recorded.
  const enqueued: Enqueued[] = [];
  /** Records one queue's evidence flushes and enqueued texts into the turn's lists. */
  const watch = (watched: OutboundQueue): void => {
    const flushTurnEvidence = watched.flushTurnEvidence.bind(watched);
    vi.spyOn(watched, 'flushTurnEvidence').mockImplementation(async (id) => {
      const flushed = await flushTurnEvidence(id);
      evidence.push(flushed);
      return flushed;
    });
    let forwarding = 0;
    const record = (text: string, role: string | undefined): void => {
      if (forwarding === 0) enqueued.push({ text, role: role ?? 'no role passed' });
    };
    const enqueueText = watched.enqueueText.bind(watched);
    vi.spyOn(watched, 'enqueueText').mockImplementation((text, ...rest) => {
      record(text, rest[0]);
      enqueueText(text, ...rest);
    });
    const enqueueResultText = watched.enqueueResultText.bind(watched);
    vi.spyOn(watched, 'enqueueResultText').mockImplementation((text, ...rest) => {
      record(text, rest[0]);
      forwarding += 1;
      try {
        return enqueueResultText(text, ...rest);
      } finally {
        forwarding -= 1;
      }
    });
    const enqueueStreamingText = watched.enqueueStreamingText.bind(watched);
    vi.spyOn(watched, 'enqueueStreamingText').mockImplementation((text, ...rest) => {
      record(text, rest[0]);
      enqueueStreamingText(text, ...rest);
    });
  };
  watch(queue);

  const turn = {
    db,
    engine,
    runtime,
    state,
    session,
    queue,
    messenger,
    scope: options.scope,
    key,
    jid,
    seq,
    turnId,
    evidence,
    enqueued,
    watch,
    deliver(event: AgentEvent): void {
      if (options.scope === 'per_chat') {
        state.handleEventWithContext(event, queue, session, key, seq, jid, `${jid}#session`);
      } else {
        (state as unknown as GlobalEventEntry).handleEvent(session, event);
      }
    },
    close(): void {
      // A pending poll holds expiry timers; drop it before the database closes.
      for (const mapKey of [...state.pendingPolls.questions.keys()]) state.deletePendingPollQuestions(mapKey);
      db.close();
    },
  };
  openTurns.push(turn);
  return turn;
}

export type Turn = ReturnType<typeof openTurn>;

export function opsOf(turn: Turn): OpRow[] {
  return turn.db.raw.prepare(
    "SELECT id, status, json_extract(payload, '$.text') AS text FROM outbound_ops WHERE source_inbound_seq = ? ORDER BY id",
  ).all(turn.seq) as OpRow[];
}

/** Every op in the database whose text contains `fragment`, whichever inbound it belongs to. */
export function opsWithText(turn: Turn, fragment: string): OpRow[] {
  return (turn.db.raw.prepare(
    "SELECT id, status, json_extract(payload, '$.text') AS text FROM outbound_ops ORDER BY id",
  ).all() as OpRow[]).filter((op) => (op.text ?? '').includes(fragment));
}

export function terminalOf(turn: Turn): { disposition: string; delivery: string } | null {
  const row = turn.db.raw.prepare(
    'SELECT inbound_disposition AS disposition, delivery_kind AS delivery FROM turn_terminal_records WHERE inbound_seq = ?',
  ).get(turn.seq) as { disposition: string; delivery: string } | undefined;
  return row ?? null;
}

export function recoveryJobsOf(turn: Turn): number {
  return (turn.db.raw.prepare(
    'SELECT COUNT(*) AS n FROM turn_recovery_jobs WHERE source_inbound_seq = ?',
  ).get(turn.seq) as { n: number }).n;
}

export function breaches(): number {
  return emitAlert.mock.calls.filter((call) => call[1] === BREACH_SOURCE).length;
}

/** The evidence list the finalizer saw the op under. */
export function evidenceOf(turn: Turn, opId: number): string {
  const flushed = turn.evidence.at(-1);
  if (!flushed) return 'no evidence flushed';
  if (flushed.answerOpIds.includes(opId)) return 'answer';
  if (flushed.statusOpIds.includes(opId)) return 'status';
  if (flushed.lifecycleOpIds.includes(opId)) return 'lifecycle';
  return 'outside the turn';
}

/** The role argument passed with every enqueued text containing `fragment`. */
export function rolesPassed(turn: Turn, fragment: string): string[] {
  return turn.enqueued.filter((entry) => entry.text.includes(fragment)).map((entry) => entry.role);
}

export function opsMatching(turn: Turn, fragment: string): OpRow[] {
  return opsOf(turn).filter((op) => op.text.includes(fragment));
}

/** Everything one notice left behind, in one object so a failure prints every field. */
export function noticeFacts(turn: Turn, fragment: string) {
  return {
    roles: rolesPassed(turn, fragment),
    ops: opsMatching(turn, fragment).map((op) => ({ status: op.status, evidence: evidenceOf(turn, op.id) })),
    terminal: terminalOf(turn),
    breaches: breaches(),
    recoveryJobs: recoveryJobsOf(turn),
  };
}

/** A turn whose only reply-shaped op is this notice: not answered, no recovery owner. */
export function notAnswered(role: 'status' | 'lifecycle', status: 'submitted' | 'echoed' = 'submitted') {
  return {
    roles: [role],
    ops: [{ status, evidence: role }],
    terminal: { disposition: 'failed_terminal', delivery: 'none' },
    breaches: 1,
    recoveryJobs: 0,
  };
}

/** Waits for the turn's durable terminal, then for every finalization in flight. */
export async function settle(turn: Turn): Promise<void> {
  await vi.waitFor(() => {
    if (terminalOf(turn) === null) throw new Error(`turn ${turn.seq} has no durable terminal yet`);
  }, SETTLE);
  await turn.state.runtimeTurnCoordinator.awaitActiveFinalizations();
}

/** Runs one case with the runtime and the turn's queue in minimal tool-update mode. */
export async function inMinimalMode(turn: Turn, run: () => Promise<void>): Promise<void> {
  const prior = mutableConfig.toolUpdateMode;
  mutableConfig.toolUpdateMode = 'minimal';
  turn.queue.setToolUpdateMode('minimal');
  try {
    await run();
  } finally {
    mutableConfig.toolUpdateMode = prior;
  }
}

/** Runs one case with NL routing on and the turn's first-line marker scan armed, as dispatch arms it. */
export async function withNlRouting(turn: Turn, run: () => Promise<void>): Promise<void> {
  const prior = mutableConfig.nlRouting;
  mutableConfig.nlRouting = true;
  if (turn.scope === 'per_chat') turn.state.perChatRouteMarkerHold.set(turn.jid, '');
  else turn.state.currentTurnRouteMarkerHold = '';
  try {
    await run();
  } finally {
    mutableConfig.nlRouting = prior;
  }
}

/** Asks one AskUserQuestion through the real poll bridge and waits until the bridge has finished. */
export async function askPoll(
  turn: Turn,
  sent: PollSend,
  options: ReadonlyArray<{ label: string; description: string }>,
): Promise<void> {
  turn.state.messenger.sendPollMessage = vi.fn(async () => sent);
  turn.deliver({
    type: 'tool_use',
    toolName: 'AskUserQuestion',
    toolId: `tool-poll-${turn.seq}`,
    toolInput: { questions: [{ question: POLL_QUESTION, header: 'Notebook', options: [...options], multiSelect: false }] },
  });
  // The bridge's last step starts the poll's expiry timers.
  await vi.waitFor(() => {
    if (turn.state.pendingPolls.questions.get(turn.jid)?.hardExpiryTimer === undefined) {
      throw new Error(`the poll of turn ${turn.seq} is still being sent`);
    }
  }, SETTLE);
}

/** A second journaled inbound from the same chat, in the context the FIFO hands the per-chat send. */
export function replyContext(turn: Turn) {
  const replyId = `${turn.turnId}-reply`;
  const replySeq = turn.engine.journalInbound(`wamid-${replyId}`, turn.key, turn.jid, 'agent');
  return context('per_chat', turn.key, replySeq, replyId);
}

/**
 * Rebuilds the turn's per-chat queue as the fallback session replacement does:
 * a new queue under the map key, on which the coordinator resumes the held
 * turn's evidence. The new queue is recorded like the turn's own.
 */
export function rebuildQueue(turn: Turn, held: TurnContext): OutboundQueue {
  const rebuilt = new OutboundQueue(turn.messenger, turn.jid, { conversationKey: turn.key });
  rebuilt.setDurability(turn.engine);
  turn.watch(rebuilt);
  turn.state.chatQueues.set(turn.jid, rebuilt);
  turn.state.runtimeTurnCoordinator.resumeRuntimeTurnOnRebuiltQueue(rebuilt, held);
  return rebuilt;
}

/**
 * Maps the turn's session as the chat's owned provider manager, active, as a
 * spawn leaves it. Returns the generation identity the manager's exit names.
 */
export function ownSession(turn: Turn): { managerId: string; generation: number } {
  const managerId = turn.state.managerIdFor(turn.session);
  const { generation } = turn.state.sessionOwnership.claim(turn.jid, managerId);
  turn.state.sessionOwnership.transition(turn.jid, managerId, 'active');
  turn.state.chatSessions.set(turn.jid, turn.session);
  return { managerId, generation };
}

/**
 * A non-zero exit of the owned session, as its manager reports it. The exit
 * carries no session id, so no respawn is scheduled.
 */
export function exitOf(owner: { managerId: string; generation: number }) {
  return { exitCode: 1, signal: null, sessionId: null, dbRowId: 41, generationIdentity: owner };
}

export function recoveryJobStatesOf(turn: Turn): string[] {
  return (turn.db.raw.prepare(
    'SELECT state FROM turn_recovery_jobs WHERE source_inbound_seq = ? ORDER BY id',
  ).all(turn.seq) as Array<{ state: string }>).map((job) => job.state);
}

export function activation() {
  return {
    primaryProvider: 'claude-cli',
    fallbackProvider: 'codex-cli',
    fallbackModel: undefined,
    reason: 'usage-limit' as const,
    resetAt: null,
    activeUntil: Date.now() + 60_000,
    extended: false,
    keyPresent: true,
    recoveryProbeRequired: true,
  };
}

export function policyBlocking(term: string, conversationKey: string): ClientOutputPolicyRegistry {
  const parsed = parseClientOutputPolicies([{
    conversationKey,
    maxCodePoints: 4000,
    maxQuestionMarks: 3,
    blockedTerms: [{ value: term, match: 'whole_word', caseSensitive: false }],
    rejectInternalArtifacts: false,
    rejectWhatsAppJids: false,
  }]);
  if (!parsed.ok) throw new Error(`fixture policy invalid: ${parsed.error.field} ${parsed.error.reason}`);
  return parsed.registry;
}
