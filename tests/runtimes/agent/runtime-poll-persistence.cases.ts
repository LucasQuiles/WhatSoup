import { describe, it, expect, vi, type Mock } from 'vitest';
import { AgentRuntime, type PendingPollQuestion } from '../../../src/runtimes/agent/runtime.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { TurnQueue } from '../../../src/runtimes/agent/turn-queue.ts';
import type { SingletonLoggerMock } from '../../helpers/logger-mock.ts';
import {
  makeRealDb, makeMessenger, makeMsg, buildPayload, insertRow,
  makeTerminalDurabilityMock, setOwnedTestSession, sendAndDrain,
} from './lib/runtime-mock-scaffold.ts';

type PollSessionMock = Parameters<typeof setOwnedTestSession>[2] & {
  sendTurn: Mock<(...args: unknown[]) => Promise<void>>;
};

export function registerRuntimePollPersistenceTests(
  mockSession: PollSessionMock,
  mockRuntimeLogger: SingletonLoggerMock,
): void {
  describe('poll persistence hardening', () => {
    it.each([
      { questionCount: 1, stop: false }, { questionCount: 2, stop: false },
      { questionCount: 1, stop: true }, { questionCount: 2, stop: true },
    ])('typed poll answer durability: $questionCount questions, shutdown=$stop preserves inbound ownership', async ({ questionCount, stop }) => {
      vi.useFakeTimers();
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const chatJid = 'typed-durable@s.whatsapp.net';
      insertRow(db, chatJid, chatJid, Date.now() + 600_000, buildPayload({
        chatJid, source: 'askuser', mode: 'textFallback', createdAt: Date.now(),
        questions: Array.from({ length: questionCount }, (_, index) => ({
          question: `Question ${index + 1}`, header: 'Choice',
          options: [{ label: 'A', description: '' }], multiSelect: false,
        })),
      }));
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const durability = { completeInbound: vi.fn(), ...makeTerminalDurabilityMock() };
      const state = runtime as unknown as {
        durability: typeof durability;
        pollPersistence: { stop(): void; healthDetails(): { degraded: boolean } };
        perChatTurnQueues: Map<string, TurnQueue>;
      };
      try {
        await runtime.start();
        state.durability = durability;
        setOwnedTestSession(runtime, chatJid, mockSession);
        db.raw.exec(`
          CREATE TRIGGER reject_typed_update BEFORE UPDATE ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
          CREATE TRIGGER reject_typed_insert BEFORE INSERT ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
        `);
        await sendAndDrain(runtime, makeMsg({ chatJid, senderJid: chatJid, content: 'A', inboundSeq: 1703 }));
        await vi.advanceTimersByTimeAsync(1);
        expect.soft(durability.finalizeTurnTerminal).not.toHaveBeenCalled();
        expect.soft(state.perChatTurnQueues.get(chatJid)?.activeTurn?.inboundSeq).toBe(1703);
        expect(mockSession.sendTurn).not.toHaveBeenCalled();
        const before = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(chatJid)!;
        expect(JSON.parse(before.payload as string).answersCollected).toEqual({});
        if (stop) await runtime.shutdown();
        db.raw.exec('DROP TRIGGER reject_typed_update; DROP TRIGGER reject_typed_insert');
        await vi.advanceTimersByTimeAsync(5_000);
        if (stop) {
          expect(mockSession.sendTurn).not.toHaveBeenCalled();
          expect(durability.finalizeTurnTerminal).not.toHaveBeenCalledWith(expect.objectContaining({
            terminal: expect.objectContaining({ attemptKind: 'suppressed_by_policy' }),
          }));
          expect(state.perChatTurnQueues.get(chatJid)?.activeTurn).toBeUndefined();
          expect(state.pollPersistence.healthDetails().degraded).toBe(true);
          expect(db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(chatJid)?.payload).toBe(before.payload);
          return;
        }
        expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
        expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
          terminal: expect.objectContaining({ inboundSeq: 1703, attemptKind: 'suppressed_by_policy' }),
        }));
        expect(state.pollPersistence.healthDetails().degraded).toBe(false);
        if (questionCount === 1) {
          expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
          expect(String((mockSession.sendTurn.mock.calls[0] as unknown as [unknown])[0])).toContain('A: A');
        } else {
          expect(mockSession.sendTurn).not.toHaveBeenCalled();
          const stored = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(chatJid)!;
          expect(JSON.parse(stored.payload as string).answersCollected).toEqual({ 0: 'A' });
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
      } finally {
        state.pollPersistence.stop();
        vi.clearAllTimers();
        db.close();
        vi.useRealTimers();
      }
    });

    it.each([
      { questionCount: 1, outcome: 'recover' }, { questionCount: 2, outcome: 'recover' },
      { questionCount: 1, outcome: 'dispatch-failure' }, { questionCount: 1, outcome: 'replace' },
      { questionCount: 1, outcome: 'newer-row' }, { questionCount: 1, outcome: 'newer-row-failure' },
    ])('console text fallback durability: $questionCount questions, $outcome without false delivery', async ({ questionCount, outcome }) => {
      vi.useFakeTimers();
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const chatJid = 'console-durable@s.whatsapp.net';
      insertRow(db, chatJid, chatJid, Date.now() + 600_000, buildPayload({
        chatJid, source: 'askuser', mode: 'textFallback', createdAt: Date.now(),
        questions: Array.from({ length: questionCount }, (_, index) => ({
          question: `Question ${index + 1}`, header: 'Choice',
          options: [{ label: 'A', description: '' }], multiSelect: false,
        })),
      }));
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        rehydratePendingPolls(): Promise<void>;
        pollPersistence: { healthDetails(): { degraded: boolean }; stop(): void };
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
      };
      try {
        await state.rehydratePendingPolls();
        setOwnedTestSession(runtime, chatJid, mockSession);
        db.raw.exec(`
          CREATE TRIGGER reject_poll_update BEFORE UPDATE ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
          CREATE TRIGGER reject_poll_insert BEFORE INSERT ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
        `);
        const decision = { mapKey: chatJid, questionIndex: 0, selectedOptions: ['A'] };
        expect.soft(await runtime.resolvePollDecisionFromConsole(decision)).toMatchObject({ ok: false, code: 'invalid' });
        expect(mockSession.sendTurn).not.toHaveBeenCalled();
        expect(state.pollPersistence.healthDetails().degraded).toBe(true);
        const before = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(chatJid)!;
        expect(JSON.parse(before.payload as string).answersCollected).toEqual({});
        if (outcome === 'dispatch-failure') mockSession.sendTurn.mockRejectedValueOnce(new Error('provider dispatch unavailable'));
        const original = state.pendingPolls.questions.get(chatJid)!;
        const replacement = { ...original, createdAt: original.createdAt + 1, toolId: 'replacement' };
        if (outcome === 'replace') state.pendingPolls.questions.set(chatJid, replacement);
        if (outcome.startsWith('newer-row')) mockSession.sendTurn.mockImplementationOnce(async () => {
          db.raw.prepare('UPDATE pending_polls SET created_at = ?, tool_id = ? WHERE map_key = ?')
            .run(replacement.createdAt, replacement.toolId, chatJid);
          if (outcome === 'newer-row-failure') throw new Error('provider dispatch unavailable');
        });
        db.raw.exec('DROP TRIGGER reject_poll_update; DROP TRIGGER reject_poll_insert');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(state.pollPersistence.healthDetails().degraded).toBe(false);
        if (outcome.startsWith('newer-row')) {
          expect(mockSession.sendTurn).toHaveBeenCalledOnce();
          expect(db.raw.prepare('SELECT created_at, tool_id FROM pending_polls WHERE map_key = ?').get(chatJid))
            .toEqual({ created_at: replacement.createdAt, tool_id: replacement.toolId });
          return;
        }
        if (outcome === 'replace') {
          expect(mockSession.sendTurn).not.toHaveBeenCalled();
          expect(state.pendingPolls.questions.get(chatJid)).toBe(replacement);
          return;
        }
        if (outcome === 'dispatch-failure') {
          expect(mockSession.sendTurn).toHaveBeenCalledOnce();
          expect(mockRuntimeLogger.error.mock.calls.some((call) => String(call[1]).includes('continuation abandoned'))).toBe(true);
          expect(state.pendingPolls.questions.has(chatJid)).toBe(false);
          expect(db.raw.prepare('SELECT map_key FROM pending_polls WHERE map_key = ?').get(chatJid)).toBeUndefined();
          await vi.advanceTimersByTimeAsync(10_000);
          expect(mockSession.sendTurn).toHaveBeenCalledOnce();
          return;
        }
        if (questionCount === 1) {
          expect(mockRuntimeLogger.error.mock.calls.filter((call) => String(call[1]).includes('continue') || String(call[1]).includes('dispatch'))).toEqual([]);
          expect(mockSession.sendTurn).toHaveBeenCalledTimes(1);
          expect(String((mockSession.sendTurn.mock.calls[0] as unknown as [unknown])[0])).toContain('A: A');
          expect(db.raw.prepare('SELECT map_key FROM pending_polls WHERE map_key = ?').get(chatJid)).toBeUndefined();
        } else {
          expect(mockSession.sendTurn).not.toHaveBeenCalled();
          const after = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(chatJid)!;
          expect(JSON.parse(after.payload as string).answersCollected).toEqual({ 0: 'A' });
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockSession.sendTurn).toHaveBeenCalledTimes(questionCount === 1 ? 1 : 0);
      } finally {
        state.pollPersistence.stop();
        vi.clearAllTimers();
        db.close();
        vi.useRealTimers();
      }
    });

    it.each(['recover', 'valid', 'corrupt', 'exhaust', 'shutdown'] as const)('poll startup read recovery: %s preserves queued decisions', async (outcome) => {
      vi.useFakeTimers();
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const mapKey = 'startup-askuser';
      insertRow(db, mapKey, 'startup@g.us', Date.now() + 600_000, buildPayload({
        chatJid: 'startup@g.us', source: 'askuser', mode: 'textFallback', createdAt: Date.now(),
        questions: ['First', 'Second'].map((question) => ({
          question, header: 'Choice', options: [{ label: 'A', description: '' }], multiSelect: false,
        })),
      }));
      db.raw.exec(`CREATE TABLE pending_poll_decisions (
        map_key TEXT NOT NULL, question_index INTEGER NOT NULL, selected_options TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), via TEXT NOT NULL,
        PRIMARY KEY (map_key, question_index)
      )`);
      // Recovery must distinguish a consumed answer from input retained for correction.
      db.raw.prepare('INSERT INTO pending_poll_decisions (map_key, question_index, selected_options, via) VALUES (?, 0, ?, ?)')
        .run(mapKey, outcome === 'valid' ? '["A"]' : '[]', 'console');
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        rehydratePendingPolls(): Promise<void>;
        consumeQueuedPollDecisions(): Promise<void>;
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
        offlineDecisionRetry: { healthDetails(): { attempts: number; pending: boolean; exhausted: boolean } };
        pollPersistence: { healthDetails(): { degraded: boolean } };
      };
      try {
        const storedPayload = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(mapKey)!.payload;
        if (outcome === 'corrupt') db.raw.prepare('UPDATE pending_polls SET payload = ? WHERE map_key = ?').run('{invalid private answer', mapKey);
        else db.raw.exec('ALTER TABLE pending_polls RENAME TO temporarily_unreadable_polls');
        await state.rehydratePendingPolls();
        await state.consumeQueuedPollDecisions();
        expect(db.raw.prepare('SELECT count(*) AS n FROM pending_poll_decisions').get()?.n).toBe(1);
        expect(state.pendingPolls.questions.size).toBe(0);
        expect(state.pollPersistence.healthDetails().degraded).toBe(true);
        expect(state.offlineDecisionRetry.healthDetails()).toMatchObject({ pending: true, attempts: 0 });
        if (outcome === 'shutdown') await runtime.shutdown();
        if (outcome === 'corrupt') db.raw.prepare('UPDATE pending_polls SET payload = ? WHERE map_key = ?').run(storedPayload, mapKey);
        else if (outcome !== 'exhaust') db.raw.exec('ALTER TABLE temporarily_unreadable_polls RENAME TO pending_polls');
        await vi.advanceTimersByTimeAsync(outcome === 'exhaust' ? 180_000 : 5_000);
        expect(db.raw.prepare('SELECT count(*) AS n FROM pending_poll_decisions').get()?.n).toBe(outcome === 'valid' ? 0 : 1);
        if (outcome === 'recover' || outcome === 'valid' || outcome === 'corrupt') {
          expect(state.pendingPolls.questions.get(mapKey)?.source).toBe('askuser');
          expect(state.pollPersistence.healthDetails().degraded).toBe(false);
          if (outcome === 'valid') {
            expect(state.pendingPolls.questions.get(mapKey)?.answersCollected).toEqual({ 0: 'A' });
            const stored = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(mapKey)!;
            expect(JSON.parse(stored.payload as string).answersCollected).toEqual({ 0: 'A' });
          }
        } else {
          expect(state.pendingPolls.questions.size).toBe(0);
          expect(state.pollPersistence.healthDetails().degraded).toBe(true);
          expect(state.offlineDecisionRetry.healthDetails()).toMatchObject(outcome === 'exhaust'
            ? { pending: false, attempts: 5, exhausted: true }
            : { pending: false, attempts: 0, exhausted: false });
        }
      } finally {
        vi.clearAllTimers();
        db.close();
        vi.useRealTimers();
      }
    });

    it.each(['delete', 'stage', 'vote', 'console'] as const)('poll terminal durability: %s waits for a durable state', async (operation) => {
      vi.useFakeTimers();
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const mapKey = 'terminal-durability';
      const chatJid = 'terminal@g.us';
      const source = operation === 'stage' ? 'askuser' : 'send_poll';
      insertRow(db, mapKey, chatJid, Date.now() + 600_000, buildPayload({
        chatJid, source, createdAt: Date.now(), resolution: 'first-vote-wins',
        pollMessageIdToQuestionIndex: new Map([['TERMINAL_POLL', 0]]),
        sentPollMessageIds: ['TERMINAL_POLL'],
      }));
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const state = runtime as unknown as {
        rehydratePendingPolls(): Promise<void>;
        pendingPolls: { questions: Map<string, PendingPollQuestion> };
        deletePendingPollQuestions(key: string): void;
        stageResolvedAskUserPoll(key: string, pending: PendingPollQuestion): boolean;
        handlePollVoteReceived(data: { pollMessageId: string; chatJid: string; voterJid: string; selectedOptions: string[] }): void;
      };
      let pending: PendingPollQuestion | undefined;
      try {
        await state.rehydratePendingPolls();
        pending = state.pendingPolls.questions.get(mapKey)!;
        expect(pending).toBeDefined();
        db.raw.prepare('UPDATE pending_polls SET created_at = ?, tool_id = ? WHERE map_key = ?')
          .run(pending.createdAt, pending.toolId, mapKey);
        const resolve = vi.fn();
        const reject = vi.fn();
        pending.awaitResolve = resolve;
        pending.awaitReject = reject;
        db.raw.exec(`
          CREATE TRIGGER reject_poll_update BEFORE UPDATE ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
          CREATE TRIGGER reject_poll_insert BEFORE INSERT ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
          CREATE TRIGGER reject_poll_delete BEFORE DELETE ON pending_polls BEGIN SELECT RAISE(FAIL, 'write blocked'); END;
        `);
        if (operation === 'delete') state.deletePendingPollQuestions(mapKey);
        else if (operation === 'stage') expect(state.stageResolvedAskUserPoll(mapKey, pending)).toBe(false);
        else if (operation === 'console') expect(await runtime.resolvePollDecisionFromConsole({
          mapKey, questionIndex: 0, selectedOptions: ['A'],
        })).toMatchObject({ ok: false, code: 'invalid' });
        else state.handlePollVoteReceived({ pollMessageId: 'TERMINAL_POLL', chatJid, voterJid: chatJid, selectedOptions: ['A'] });
        expect(resolve).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
        expect(state.pendingPolls.questions.get(mapKey)).toBe(pending);
        expect(pending.resolvedAt).toBeUndefined();
        const stored = db.raw.prepare('SELECT payload FROM pending_polls WHERE map_key = ?').get(mapKey)!;
        expect(JSON.parse(stored.payload as string).resolvedAt).toBeUndefined();
        db.raw.exec('DROP TRIGGER reject_poll_update; DROP TRIGGER reject_poll_insert; DROP TRIGGER reject_poll_delete');
        await vi.advanceTimersByTimeAsync(5_000);
        if (operation === 'stage') expect(pending.resolvedAt).toBeTypeOf('number');
        else {
          expect(operation === 'delete' ? reject : resolve).toHaveBeenCalledTimes(1);
          expect(state.pendingPolls.questions.has(mapKey)).toBe(false);
        }
      } finally {
        if (pending?.softExpiryTimer) clearTimeout(pending.softExpiryTimer);
        if (pending?.hardExpiryTimer) clearTimeout(pending.hardExpiryTimer);
        db.close();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it('rehydrate consolidates expired-during-downtime notices to one message per chat', async () => {
      const db = makeRealDb();
      const { messenger, sentMessages } = makeMessenger();
      const past = Date.now() - 10_000;
      const future = Date.now() + 3_600_000;

      // chatA: 3 stranded polls → one consolidated "3 polls" notice
      insertRow(db, 'send_poll:a1', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      insertRow(db, 'send_poll:a2', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      insertRow(db, 'send_poll:a3', 'chatA@g.us', past, buildPayload({ chatJid: 'chatA@g.us' }));
      // chatB: 1 stranded poll → one single-poll notice
      insertRow(db, 'send_poll:b1', 'chatB@g.us', past, buildPayload({ chatJid: 'chatB@g.us' }));
      // chatC: live poll → restored, no notice
      insertRow(db, 'send_poll:c1', 'chatC@g.us', future, buildPayload({
        chatJid: 'chatC@g.us',
        pollMessageIdToQuestionIndex: new Map([['POLL_C', 0]]),
        sentPollMessageIds: ['POLL_C'],
      }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await (runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls();

      // Exactly 2 chats notified (chatA + chatB), not 4 messages
      expect(sentMessages).toHaveLength(2);
      const byChat = new Map(sentMessages.map((m) => [m.jid, m.text]));
      expect(byChat.get('chatA@g.us')).toMatch(/3 polls/);
      expect(byChat.get('chatB@g.us')).toMatch(/A poll I was waiting on/);
      expect(byChat.has('chatC@g.us')).toBe(false);

      // chatC live poll restored into the in-memory map; expired rows deleted from table
      const state = runtime as unknown as { pendingPolls: { questions: Map<string, unknown> } };
      expect(state.pendingPolls.questions.has('send_poll:c1')).toBe(true);
      expect(state.pendingPolls.questions.has('send_poll:a1')).toBe(false);
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(1);

      db.close();
    });

    it('rehydrate removes a resolved AskUser continuation and sends a deterministic retry notice', async () => {
      const db = makeRealDb();
      const { messenger, sentMessages } = makeMessenger();
      const future = Date.now() + 3_600_000;
      insertRow(db, 'resolved-askuser', 'resolved-chat@g.us', future, buildPayload({
        chatJid: 'resolved-chat@g.us',
        answersCollected: { 0: 'A' },
        resolvedAt: Date.now() - 1_000,
      }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await (runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls();

      expect(sentMessages).toEqual([{
        jid: 'resolved-chat@g.us',
        text: expect.stringMatching(/received your poll answer.*send the answer again/i),
      }]);
      expect((runtime as unknown as {
        pendingPolls: { questions: Map<string, unknown> };
      }).pendingPolls.questions.has('resolved-askuser')).toBe(false);
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

      db.close();
    });

    it('rehydrate logs and drops expired polls when the downtime notice send rejects', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const past = Date.now() - 10_000;
      const sendError = new Error('socket closed');
      messenger.sendMessage = vi.fn(async () => {
        throw sendError;
      });
      mockRuntimeLogger.warn.mockClear();

      insertRow(db, 'send_poll:reject', 'chatReject@g.us', past, buildPayload({ chatJid: 'chatReject@g.us' }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await expect((runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls()).resolves.toBeUndefined();
      await Promise.resolve();

      expect(messenger.sendMessage).toHaveBeenCalledWith(
        'chatReject@g.us',
        expect.stringContaining('A poll I was waiting on expired'),
      );
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { err: sendError, chatJid: 'chatReject@g.us' },
        'notifyPollExpiredDuringDowntime: send failed (non-fatal)',
      );
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

      db.close();
    });

    it('rehydrate logs and drops expired polls when downtime notice dispatch throws synchronously', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const past = Date.now() - 10_000;
      const dispatchError = new Error('transport unavailable');
      messenger.sendMessage = vi.fn(() => {
        throw dispatchError;
      }) as unknown as Messenger['sendMessage'];
      mockRuntimeLogger.warn.mockClear();

      insertRow(db, 'send_poll:throw', 'chatThrow@g.us', past, buildPayload({ chatJid: 'chatThrow@g.us' }));

      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      await expect((runtime as unknown as { rehydratePendingPolls(): Promise<void> }).rehydratePendingPolls()).resolves.toBeUndefined();

      expect(messenger.sendMessage).toHaveBeenCalledWith(
        'chatThrow@g.us',
        expect.stringContaining('A poll I was waiting on expired'),
      );
      expect(mockRuntimeLogger.warn).toHaveBeenCalledWith(
        { err: dispatchError, chatJid: 'chatThrow@g.us' },
        'notifyPollExpiredDuringDowntime: dispatch failed (non-fatal)',
      );
      const remaining = db.raw.prepare('SELECT COUNT(*) AS cnt FROM pending_polls').get() as { cnt: number };
      expect(remaining.cnt).toBe(0);

      db.close();
    });

    it('persistPendingPoll failure increments pollPersistenceErrors and surfaces it in the health snapshot', async () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      const snapBefore = runtime.getHealthSnapshot();
      expect((snapBefore.details as { pollPersistenceErrors: number }).pollPersistenceErrors).toBe(0);

      // Drop the table AFTER construction so the constructor's own prepares
      // succeed but persist/remove INSERT/DELETE hit "no such table" and the
      // catch blocks increment the counter.
      db.raw.prepare('DROP TABLE pending_polls').run();

      const pending: PendingPollQuestion = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-y',
        chatJid: 'chatErr@g.us',
        chatJidAliases: new Set(['chatErr@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_Y', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution: 'first-vote-wins',
        timeoutMs: 3_600_000,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'send_poll',
        sentPollMessageIds: ['POLL_Y'],
      };

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('send_poll:y', pending);
      (runtime as unknown as { pollPersistence: { remove(k: string): void } })
        .pollPersistence.remove('send_poll:y');

      const snapAfter = runtime.getHealthSnapshot();
      expect((snapAfter.details as { pollPersistenceErrors: number }).pollPersistenceErrors).toBe(2);

      db.close();
    });

    it('CAR-20 (#2539): persistence failure surfaces a degradation cause + current-vs-historical health', () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });

      const pending: PendingPollQuestion = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-d',
        chatJid: 'chatD@g.us',
        chatJidAliases: new Set(['chatD@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_D', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt: Date.now(),
        resolution: 'first-vote-wins',
        timeoutMs: 3_600_000,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'send_poll',
        sentPollMessageIds: ['POLL_D'],
      };

      // Drop the table so save/remove hit "no such table" → recordFailure (current active failure).
      db.raw.prepare('DROP TABLE pending_polls').run();
      const p = (runtime as unknown as {
        pollPersistence: { save(k: string, pp: PendingPollQuestion): void; remove(k: string): void };
      }).pollPersistence;
      p.save('send_poll:d', pending);
      p.remove('send_poll:d');

      const degraded = runtime.getHealthSnapshot();
      const dDetails = degraded.details as {
        degradedReasons: string[];
        pollPersistenceHealth: { degraded: boolean; consecutiveFailures: number; totalRecoveries: number; lastRecoveredAt: number | null };
      };
      // [DISCRIMINATING (1): fails if the degradation surface is removed]
      expect(dDetails.degradedReasons).toContain('poll_persistence_failure');
      expect(dDetails.pollPersistenceHealth.degraded).toBe(true);         // CURRENT active failure
      expect(dDetails.pollPersistenceHealth.consecutiveFailures).toBe(2);
      expect(dDetails.pollPersistenceHealth.totalRecoveries).toBe(0);     // not yet recovered
      expect(degraded.status).toBe('degraded');

      // Recreate the table and succeed → historical recovery, no current failure.
      db.raw.exec(
        'CREATE TABLE pending_polls (map_key TEXT PRIMARY KEY, chat_jid TEXT NOT NULL, tool_id TEXT NOT NULL, ' +
        'source TEXT NOT NULL, resolution TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
        'closes_at INTEGER, hard_closes_at INTEGER)',
      );
      p.remove('send_poll:d'); // now succeeds → ends the streak, marks a recovery

      const recovered = runtime.getHealthSnapshot();
      const rDetails = recovered.details as {
        degradedReasons: string[];
        pollPersistenceHealth: { degraded: boolean; totalRecoveries: number; lastRecoveredAt: number | null };
      };
      // [DISCRIMINATING (4): current-vs-historical distinction]
      expect(rDetails.degradedReasons).not.toContain('poll_persistence_failure');
      expect(rDetails.pollPersistenceHealth.degraded).toBe(false);        // recovered → historical only
      expect(rDetails.pollPersistenceHealth.totalRecoveries).toBe(1);     // one recovery recorded
      expect(rDetails.pollPersistenceHealth.lastRecoveredAt).not.toBeNull();

      db.close();
    });

    it('normalizes legacy pending poll timeout before persistence', () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const createdAt = 1_700_000_000_000;
      const pending = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-legacy-timeout',
        chatJid: 'chatLegacy@g.us',
        chatJidAliases: new Set(['chatLegacy@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_LEGACY', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt,
        resolution: 'first-vote-wins',
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_LEGACY'],
      } as PendingPollQuestion;

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('legacy-timeout', pending);

      const row = db.raw
        .prepare('SELECT payload, closes_at, hard_closes_at FROM pending_polls WHERE map_key = ?')
        .get('legacy-timeout') as { payload: string; closes_at: number; hard_closes_at: number };
      const payload = JSON.parse(row.payload) as { timeoutMs?: number };
      expect(payload.timeoutMs).toBe(3_600_000);
      expect(row.closes_at).toBe(createdAt + 3_600_000);
      expect(row.hard_closes_at).toBe(createdAt + 7_200_000);

      db.close();
    });

    it('clamps out-of-range legacy pending poll timeout before persistence', () => {
      const db = makeRealDb();
      const { messenger } = makeMessenger();
      const runtime = new AgentRuntime(db, messenger, 'test', { sessionScope: 'per_chat' });
      const createdAt = 1_700_000_000_000;
      const pending = {
        questions: [{ question: 'Q', header: 'H', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }],
        toolId: 'tool-huge-timeout',
        chatJid: 'chatHuge@g.us',
        chatJidAliases: new Set(['chatHuge@g.us']),
        mode: 'poll',
        pollMessageIdToQuestionIndex: new Map([['POLL_HUGE', 0]]),
        currentQuestionIndex: 0,
        answersCollected: {},
        createdAt,
        resolution: 'first-vote-wins',
        timeoutMs: Number.MAX_SAFE_INTEGER,
        votesByQuestion: new Map(),
        adminJids: null,
        source: 'askuser',
        sentPollMessageIds: ['POLL_HUGE'],
      } as PendingPollQuestion;

      (runtime as unknown as { pollPersistence: { save(k: string, p: PendingPollQuestion): void } })
        .pollPersistence.save('huge-timeout', pending);

      const row = db.raw
        .prepare('SELECT payload, closes_at, hard_closes_at FROM pending_polls WHERE map_key = ?')
        .get('huge-timeout') as { payload: string; closes_at: number; hard_closes_at: number };
      const payload = JSON.parse(row.payload) as { timeoutMs?: number };
      expect(payload.timeoutMs).toBe(86_400_000);
      expect(row.closes_at).toBe(createdAt + 86_400_000);
      expect(row.hard_closes_at).toBe(createdAt + 172_800_000);

      db.close();
    });
  });
}
