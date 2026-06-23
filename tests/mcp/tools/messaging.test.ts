// tests/mcp/tools/messaging.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerMessagingTools, type MessagingDeps, type PollRegistrar } from '../../../src/mcp/tools/messaging.ts';
import { createProfileRegistry } from '../../../src/core/profiles.ts';
import { createOutboundSendsWriter } from '../../../src/core/outbound-sends.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { emitAlert } from '../../../src/lib/emit-alert.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
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

function seedMessage(
  db: DatabaseSync,
  overrides: {
    message_id?: string;
    chat_jid?: string;
    conversation_key?: string;
    sender_jid?: string;
    is_from_me?: number;
    content?: string | null;
  } = {},
): string {
  const messageId = overrides.message_id ?? 'msg-001';
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.chat_jid ?? 'main-chat@s.whatsapp.net',
    overrides.conversation_key ?? 'main-chat',
    overrides.sender_jid ?? 'main-chat@s.whatsapp.net',
    messageId,
    overrides.content === undefined ? 'hello' : overrides.content,
    overrides.is_from_me ?? 0,
    1_700_000_000,
  );
  return messageId;
}

function seedAlias(db: DatabaseSync, alias: string, chatJid: string): void {
  db.prepare(`
    INSERT INTO chat_aliases (alias, chat_jid)
    VALUES (?, ?)
  `).run(alias, chatJid);
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

type FakeRegisterCall = {
  pollId: string;
  chatJid: string;
  options: string[];
  resolution: string;
  timeoutMs: number;
  abortSignal: AbortSignal | undefined;
};

type FakePollRegistrar = PollRegistrar & {
  calls: FakeRegisterCall[];
  resolveLast(answer: string): void;
  rejectLast(err: Error): void;
};

function makeFakePollRegistrar(): FakePollRegistrar {
  const calls: FakeRegisterCall[] = [];
  let pendingResolve: ((answer: string) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  const registrar: FakePollRegistrar = {
    calls,
    resolveLast(answer: string): void {
      if (!pendingResolve) throw new Error('no pending registrar call to resolve');
      pendingResolve(answer);
      pendingResolve = null;
      pendingReject = null;
    },
    rejectLast(err: Error): void {
      if (!pendingReject) throw new Error('no pending registrar call to reject');
      pendingReject(err);
      pendingResolve = null;
      pendingReject = null;
    },
    async register(pollId, chatJid, options, resolution, timeoutMs, abortSignal) {
      calls.push({ pollId, chatJid, options, resolution, timeoutMs, abortSignal });
      return new Promise<string>((resolve, reject) => {
        pendingResolve = resolve;
        pendingReject = reject;
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    },
  };
  return registrar;
}

function depsWithRegistrar(base: MessagingDeps, registrar: FakePollRegistrar): MessagingDeps {
  return Object.assign({}, base, { pollRegistrar: registrar });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerMessagingTools', () => {
  let registry: ToolRegistry;
  let db: DatabaseSync;
  let calls: string[];
  let connection: ReturnType<typeof makeConnection>;
  let deps: MessagingDeps;

  beforeEach(() => {
    vi.mocked(emitAlert).mockClear();
    registry = new ToolRegistry();
    db = makeDb();
    calls = makeCalls();
    connection = makeConnection(calls);
    deps = {
      connection,
      db,
      instanceName: 'test-bot',
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite', linkPreview: 'off' },
      }),
    };
    registerMessagingTools(registry, deps);
  });

  // ── send_message ──────────────────────────────────────────────────────────

  describe('send_message', () => {
    it('calls sock.sendMessage with plain text', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('send_message', { text: 'Hello world' }, session);

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.jid).toBe('main-chat@s.whatsapp.net');
      expect(call.content.text).toBe('Hello world');
    });

    // ── client-safety guardrail (Lane 2) ───────────────────────────────────
    it('redacts an internal path leaked in client-facing text before sending', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_message',
        { text: 'Sorry, my config at /Users/testuser/.claude/settings.json is acting up.' },
        session,
      );

      expect(result.isError).toBeUndefined();
      const sent = JSON.parse(calls[0]).content.text as string;
      expect(sent).not.toContain('/Users/testuser');
      expect(sent).not.toContain('settings.json');
      // the handler's returned text mirrors what was actually sent
      const body = JSON.parse(result.content[0].text);
      expect(body.text).not.toContain('/Users/testuser');
    });

    it('diverts a false infra-block self-diagnosis to generic client text', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_message',
        {
          text: 'All tools are blocked because agent-sandbox.sh is failing closed and sandbox-policy.json is missing.',
        },
        session,
      );

      const sent = JSON.parse(calls[0]).content.text as string;
      expect(sent).not.toContain('agent-sandbox.sh');
      expect(sent).not.toContain('sandbox-policy.json');
      expect(sent).toContain('temporary issue');
    });

    it('alerts ops with sanitized diagnostic evidence when a client message is diverted', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_message',
        { text: 'All tools are blocked because agent-sandbox.sh is failing closed.' },
        session,
      );
      expect(vi.mocked(emitAlert)).toHaveBeenCalledTimes(1);
      const [instance, source, , evidence, severity] = vi.mocked(emitAlert).mock.calls[0];
      expect(instance).toBe('test-bot');
      expect(source).toBe('outbound_message_guard');
      expect(severity).toBe('warning');
      // the diagnostic is preserved for ops (that is the point), client never saw it
      expect(evidence).toContain('agent-sandbox.sh');
    });

    it('does not alert ops for benign client text', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'See you Tuesday at 3pm.' }, session);
      expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
    });

    it('does not alert ops for a mere internal-path redaction (no false claim)', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_message',
        { text: 'Config is at /Users/testuser/.claude/settings.json.' },
        session,
      );
      expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
    });

    it('does not rewrite a send addressed to the configured BOT_ERRORS ops channel', async () => {
      const prev = process.env['BOT_ERRORS_JID'];
      process.env['BOT_ERRORS_JID'] = 'main-chat@s.whatsapp.net';
      try {
        const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
        const raw = 'agent-sandbox.sh failing closed at /Users/testuser/.claude/sandbox-policy.json';
        await registry.call('send_message', { text: raw }, session);
        const sent = JSON.parse(calls[0]).content.text as string;
        expect(sent).toBe(raw);
      } finally {
        if (prev === undefined) delete process.env['BOT_ERRORS_JID'];
        else process.env['BOT_ERRORS_JID'] = prev;
      }
    });

    it('leaves ordinary client text untouched', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_message',
        { text: 'Your appointment is confirmed for Tuesday at 3pm.' },
        session,
      );
      const sent = JSON.parse(calls[0]).content.text as string;
      expect(sent).toBe('Your appointment is confirmed for Tuesday at 3pm.');
    });

    it('resolves to alias in a global session and sends to the aliased JID', async () => {
      seedAlias(db, 'ops', 'ops-chat@s.whatsapp.net');

      const result = await registry.call(
        'send_message',
        { to: 'ops', text: 'Alias hello' },
        { tier: 'global' },
      );

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.jid).toBe('ops-chat@s.whatsapp.net');
      expect(call.content.text).toBe('Alias hello');
    });

    it('returns an alias error and does not send when to is unknown', async () => {
      const result = await registry.call(
        'send_message',
        { to: 'missing', text: 'Alias hello' },
        { tier: 'global' },
      );

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('alias not found: missing');
    });

    it('returns a target error and does not send when chatJid and to are both provided', async () => {
      seedAlias(db, 'ops', 'ops-chat@s.whatsapp.net');

      const result = await registry.call(
        'send_message',
        {
          chatJid: 'main-chat@s.whatsapp.net',
          to: 'ops',
          text: 'Alias hello',
        },
        { tier: 'global' },
      );

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('chatJid and to are mutually exclusive; provide exactly one');
    });

    it('rejects alias resolution that crosses a bound global conversation', async () => {
      seedAlias(db, 'bob', 'bob-chat@s.whatsapp.net');

      const result = await registry.call(
        'send_message',
        { to: 'bob', text: 'wrong chat' },
        { tier: 'global', conversationKey: 'main-chat' },
      );

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/does not match session conversation/);
    });

    it('ignores caller-supplied to in a chat-scoped session and sends to deliveryJid', async () => {
      seedAlias(db, 'bob', 'bob-chat@s.whatsapp.net');

      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_message',
        { to: 'bob', text: 'Current chat only' },
        session,
      );

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.jid).toBe('main-chat@s.whatsapp.net');
      expect(call.jid).not.toBe('bob-chat@s.whatsapp.net');
    });

    it('applies mention formatting for @name patterns', async () => {
      const alicePhone = '15555550001';
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'Hi @alice!' }, session);

      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.content.text).toBe(`Hi @${alicePhone}!`);
      expect(call.content.mentions).toContain(`${alicePhone}@s.whatsapp.net`);
    });

    it('sends plain text without mentions field when no @mentions present', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'No mentions here' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('mentions');
    });

    it('returns error when socket is not connected', async () => {
      (connection as any).sendRaw = async () => {
        throw new Error('WhatsApp is not connected');
      };

      const result = await registry.call(
        'send_message',
        { text: 'test' },
        chatSession('x', 'x@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/temporarily disconnected/);
    });

    it.each([
      ['timeout transport error', new Error('ETIMEDOUT while writing'), 'The request timed out. Try again.'],
      ['rate limit transport error', new Error('429 too many requests'), 'Too many requests. Wait a moment and try again.'],
      ['missing resource transport error', new Error('404 not found from upstream'), 'The requested resource was not found.'],
      ['authorization transport error', new Error('401 unauthorized'), 'Permission denied for this operation.'],
      ['opaque non-Error transport error', 'opaque internal failure', 'Operation failed. Try again.'],
    ])('sanitizes %s without leaking raw transport details', async (_label, thrown, expected) => {
      (connection as any).sendRaw = async () => {
        throw thrown;
      };

      const result = await registry.call(
        'send_message',
        { text: 'test' },
        chatSession('x', 'x@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe(expected);
      expect(body.error).not.toContain(String(thrown));
    });

    it('rejects an alias that resolves to an invalid JID before audit or send', async () => {
      seedAlias(db, 'bad-target', 'not-a-jid');

      const result = await registry.call(
        'send_message',
        { to: 'bad-target', text: 'bad alias' },
        { tier: 'global', conversationKey: 'main-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Invalid chatJid "not-a-jid": must be a valid JID');
      expect(calls).toHaveLength(0);
    });

    // Gap #13: viewOnce flag passes through to the Baileys sendRaw call
    it('passes viewOnce flag through to sendRaw when set to true', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_message',
        { text: 'secret message', viewOnce: true },
        session,
      );

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.content.viewOnce).toBe(true);
    });

    it('does not include viewOnce in sendRaw content when not set', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'normal message' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('viewOnce');
    });

    // SP6: link_preview opt-out
    it('does not set linkPreview when link_preview is omitted (auto default)', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'https://example.com' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('linkPreview');
    });

    it('does not set linkPreview when link_preview is "auto"', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'https://example.com', link_preview: 'auto' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('linkPreview');
    });

    it('sets linkPreview to null when link_preview is "off"', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('send_message', { text: 'https://example.com', link_preview: 'off' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).toHaveProperty('linkPreview', null);
    });

    it('applies a named profile before sending', async () => {
      const result = await registry.call(
        'send_message',
        { chatJid: 'audit-chat@s.whatsapp.net', text: 'Hello', profile: 'satellite' },
        { tier: 'global' },
      );

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.jid).toBe('audit-chat@s.whatsapp.net');
      expect(call.content.text).toBe('[SAT] Hello #satellite');
      expect(call.content).toHaveProperty('linkPreview', null);
    });

    it('returns unknown profile without sending', async () => {
      const result = await registry.call(
        'send_message',
        { chatJid: 'audit-chat@s.whatsapp.net', text: 'Hello', profile: 'missing' },
        { tier: 'global' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('unknown profile: missing');
      expect(calls).toHaveLength(0);
    });

    it('lets request link_preview override profile link preview policy', async () => {
      const result = await registry.call(
        'send_message',
        {
          chatJid: 'audit-chat@s.whatsapp.net',
          text: 'https://example.com',
          profile: 'satellite',
          link_preview: 'auto',
        },
        { tier: 'global' },
      );

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
      const call = JSON.parse(calls[0]);
      expect(call.content.text).toBe('[SAT] https://example.com #satellite');
      expect(call.content).not.toHaveProperty('linkPreview');
    });

    it('audits a successful send_message exactly once when configured', async () => {
      const auditDb = new Database(':memory:');
      auditDb.open();
      try {
        const auditRegistry = new ToolRegistry();
        const auditCalls = makeCalls();
        const auditConnection = makeConnection(auditCalls);
        registerMessagingTools(auditRegistry, {
          connection: auditConnection,
          db: auditDb.raw,
          auditWriter: createOutboundSendsWriter({ db: auditDb.raw, line: 'test-line' }),
        });

        const result = await auditRegistry.call(
          'send_message',
          { chatJid: 'audit-chat@s.whatsapp.net', text: 'Hello audit' },
          { tier: 'global' },
        );

        expect(result.isError).toBeUndefined();
        const rows = auditDb.raw
          .prepare('SELECT line, caller, chat_jid, target_kind, status, text_length FROM outbound_sends')
          .all() as Array<Record<string, unknown>>;
        expect(rows).toEqual([{
          line: 'test-line',
          caller: 'mcp',
          chat_jid: 'audit-chat@s.whatsapp.net',
          target_kind: 'chatJid',
          status: 'sent',
          text_length: 'Hello audit'.length,
        }]);
      } finally {
        auditDb.close();
      }
    });

    it('audits a failed send_message exactly once when transport throws', async () => {
      const auditDb = new Database(':memory:');
      auditDb.open();
      try {
        const auditRegistry = new ToolRegistry();
        registerMessagingTools(auditRegistry, {
          connection: {
            ...makeConnection(makeCalls()),
            sendRaw: async () => {
              throw new Error('socket closed');
            },
          } as never,
          db: auditDb.raw,
          auditWriter: createOutboundSendsWriter({ db: auditDb.raw, line: 'test-line' }),
        });

        const result = await auditRegistry.call(
          'send_message',
          { chatJid: 'audit-chat@s.whatsapp.net', text: 'will fail' },
          { tier: 'global' },
        );

        const body = JSON.parse(result.content[0].text);
        expect(body.error).toMatch(/temporarily disconnected/);
        const rows = auditDb.raw
          .prepare('SELECT caller, chat_jid, target_kind, status, error FROM outbound_sends')
          .all() as Array<Record<string, unknown>>;
        expect(rows).toEqual([{
          caller: 'mcp',
          chat_jid: 'audit-chat@s.whatsapp.net',
          target_kind: 'chatJid',
          status: 'failed',
          error: 'socket closed',
        }]);
      } finally {
        auditDb.close();
      }
    });
  });

  // ── reply_message ─────────────────────────────────────────────────────────

  describe('reply_message', () => {
    it('sends a quoted reply to the correct message', async () => {
      const messageId = seedMessage(db, {
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        sender_jid: 'bob@s.whatsapp.net',
        is_from_me: 0,
      });

      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId, text: 'Replying!' }, session);

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.sent).toBe(true);

      const call = JSON.parse(calls[0]);
      expect(call.content.contextInfo.stanzaId).toBe(messageId);
    });

    // ── client-safety guardrail (Lane 2 — reply_message is the same audience
    //    as send_message and must not be a bypass) ──────────────────────────
    it('redacts an internal path leaked in reply text before sending', async () => {
      const messageId = seedMessage(db, {
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        sender_jid: 'bob@s.whatsapp.net',
        is_from_me: 0,
      });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'reply_message',
        { messageId, text: 'It is at /Users/testuser/.claude/settings.json on the box.' },
        session,
      );
      const sent = JSON.parse(calls[0]).content.text as string;
      expect(sent).not.toContain('/Users/testuser');
      expect(sent).not.toContain('settings.json');
    });

    it('diverts a false infra-block claim in reply text to generic text', async () => {
      const messageId = seedMessage(db, {
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        sender_jid: 'bob@s.whatsapp.net',
        is_from_me: 0,
      });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'reply_message',
        { messageId, text: 'All tools are blocked because agent-sandbox.sh is failing closed.' },
        session,
      );
      const sent = JSON.parse(calls[0]).content.text as string;
      expect(sent).not.toContain('agent-sandbox.sh');
      expect(sent).toContain('temporary issue');
    });

    it('returns error for unknown message ID', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId: 'nonexistent', text: 'hi' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Message not found/);
    });

    it('rejects cross-conversation access in chat-scoped session', async () => {
      seedMessage(db, { message_id: 'msg-other', conversation_key: 'other' });

      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('reply_message', { messageId: 'msg-other', text: 'sneaky' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
    });

    it('treats cross-conversation message IDs as scoped misses without exposing target data', async () => {
      seedMessage(db, {
        message_id: 'msg-other-secret',
        chat_jid: 'other-chat@s.whatsapp.net',
        conversation_key: 'other-secret-chat',
        sender_jid: 'secret-sender@s.whatsapp.net',
        content: 'secret message body',
      });

      const session = chatSession('current-chat', 'current-chat@s.whatsapp.net');
      const result = await registry.call(
        'reply_message',
        { messageId: 'msg-other-secret', text: 'sneaky' },
        session,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(body.error).not.toContain('other-secret-chat');
      expect(body.error).not.toContain('other-chat@s.whatsapp.net');
      expect(body.error).not.toContain('secret-sender@s.whatsapp.net');
      expect(body.error).not.toContain('secret message body');
      expect(calls).toHaveLength(0);
    });

    // SP6: link_preview opt-out for reply_message
    it('does not set linkPreview when link_preview is omitted (auto default)', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('reply_message', { messageId, text: 'https://example.com' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).not.toHaveProperty('linkPreview');
    });

    it('sets linkPreview to null when link_preview is "off"', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call('reply_message', { messageId, text: 'https://example.com', link_preview: 'off' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content).toHaveProperty('linkPreview', null);
    });

    it('rejects foreign message IDs in bound global sessions', async () => {
      seedMessage(db, {
        message_id: 'msg-foreign-reply',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
        sender_jid: 'bob@s.whatsapp.net',
        content: 'foreign reply body',
      });

      const result = await registry.call(
        'reply_message',
        {
          chatJid: 'foreign-chat@s.whatsapp.net',
          messageId: 'msg-foreign-reply',
          text: 'no leak',
        },
        { tier: 'global', conversationKey: 'foreign-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(JSON.stringify(result)).not.toContain('foreign reply body');
      expect(calls).toHaveLength(0);
    });

    it('replies from an unbound global session and defaults null quoted content to empty text', async () => {
      const messageId = seedMessage(db, {
        message_id: 'msg-global-reply',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
        sender_jid: 'bob@s.whatsapp.net',
        content: null,
      });

      const result = await registry.call(
        'reply_message',
        { chatJid: 'reply-chat@s.whatsapp.net', messageId, text: 'global reply' },
        { tier: 'global' },
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.contextInfo.quotedMessage.conversation).toBe('');
    });

    it('returns a scoped miss for unknown message IDs in unbound global sessions', async () => {
      const result = await registry.call(
        'reply_message',
        { chatJid: 'reply-chat@s.whatsapp.net', messageId: 'missing-global-message', text: 'global reply' },
        { tier: 'global' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(calls).toHaveLength(0);
    });

    it('rejects malformed chat-scoped ownership context without leaking message data', async () => {
      seedMessage(db, {
        message_id: 'msg-no-conversation-key',
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        content: 'private body',
      });

      const result = await registry.call(
        'reply_message',
        { messageId: 'msg-no-conversation-key', text: 'reply' },
        { tier: 'chat-scoped', deliveryJid: 'main-chat@s.whatsapp.net' } as SessionContext,
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Chat-scoped session has no conversation key');
      expect(JSON.stringify(result)).not.toContain('private body');
      expect(calls).toHaveLength(0);
    });

    it('sanitizes reply transport failures', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      (connection as any).sendRaw = async () => {
        throw new Error('ETIMEDOUT while replying');
      };

      const result = await registry.call(
        'reply_message',
        { messageId, text: 'reply' },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('The request timed out. Try again.');
    });
  });

  // ── react_message ─────────────────────────────────────────────────────────

  describe('react_message', () => {
    it('sends a reaction with the correct emoji and message key', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 0 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('react_message', { messageId, emoji: '👍' }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.react.text).toBe('👍');
      expect(call.content.react.key.id).toBe(messageId);
    });

    it('allows removing a reaction with empty string emoji', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      await registry.call('react_message', { messageId, emoji: '' }, session);

      const call = JSON.parse(calls[0]);
      expect(call.content.react.text).toBe('');
    });

    it('rejects cross-conversation message for react', async () => {
      seedMessage(db, { message_id: 'msg-x', conversation_key: 'other' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('react_message', { messageId: 'msg-x', emoji: '❤️' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
    });

    it('rejects foreign message IDs in bound global sessions', async () => {
      seedMessage(db, {
        message_id: 'msg-foreign-react',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
      });

      const result = await registry.call(
        'react_message',
        { chatJid: 'foreign-chat@s.whatsapp.net', messageId: 'msg-foreign-react', emoji: '👍' },
        { tier: 'global', conversationKey: 'foreign-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(calls).toHaveLength(0);
    });

    it('reacts to the latest inbound message when messageId is omitted', async () => {
      seedMessage(db, {
        message_id: 'old-inbound',
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        is_from_me: 0,
        content: 'older',
      });
      seedMessage(db, {
        message_id: 'latest-inbound',
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        is_from_me: 0,
        content: 'newer',
      });
      db.prepare('UPDATE messages SET timestamp = ? WHERE message_id = ?').run(1_700_000_001, 'latest-inbound');

      const result = await registry.call(
        'react_message',
        { emoji: '✅' },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body).toMatchObject({ sent: true, emoji: '✅', messageId: 'latest-inbound', resolved: 'last_inbound' });
      const call = JSON.parse(calls[0]);
      expect(call.content.react.key.id).toBe('latest-inbound');
    });

    it('returns an operator error when no inbound message can be inferred for reaction', async () => {
      const result = await registry.call(
        'react_message',
        { emoji: '✅' },
        chatSession('empty-chat', 'empty-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('No recent inbound message found in this chat to react to');
      expect(calls).toHaveLength(0);
    });

    it('sanitizes inferred reaction send failures', async () => {
      seedMessage(db, {
        message_id: 'latest-inbound-fail',
        chat_jid: 'main-chat@s.whatsapp.net',
        conversation_key: 'main-chat',
        is_from_me: 0,
      });
      (connection as any).sendRaw = async () => {
        throw new Error('socket hang up');
      };

      const result = await registry.call(
        'react_message',
        { emoji: '✅' },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('WhatsApp is temporarily disconnected. Try again in a moment.');
    });

    it('sanitizes explicit reaction send failures', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      (connection as any).sendRaw = async () => {
        throw new Error('429 too many requests');
      };

      const result = await registry.call(
        'react_message',
        { messageId, emoji: '✅' },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Too many requests. Wait a moment and try again.');
    });
  });

  // ── edit_message ──────────────────────────────────────────────────────────

  describe('edit_message', () => {
    it('sends edit for a message sent by me', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 1 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId, newText: 'corrected text' }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.text).toBe('corrected text');
      expect(call.content.edit.id).toBe(messageId);
    });

    // ── client-safety guardrail: editing is another agent free-text vector ──
    it('redacts an internal path in edited text before sending', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 1 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'edit_message',
        { messageId, newText: 'actually it is /Users/testuser/.claude/settings.json' },
        session,
      );
      const call = JSON.parse(calls[0]);
      expect(call.content.text).not.toContain('/Users/testuser');
      expect(call.content.text).not.toContain('settings.json');
    });

    it('rejects editing a message not sent by me', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 0 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId, newText: 'try to edit' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/own messages/);
    });

    it('rejects cross-conversation message for edit', async () => {
      seedMessage(db, { message_id: 'msg-y', conversation_key: 'other', is_from_me: 1 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('edit_message', { messageId: 'msg-y', newText: 'hack' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
    });

    it('rejects foreign message IDs in bound global sessions', async () => {
      seedMessage(db, {
        message_id: 'msg-foreign-edit',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
        is_from_me: 1,
      });

      const result = await registry.call(
        'edit_message',
        { chatJid: 'foreign-chat@s.whatsapp.net', messageId: 'msg-foreign-edit', newText: 'no leak' },
        { tier: 'global', conversationKey: 'foreign-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(calls).toHaveLength(0);
    });

    it('sanitizes edit transport failures', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 1 });
      (connection as any).sendRaw = async () => {
        throw 'opaque edit failure';
      };

      const result = await registry.call(
        'edit_message',
        { messageId, newText: 'corrected text' },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Operation failed. Try again.');
    });
  });

  // ── delete_message ────────────────────────────────────────────────────────

  describe('delete_message', () => {
    it('sends delete for an existing message', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 1 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('delete_message', { messageId }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.delete.id).toBe(messageId);
    });

    it('rejects delete for nonexistent message', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('delete_message', { messageId: 'ghost' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/Message not found/);
    });

    it('rejects cross-conversation message for delete', async () => {
      seedMessage(db, { message_id: 'msg-z', conversation_key: 'other', is_from_me: 1 });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('delete_message', { messageId: 'msg-z' }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
    });

    it('rejects foreign message IDs in bound global sessions', async () => {
      seedMessage(db, {
        message_id: 'msg-foreign-delete',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
        is_from_me: 1,
      });

      const result = await registry.call(
        'delete_message',
        { chatJid: 'foreign-chat@s.whatsapp.net', messageId: 'msg-foreign-delete' },
        { tier: 'global', conversationKey: 'foreign-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(calls).toHaveLength(0);
    });

    it('sanitizes delete transport failures', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat', is_from_me: 1 });
      (connection as any).sendRaw = async () => {
        throw new Error('404 not found while deleting');
      };

      const result = await registry.call(
        'delete_message',
        { messageId },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('The requested resource was not found.');
    });
  });

  // ── send_location ─────────────────────────────────────────────────────────

  describe('send_location', () => {
    it('sends location with lat/lon', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_location',
        { latitude: 40.7128, longitude: -74.006, name: 'NYC' },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.location.degreesLatitude).toBe(40.7128);
      expect(call.content.location.degreesLongitude).toBe(-74.006);
      expect(call.content.location.name).toBe('NYC');
    });

    it('passes viewOnce through for location sends', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_location',
        { latitude: 40.7128, longitude: -74.006, viewOnce: true },
        session,
      );

      const call = JSON.parse(calls[0]);
      expect(call.content.viewOnce).toBe(true);
    });

    it('sanitizes location transport failures', async () => {
      (connection as any).sendRaw = async () => {
        throw new Error('403 forbidden');
      };

      const result = await registry.call(
        'send_location',
        { latitude: 40.7128, longitude: -74.006 },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Permission denied for this operation.');
    });
  });

  // ── send_contact ──────────────────────────────────────────────────────────

  describe('send_contact', () => {
    it('sends a vCard contact via contacts array (single)', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_contact',
        { contacts: [{ displayName: 'John Doe', phone: '15551234567' }] },
        session,
      );

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.contacts.displayName).toBe('John Doe');
      expect(call.content.contacts.contacts[0].vcard).toContain('John Doe');
      expect(call.content.contacts.contacts[0].vcard).toContain('15551234567');
    });

    it('sends multiple contacts in a single message', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call(
        'send_contact',
        {
          contacts: [
            { displayName: 'Alice Smith', phone: '15551111111' },
            { displayName: 'Bob Jones', phone: '15552222222' },
          ],
        },
        session,
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.count).toBe(2);
      const call = JSON.parse(calls[0]);
      expect(call.content.contacts.displayName).toBe('2 contacts');
      expect(call.content.contacts.contacts).toHaveLength(2);
      expect(call.content.contacts.contacts[0].vcard).toContain('Alice Smith');
      expect(call.content.contacts.contacts[1].vcard).toContain('Bob Jones');
    });

    it('rejects empty contacts array', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      const result = await registry.call('send_contact', { contacts: [] }, session);
      expect(result.isError).toBe(true);
    });

    it('passes viewOnce through for contact sends', async () => {
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');
      await registry.call(
        'send_contact',
        { contacts: [{ displayName: 'Jane Doe', phone: '+1 (555) 222-3333' }], viewOnce: true },
        session,
      );

      const call = JSON.parse(calls[0]);
      expect(call.content.viewOnce).toBe(true);
    });

    it('sanitizes contact transport failures', async () => {
      (connection as any).sendRaw = async () => {
        throw new Error('connection closed while sending contact');
      };

      const result = await registry.call(
        'send_contact',
        { contacts: [{ displayName: 'Jane Doe', phone: '+1 (555) 222-3333' }] },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('WhatsApp is temporarily disconnected. Try again in a moment.');
    });
  });

  // ── send_poll ─────────────────────────────────────────────────────────────

  describe('send_poll', () => {
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

  // ── pin_message ───────────────────────────────────────────────────────────

  describe('pin_message', () => {
    it('pins a message', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId, pin: true, duration: '24h' }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.pin.id).toBe(messageId);
      expect(call.content.type).toBe(1);
      expect(call.content.time).toBe(86400);
    });

    it('unpins a message', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId, pin: false }, session);

      expect(result.isError).toBeUndefined();
      const call = JSON.parse(calls[0]);
      expect(call.content.type).toBe(2);
    });

    it('rejects cross-conversation message for pin', async () => {
      seedMessage(db, { message_id: 'msg-p', conversation_key: 'other' });
      const session = chatSession('main-chat', 'main-chat@s.whatsapp.net');

      const result = await registry.call('pin_message', { messageId: 'msg-p', pin: true }, session);

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
    });

    it('rejects foreign message IDs in bound global sessions', async () => {
      seedMessage(db, {
        message_id: 'msg-foreign-pin',
        chat_jid: 'reply-chat@s.whatsapp.net',
        conversation_key: 'reply-chat',
      });

      const result = await registry.call(
        'pin_message',
        { chatJid: 'foreign-chat@s.whatsapp.net', messageId: 'msg-foreign-pin', pin: true },
        { tier: 'global', conversationKey: 'foreign-chat' },
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Message not found');
      expect(calls).toHaveLength(0);
    });

    it('sanitizes pin transport failures', async () => {
      const messageId = seedMessage(db, { conversation_key: 'main-chat' });
      (connection as any).sendRaw = async () => {
        throw new Error('401 unauthorized while pinning');
      };

      const result = await registry.call(
        'pin_message',
        { messageId, pin: true },
        chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      );

      const body = JSON.parse(result.content[0].text);
      expect(body.error).toBe('Permission denied for this operation.');
    });
  });
});
