// src/runtimes/agent/runtime-new-command.ts
// The /new command, extracted from AgentRuntime's command switch as a leaf
// collaborator (same pattern as runtime-tool-registrations.ts): the runtime
// builds a closure-backed host at the single call site, so this module owns
// the command's control flow without reaching into runtime privates.
//
// /new is the user's natural interrupt. It used to 409-bounce while a turn was
// in flight ("A response is still in progress") — which made a runaway long job
// un-cancelable: the interrupt was blocked by the very turn it was meant to
// stop. A mid-turn /new now
// performs the PROVEN kill-session teardown first (turn abort + durable turn
// terminalization + session shutdown) so the admitted turn still reaches a
// terminal transaction — the invariant the old assert protected — and then
// proceeds as a clean reset. Idle /new is unchanged.

import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('runtime-new-command');

/**
 * Closure-backed surface the runtime hands to {@link runNewCommand}. TSession
 * stays opaque here — every session operation the command needs is a host
 * closure, so this module never imports the session manager.
 */
export interface NewCommandHost<TSession, TTeardown> {
  chatJid: string;
  sessionScope: 'single' | 'shared' | 'per_chat';
  shared: boolean;
  sandboxPerChat: boolean;
  scopeKey: string;
  perChatMapKey: string | null;
  isTurnInFlight(): boolean;
  // per_chat scope surface
  getPerChatSession(): TSession | undefined;
  abortPerChatQueue(): void;
  disposePerChatSession(session: TSession, teardown: TTeardown): Promise<void>;
  resetOwnedPerChatSession(session: TSession): Promise<void>;
  // single/shared scope surface
  getSingleSession(): TSession | null;
  abortActiveQueue(): void;
  terminalizeTurnForInterrupt(): Promise<TTeardown>;
  retireTurnQueueAfterInterrupt(teardown: TTeardown): Promise<void>;
  shutdownOperationTracker(): void;
  cleanupGlobalAutoCompactState(): void;
  shutdownSingleSession(session: TSession): Promise<void>;
  clearSingleScopeRefs(): void;
  abortChatQueue(): void;
  replaceOutboundQueue(): void;
  resetSingleSession(session: TSession): Promise<void>;
  // reset epilogue
  clearHandoffLatches(): void;
  clearTurnHadVisibleOutput(): void;
  sendDirect(text: string): void;
}

/** Execute /new: interrupt an in-flight turn if one exists, then reset. */
export async function runNewCommand<TSession, TTeardown>(
  host: NewCommandHost<TSession, TTeardown>,
): Promise<void> {
  const interruptingTurn = host.isTurnInFlight();
  if (interruptingTurn) {
    log.warn({
      chatJid: host.chatJid,
      sessionScope: host.sessionScope,
      scopeKey: host.scopeKey,
    }, '/new received mid-turn — interrupting in-flight task via kill-session-equivalent teardown');
    if (host.sessionScope === 'per_chat') {
      const interruptedSession = host.getPerChatSession();
      host.abortPerChatQueue();
      let teardown: TTeardown;
      try {
        teardown = await host.terminalizeTurnForInterrupt();
      } catch (err) {
        log.error({ err, mapKey: host.perChatMapKey }, '/new interrupt: runtime turn queue teardown failed');
        throw err;
      }
      if (interruptedSession !== undefined) {
        await host.disposePerChatSession(interruptedSession, teardown);
      } else {
        await host.retireTurnQueueAfterInterrupt(teardown);
      }
    } else {
      host.abortActiveQueue();
      let teardown: TTeardown;
      try {
        teardown = await host.terminalizeTurnForInterrupt();
      } catch (err) {
        log.error({ err, scopeKey: host.scopeKey }, '/new interrupt: runtime turn teardown failed');
        throw err;
      }
      host.shutdownOperationTracker();
      host.cleanupGlobalAutoCompactState();
      const singleSession = host.getSingleSession();
      if (singleSession !== null) {
        await host.shutdownSingleSession(singleSession);
      }
      await host.retireTurnQueueAfterInterrupt(teardown);
      // The durable row terminalizes through the abort/rejection machinery; the
      // in-memory markers must not outlive the teardown or the runtime reads
      // "turn in progress" forever — the exact un-cancelable wedge this
      // interrupt path exists to fix.
      host.clearSingleScopeRefs();
    }
  }
  // Capture session ref before branches may delete it from the map. In
  // per_chat mode the shared session field is NOT reliable (shared field
  // race), so the host resolves the correct session from the per-chat maps.
  // After an interrupt the session is deliberately gone — a fresh one spawns
  // on the next message, exactly like the post-kill-session state.
  const sessionForNew = interruptingTurn
    ? undefined
    : host.sessionScope === 'per_chat'
      ? host.getPerChatSession()
      : host.getSingleSession() ?? undefined;
  log.info({
    chatJid: host.chatJid,
    sessionScope: host.sessionScope,
    shared: host.shared,
    sandboxPerChat: host.sandboxPerChat,
    interruptedTurn: interruptingTurn,
  }, 'resetting session and queue for /new');
  if (host.sessionScope === 'per_chat') {
    if (sessionForNew === undefined && !interruptingTurn) {
      throw new Error(`No owned per-chat session found for /new at "${host.perChatMapKey!}"`);
    }
    if (sessionForNew !== undefined) {
      await host.resetOwnedPerChatSession(sessionForNew);
    }
  } else {
    // Abort the old queue — clears timers and typing heartbeat before
    // discarding — then create a fresh queue before spawning so stale output
    // from the old session can never leak into the new session's delivery
    // channel.
    host.abortChatQueue();
    host.cleanupGlobalAutoCompactState();
    host.replaceOutboundQueue();
    if (sessionForNew !== undefined) {
      await host.resetSingleSession(sessionForNew);
    }
  }
  // QR-108: /new is a clean reset, so drop the one-message-handoff latches for
  // this conversation too — otherwise a standby notice or handoff artifact
  // stashed before /new leaks into the NEXT reply/prelude (both tables are
  // keyed by the stable conversation_key, which /new does not change). Both
  // fns are idempotent no-ops when nothing is pending.
  host.clearHandoffLatches();
  // Reset turn flag — stale value from the old session must not suppress the
  // _(no response)_ fallback if the first new-session turn has no visible text.
  host.clearTurnHadVisibleOutput();
  host.sendDirect(
    interruptingTurn
      ? '*Interrupted the running task — starting new session* ✓'
      : '*Starting new session* ✓',
  );
}
