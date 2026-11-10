import { expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeOptions } from '../../../../src/runtimes/agent/runtime.ts';
import type { RuntimeTurnContext } from '../../../../src/runtimes/agent/runtime-turn-context.ts';
import type { RuntimeTurnCoordinator } from '../../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import type { TurnQueue } from '../../../../src/runtimes/agent/turn-queue.ts';

interface Completion {
  promise: Promise<void>;
  resolve(): void;
}

interface AliasLifecycle {
  perChatRuntimeTurnCompletions: Map<string, Completion & { context: RuntimeTurnContext }>;
  perChatTurnQueues: Map<string, TurnQueue>;
  chatQueues: Map<string, unknown>;
  runtimeTurnAfterTerminal: Map<string, (result: unknown) => void | Promise<void>>;
  runtimeTurnCoordinator: RuntimeTurnCoordinator;
}

export function registerAfterTerminalAliasCases<Queue>(fixtures: {
  lidJid: string;
  lidCanonicalJid: string;
  runtime(): Pick<AgentRuntime, 'handleJidAliasChanged'>;
  makeRuntime(options: AgentRuntimeOptions): void;
  lifecycle(): AliasLifecycle;
  queueFor(jid: string): Queue;
  echoNextAnswer(queue: Queue, seq: number, jid: string): void;
  admitTurn(jid: string, messageId: string, content: string): Promise<{
    seq: number;
    session: { emit(event: { type: 'result'; text: string }): void };
    mapKey: string;
    held: RuntimeTurnContext;
  }>;
  status(seq: number): string;
  captureUnhandledRejections(): { reasons: unknown[]; stop(): void };
  watchCompletion(completion: { promise: Promise<void> }): () => 'pending' | 'resolved' | 'rejected';
}): void {
  const {
    lidJid, lidCanonicalJid, makeRuntime, lifecycle, queueFor, echoNextAnswer,
    admitTurn, status, captureUnhandledRejections, watchCompletion,
  } = fixtures;

  it.each(['resolves', 'rejects'] as const)(
    'drains a deferred LID rekey appended while an after-terminal reset %s',
    async (outcome) => {
      let resolveReset: (() => void) | undefined;
      let rejectReset: (() => void) | undefined;
      let resetSettled = false;
      let heldCompletion: { promise: Promise<void>; resolve(): void } | undefined;
      const unhandled = captureUnhandledRejections();
      try {
        makeRuntime({ sessionScope: 'per_chat' });
        const { seq, session, mapKey, held } = await admitTurn(
          lidJid,
          'wamid-deferred-rekey-during-reset',
          'deferred rekey during reset question',
        );
        heldCompletion = lifecycle().perChatRuntimeTurnCompletions.get(mapKey)!;
        const turnQueue = lifecycle().perChatTurnQueues.get(mapKey)!;
        const queue = queueFor(lidJid);
        lifecycle().runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(held, async () => {
          await new Promise<void>((resolve, reject) => {
            resolveReset = () => { resetSettled = true; resolve(); };
            rejectReset = () => { resetSettled = true; reject(new Error('test reset rejection')); };
          });
        });

        echoNextAnswer(queue, seq, lidJid);
        session.emit({ type: 'result', text: 'deferred rekey during reset answer' });
        await vi.waitFor(() => expect(resolveReset).toBeTypeOf('function'));

        fixtures.runtime().handleJidAliasChanged(held.identity.conversationKey, lidCanonicalJid);
        expect(lifecycle().chatQueues.get(lidJid)).toBe(queue);
        expect(lifecycle().runtimeTurnAfterTerminal.has(held.identity.logicalTurnId)).toBe(true);

        if (outcome === 'rejects') rejectReset!();
        else resolveReset!();
        await expect(heldCompletion.promise).resolves.toBeUndefined();
        await turnQueue.idle();
        expect(status(seq)).toBe('complete');
        expect(lifecycle().chatQueues.get(lidCanonicalJid)).toBe(queue);
        expect(lifecycle().runtimeTurnAfterTerminal.has(held.identity.logicalTurnId)).toBe(false);
        expect(unhandled.reasons).toEqual([]);
      } finally {
        if (!resetSettled) resolveReset?.();
        heldCompletion?.resolve();
        unhandled.stop();
      }
    },
  );

  it('drains a LID rekey queued after the after-terminal drain observes no action', async () => {
    let resolveReset: (() => void) | undefined;
    let resetSettled = false;
    let heldCompletion: { promise: Promise<void>; resolve(): void } | undefined;
    let resolveDrainEmpty!: () => void;
    const drainEmpty = new Promise<void>((resolve) => { resolveDrainEmpty = resolve; });
    let resolveAliasApplied!: () => void;
    let rejectAliasApplied!: (err: unknown) => void;
    const aliasApplied = new Promise<void>((resolve, reject) => {
      resolveAliasApplied = resolve;
      rejectAliasApplied = reject;
    });
    let aliasRanBeforeCompletion = false;
    const unhandled = captureUnhandledRejections();
    try {
      makeRuntime({ sessionScope: 'per_chat' });
      const { seq, session, mapKey, held } = await admitTurn(
        lidJid,
        'wamid-deferred-rekey-after-drain',
        'deferred rekey after drain question',
      );
      heldCompletion = lifecycle().perChatRuntimeTurnCompletions.get(mapKey)!;
      const heldOutcome = watchCompletion(heldCompletion);
      const turnQueue = lifecycle().perChatTurnQueues.get(mapKey)!;
      const queue = queueFor(lidJid);
      const deferredActions = lifecycle().runtimeTurnAfterTerminal;
      const getDeferredAction = deferredActions.get.bind(deferredActions);
      let scheduledAlias = false;
      vi.spyOn(deferredActions, 'get').mockImplementation((turnId) => {
        const action = getDeferredAction(turnId);
        // Queue the identity update after the drain sees no action, before
        // its caller resumes to settle completion in the next microtask.
        if (
          turnId === held.identity.logicalTurnId
          && resetSettled
          && action === undefined
          && !scheduledAlias
        ) {
          scheduledAlias = true;
          resolveDrainEmpty();
          queueMicrotask(() => {
            try {
              aliasRanBeforeCompletion = heldOutcome() === 'pending';
              fixtures.runtime().handleJidAliasChanged(held.identity.conversationKey, lidCanonicalJid);
              resolveAliasApplied();
            } catch (err) {
              rejectAliasApplied(err);
            }
          });
        }
        return action;
      });
      lifecycle().runtimeTurnCoordinator.appendRuntimeTurnAfterTerminalAction(held, async () => {
        await new Promise<void>((resolve) => {
          resolveReset = () => { resetSettled = true; resolve(); };
        });
      });

      echoNextAnswer(queue, seq, lidJid);
      session.emit({ type: 'result', text: 'deferred rekey after drain answer' });
      await vi.waitFor(() => expect(resolveReset).toBeTypeOf('function'));

      resolveReset!();
      await drainEmpty;
      await aliasApplied;
      expect(aliasRanBeforeCompletion).toBe(true);
      await expect(heldCompletion.promise).resolves.toBeUndefined();
      await turnQueue.idle();
      expect(status(seq)).toBe('complete');
      expect(lifecycle().chatQueues.has(lidJid)).toBe(false);
      expect(lifecycle().chatQueues.get(lidCanonicalJid)).toBe(queue);
      expect(lifecycle().runtimeTurnAfterTerminal.has(held.identity.logicalTurnId)).toBe(false);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      if (!resetSettled) resolveReset?.();
      heldCompletion?.resolve();
      unhandled.stop();
    }
  });

  it('applies a LID rekey after completion ownership is removed but before its queue retires the active turn', async () => {
    let heldCompletion: { promise: Promise<void>; resolve(): void } | undefined;
    let resolveAliasApplied!: () => void;
    let rejectAliasApplied!: (err: unknown) => void;
    const aliasApplied = new Promise<void>((resolve, reject) => {
      resolveAliasApplied = resolve;
      rejectAliasApplied = reject;
    });
    let aliasSawNoOwnedCompletion = false;
    let aliasSawActiveTurn = false;
    const unhandled = captureUnhandledRejections();
    try {
      makeRuntime({ sessionScope: 'per_chat' });
      const { seq, session, mapKey, held } = await admitTurn(
        lidJid,
        'wamid-deferred-rekey-after-completion',
        'deferred rekey after completion question',
      );
      heldCompletion = lifecycle().perChatRuntimeTurnCompletions.get(mapKey)!;
      const turnQueue = lifecycle().perChatTurnQueues.get(mapKey)!;
      const queue = queueFor(lidJid);
      const completions = lifecycle().perChatRuntimeTurnCompletions;
      const deleteCompletion = completions.delete.bind(completions);
      let scheduledAlias = false;
      vi.spyOn(completions, 'delete').mockImplementation((key) => {
        const completion = completions.get(key);
        const deleted = deleteCompletion(key);
        if (
          completion?.context.identity.logicalTurnId === held.identity.logicalTurnId
          && deleted
          && !scheduledAlias
        ) {
          scheduledAlias = true;
          // resolveOwnedPerChatCompletion deletes first and resolves next.
          // This queued callback therefore runs after ownership is gone but
          // before TurnQueue's processor finally clears its active turn.
          queueMicrotask(() => {
            try {
              aliasSawNoOwnedCompletion = ![...completions.values()].some(
                (candidate) => candidate.context.identity.logicalTurnId === held.identity.logicalTurnId,
              );
              aliasSawActiveTurn = turnQueue.activeTurn?.runtimeContext === held;
              fixtures.runtime().handleJidAliasChanged(held.identity.conversationKey, lidCanonicalJid);
              resolveAliasApplied();
            } catch (err) {
              rejectAliasApplied(err);
            }
          });
        }
        return deleted;
      });

      echoNextAnswer(queue, seq, lidJid);
      session.emit({ type: 'result', text: 'deferred rekey after completion answer' });

      await expect(heldCompletion.promise).resolves.toBeUndefined();
      expect(scheduledAlias).toBe(true);
      await aliasApplied;
      expect(aliasSawNoOwnedCompletion).toBe(true);
      expect(aliasSawActiveTurn).toBe(true);
      await turnQueue.idle();
      expect(status(seq)).toBe('complete');
      expect(lifecycle().chatQueues.has(lidJid)).toBe(false);
      expect(lifecycle().chatQueues.get(lidCanonicalJid)).toBe(queue);
      expect(lifecycle().runtimeTurnAfterTerminal.has(held.identity.logicalTurnId)).toBe(false);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      heldCompletion?.resolve();
      unhandled.stop();
    }
  });

}
