import { describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../../src/core/outbound-sends.ts';
import { IN_PROCESS_CALLER } from '../../../src/mcp/caller-attribution.ts';
import { registerMessagingTools } from '../../../src/mcp/tools/messaging.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createActiveTurnReplySink } from '../../../src/runtimes/agent/turn-reply-sink.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';

function makeConnection(calls: string[]) {
  return {
    contactsDir: { contacts: new Map<string, string>(), getLidMappings: () => undefined },
    sendRaw: async (jid: string, content: unknown) => {
      calls.push(JSON.stringify({ jid, content }));
      return { waMessageId: null };
    },
    sendPollMessage: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

function makeHarness() {
  const dbWrapper = new Database(':memory:');
  dbWrapper.open();
  const calls: string[] = [];
  const registry = new ToolRegistry();
  registerMessagingTools(registry, {
    connection: makeConnection(calls),
    db: dbWrapper.raw,
    dbWrapper,
    adminPhones: new Set<string>(),
  });
  return { calls, dbWrapper, registry };
}

describe('messaging active turn reply lifecycle', () => {
  it('routes a same-conversation active-turn send through the trusted reply sink', async () => {
    const { calls, dbWrapper, registry } = makeHarness();
    const captured: Array<{ chatJid: string; conversationKey: string; text: string; runtimeSessionId: string }> = [];
    const session = {
      ...chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      turnReplySink(request: { chatJid: string; conversationKey: string; text: string; runtimeSessionId: string }) {
        captured.push(request);
        return { disposition: 'queued' as const };
      },
      callerAttribution: IN_PROCESS_CALLER,
      turnReplySessionId: 'runtime-session-1',
    } as SessionContext;

    try {
      const result = await registry.call('send_message', { text: 'Durable turn reply' }, session);

      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(0);
      expect(captured).toEqual([{
        chatJid: 'main-chat@s.whatsapp.net',
        conversationKey: 'main-chat',
        text: 'Durable turn reply',
        runtimeSessionId: 'runtime-session-1',
        action: 'enqueue',
      }]);
      expect(JSON.parse(result.content[0].text)).toEqual(expect.objectContaining({
        sent: false,
        queued: true,
        delivery: 'pending',
        text: 'Durable turn reply',
      }));
    } finally {
      dbWrapper.close();
    }
  });

  it('does not let an unowned socket caller capture an active reply channel', async () => {
    const { calls, dbWrapper, registry } = makeHarness();
    const sink = vi.fn(() => ({ disposition: 'queued' as const }));
    const session: SessionContext = {
      ...chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      turnReplySink: sink,
      callerAttribution: {
        transport: 'socket',
        connectionId: 'foreign-client',
        clientName: null,
        clientVersion: null,
        tokenResult: 'absent',
      },
    };

    try {
      const result = await registry.call('send_message', { text: 'Existing raw behavior' }, session);
      expect(result.isError).toBeUndefined();
      expect(sink).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    } finally {
      dbWrapper.close();
    }
  });

  it('does not fall through to raw transport when an owned session has no active reply binding', async () => {
    const { calls, dbWrapper, registry } = makeHarness();
    const sink = vi.fn(() => ({ disposition: 'inactive' as const }));
    const session: SessionContext = {
      ...chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      turnReplySink: sink,
      callerAttribution: IN_PROCESS_CALLER,
      turnReplySessionId: 'stale-runtime-session',
    };

    try {
      const result = await registry.call('send_message', { text: 'stale turn reply' }, session);
      expect(sink).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        sent: false,
        suppressed: true,
        reason: 'active_turn_unavailable',
      });
    } finally {
      dbWrapper.close();
    }
  });

  it('retains raw transport for a global caller without a runtime turn binding', async () => {
    const { calls, dbWrapper, registry } = makeHarness();
    try {
      const result = await registry.call(
        'send_message',
        { chatJid: 'other-chat@s.whatsapp.net', text: 'operator message' },
        { tier: 'global' },
      );
      expect(result.isError).toBeUndefined();
      expect(calls).toHaveLength(1);
    } finally {
      dbWrapper.close();
    }
  });

  it('preserves explicit raw options while reserving and committing the same answer owner', async () => {
    const { calls, dbWrapper, registry } = makeHarness();
    const actions: string[] = [];
    const sink = vi.fn((request: { action?: string }) => {
      actions.push(request.action ?? 'enqueue');
      return request.action === 'reserve'
        ? { disposition: 'reserved' as const, reservationId: 'raw-owner-1' }
        : { disposition: 'committed' as const };
    });
    const session: SessionContext = {
      ...chatSession('main-chat', 'main-chat@s.whatsapp.net'),
      turnReplySink: sink,
      callerAttribution: IN_PROCESS_CALLER,
      turnReplySessionId: 'runtime-session-1',
    };

    try {
      await registry.call('send_message', { text: 'https://example.com', link_preview: 'off', viewOnce: true }, session);
      expect(actions).toEqual(['reserve', 'commit']);
      expect(JSON.parse(calls[0]).content).toMatchObject({ linkPreview: null, viewOnce: true });
    } finally {
      dbWrapper.close();
    }
  });

  it('records a raw provider acknowledgement even when a delayed reservation commit is stale', async () => {
    const auditDb = new Database(':memory:');
    auditDb.open();
    const auditRegistry = new ToolRegistry();
    const auditCalls: string[] = [];
    const actions: string[] = [];
    registerMessagingTools(auditRegistry, {
      connection: makeConnection(auditCalls),
      db: auditDb.raw,
      dbWrapper: auditDb,
      adminPhones: new Set<string>(),
      auditWriter: createOutboundSendsWriter({ db: auditDb.raw, line: 'test-line' }),
    });
    try {
      const result = await auditRegistry.call(
        'send_message',
        { text: 'https://example.com', link_preview: 'off' },
        {
          ...chatSession('main-chat', 'main-chat@s.whatsapp.net'),
          callerAttribution: IN_PROCESS_CALLER,
          turnReplySessionId: 'runtime-session-1',
          turnReplySink: (request) => {
            actions.push(request.action ?? 'enqueue');
            return request.action === 'reserve'
              ? { disposition: 'reserved' as const, reservationId: 'old-turn-ticket' }
              : { disposition: 'inactive' as const };
          },
        },
      );

      expect(actions).toEqual(['reserve', 'commit']);
      expect(auditCalls).toHaveLength(1);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ sent: true });
      expect(auditDb.raw.prepare(`
        SELECT outcome_code, failure_stage, mutation_state, provider_submission_count
        FROM outbound_sends
      `).get()).toEqual({
        outcome_code: 'submitted',
        failure_stage: 'ack_received',
        mutation_state: 'acknowledged',
        provider_submission_count: 1,
      });
    } finally {
      auditDb.close();
    }
  });

  it('leaves a trusted captured reply as an audit intent until the durable queue submits it', async () => {
    const auditDb = new Database(':memory:');
    auditDb.open();
    try {
      const auditRegistry = new ToolRegistry();
      const auditCalls: string[] = [];
      registerMessagingTools(auditRegistry, {
        connection: makeConnection(auditCalls),
        db: auditDb.raw,
        dbWrapper: auditDb,
        adminPhones: new Set<string>(),
        auditWriter: createOutboundSendsWriter({ db: auditDb.raw, line: 'test-line' }),
      });
      const result = await auditRegistry.call(
        'send_message',
        { chatJid: 'audit-chat@s.whatsapp.net', text: 'Queued audit reply' },
        {
          tier: 'global',
          conversationKey: 'audit-chat',
          callerAttribution: IN_PROCESS_CALLER,
          turnReplySessionId: 'runtime-session-1',
          turnReplySink: () => ({ disposition: 'queued' }),
        },
      );

      const body = JSON.parse(result.content[0].text) as {
        sent: boolean; queued: boolean; delivery: string; audit_receipt: string;
      };
      expect(body).toMatchObject({ sent: false, queued: true, delivery: 'pending' });
      expect(auditCalls).toHaveLength(0);
      const row = auditDb.raw.prepare(`
        SELECT audit_receipt, outcome_code, failure_stage, mutation_state, provider_submission_count, completed_at
        FROM outbound_sends
      `).get() as Record<string, unknown>;
      expect(row).toMatchObject({
        audit_receipt: body.audit_receipt,
        outcome_code: 'intent',
        failure_stage: 'not_started',
        mutation_state: 'not_started',
        provider_submission_count: 0,
        completed_at: null,
      });
    } finally {
      auditDb.close();
    }
  });

  it('finalizes an audit intent only after the durable answer queue receives a provider acknowledgement', async () => {
    const auditDb = new Database(':memory:');
    auditDb.open();
    const providerCalls: string[] = [];
    let releaseProviderAck: (() => void) | undefined;
    const providerAck = new Promise<void>((resolve) => { releaseProviderAck = resolve; });
    const queue = new OutboundQueue({
      sendMessage: async (jid: string, text: string) => {
        providerCalls.push(`${jid}:${text}`);
        await providerAck;
        return { waMessageId: 'queued-provider-ack' };
      },
      sendMedia: async () => ({ waMessageId: null }),
    } as never, 'audit-chat@s.whatsapp.net', { conversationKey: 'audit-chat' });
    queue.beginTurnEvidence('audit-turn');
    const sink = createActiveTurnReplySink(() => ({ queue, logicalTurnId: 'audit-turn' }));
    try {
      const auditRegistry = new ToolRegistry();
      registerMessagingTools(auditRegistry, {
        connection: makeConnection([]),
        db: auditDb.raw,
        dbWrapper: auditDb,
        adminPhones: new Set<string>(),
        auditWriter: createOutboundSendsWriter({ db: auditDb.raw, line: 'test-line' }),
      });
      const result = await auditRegistry.call(
        'send_message',
        { chatJid: 'audit-chat@s.whatsapp.net', text: 'queue finalization proof' },
        {
          tier: 'global',
          conversationKey: 'audit-chat',
          callerAttribution: IN_PROCESS_CALLER,
          turnReplySessionId: 'runtime-session-1',
          turnReplySink: sink,
        },
      );

      expect(JSON.parse(result.content[0].text)).toMatchObject({ sent: false, queued: true });
      await Promise.resolve();
      expect(providerCalls).toEqual(['audit-chat@s.whatsapp.net:queue finalization proof']);
      expect(auditDb.raw.prepare('SELECT outcome_code, completed_at FROM outbound_sends').get())
        .toEqual({ outcome_code: 'intent', completed_at: null });
      releaseProviderAck!();
      await queue.flush();
      expect(auditDb.raw.prepare('SELECT outcome_code, mutation_state, provider_submission_count FROM outbound_sends').get())
        .toEqual({ outcome_code: 'submitted', mutation_state: 'acknowledged', provider_submission_count: 1 });
    } finally {
      queue.abortTurn();
      auditDb.close();
    }
  });
});
