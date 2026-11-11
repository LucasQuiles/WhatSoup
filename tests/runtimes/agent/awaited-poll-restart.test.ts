import { describe, expect, it, vi } from 'vitest';
import type { Messenger } from '../../../src/core/types.ts';
import type { ToolRegistry } from '../../../src/mcp/registry.ts';
import { resolveSessionContext } from '../../../src/mcp/types.ts';
import {
  MAX_PENDING_POLL_AWAITS,
  MAX_PENDING_POLL_AWAITS_PER_CONVERSATION,
} from '../../../src/mcp/tools/messaging.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import type { PendingPollStore } from '../../../src/runtimes/agent/pending-poll-store.ts';
import { buildPayload, insertRow, makeRealDb } from './lib/runtime-mock-scaffold.ts';

interface RuntimeView {
  registry: ToolRegistry;
  pendingPolls: PendingPollStore;
  deletePendingPollQuestions(mapKey: string): void;
  rehydratePendingPolls(): Promise<void>;
}

const ASK_CHAT = 'restart-ask@g.us';
const CHATS = Array.from(
  { length: MAX_PENDING_POLL_AWAITS / MAX_PENDING_POLL_AWAITS_PER_CONVERSATION },
  (_, i) => `1555010080${i}@s.whatsapp.net`,
);
const EXTRA_CHAT = '15550100899@s.whatsapp.net';

function notice(count: number): string {
  return count > 1
    ? `I restarted while waiting on ${count} polls, so I can no longer act on their votes — ask me again if you still need those decisions.`
    : 'I restarted while waiting on a poll, so I can no longer act on its votes — ask me again if you still need that decision.';
}

describe('awaited send_poll admission across restarts', () => {
  it.each(['marker', 'delete'] as const)('recovers a failed %s write and admits only a full cap after each restart', async (failureStage) => {
    vi.useFakeTimers();
    const db = makeRealDb();
    const sentMessages: Array<{ jid: string; text: string }> = [];
    let nextPoll = 0;
    const sendPollMessage = vi.fn(async () => ({ waMessageId: `restart-poll-${++nextPoll}`, hasSecret: true }));
    const messenger = {
      sendMessage: async (jid: string, text: string) => { sentMessages.push({ jid, text }); return { waMessageId: null }; },
      sendMedia: async () => ({ waMessageId: null }),
      setTyping: async () => undefined,
      sendPollMessage,
    } as unknown as Messenger;
    const runtimes: AgentRuntime[] = [];
    const controllers: AbortController[] = [];
    const calls: Array<Promise<unknown>> = [];
    const prepare = db.raw.prepare.bind(db.raw);
    let failNextOrphanWrite = false;
    const prepareSpy = vi.spyOn(db.raw, 'prepare').mockImplementation(((sql: string) => {
      const failedStatement = failureStage === 'marker'
        ? 'UPDATE pending_polls SET hard_closes_at = 0' : 'DELETE FROM pending_polls';
      if (failNextOrphanWrite && sql.startsWith(failedStatement)) {
        failNextOrphanWrite = false;
        throw new Error('disk I/O error');
      }
      return prepare(sql);
    }) as typeof db.raw.prepare);
    const sendPollRows = () => db.raw
      .prepare("SELECT map_key, chat_jid, hard_closes_at FROM pending_polls WHERE map_key LIKE 'send_poll:%' ORDER BY map_key")
      .all() as Array<{ map_key: string; chat_jid: string; hard_closes_at: number }>;
    let timersLeft = -1;

    try {
      insertRow(db, 'askuser-live', ASK_CHAT, Date.now() + 3_600_000, buildPayload({ chatJid: ASK_CHAT }));
      let retained: { map_key: string; chat_jid: string; hard_closes_at: number } | undefined;

      for (let generation = 0; generation < 3; generation += 1) {
        // A new process: new runtime, new MCP registry, admission counters at zero.
        const runtime = new AgentRuntime(db, messenger, `poll-restart-${generation}`, { sessionScope: 'per_chat' });
        runtimes.push(runtime);
        const state = runtime as unknown as RuntimeView;
        const abort = new AbortController();
        controllers.push(abort);
        const ask = (chatJid: string) => state.registry.call(
          'send_poll',
          { chatJid, question: 'Proceed?', options: ['Yes', 'No'], awaitResult: true, timeoutMs: 3_600_000 },
          resolveSessionContext(
            { tier: 'chat-scoped', conversationKey: chatJid, deliveryJid: chatJid, abortSignal: abort.signal },
            { actorJid: chatJid, conversationKey: chatJid, purpose: undefined, resolved: true },
          ),
        );

        sentMessages.length = 0;
        failNextOrphanWrite = generation === 1;
        await state.rehydratePendingPolls();

        // AskUser recovery is preserved; the failed write retains its row without an active await.
        expect([...state.pendingPolls.questions.keys()]).toEqual(['askuser-live']);
        const after = sendPollRows();
        if (generation === 1) {
          expect(after).toHaveLength(1);
          retained = after[0];
          if (failureStage === 'marker') expect(retained!.hard_closes_at).toBeGreaterThan(Date.now());
          else expect(retained!.hard_closes_at).toBe(0);
        } else {
          expect(after).toEqual([]);
        }
        const expected = generation === 0 ? [] : CHATS.map((jid) => {
          let count = MAX_PENDING_POLL_AWAITS_PER_CONVERSATION;
          if (generation === 1 && failureStage === 'marker' && jid === retained!.chat_jid) count -= 1;
          return { jid, text: notice(count) };
        });
        expect([...sentMessages].sort((a, b) => a.jid.localeCompare(b.jid))).toEqual(expected);
        if (generation === 1) {
          await vi.advanceTimersByTimeAsync(5_000);
          expect(sendPollRows()).toEqual([]);
          if (failureStage === 'marker') expected.push({ jid: retained!.chat_jid, text: notice(1) });
          expect(sentMessages).toEqual(expect.arrayContaining(expected));
          expect(sentMessages).toHaveLength(expected.length);
          await vi.advanceTimersByTimeAsync(10_000);
          expect(sentMessages).toHaveLength(expected.length);
        }

        // Fill the cap through MCP admission, 8 per conversation across 4 conversations.
        const sentBefore = sendPollMessage.mock.calls.length;
        for (const chatJid of CHATS) {
          for (let i = 0; i < MAX_PENDING_POLL_AWAITS_PER_CONVERSATION; i += 1) calls.push(ask(chatJid));
        }
        await vi.waitFor(() => { expect(sendPollRows()).toHaveLength(MAX_PENDING_POLL_AWAITS); });

        const perConversation = await ask(CHATS[0]!);
        expect(perConversation.isError).toBe(true);
        expect(JSON.parse(perConversation.content[0]!.text).error)
          .toMatch(/limit 8 per conversation\); poll not sent/);
        const total = await ask(EXTRA_CHAT);
        expect(total.isError).toBe(true);
        expect(JSON.parse(total.content[0]!.text).error).toMatch(/limit 32 in total\); poll not sent/);
        expect(sendPollMessage.mock.calls.length - sentBefore).toBe(MAX_PENDING_POLL_AWAITS);
        expect(sendPollRows()).toHaveLength(MAX_PENDING_POLL_AWAITS);
      }

      // Bounded recovery removed the retained generation without another restart notice.
      expect(sendPollRows().some((row) => row.map_key === retained!.map_key)).toBe(false);
    } finally {
      prepareSpy.mockRestore();
      for (const abort of controllers) abort.abort();
      await Promise.allSettled(calls);
      for (const runtime of runtimes) {
        const state = runtime as unknown as RuntimeView;
        for (const key of [...state.pendingPolls.questions.keys()]) state.deletePendingPollQuestions(key);
      }
      await Promise.resolve();
      timersLeft = vi.getTimerCount();
      vi.useRealTimers();
      for (const runtime of runtimes) await runtime.shutdown();
      db.close();
    }
    expect(timersLeft, 'poll timers must be removed').toBe(0);
  });
});
