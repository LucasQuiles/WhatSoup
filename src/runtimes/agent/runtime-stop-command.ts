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
//   'stopped'         — the teardown sequence completed AND the runtime's own
//                       in-flight resolver reports the scope idle afterwards.
//   'uncertain'       — teardown was requested but NOT proven: a step threw, the
//                       bounded wait elapsed, the scope still reads in flight, or
//                       delivery is poisoned.
// There is no fourth outcome and no optimistic success. A bounded wait that
// elapses poisons the lane rather than authorizing a replacement, per the same
// owner comment's cancellation-containment rule.
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
export const STOP_ACK_UNCERTAIN_TIMEOUT =
  '*Stop requested — teardown did not complete in time, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_FAILED =
  '*Stop requested — teardown failed, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_STILL_ACTIVE =
  '*Stop requested — the task still reports as running, outcome uncertain; operator reconciliation required*';
export const STOP_ACK_UNCERTAIN_DELIVERY =
  '*Stop requested — delivery remains blocked, outcome uncertain; operator reconciliation required*';

/** The three durable outcomes. Never a false success. */
export type StopOutcome = 'stopped' | 'nothing-to-stop' | 'uncertain';

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
 */
async function tearDownActiveTurn<TSession, TTeardown>(
  host: StopCommandHost<TSession, TTeardown>,
): Promise<void> {
  if (host.sessionScope === 'per_chat') {
    const interruptedSession = host.getPerChatSession();
    host.abortPerChatQueue();
    const teardown = await host.terminalizeTurnForInterrupt();
    if (interruptedSession !== undefined) {
      await host.disposePerChatSession(interruptedSession, teardown);
    } else {
      await host.retireTurnQueueAfterInterrupt(teardown);
    }
    return;
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
}

/**
 * Execute /stop: tear down the active provider turn for this chat, then report
 * one of three durable outcomes. Returns the outcome so the call site and tests
 * can assert it without parsing the acknowledgement text.
 */
export async function runStopCommand<TSession, TTeardown>(
  host: StopCommandHost<TSession, TTeardown>,
): Promise<StopOutcome> {
  const scope = { chatJid: host.chatJid, sessionScope: host.sessionScope, scopeKey: host.scopeKey };

  if (!host.isTurnInFlight()) {
    log.info(scope, '/stop received with no active turn — nothing to stop');
    host.sendDirect(STOP_ACK_NOTHING_TO_STOP);
    return 'nothing-to-stop';
  }

  log.warn(scope, '/stop received mid-turn — tearing down the active turn via the /new interrupt seam');
  const result = await boundedWait(
    tearDownActiveTurn(host),
    host.teardownTimeoutMs ?? DEFAULT_STOP_TEARDOWN_TIMEOUT_MS,
  );

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
