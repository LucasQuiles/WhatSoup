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
  it('admits a full cap after each restart, rejects past it, and removes orphaned rows durably', async () => {
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
    let failNextOrphanDelete = false;
    const prepareSpy = vi.spyOn(db.raw, 'prepare').mockImplementation(((sql: string) => {
      if (failNextOrphanDelete && sql.startsWith('DELETE FROM pending_polls')) {
        failNextOrphanDelete = false;
        throw new Error('disk I/O error');
      }
      return prepare(sql);
    }) as typeof db.raw.prepare);
    const sendPollRows = () => db.raw
      .prepare("SELECT map_key, chat_jid FROM pending_polls WHERE map_key LIKE 'send_poll:%' ORDER BY map_key")
      .all() as Array<{ map_key: string; chat_jid: string }>;
    let timersLeft = -1;

    try {
      insertRow(db, 'askuser-live', ASK_CHAT, Date.now() + 3_600_000, buildPayload({ chatJid: ASK_CHAT }));
      let retained: { map_key: string; chat_jid: string } | undefined;

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
        failNextOrphanDelete = generation === 1;
        await state.rehydratePendingPolls();

        // AskUser recovery is preserved; no send_poll row survives except one whose delete failed.
        expect([...state.pendingPolls.questions.keys()]).toEqual(['askuser-live']);
        const after = sendPollRows();
        if (generation === 1) {
          expect(after).toHaveLength(1);
          retained = after[0];
        } else {
          expect(after).toEqual([]);
        }
        const expected = generation === 0 ? [] : CHATS.map((jid) => {
          let count = MAX_PENDING_POLL_AWAITS_PER_CONVERSATION;
          if (jid === retained!.chat_jid) count += generation === 1 ? -1 : 1;
          return { jid, text: notice(count) };
        });
        expect([...sentMessages].sort((a, b) => a.jid.localeCompare(b.jid))).toEqual(expected);

        // Fill the cap through MCP admission, 8 per conversation across 4 conversations.
        const sentBefore = sendPollMessage.mock.calls.length;
        for (const chatJid of CHATS) {
          for (let i = 0; i < MAX_PENDING_POLL_AWAITS_PER_CONVERSATION; i += 1) calls.push(ask(chatJid));
        }
        const baseline = generation === 1 ? 1 : 0;
        await vi.waitFor(() => { expect(sendPollRows()).toHaveLength(MAX_PENDING_POLL_AWAITS + baseline); });

        const perConversation = await ask(CHATS[0]!);
        expect(perConversation.isError).toBe(true);
        expect(JSON.parse(perConversation.content[0]!.text).error)
          .toMatch(/limit 8 per conversation\); poll not sent/);
        const total = await ask(EXTRA_CHAT);
        expect(total.isError).toBe(true);
        expect(JSON.parse(total.content[0]!.text).error).toMatch(/limit 32 in total\); poll not sent/);
        expect(sendPollMessage.mock.calls.length - sentBefore).toBe(MAX_PENDING_POLL_AWAITS);
        expect(sendPollRows()).toHaveLength(MAX_PENDING_POLL_AWAITS + baseline);
      }

      // The row kept by the failed delete was retried and removed on the next start.
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
