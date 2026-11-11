// tests/mcp/tools/messaging-send-poll.test.ts
//
// send_poll tests, moved verbatim from messaging.test.ts. The awaited-poll
// admission tests (#3867) pushed messaging.test.ts past the 2000-line
// arch.file-size warn budget; moving the send_poll block here keeps that file
// under budget instead of grandfathering a 36th warning file. The fixture below
// mirrors messaging.test.ts's per-file setup (the repo norm, see
// messaging-send-resolved-jid-3150.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { MAX_PENDING_POLL_AWAITS, MAX_PENDING_POLL_AWAITS_PER_CONVERSATION, registerMessagingTools, type MessagingDeps } from '../../../src/mcp/tools/messaging.ts';
import { depsWithRegistrar, makeFakePollRegistrar } from '../../helpers/poll-registrar.ts';
import { createProfileRegistry } from '../../../src/core/profiles.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import { ToolRegistry as ProductionToolRegistry } from '../../../src/mcp/registry.ts';
import { resolveSessionContext } from '../../../src/mcp/types.ts';
import { attachPollWaitOwner } from '../../../src/mcp/poll-wait-owner.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      quoted_message_id TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE chat_aliases (
      alias TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function makeCalls(): string[] {
  return [];
}

function makeConnection(calls: string[]) {
  return {
    contactsDir: {
      contacts: new Map<string, string>([['alice', '15555550001']]),
      getLidMappings: () => undefined,
    },
    sendRaw: async (jid: string, content: unknown) => {
      calls.push(JSON.stringify({ jid, content }));
      return { waMessageId: null };
    },
    sendPollMessage: async (jid: string, name: string, values: string[], selectableCount: number) => {
      calls.push(JSON.stringify({ jid, content: { poll: { name, values, selectableCount } } }));
      return { waMessageId: `poll-${Date.now()}`, hasSecret: true };
    },
    sendMedia: async (jid: string, media: unknown) => {
      calls.push(JSON.stringify({ sendMedia: { jid, media } }));
      return { waMessageId: null };
    },
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMessagingTools — send_poll', () => {
  let registry: ToolRegistry;
  let db: DatabaseSync;
  // T8-F1+F2: separate Database WRAPPER (distinct from the hand-rolled `db`
  // above) — isOperatorDmPeer needs lid_mappings resolution via the wrapper's
  // `.raw`, which the lightweight `makeDb()` fixture doesn't create. Default
  // adminPhones is empty so every PRE-EXISTING test in this file keeps its
  // exact prior behavior (never elevates); only the T8-F1+F2 describe block
  // below overrides it to prove elevation.
  let dbWrapper: Database;
  let calls: string[];
  let connection: ReturnType<typeof makeConnection>;
  let deps: MessagingDeps;

  beforeEach(() => {
    vi.mocked(emitAlertChecked).mockClear();
    registry = new ToolRegistry();
    db = makeDb();
    dbWrapper = new Database(':memory:');
    dbWrapper.open();
    calls = makeCalls();
    connection = makeConnection(calls);
    deps = {
      connection,
      db,
      dbWrapper,
      adminPhones: new Set<string>(),
      instanceName: 'test-bot',
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite', linkPreview: 'off' },
      }),
    };
    registerMessagingTools(registry, deps);
  });

  describe('send_poll', () => {
    it.each(['vote', 'expiry', 'abort'] as const)('releases the requesting turn wait after %s', async (outcome) => {
      const localRegistry = new ProductionToolRegistry();
      const registrar = makeFakePollRegistrar();
      registerMessagingTools(localRegistry, depsWithRegistrar(deps, registrar));
      const controller = new AbortController();
      const session = resolveSessionContext(
        { ...chatSession('poll-owner', 'poll-owner@s.whatsapp.net'), abortSignal: controller.signal },
        { actorJid: undefined, purpose: undefined, conversationKey: 'poll-owner' },
      );
      const finish = vi.fn();
      const begin = vi.fn(() => {
        expect(registrar.calls).toHaveLength(1);
        return finish;
      });
      attachPollWaitOwner(session, { begin });

      const pending = localRegistry.call('send_poll', {
        question: 'Pick', options: ['A', 'B'], awaitResult: true, timeoutMs: 5000,
      }, session);
      await vi.waitFor(() => expect(begin).toHaveBeenCalledWith(5000));
      expect(finish).not.toHaveBeenCalled();
      if (outcome === 'vote') registrar.resolveLast('A');
      else if (outcome === 'expiry') registrar.rejectLast(new Error('expired'));
      else controller.abort();

      const result = await pending;
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);
      if (outcome === 'vote') expect(body.answer).toBe('A');
      else expect(body.awaitFailed).toBe(true);
      expect(begin).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledOnce();
    });

    it.each(['nonblocking', 'untracked', 'registration-error'] as const)(
      'does not extend the requesting turn for a %s poll', async (condition) => {
        const localRegistry = new ProductionToolRegistry();
        const registrar = makeFakePollRegistrar();
        const localDeps = condition === 'untracked' ? deps : depsWithRegistrar(deps, registrar);
        if (condition === 'registration-error') {
          registrar.register = () => { throw new Error('registration failed'); };
        }
        registerMessagingTools(localRegistry, localDeps);
        const session = resolveSessionContext(
          chatSession('poll-owner', 'poll-owner@s.whatsapp.net'),
          { actorJid: undefined, purpose: undefined, conversationKey: 'poll-owner' },
        );
        const begin = vi.fn();
        attachPollWaitOwner(session, { begin });
        const result = await localRegistry.call('send_poll', {
          question: 'Pick', options: ['A', 'B'], awaitResult: condition !== 'nonblocking',
        }, session);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ sent: true });
        expect(begin).not.toHaveBeenCalled();
      },
    );

    it('advertises portable usage guidance in the MCP schema', () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      const tool = registry.listTools(session).find((candidate) => candidate.name === 'send_poll');
      const schema = tool?.inputSchema as {
        properties: Record<string, { description?: string; items?: { description?: string } }>;
      } | undefined;

      expect(tool?.description).toContain('blocking user input, prefer AskUserQuestion');
      expect(schema?.properties['question'].description).toContain('send long context in a normal message before the poll');
      expect(schema?.properties['options'].description).toContain('2-12 unique');
      expect(schema?.properties['options'].items?.description).toContain('Short poll option label');
      expect(schema?.properties['selectableCount'].description).toContain('multi-select polls');
    });

    it('sends a poll with question and options', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'Favourite colour?', options: ['Red', 'Blue', 'Green'] },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.poll.name).toBe('Favourite colour?');
      expect(call.content.poll.values).toEqual(['Red', 'Blue', 'Green']);
      expect(call.content.poll.selectableCount).toBe(1);
      expect(JSON.parse(result.content[0].text).selectableCount).toBe(1);
    });

    // ── client-safety guardrail: poll question + options are agent free-text.
    //    Redaction-only (divert/generic-replacement is nonsensical for a poll). ─
    it('redacts an internal path leaked in a poll question and options', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      await registry.call(
        'send_poll',
        {
          question: 'Open /Users/testuser/.claude/settings.json?',
          options: ['Yes', 'No, see agent-sandbox.sh'],
        },
        session,
      );
      const call = JSON.parse(calls[0]);
      expect(call.content.poll.name).not.toContain('/Users/testuser');
      expect(JSON.stringify(call.content.poll.values)).not.toContain('agent-sandbox.sh');
    });

    it('sends a multi-select poll when selectableCount allows multiple choices', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'Pick supported channels', options: ['WhatsApp', 'Email', 'Slack'], selectableCount: 2 },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.poll.selectableCount).toBe(2);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        sent: true,
        selectableCount: 2,
      });
    });

    it('rejects poll with fewer than 2 options', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'One option?', options: ['Only one'] },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/at least 2 options/);
    });

    it('rejects poll with more than 12 options', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');
      const tooMany = Array.from({ length: 13 }, (_, i) => `Option ${i + 1}`);
      const result = await registry.call(
        'send_poll',
        { question: 'Too many?', options: tooMany },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/at most 12 options/);
    });

    it('rejects invalid selectableCount values before sending', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');

      for (const [selectableCount, errorPattern] of [
        [0, /at least 1/],
        [1.5, /whole number/],
        [4, /cannot exceed/],
      ] as const) {
        const result = await registry.call(
          'send_poll',
          { question: 'Pick options', options: ['A', 'B', 'C'], selectableCount },
          session,
        );

        const body = JSON.parse(result.content[0].text);
        expect(body.error).toMatch(errorPattern);
      }
      expect(calls).toHaveLength(0);
    });

    it('rejects blank, duplicate, and overly long poll text before sending', async () => {
      const session = chatSession('poll-chat', 'poll-chat@s.whatsapp.net');

      const blank = await registry.call('send_poll', { question: '  ', options: ['A', 'B'] }, session);
      expect(JSON.parse(blank.content[0].text).error).toMatch(/question is required/);

      const longQuestion = await registry.call('send_poll', { question: 'Q'.repeat(901), options: ['A', 'B'] }, session);
      expect(JSON.parse(longQuestion.content[0].text).error).toMatch(/900 characters or fewer/);

      const blankOption = await registry.call('send_poll', { question: 'Pick', options: ['A', '  '] }, session);
      expect(JSON.parse(blankOption.content[0].text).error).toBe('Poll option 2 is blank');

      const duplicate = await registry.call('send_poll', { question: 'Pick', options: ['A', ' a '] }, session);
      expect(JSON.parse(duplicate.content[0].text).error).toMatch(/unique/);

      const longOption = await registry.call('send_poll', { question: 'Pick', options: ['A'.repeat(96), 'B'] }, session);
      expect(JSON.parse(longOption.content[0].text).error).toMatch(/95 characters or fewer/);

      expect(calls).toHaveLength(0);
    });

    it('sanitizes poll send failures', async () => {
      (connection as any).sendPollMessage = async () => {
        throw new Error('404 not found while sending poll');
      };

      const result = await registry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'] },
        chatSession('poll-chat', 'poll-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('The requested resource was not found.');
    });

    it('C6a — awaitResult:true awaits the registrar and returns the resolved answer with exact register args', async () => {
      const localRegistry = new ToolRegistry();
      const fakeRegistrar = makeFakePollRegistrar();
      registerMessagingTools(localRegistry, depsWithRegistrar(deps, fakeRegistrar));

      const session = chatSession('poll-await', 'poll-await@s.whatsapp.net');
      const callPromise = localRegistry.call(
        'send_poll',
        {
          question: 'Pick a colour',
          options: ['Red', 'Blue', 'Green'],
          resolution: 'first-vote-wins',
          timeoutMs: 5000,
          awaitResult: true,
        },
        session,
      );

      await vi.waitFor(() => {
        expect(fakeRegistrar.calls).toHaveLength(1);
      });
      const registerCall = fakeRegistrar.calls[0];
      expect(registerCall.pollId).toMatch(/^poll-/);
      expect(registerCall.chatJid).toBe('poll-await@s.whatsapp.net');
      expect(registerCall.options).toEqual(['Red', 'Blue', 'Green']);
      expect(registerCall.resolution).toBe('first-vote-wins');
      expect(registerCall.timeoutMs).toBe(5000);

      fakeRegistrar.resolveLast('Red');
      const result = await callPromise;
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);
      expect(body.pollId).toBe(registerCall.pollId);
      expect(body.answer).toBe('Red');
      expect(body.awaitFailed).toBeUndefined();
      expect(body.error).toBeUndefined();
      expect(body.options).toEqual(['Red', 'Blue', 'Green']);
    });

    it('C6b — awaitResult:true without a pollRegistrar dep returns awaitFailed with the tracking-unavailable error', async () => {
      const session = chatSession('poll-no-reg', 'poll-no-reg@s.whatsapp.net');
      const result = await registry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);
      expect(body.pollId).toMatch(/^poll-/);
      expect(body.awaitFailed).toBe(true);
      expect(body.answer).toBeUndefined();
      expect(body.options).toEqual(['A', 'B']);
      expect(body.question).toBe('Pick');
      expect(body.error).toBe('Poll sent but vote tracking unavailable — cannot await result');
    });

    it('C6c — timeoutMs is bounded by Zod inclusive and defaults to 3,600,000 when undefined', async () => {
      const session = chatSession('poll-bounds', 'poll-bounds@s.whatsapp.net');

      const tooLow = await registry.call('send_poll', { question: 'Pick', options: ['A', 'B'], timeoutMs: 999 }, session);
      expect(tooLow.isError).toBe(true);
      expect(tooLow.content[0].text).toMatch(/timeoutMs/i);

      const tooHigh = await registry.call('send_poll', { question: 'Pick', options: ['A', 'B'], timeoutMs: 86_400_001 }, session);
      expect(tooHigh.isError).toBe(true);
      expect(tooHigh.content[0].text).toMatch(/timeoutMs/i);

      const localRegistry = new ToolRegistry();
      const fakeRegistrar = makeFakePollRegistrar();
      registerMessagingTools(localRegistry, depsWithRegistrar(deps, fakeRegistrar));

      const minPromise = localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true, timeoutMs: 1000 },
        chatSession('poll-min', 'poll-min@s.whatsapp.net'),
      );
      await vi.waitFor(() => { expect(fakeRegistrar.calls).toHaveLength(1); });
      expect(fakeRegistrar.calls[0].timeoutMs).toBe(1000);
      fakeRegistrar.resolveLast('A');
      await minPromise;

      const maxPromise = localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true, timeoutMs: 86_400_000 },
        chatSession('poll-max', 'poll-max@s.whatsapp.net'),
      );
      await vi.waitFor(() => { expect(fakeRegistrar.calls).toHaveLength(2); });
      expect(fakeRegistrar.calls[1].timeoutMs).toBe(86_400_000);
      fakeRegistrar.resolveLast('A');
      await maxPromise;

      const defaultPromise = localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        chatSession('poll-default', 'poll-default@s.whatsapp.net'),
      );
      await vi.waitFor(() => { expect(fakeRegistrar.calls).toHaveLength(3); });
      expect(fakeRegistrar.calls[2].timeoutMs).toBe(3_600_000);
      fakeRegistrar.resolveLast('A');
      await defaultPromise;
    });

    // An over-limit call must return at once. Without the limit it would wait for a vote, so
    // fail by assertion instead of by the test timeout.
    const returnsWithoutVote = async <T,>(call: Promise<T>): Promise<T> => {
      let settled: { value: T } | undefined;
      void call.then((value) => { settled = { value }; });
      await vi.waitFor(() => { expect(settled, 'call returned without waiting for a vote').toBeDefined(); });
      return settled!.value;
    };

    it('C6d — bounds concurrently awaited polls before the external send and frees a slot on settle or send failure', async () => {
      const localRegistry = new ToolRegistry();
      const settle: Array<(answer: string) => void> = [];
      const registrar = {
        register: vi.fn(() => new Promise<string>((resolve) => { settle.push(resolve); })),
      };
      registerMessagingTools(localRegistry, Object.assign({}, deps, { pollRegistrar: registrar }));
      const sendPoll = vi.spyOn(connection as unknown as { sendPollMessage: (...args: unknown[]) => unknown }, 'sendPollMessage');
      const sendCountBefore = sendPoll.mock.calls.length;
      const ask = (i: number) => localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        chatSession(`poll-cap-${i}`, `poll-cap-${i}@s.whatsapp.net`),
      );

      const pending = Array.from({ length: MAX_PENDING_POLL_AWAITS }, (_, i) => ask(i));
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS); });

      const refused = await returnsWithoutVote(ask(MAX_PENDING_POLL_AWAITS));
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0].text).error).toMatch(/Too many awaited polls are pending \(limit 32 in total\); poll not sent/);
      expect(sendPoll.mock.calls.length - sendCountBefore).toBe(MAX_PENDING_POLL_AWAITS);

      // A poll without awaitResult creates no wait and is not limited.
      const plain = await localRegistry.call('send_poll', { question: 'Pick', options: ['A', 'B'] }, chatSession('poll-plain', 'poll-plain@s.whatsapp.net'));
      expect(JSON.parse(plain.content[0].text).sent).toBe(true);

      settle[0]!('A');
      await pending[0];
      const readmitted = ask(MAX_PENDING_POLL_AWAITS + 1);
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS + 1); });

      // A failed send releases its reservation too.
      const failing = vi.spyOn(connection as unknown as { sendPollMessage: (...args: unknown[]) => unknown }, 'sendPollMessage');
      settle[1]!('A');
      await pending[1];
      failing.mockRejectedValueOnce(new Error('send failed'));
      const failed = await ask(MAX_PENDING_POLL_AWAITS + 2);
      expect(failed.isError).toBe(true);
      const afterFailure = ask(MAX_PENDING_POLL_AWAITS + 3);
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS + 2); });

      for (const resolve of settle.slice(2)) resolve('A');
      await Promise.all([...pending.slice(2), readmitted, afterFailure]);
      sendPoll.mockRestore();
    });

    it('C6e — one conversation cannot take every awaited-poll slot', async () => {
      const localRegistry = new ToolRegistry();
      const settle: Array<(answer: string) => void> = [];
      const registrar = {
        register: vi.fn(() => new Promise<string>((resolve) => { settle.push(resolve); })),
      };
      registerMessagingTools(localRegistry, Object.assign({}, deps, { pollRegistrar: registrar }));
      const ask = (key: string) => localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        chatSession(key, `${key}@s.whatsapp.net`),
      );

      const busy = Array.from({ length: MAX_PENDING_POLL_AWAITS_PER_CONVERSATION }, () => ask('poll-busy'));
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS_PER_CONVERSATION); });
      const refused = await returnsWithoutVote(ask('poll-busy'));
      expect(JSON.parse(refused.content[0].text).error).toMatch(/limit 8 per conversation\); poll not sent/);

      const other = ask('poll-other');
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS_PER_CONVERSATION + 1); });

      settle[0]!('A');
      await busy[0];
      const again = ask('poll-busy');
      await vi.waitFor(() => { expect(registrar.register).toHaveBeenCalledTimes(MAX_PENDING_POLL_AWAITS_PER_CONVERSATION + 2); });
      for (const resolve of settle.slice(1)) resolve('A');
      await Promise.all([...busy.slice(1), other, again]);
    });

    it('C7a — AbortController firing during an in-flight registrar call resolves to awaitFailed with the cancelled error', async () => {
      const localRegistry = new ToolRegistry();
      const fakeRegistrar = makeFakePollRegistrar();
      registerMessagingTools(localRegistry, depsWithRegistrar(deps, fakeRegistrar));

      const controller = new AbortController();
      const session: SessionContext = {
        tier: 'chat-scoped',
        conversationKey: 'poll-cancel',
        deliveryJid: 'poll-cancel@s.whatsapp.net',
        abortSignal: controller.signal,
      };
      const callPromise = localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        session,
      );

      await vi.waitFor(() => { expect(fakeRegistrar.calls).toHaveLength(1); });
      expect(fakeRegistrar.calls[0].abortSignal).toBe(controller.signal);

      controller.abort();
      const result = await callPromise;
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);
      expect(body.pollId).toBe(fakeRegistrar.calls[0].pollId);
      expect(body.awaitFailed).toBe(true);
      expect(body.answer).toBeUndefined();
      expect(body.options).toEqual(['A', 'B']);
      expect(body.question).toBe('Pick');
      expect(body.error).toBe('Poll timed out or was cancelled');
    });

    it('C7b — AbortSignal already aborted before the call short-circuits without engaging the registrar', async () => {
      const localRegistry = new ToolRegistry();
      const fakeRegistrar = makeFakePollRegistrar();
      registerMessagingTools(localRegistry, depsWithRegistrar(deps, fakeRegistrar));

      const controller = new AbortController();
      controller.abort();
      const session: SessionContext = {
        tier: 'chat-scoped',
        conversationKey: 'poll-pre-abort',
        deliveryJid: 'poll-pre-abort@s.whatsapp.net',
        abortSignal: controller.signal,
      };
      const result = await localRegistry.call(
        'send_poll',
        { question: 'Pick', options: ['A', 'B'], awaitResult: true },
        session,
      );

      expect(fakeRegistrar.calls).toHaveLength(0);
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);
      expect(body.pollId).toMatch(/^poll-/);
      expect(body.awaitFailed).toBe(true);
      expect(body.answer).toBeUndefined();
      expect(body.error).toBe('Poll cancelled before await began');
    });
  });
});
