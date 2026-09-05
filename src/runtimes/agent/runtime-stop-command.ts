// src/runtimes/agent/runtime-stop-command.ts
// The /stop command — a registered PREEMPTIVE CONTROL, sibling to
// runtime-new-command.ts and built the same way: the runtime hands this module
// a closure-backed host at its single call site, so the command owns its
// control flow without reaching into runtime privates.
//
// #2949: the per-chat FIFO carries logical work order AND active-turn control,
// so a mid-turn control used to queue behind the very turn it was meant to
// stop. `/stop` was not a local control at all — it reached the agent as
// ordinary text and terminalized as an admission-rejected work turn. Registering
// it in COMMAND_REGISTRY is what keeps it out of the work FIFO: the classifier
// derives LOCAL_COMMANDS from the registry, and runtime.ts finalizes a local
// command as 'local_command_handled' and RETURNS before the enqueue block.
//
// /stop is NOT /new. It reuses /new's proven interrupt seam (queue abort →
// durable turn terminalization → session teardown → queue retirement) and stops
// there: no session reset, no replacement outbound queue. After the teardown the
// session is deliberately gone and a fresh one spawns on the next message —
// exactly the post-kill-session state /new's interrupt branch already produces.
//
// THE OUTCOME CONTRACT (owner comment #6 on #2949: "distinguish 'stop
// requested,' 'stopped,' and 'outcome uncertain'. Do not say a message was seen
// by the agent without protocol evidence."):
//   'nothing-to-stop' — no active turn at entry; no teardown is attempted.
//   'stopped'         — the teardown sequence completed, the runtime's own
//                       in-flight resolver reports the scope idle afterwards,
//                       AND every session torn down passes the runtime's
//                       termination proof (isSessionProvablyTerminated).
//   'uncertain'       — teardown was requested but NOT proven: a step threw, the
//                       bounded wait elapsed, the scope still reads in flight, a
//                       torn-down session is not provably terminated, or
//                       delivery is poisoned.
//   'already-stopping' — a teardown for this scopeKey is still in flight, so
//                       this /stop did not re-enter it. NOT a claim about the
//                       task: it reports what this invocation did, and the
//                       in-flight teardown still owns the outcome.
// No optimistic success. A bounded wait that elapses poisons the lane rather
// than authorizing a replacement, per the same owner comment's
// cancellation-containment rule.
//
// WHY THE TERMINATION PROOF IS A SEPARATE CONJUNCT: `isTurnInFlight` is a
// runtime BOOKKEEPING reading, not a provider-process reading. In single/shared
// scope it is a disjunction of eight markers (runtime.ts:1447-1456) and
// `clearSingleScopeRefs` clears exactly two of them (`currentInboundSeq`,
// `currentTurnChatJid`); the other six — the runtime turn context, the pending
// singleton context, the turn completion, `turnQueue.isProcessing`,
// `turnQueue.pending` and `hasGlobalTeardownPending` — are cleared by the
// coordinator's own finalization, so the re-read is PARTIALLY self-fulfilling
// rather than trivially false. In per_chat scope the same holds for the six
// markers at runtime.ts:1436-1445: `disposePerChatSession` runs
// `cleanupPerChatState`, which deletes this chat's `perChatInboundSeqQueue`
// entry (runtime.ts:2024) among others. Either way the teardown clears part of
// what the proof reads, which is why `stopped` also requires the
// provider-independent predicate at runtime.ts:8098.
//
// RESIDUAL, DISCLOSED: when the scope holds no session object to prove
// (single/shared with a null session ref, per_chat with no mapped session) the
// torn-down set is empty and the predicate is vacuously satisfied, so 'stopped'
// is reachable without a positive termination proof. That is the state where
// the runtime has nothing left to interrogate; it is not evidence of
// termination and is recorded here rather than hidden.
//
// TURN RECOVERY (#2949 N1 review item D, report-only): the cancelled turn is
// finalized `{ kind: 'failed', class: 'crash' }` by the SAME coordinator
// methods /new's interrupt branch binds. When that turn already had answer
// delivery evidence in a non-terminal state, `deriveInboundDisposition`
// (turn-finalizer.ts:180-196) returns 'transferred_to_recovery_owner', which
// enqueues a replay-safe turn-recovery job (turn-finalizer.ts:391-393 →
// turn-recovery-store.ts:975) that the recovery supervisor can later replay
// with the ORIGINAL user text. /stop cannot narrow that without changing /new:
// both bind the same `terminalizeTurnForInterrupt` /
// `retireTurnQueueAfterInterrupt` closures (runtime.ts:4637-4642 and
// :4700-4705). Left as-is deliberately.
//
// ACKNOWLEDGEMENT DELIVERY, RECORDED LIMIT: every acknowledgement here goes
// through `runtime.sendDirect`, which passes `bypassEchoGuard = false` and
// discards the promise (runtime.ts:8579-8580). `sendDirectWithReceipt` returns
// `{ accepted: false }` without sending when the chat's outbound queue is
// poisoned (chat-transport.ts:211-217), so STOP_ACK_UNCERTAIN_DELIVERY is
// dropped in exactly the case it describes. The bypass path exists but no
// production call site uses it, so introducing one here would be a new
// precedent rather than a fix; it is filed as a follow-up on #2949 instead.
//
// COMMAND TEXT AFTER /stop: single-line trailing text ("/stop now") is parsed
// into `args` by classifyInput (commands.ts:145-151) and deliberately ignored
// — /stop takes no arguments. A multi-line body ("/stop\n<body>") is different:
// classifyInput returns it as `compoundBody` (commands.ts:87-93, :150), and the
// #2357 B1 fall-through would dispatch it as a NEW turn under the same inbound,
// onto state this command just tore down. The runtime therefore refuses a
// compound body for /stop and acknowledges the refusal
// (STOP_ACK_COMPOUND_BODY_REFUSED, runtime.ts's compound-forwarding site); the
// inbound still completes as 'local_command_handled'. Every other command keeps
// the #2357 B1 behaviour.
//
// WHY NOT `teardown.disposition`: the coordinator assigns it unconditionally
// from WHICH method ran — 'interruption' in terminalizeGlobalTurnForReset,
// 'kill' in terminalizePerChatTurnQueueForKill. It is a function of session
// scope, not of teardown success, so an outcome keyed off it would report scope
// while claiming to report proof.

import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('runtime-stop-command');

/** Bounded wait for the teardown sequence before the outcome degrades to
 *  uncertain. Long enough for a SIGTERM grace + durable terminalization, short
 *  enough that the user gets an honest answer rather than silence. */
export const DEFAULT_STOP_TEARDOWN_TIMEOUT_MS = 30_000;

export const STOP_ACK_STOPPED = '*Stopped the running task* ✓';
export const STOP_ACK_NOTHING_TO_STOP = '*Nothing to stop — no task is running*';
/** single/shared only. /stop runs inside turnChain, so in these scopes a /stop
 *  sent DURING a task is only handled once that task finishes — at which point
 *  the scope reads idle and the plain wording above would tell the user nothing
 *  was running. Say what actually happened instead. */
export const STOP_ACK_NOTHING_TO_STOP_SERIALIZED_SCOPE =
  '*Nothing to stop — no task is running now. In this session mode a /stop sent during a task is only seen after that task finishes; it cannot interrupt a task already in progress.*';
export const STOP_ACK_UNCERTAIN_TIMEOUT =
  '*Stop requested — teardown did not complete in time, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_FAILED =
  '*Stop requested — teardown failed, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_STILL_ACTIVE =
  '*Stop requested — the task still reports as running, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_DELIVERY =
  '*Stop requested — delivery remains blocked, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_NOT_PROVEN =
  '*Stop requested — the task process could not be proven terminated, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_ALREADY_STOPPING =
  '*Stop already in progress — waiting for the current teardown to settle*';
/** Compound `/stop\n<body>` refusal. See the COMPOUND BODY note in the header. */
export const STOP_ACK_COMPOUND_BODY_REFUSED =
  '*/stop does not take a follow-up message; send it on its own after the stop acknowledgement*';

/** The durable outcomes. Never a false success. */
export type StopOutcome = 'stopped' | 'nothing-to-stop' | 'uncertain' | 'already-stopping';

/**
 * Closure-backed surface the runtime hands to {@link runStopCommand}. Every
 * member is also on {@link import('./runtime-new-command.ts').NewCommandHost} —
 * this is /new's interrupt seam MINUS its reset epilogue, never a second
 * teardown path.
 *
 * TSession/TTeardown stay opaque: this module never imports the session manager
 * or the turn coordinator.
 */
export interface StopCommandHost<TSession, TTeardown> {
  chatJid: string;
  sessionScope: 'single' | 'shared' | 'per_chat';
  scopeKey: string;
  perChatMapKey: string | null;
  /** Bounded wait; defaults to {@link DEFAULT_STOP_TEARDOWN_TIMEOUT_MS}. */
  teardownTimeoutMs?: number;
  /** The runtime's OWN in-flight resolver — read at entry and re-read after the
   *  teardown as the completion proof. */
  isTurnInFlight(): boolean;
  isOutboundQueuePoisoned(): boolean;
  /** The runtime's OWN termination proof (runtime.ts:8098) — provider-independent
   *  and the same predicate the respawn and turn-recovery abort paths already
   *  require. Read for every session this command tore down. */
  isSessionProvablyTerminated(session: TSession): boolean;
  // per_chat scope surface
  getPerChatSession(): TSession | undefined;
  abortPerChatQueue(): void;
  disposePerChatSession(session: TSession, teardown: TTeardown): Promise<void>;
  // single/shared scope surface
  getSingleSession(): TSession | null;
  abortActiveQueue(): void;
  terminalizeTurnForInterrupt(): Promise<TTeardown>;
  retireTurnQueueAfterInterrupt(teardown: TTeardown): Promise<void>;
  shutdownOperationTracker(): void;
  cleanupGlobalAutoCompactState(): void;
  shutdownSingleSession(session: TSession): Promise<void>;
  /** Must run after a single/shared teardown: runtime-new-command.ts's own note
   *  applies verbatim — leave the in-memory markers behind and the runtime reads
   *  "turn in progress" forever, the un-cancelable wedge this path exists to fix. */
  clearSingleScopeRefs(): void;
  clearTurnHadVisibleOutput(): void;
  sendDirect(text: string): void;
}

type BoundedResult<T> =
  | { kind: 'settled'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

/**
 * Race `work` against `timeoutMs`. `work` is pre-caught so a rejection arriving
 * AFTER the timeout wins cannot surface as an unhandled rejection — the detached
 * teardown keeps running and owns its own coordinator state either way.
 */
async function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<BoundedResult<T>> {
  const guarded: Promise<BoundedResult<T>> = work.then(
    (value) => ({ kind: 'settled' as const, value }),
    (error) => ({ kind: 'error' as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<BoundedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([guarded, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * /new's interrupt branch, verbatim in ordering, with the reset epilogue
 * removed. Scope-ref and map cleanup are TEARDOWN, not reset, so they stay.
 *
 * Returns the sessions it tore down, each captured BEFORE the cleanup that
 * unmaps it (`clearSingleScopeRefs`, `disposePerChatSession`). Reading them
 * back from the host afterwards would hand the caller null/undefined and make
 * the termination proof vacuous — the proof must run against the object that
 * was actually torn down.
 */
async function tearDownActiveTurn<TSession, TTeardown>(
  host: StopCommandHost<TSession, TTeardown>,
): Promise<readonly TSession[]> {
  if (host.sessionScope === 'per_chat') {
    const interruptedSession = host.getPerChatSession();
    host.abortPerChatQueue();
    const teardown = await host.terminalizeTurnForInterrupt();
    if (interruptedSession !== undefined) {
      await host.disposePerChatSession(interruptedSession, teardown);
      return [interruptedSession];
    }
    await host.retireTurnQueueAfterInterrupt(teardown);
    return [];
  }
  host.abortActiveQueue();
  const teardown = await host.terminalizeTurnForInterrupt();
  host.shutdownOperationTracker();
  host.cleanupGlobalAutoCompactState();
  const singleSession = host.getSingleSession();
  if (singleSession !== null) {
    await host.shutdownSingleSession(singleSession);
  }
  await host.retireTurnQueueAfterInterrupt(teardown);
  host.clearSingleScopeRefs();
  return singleSession !== null ? [singleSession] : [];
}

/**
 * Teardowns in flight, keyed by scopeKey (item C). Module state because the
 * runtime builds a fresh host per /stop, so the guard cannot live on the host.
 *
 * HELD UNTIL THE TEARDOWN PROMISE SETTLES, not merely until the bounded wait
 * elapses. On timeout the teardown is detached and still owns the coordinator
 * state for that scope, and a second teardown running concurrently against it
 * is exactly the un-contained duplicate this command's outcome contract
 * forbids. The user is never left silent: a /stop that hits the guard still
 * gets STOP_ACK_ALREADY_STOPPING. The cost is that a teardown which never
 * settles holds its scope's guard for the life of the process — deliberate, and
 * consistent with the poisoned-lane rule above.
 */
const teardownsInFlight = new Map<string, Promise<unknown>>();

/**
 * Execute /stop: tear down the active provider turn for this chat, then report
 * one durable outcome. Returns the outcome so the call site and tests can
 * assert it without parsing the acknowledgement text.
 */
export async function runStopCommand<TSession, TTeardown>(
  host: StopCommandHost<TSession, TTeardown>,
): Promise<StopOutcome> {
  const scope = { chatJid: host.chatJid, sessionScope: host.sessionScope, scopeKey: host.scopeKey };

  if (teardownsInFlight.has(host.scopeKey)) {
    log.warn(scope, '/stop received while a teardown for this scope is still in flight — not re-entering');
    host.sendDirect(STOP_ACK_ALREADY_STOPPING);
    return 'already-stopping';
  }

  if (!host.isTurnInFlight()) {
    log.info(scope, '/stop received with no active turn — nothing to stop');
    host.sendDirect(
      host.sessionScope === 'per_chat'
        ? STOP_ACK_NOTHING_TO_STOP
        : STOP_ACK_NOTHING_TO_STOP_SERIALIZED_SCOPE,
    );
    return 'nothing-to-stop';
  }

  log.warn(scope, '/stop received mid-turn — tearing down the active turn via the /new interrupt seam');
  // Registered synchronously, before the first await: a second /stop that
  // arrives while this one is suspended must see the guard already set.
  const teardown = tearDownActiveTurn(host);
  teardownsInFlight.set(host.scopeKey, teardown);
  const releaseGuard = (): void => {
    if (teardownsInFlight.get(host.scopeKey) === teardown) teardownsInFlight.delete(host.scopeKey);
  };
  // The release for the TIMEOUT path, where the detached teardown outlives this
  // call. Pre-caught so a late rejection cannot surface as an unhandled one.
  void teardown.then(() => {}, () => {}).finally(releaseGuard);
  const result = await boundedWait(
    teardown,
    host.teardownTimeoutMs ?? DEFAULT_STOP_TEARDOWN_TIMEOUT_MS,
  );
  // Released here too, so it is gone by the time this call returns rather than
  // a microtask later; both releases are identity-checked and idempotent.
  if (result.kind !== 'timeout') releaseGuard();

  if (result.kind === 'timeout') {
    // The lane stays poisoned deliberately: an unproven cancellation must never
    // authorize a concurrent replacement.
    log.error(scope, '/stop teardown did not complete within the bounded wait — outcome uncertain');
    host.sendDirect(STOP_ACK_UNCERTAIN_TIMEOUT);
    return 'uncertain';
  }
  if (result.kind === 'error') {
    log.error({ ...scope, err: result.error }, '/stop teardown failed — outcome uncertain');
    host.sendDirect(STOP_ACK_UNCERTAIN_FAILED);
    return 'uncertain';
  }
  // Completion is PROVEN by re-reading the runtime's own resolver, not inferred
  // from the teardown call returning.
  if (host.isTurnInFlight()) {
    log.error(scope, '/stop teardown returned but the scope still reports a turn in flight — outcome uncertain');
    host.sendDirect(STOP_ACK_UNCERTAIN_STILL_ACTIVE);
    return 'uncertain';
  }
  // The in-flight resolver reads runtime bookkeeping the teardown itself
  // partly clears (see the module header). Termination of the provider work is
  // a separate question, answered by the runtime's own predicate against the
  // sessions this teardown actually disposed of.
  const unproven = result.value.filter((session) => !host.isSessionProvablyTerminated(session));
  if (unproven.length > 0) {
    log.error(
      { ...scope, unprovenSessions: unproven.length },
      '/stop tore the turn down but the session could not be proven terminated — outcome uncertain',
    );
    host.sendDirect(STOP_ACK_UNCERTAIN_NOT_PROVEN);
    return 'uncertain';
  }
  // The flag belongs to the turn just torn down; a stale `true` would suppress
  // the next session's _(no response)_ fallback.
  host.clearTurnHadVisibleOutput();
  if (host.isOutboundQueuePoisoned()) {
    log.error(scope, '/stop tore the turn down but delivery remains blocked — outcome uncertain');
    host.sendDirect(STOP_ACK_UNCERTAIN_DELIVERY);
    return 'uncertain';
  }
  log.info(scope, '/stop: active turn torn down and the scope reads idle');
  host.sendDirect(STOP_ACK_STOPPED);
  return 'stopped';
}
