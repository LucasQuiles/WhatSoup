import { expect, it, vi } from 'vitest';
import type { Database } from '../../../../src/core/database.ts';
import { toConversationKey } from '../../../../src/core/conversation-key.ts';
import { upsertLidMapping } from '../../../../src/core/lid-resolver.ts';
import type { AgentRuntime, AgentRuntimeOptions } from '../../../../src/runtimes/agent/runtime.ts';
import type { RuntimeTurnContext } from '../../../../src/runtimes/agent/runtime-turn-context.ts';
import type { TurnQueue } from '../../../../src/runtimes/agent/turn-queue.ts';

interface Session {
  readonly turnInFlight: boolean;
  turnsSent: unknown[];
  getStatus(): { active: boolean };
  emit(event: { type: 'result'; text: string }): void;
  completeProviderTurn(): void;
}

interface Lifecycle {
  perChatRuntimeTurnCompletions: Map<string, { context: RuntimeTurnContext; promise: Promise<void>; resolve(): void }>;
  perChatTurnQueues: Map<string, TurnQueue>;
  chatQueues: Map<string, unknown>;
}

export function registerPreProviderAliasCases<Queue extends { indicateTyping: ReturnType<typeof vi.fn> }>(fixtures: {
  lidJid: string;
  canonicalJid: string;
  otherJid: string;
  senderJid: string;
  db(): Database;
  runtime(): AgentRuntime;
  makeRuntime(options: AgentRuntimeOptions): void;
  lifecycle(): Lifecycle;
  queueFor(jid: string): Queue;
  echoNextAnswer(queue: Queue, seq: number, jid: string): void;
  admitTurn(jid: string, messageId: string, content: string): Promise<{
    seq: number;
    session: Session;
    mapKey: string;
    held: RuntimeTurnContext;
  }>;
  enqueueTurn(jid: string, messageId: string, content: string): Promise<number>;
  status(seq: number): string;
}): void {
  it.each([false, true])('keeps an active-session actor and typing visible after a pre-provider wait (alias=%s)', async (alias) => {
    const { lidJid, canonicalJid, otherJid, senderJid } = fixtures;
    fixtures.makeRuntime({ sessionScope: 'per_chat' });
    const first = await fixtures.admitTurn(lidJid, 'pre-provider-first', 'first question');
    const runtime = fixtures.runtime();
    const state = fixtures.lifecycle();
    const queue = fixtures.queueFor(lidJid);
    const turnQueue = state.perChatTurnQueues.get(first.mapKey)!;
    const firstCompletion = state.perChatRuntimeTurnCompletions.get(first.mapKey)!;
    fixtures.echoNextAnswer(queue, first.seq, lidJid);
    first.session.emit({ type: 'result', text: 'first answer' });
    await firstCompletion.promise;
    await turnQueue.idle();
    expect(fixtures.status(first.seq)).toBe('complete');
    expect(first.session.getStatus().active).toBe(true);
    expect(first.session.turnInFlight).toBe(false);

    const access = runtime as unknown as {
      autoCompact: { waiters: Map<string, {
        promise: Promise<void>;
        resolve(): void;
        timer: ReturnType<typeof setTimeout>;
      }> };
      resolveExecutingActor(jid: string): string | undefined;
    };
    let entered!: () => void;
    let release!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const waiterTimer = setTimeout(release, 10_000);
    // Hold the existing compact waiter after dispatch has captured its key.
    // The real alias handler, SQLite mapping, actor register and resolver run.
    access.autoCompact.waiters.set(first.mapKey, {
      get promise() { entered(); return barrier; },
      resolve: release,
      timer: waiterTimer,
    });
    queue.indicateTyping.mockClear();
    let secondSeq: number | undefined;
    let liveJid = lidJid;
    try {
      secondSeq = await fixtures.enqueueTurn(lidJid, 'pre-provider-second', 'second question');
      await enteredBarrier;
      expect(turnQueue.activeTurn?.inboundSeq).toBe(secondSeq);
      expect(turnQueue.activeTurn?.runtimeContext).toBeDefined();
      expect(state.perChatRuntimeTurnCompletions.size).toBe(0);
      expect(first.session.turnsSent).toHaveLength(1);

      if (alias) {
        runtime.handleJidAliasChanged(toConversationKey(lidJid), canonicalJid);
        // Match the synchronous production event order: runtime rekey, then DB.
        upsertLidMapping(fixtures.db(), toConversationKey(lidJid), canonicalJid);
        liveJid = canonicalJid;
        expect(state.chatQueues.has(lidJid)).toBe(false);
      }
      expect(state.chatQueues.get(liveJid)).toBe(queue);
      access.autoCompact.waiters.delete(first.mapKey);
      release();
      await vi.waitFor(() => expect(first.session.turnsSent).toHaveLength(2));

      expect(access.resolveExecutingActor(liveJid)).toBe(senderJid);
      expect(queue.indicateTyping).toHaveBeenCalledTimes(1);
      expect(access.resolveExecutingActor(otherJid)).toBeUndefined();
      const secondCompletion = state.perChatRuntimeTurnCompletions.get(liveJid)!;
      expect(secondCompletion).toBeDefined();
      // OutboundQueue retains the admitted turn's delivery identity after rekey.
      fixtures.echoNextAnswer(queue, secondSeq, lidJid);
      first.session.emit({ type: 'result', text: 'second answer' });
      let secondSettled = false;
      void secondCompletion.promise.then(() => { secondSettled = true; });
      await vi.waitFor(() => expect(secondSettled).toBe(true));
      await turnQueue.idle();
      expect(fixtures.status(secondSeq)).toBe('complete');
      expect(access.resolveExecutingActor(liveJid)).toBeUndefined();

      const next = await fixtures.admitTurn(liveJid, 'pre-provider-next', 'next question');
      expect(next.session).toBe(first.session);
      expect(next.mapKey).toBe(liveJid);
      expect(access.resolveExecutingActor(liveJid)).toBe(senderJid);
      const nextCompletion = state.perChatRuntimeTurnCompletions.get(liveJid)!;
      fixtures.echoNextAnswer(queue, next.seq, liveJid);
      next.session.emit({ type: 'result', text: 'next answer' });
      let nextSettled = false;
      void nextCompletion.promise.then(() => { nextSettled = true; });
      await vi.waitFor(() => expect(nextSettled).toBe(true));
      await turnQueue.idle();
      expect(fixtures.status(next.seq)).toBe('complete');
      expect(access.resolveExecutingActor(liveJid)).toBeUndefined();
      expect(state.perChatRuntimeTurnCompletions.size).toBe(0);
    } finally {
      clearTimeout(waiterTimer);
      access.autoCompact.waiters.delete(first.mapKey);
      release();
      await vi.waitFor(() => expect(first.session.turnInFlight || !turnQueue.activeTurn).toBe(true));
      if (first.session.turnInFlight && secondSeq !== undefined) {
        fixtures.echoNextAnswer(queue, secondSeq, lidJid);
        first.session.emit({ type: 'result', text: 'cleanup answer' });
      }
      // A failed behavior assertion must not become a shutdown timeout.
      // This releases retained awaiters only after the assertions have run.
      first.session.completeProviderTurn();
      for (const completion of state.perChatRuntimeTurnCompletions.values()) completion.resolve();
      await turnQueue.idle();
    }
  });
}
