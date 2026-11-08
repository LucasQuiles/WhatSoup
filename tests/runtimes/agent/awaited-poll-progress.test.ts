import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import type { Messenger, TypingState } from '../../../src/core/types.ts';
import type { ToolRegistry } from '../../../src/mcp/registry.ts';
import { resolveSessionContext } from '../../../src/mcp/types.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import type { PendingPollStore } from '../../../src/runtimes/agent/pending-poll-store.ts';

const OWNER = '15550100701@s.whatsapp.net';
const TARGET = '15550100702@s.whatsapp.net';

interface RuntimeView {
  registry: ToolRegistry;
  pendingPolls: PendingPollStore;
  chatQueues: Map<string, OutboundQueue>;
  handlePollVoteReceived(data: {
    pollMessageId: string; chatJid: string; voterJid: string; selectedOptions: string[];
  }): void;
  deletePendingPollQuestions(mapKey: string): void;
}

describe('awaited poll progress through runtime settlement', () => {
  let db: Database;
  let runtime: AgentRuntime;
  let state: RuntimeView;
  let queue: OutboundQueue;
  let targetQueue: OutboundQueue;
  let tracker: OperationTracker;
  let abort: AbortController;
  let sends: Array<{ jid: string; text: string }>;
  let typing: Array<{ jid: string; active: TypingState }>;
  let nextPoll: number;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.open();
    sends = [];
    typing = [];
    nextPoll = 0;
    abort = new AbortController();
    const messenger: Messenger = {
      sendMessage: async (jid, text) => { sends.push({ jid, text }); return { waMessageId: null }; },
      sendMedia: async () => ({ waMessageId: null }),
      setTyping: async (jid, active) => { typing.push({ jid, active }); },
      sendPollMessage: async () => ({ waMessageId: `progress-poll-${++nextPoll}`, hasSecret: true }),
    } as Messenger;
    runtime = new AgentRuntime(db, messenger, 'poll-progress', { sessionScope: 'per_chat' });
    state = runtime as unknown as RuntimeView;
    queue = new OutboundQueue(messenger, OWNER);
    targetQueue = new OutboundQueue(messenger, TARGET);
    queue.setToolUpdateMode('full');
    queue.setProgressFloorMs(0);
    targetQueue.setToolUpdateMode('full');
    state.chatQueues.set(OWNER, queue);
    state.chatQueues.set(TARGET, targetQueue);
    tracker = new OperationTracker('poll-progress', {
      enabled: true, progressIntervalMs: 100, thinkingLongMs: 60_000,
      thinkingStallMs: 120_000, progressPlaceholderRateLimitMs: 0,
      maxStatusMessagesPerTurn: 100, maxStatusMessagesPerWindow: 100, statusMessageWindowMs: 300_000,
      toolThresholds: { default: { expectedMs: 10_000, slowMultiplier: 2, stallMultiplier: 3 } },
    }, {
      onProgress: (event) => queue.enqueueProgressUpdate(event, 'poll-progress'),
      onStalled: () => { throw new Error('unexpected stalled operation'); },
      onThinkingStalled: () => { throw new Error('unexpected thinking stall'); },
    });
  });

  afterEach(async () => {
    abort.abort();
    for (const key of [...state.pendingPolls.questions.keys()]) state.deletePendingPollQuestions(key);
    tracker.shutdown();
    queue.abortTurn();
    targetQueue.abortTurn();
    await Promise.resolve();
    const timers = vi.getTimerCount();
    vi.useRealTimers();
    await runtime.shutdown();
    db.close();
    expect(timers, 'poll/tracker/queue timers must be removed').toBe(0);
  });

  function sendPoll(awaitResult: boolean, id = 'poll-tool') {
    const params = { chatJid: TARGET, question: 'Proceed?', options: ['Yes', 'No'], awaitResult, timeoutMs: 1_000 };
    tracker.onToolStart(id, 'send_poll', 'other', params);
    return state.registry.call('send_poll', params, resolveSessionContext(
      { tier: 'global', abortSignal: abort.signal },
      { actorJid: OWNER, conversationKey: undefined, purpose: undefined },
    )).then((result) => {
      expect(result.isError).toBeUndefined();
      return JSON.parse(result.content[0].text);
    });
  }

  function vote(pollId = 'progress-poll-1') {
    state.handlePollVoteReceived({ pollMessageId: pollId, chatJid: TARGET, voterJid: TARGET, selectedOptions: ['Yes'] });
  }

  async function drain() {
    tracker.onTurnComplete();
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushed;
  }

  it.each(['vote', 'timeout', 'abort', 'replacement'] as const)(
    'suppresses awaited poll progress until %s without suppressing typing or unrelated work', async (terminal) => {
      const answer = sendPoll(true);
      await vi.advanceTimersByTimeAsync(101);
      expect(state.pendingPolls.questions.size).toBe(1);
      const leaked = sends.filter(({ text }) => text.includes('running send_poll'));
      const composing = typing.some(({ jid, active }) => jid === OWNER && active === true);

      // An unrelated operation targeting the same queue must remain visible.
      tracker.onToolStart('ordinary-tool', 'Read', 'reading');
      await vi.advanceTimersByTimeAsync(101);
      tracker.onToolEnd('ordinary-tool');
      if (terminal === 'vote') vote();
      if (terminal === 'timeout') await vi.advanceTimersByTimeAsync(800);
      if (terminal === 'abort') abort.abort();
      if (terminal === 'replacement') state.deletePendingPollQuestions('send_poll:progress-poll-1');
      const result = await answer;
      tracker.onToolEnd('poll-tool');
      await drain();

      expect(result).toMatchObject(terminal === 'vote' ? { sent: true, answer: 'Yes' } : { sent: true, awaitFailed: true });
      expect(state.pendingPolls.questions.size).toBe(0);
      expect(tracker.getActive()).toEqual([]);
      expect(targetQueue.hasPendingPoll()).toBe(false);
      expect(leaked).toEqual([]);
      expect(composing).toBe(true);
      expect(sends.some(({ jid, text }) => jid === OWNER && text.includes('running Read'))).toBe(true);

      const priorSends = sends.length;
      expect(await sendPoll(false)).toMatchObject({ sent: true, pollId: 'progress-poll-2' });
      await vi.advanceTimersByTimeAsync(101);
      tracker.onToolEnd('poll-tool');
      await drain();
      expect(sends.slice(priorSends).some(({ text }) => text.includes('running send_poll'))).toBe(true);
    },
  );

  it('preserves ordinary poll progress and the ordinary sent result', async () => {
    const result = await sendPoll(false);
    await vi.advanceTimersByTimeAsync(101);
    tracker.onToolEnd('poll-tool');
    await drain();
    expect(result).toMatchObject({ sent: true, pollId: 'progress-poll-1' });
    expect(result).not.toHaveProperty('awaitFailed');
    expect(state.pendingPolls.questions.size).toBe(0);
    expect(sends.some(({ jid, text }) => jid === OWNER && text.includes('running send_poll'))).toBe(true);
  });

  it('suppresses awaited poll progress independently for overlapping waits', async () => {
    const first = sendPoll(true, 'first');
    const second = sendPoll(true, 'second');
    await vi.advanceTimersByTimeAsync(101);
    expect(state.pendingPolls.questions.size).toBe(2);
    vote();
    expect(await first).toMatchObject({ answer: 'Yes' });
    tracker.onToolEnd('first');
    await vi.advanceTimersByTimeAsync(101);
    vote('progress-poll-2');
    expect(await second).toMatchObject({ answer: 'Yes' });
    tracker.onToolEnd('second');
    await drain();
    expect(state.pendingPolls.questions.size).toBe(0);
    expect(sends.filter(({ text }) => text.includes('running send_poll'))).toEqual([]);
  });

  it('restores ordinary progress after bounded expiry when the provider has not reported a tool result', async () => {
    const answer = sendPoll(true);
    await vi.advanceTimersByTimeAsync(1_101);
    expect(await answer).toMatchObject({ sent: true, awaitFailed: true });
    expect(tracker.getActive()).toHaveLength(1);
    tracker.onToolEnd('poll-tool');
    await drain();
    expect(state.pendingPolls.questions.size).toBe(0);
    expect(sends.some(({ text }) => text.includes('running send_poll'))).toBe(true);
  });
});
