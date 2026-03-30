/**
 * Integration: Scope Injection — chat/global session enforcement for all injected tools
 *
 * Tests the complete scope-enforcement matrix:
 *   A. Chat-scoped session — injected tools (auto-injection, schema stripping, override prevention)
 *   B. Global session — injected tools (schema enrichment, chatJid required, chatJid accepted)
 *   C. Global-only tools — hidden from and rejected by chat-scoped sessions
 *   D. Cross-conversation guard — injected chatJid always uses session.deliveryJid
 *   E. The 4 recently-changed tools (clear_chat, delete_chat, delete_message_for_me,
 *      mark_chat_read) — were 'global', now 'chat'+'injected'. Both session types verified.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { registerChatOperationTools } from '../../src/mcp/tools/chat-operations.ts';
import { registerMessagingTools, type MessagingDeps } from '../../src/mcp/tools/messaging.ts';
import { registerGroupTools } from '../../src/mcp/tools/groups.ts';
import { registerAdvancedTools } from '../../src/mcp/tools/advanced.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import type { SessionContext } from '../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../src/transport/connection.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// JIDs / conversation keys
// ---------------------------------------------------------------------------

const ALICE_JID = '15551110001@s.whatsapp.net';
const ALICE_KEY = '15551110001';

const BOB_JID = '15552220002@s.whatsapp.net';

// ---------------------------------------------------------------------------
// Session factory helpers
// ---------------------------------------------------------------------------

function chatSession(conversationKey: string, deliveryJid: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

// ---------------------------------------------------------------------------
// Mock socket — tracks chatModify and sendMessage calls
// ---------------------------------------------------------------------------

interface CapturedCall {
  method: string;
  jid: string;
  args: unknown[];
}

function makeMockSock(captured: CapturedCall[] = []): WhatsAppSocket {
  return {
    sendMessage: async (jid: string, ...args: unknown[]) => {
      captured.push({ method: 'sendMessage', jid, args });
      return undefined;
    },
    chatModify: async (mod: unknown, jid: string) => {
      captured.push({ method: 'chatModify', jid, args: [mod] });
      return undefined;
    },
    readMessages: async () => undefined,
    star: async () => undefined,
    groupFetchAllParticipating: async () => ({}),
    groupMetadata: async () => ({}),
    groupInviteCode: async () => null,
  } as unknown as WhatsAppSocket;
}

function makeMockConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map<string, string>() },
    sendRaw: async (_jid: string, _content: unknown) => ({ waMessageId: null }),
    sendMedia: async (_jid: string, _media: unknown) => ({ waMessageId: null }),
    botJid: null,
    botLid: null,
  } as unknown as ConnectionManager;
}

// ---------------------------------------------------------------------------
// Registry builder — registers all tool groups
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeRegistry(
  db: Database,
  sock: WhatsAppSocket,
  conn: ConnectionManager = makeMockConnection(),
): ToolRegistry {
  const registry = new ToolRegistry();
  const getSock = () => sock;

  registerChatOperationTools(db, getSock, (tool) => registry.register(tool));
  registerGroupTools(getSock, (tool) => registry.register(tool));
  registerAdvancedTools(getSock, (tool) => registry.register(tool));
  registerChatManagementTools(db, getSock, (tool) => registry.register(tool));

  const messagingDeps: MessagingDeps = { connection: conn, db: db.raw };
  registerMessagingTools(registry, messagingDeps);

  return registry;
}

// ---------------------------------------------------------------------------
// The exhaustive list of injected tools we test systematically
// ---------------------------------------------------------------------------

// Each entry: tool name + minimal valid params (WITHOUT chatJid)
const INJECTED_TOOLS: Array<{ name: string; params: Record<string, unknown> }> = [
  {
    name: 'clear_chat',
    params: { messages: [{ id: 'msg-1', fromMe: true, timestamp: 1000 }] },
  },
  {
    name: 'delete_chat',
    params: {
      last_message_key: { id: 'msg-1', fromMe: true },
      last_message_timestamp: 1000,
    },
  },
  {
    name: 'delete_message_for_me',
    params: { message_id: 'msg-1', from_me: true, timestamp: 1000 },
  },
  {
    name: 'mark_chat_read',
    params: {
      read: true,
      last_message_key: { id: 'msg-1', fromMe: false },
      last_message_timestamp: 2000,
    },
  },
  {
    name: 'send_event_message',
    params: { name: 'Test Event', start_time: 1700000000, end_time: 1700003600 },
  },
  {
    name: 'send_message',
    params: { text: 'hello' },
  },
  {
    name: 'send_group_invite',
    params: {
      groupJid: '99999@g.us',
      inviteCode: 'ABCDE',
      inviteExpiration: 9999999999,
      groupName: 'Test Group',
    },
  },
  {
    name: 'send_button_reply',
    params: { displayText: 'Yes', id: 'btn-1', type: 1 },
  },
  {
    name: 'send_list_reply',
    params: { title: 'Choice', listType: 1, selectedRowId: 'row-1' },
  },
  {
    name: 'send_limit_sharing',
    params: {},
  },
];

// Global-scope tools that should be invisible/blocked in chat-scoped sessions
const GLOBAL_ONLY_TOOLS = ['list_chats', 'get_reactions', 'update_push_name'];

// ===========================================================================
// A. Chat-scoped session — injected tools
// ===========================================================================

describe('A. chat-scoped session — injected tools', () => {
  let registry: ToolRegistry;
  let captured: CapturedCall[];
  const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

  beforeEach(() => {
    captured = [];
    registry = makeRegistry(makeDb(), makeMockSock(captured));
  });

  for (const tool of INJECTED_TOOLS) {
    it(`${tool.name}: appears in listTools for chat-scoped session`, () => {
      const tools = registry.listTools(aliceSession);
      const names = tools.map((t) => t.name);
      expect(names).toContain(tool.name);
    });

    it(`${tool.name}: chatJid is NOT in inputSchema for chat-scoped session (schema stripping)`, () => {
      const tools = registry.listTools(aliceSession);
      const entry = tools.find((t) => t.name === tool.name);
      expect(entry).toBeDefined();
      const props = (entry!.inputSchema as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined;
      // chatJid must not appear in the advertised schema — it is auto-filled from session
      if (props !== undefined) {
        expect(props).not.toHaveProperty('chatJid');
      }
      const required = (entry!.inputSchema as Record<string, unknown>).required as
        | string[]
        | undefined;
      if (required) {
        expect(required).not.toContain('chatJid');
      }
    });

    it(`${tool.name}: auto-injects deliveryJid when chatJid not supplied`, async () => {
      const result = await registry.call(tool.name, { ...tool.params }, aliceSession);
      // The call must not fail with a scope/injection error
      if (result.isError) {
        // Any error must be about the WhatsApp socket (not connected), not about chatJid injection
        expect(result.content[0].text).not.toContain('requires chatJid');
        expect(result.content[0].text).not.toContain('deliveryJid');
      }
    });

    it(`${tool.name}: overrides caller-supplied chatJid with session.deliveryJid`, async () => {
      // Supply a different JID than the session deliveryJid — it must be replaced
      const result = await registry.call(
        tool.name,
        { ...tool.params, chatJid: BOB_JID },
        aliceSession,
      );
      // Must not error about scope/injection
      if (result.isError) {
        expect(result.content[0].text).not.toContain('requires chatJid');
        expect(result.content[0].text).not.toContain('cross-conversation');
      }
      // The socket call must have been made with ALICE_JID, not BOB_JID
      const sockCalls = captured.filter((c) => c.jid !== undefined);
      if (sockCalls.length > 0) {
        for (const call of sockCalls) {
          expect(call.jid).toBe(ALICE_JID);
          expect(call.jid).not.toBe(BOB_JID);
        }
      }
    });
  }
});

// ===========================================================================
// B. Global session — injected tools
// ===========================================================================

describe('B. global session — injected tools', () => {
  let registry: ToolRegistry;
  let captured: CapturedCall[];
  const session = globalSession();

  beforeEach(() => {
    captured = [];
    registry = makeRegistry(makeDb(), makeMockSock(captured));
  });

  for (const tool of INJECTED_TOOLS) {
    it(`${tool.name}: appears in listTools for global session`, () => {
      const tools = registry.listTools(session);
      const names = tools.map((t) => t.name);
      expect(names).toContain(tool.name);
    });

    it(`${tool.name}: inputSchema INCLUDES chatJid as required for global session`, () => {
      const tools = registry.listTools(session);
      const entry = tools.find((t) => t.name === tool.name);
      expect(entry).toBeDefined();
      const schema = entry!.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown> | undefined;
      expect(props).toBeDefined();
      expect(props).toHaveProperty('chatJid');
      const required = schema.required as string[] | undefined;
      expect(required).toBeDefined();
      expect(required).toContain('chatJid');
    });

    it(`${tool.name}: returns error when called without chatJid in global session`, async () => {
      const result = await registry.call(tool.name, { ...tool.params }, session);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('chatJid');
    });

    it(`${tool.name}: accepts chatJid and calls socket with that JID in global session`, async () => {
      const result = await registry.call(
        tool.name,
        { ...tool.params, chatJid: ALICE_JID },
        session,
      );
      // Must not be a scope/injection error
      if (result.isError) {
        expect(result.content[0].text).not.toContain('requires chatJid');
        // Only permissible error: WhatsApp not connected (mock returned)
      }
      // When the socket WAS called, it must use the supplied JID
      const sockCalls = captured.filter((c) => c.jid !== undefined);
      if (sockCalls.length > 0) {
        for (const call of sockCalls) {
          expect(call.jid).toBe(ALICE_JID);
        }
      }
    });
  }
});

// ===========================================================================
// C. Global-only tools — hidden from chat-scoped sessions
// ===========================================================================

describe('C. global-only tools are hidden from and rejected by chat-scoped sessions', () => {
  let registry: ToolRegistry;
  const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

  beforeEach(() => {
    registry = makeRegistry(makeDb(), makeMockSock());
  });

  for (const toolName of GLOBAL_ONLY_TOOLS) {
    it(`${toolName}: does NOT appear in listTools for chat-scoped session`, () => {
      const tools = registry.listTools(aliceSession);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain(toolName);
    });

    it(`${toolName}: returns scope error when called from chat-scoped session`, async () => {
      const result = await registry.call(toolName, {}, aliceSession);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available in a chat-scoped session');
    });
  }

  it('global-only tools remain visible in listTools for global session', () => {
    const globalReg = makeRegistry(makeDb(), makeMockSock());
    const tools = globalReg.listTools(globalSession());
    const names = tools.map((t) => t.name);
    for (const toolName of GLOBAL_ONLY_TOOLS) {
      expect(names).toContain(toolName);
    }
  });
});

// ===========================================================================
// D. Cross-conversation guard
// ===========================================================================

describe('D. cross-conversation guard', () => {
  let captured: CapturedCall[];
  let registry: ToolRegistry;

  beforeEach(() => {
    captured = [];
    registry = makeRegistry(makeDb(), makeMockSock(captured));
  });

  it('chat-scoped session bound to ALICE — injected tool always uses ALICE_JID regardless of caller input', async () => {
    const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

    await registry.call(
      'clear_chat',
      {
        chatJid: BOB_JID, // attacker supplies a different JID
        messages: [{ id: 'msg-x', fromMe: true, timestamp: 1000 }],
      },
      aliceSession,
    );

    // Every chatModify call must have gone to ALICE_JID
    const chatModifyCalls = captured.filter((c) => c.method === 'chatModify');
    expect(chatModifyCalls.length).toBeGreaterThan(0);
    for (const call of chatModifyCalls) {
      expect(call.jid).toBe(ALICE_JID);
      expect(call.jid).not.toBe(BOB_JID);
    }
  });

  it('chat-scoped session: send_message uses session deliveryJid even if caller supplies different chatJid', async () => {
    const conn = {
      contactsDir: { contacts: new Map<string, string>() },
      sendRaw: async (jid: string, _content: unknown) => {
        captured.push({ method: 'sendRaw', jid, args: [_content] });
        return { waMessageId: null };
      },
    } as unknown as ConnectionManager;

    const reg = new ToolRegistry();
    registerMessagingTools(reg, { connection: conn, db: makeDb().raw });

    const aliceSession = chatSession(ALICE_KEY, ALICE_JID);
    await reg.call(
      'send_message',
      { chatJid: BOB_JID, text: 'cross-chat attempt' },
      aliceSession,
    );

    const sendCalls = captured.filter((c) => c.method === 'sendRaw');
    expect(sendCalls.length).toBeGreaterThan(0);
    for (const call of sendCalls) {
      expect(call.jid).toBe(ALICE_JID);
      expect(call.jid).not.toBe(BOB_JID);
    }
  });

  it('global session with bound conversationKey rejects chatJid from a different conversation', async () => {
    // Global session bound to ALICE_KEY
    const boundGlobal: SessionContext = {
      tier: 'global',
      conversationKey: ALICE_KEY,
    };

    const result = await registry.call(
      'clear_chat',
      {
        chatJid: BOB_JID, // BOB resolves to BOB_KEY, which != ALICE_KEY
        messages: [{ id: 'msg-x', fromMe: true, timestamp: 1000 }],
      },
      boundGlobal,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('does not match session conversation');
  });

  it('global session without bound conversationKey accepts any valid chatJid', async () => {
    const unboundGlobal: SessionContext = { tier: 'global' };

    const result = await registry.call(
      'clear_chat',
      {
        chatJid: BOB_JID,
        messages: [{ id: 'msg-x', fromMe: true, timestamp: 1000 }],
      },
      unboundGlobal,
    );

    // No cross-conversation error — only possible error is WhatsApp not connected
    if (result.isError) {
      expect(result.content[0].text).not.toContain('does not match session conversation');
    }
  });
});

// ===========================================================================
// E. The 4 recently-changed tools specifically
//    (were scope:'global', now scope:'chat', targetMode:'injected')
// ===========================================================================

describe('E. recently-changed tools — clear_chat, delete_chat, delete_message_for_me, mark_chat_read', () => {
  const CHANGED_TOOLS: Array<{ name: string; params: Record<string, unknown> }> = [
    {
      name: 'clear_chat',
      params: { messages: [{ id: 'msg-1', fromMe: true, timestamp: 1000 }] },
    },
    {
      name: 'delete_chat',
      params: {
        last_message_key: { id: 'msg-1', fromMe: true },
        last_message_timestamp: 1000,
      },
    },
    {
      name: 'delete_message_for_me',
      params: { message_id: 'msg-1', from_me: true, timestamp: 1000 },
    },
    {
      name: 'mark_chat_read',
      params: {
        read: true,
        last_message_key: { id: 'msg-1', fromMe: false },
        last_message_timestamp: 2000,
      },
    },
  ];

  describe('from chat-scoped session', () => {
    let captured: CapturedCall[];
    let registry: ToolRegistry;
    const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

    beforeEach(() => {
      captured = [];
      registry = makeRegistry(makeDb(), makeMockSock(captured));
    });

    for (const tool of CHANGED_TOOLS) {
      it(`${tool.name}: is visible in listTools (scope is 'chat', not 'global')`, () => {
        const tools = registry.listTools(aliceSession);
        const names = tools.map((t) => t.name);
        expect(names).toContain(tool.name);
      });

      it(`${tool.name}: chatJid NOT in advertised schema for chat-scoped session`, () => {
        const tools = registry.listTools(aliceSession);
        const entry = tools.find((t) => t.name === tool.name);
        expect(entry).toBeDefined();
        const props = (entry!.inputSchema as Record<string, unknown>).properties as
          | Record<string, unknown>
          | undefined;
        if (props) {
          expect(props).not.toHaveProperty('chatJid');
        }
      });

      it(`${tool.name}: chatModify is called with session.deliveryJid (ALICE_JID), not any other JID`, async () => {
        await registry.call(tool.name, { ...tool.params }, aliceSession);

        const modCalls = captured.filter((c) => c.method === 'chatModify');
        expect(modCalls.length).toBe(1);
        expect(modCalls[0]!.jid).toBe(ALICE_JID);
      });

      it(`${tool.name}: caller-supplied chatJid is silently replaced by session.deliveryJid`, async () => {
        // Attacker tries to target Bob's chat from Alice's session
        await registry.call(
          tool.name,
          { ...tool.params, chatJid: BOB_JID },
          aliceSession,
        );

        const modCalls = captured.filter((c) => c.method === 'chatModify');
        expect(modCalls.length).toBe(1);
        expect(modCalls[0]!.jid).toBe(ALICE_JID);
        expect(modCalls[0]!.jid).not.toBe(BOB_JID);
      });
    }
  });

  describe('from global session', () => {
    let captured: CapturedCall[];
    let registry: ToolRegistry;
    const session = globalSession();

    beforeEach(() => {
      captured = [];
      registry = makeRegistry(makeDb(), makeMockSock(captured));
    });

    for (const tool of CHANGED_TOOLS) {
      it(`${tool.name}: is visible in listTools for global session`, () => {
        const tools = registry.listTools(session);
        const names = tools.map((t) => t.name);
        expect(names).toContain(tool.name);
      });

      it(`${tool.name}: chatJid IS in advertised schema as required for global session`, () => {
        const tools = registry.listTools(session);
        const entry = tools.find((t) => t.name === tool.name);
        expect(entry).toBeDefined();
        const schema = entry!.inputSchema as Record<string, unknown>;
        const props = schema.properties as Record<string, unknown> | undefined;
        expect(props).toBeDefined();
        expect(props).toHaveProperty('chatJid');
        const required = schema.required as string[] | undefined;
        expect(required).toBeDefined();
        expect(required).toContain('chatJid');
      });

      it(`${tool.name}: returns error when called without chatJid in global session`, async () => {
        const result = await registry.call(tool.name, { ...tool.params }, session);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('chatJid');
      });

      it(`${tool.name}: chatModify is called with supplied chatJid from global session`, async () => {
        await registry.call(
          tool.name,
          { ...tool.params, chatJid: ALICE_JID },
          session,
        );

        const modCalls = captured.filter((c) => c.method === 'chatModify');
        expect(modCalls.length).toBe(1);
        expect(modCalls[0]!.jid).toBe(ALICE_JID);
      });
    }
  });
});

// ===========================================================================
// F. Schema integrity — injected tools have chatJid in their Zod schema
//    but the registry correctly strips it from the advertised schema for
//    chat-scoped sessions and adds it for global sessions
// ===========================================================================

describe('F. schema advertised vs underlying schema integrity', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = makeRegistry(makeDb(), makeMockSock());
  });

  it('send_group_invite: chatJid is optional in underlying schema but still injected correctly', async () => {
    // send_group_invite has chatJid as optional in Zod schema.
    // From chat-scoped: registry must still inject deliveryJid and the handler must use it.
    const captured: CapturedCall[] = [];
    const reg = makeRegistry(makeDb(), makeMockSock(captured));
    const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

    await reg.call(
      'send_group_invite',
      {
        groupJid: '99999@g.us',
        inviteCode: 'TESTCODE',
        inviteExpiration: 9999999999,
        groupName: 'Test Group',
      },
      aliceSession,
    );

    // sendMessage must be called with ALICE_JID
    const smCalls = captured.filter((c) => c.method === 'sendMessage');
    expect(smCalls.length).toBe(1);
    expect(smCalls[0]!.jid).toBe(ALICE_JID);
  });

  it('send_limit_sharing: only chatJid in schema — injection supplies the only needed param', async () => {
    const captured: CapturedCall[] = [];
    const reg = makeRegistry(makeDb(), makeMockSock(captured));
    const aliceSession = chatSession(ALICE_KEY, ALICE_JID);

    // No params at all (chatJid will be injected)
    const result = await reg.call('send_limit_sharing', {}, aliceSession);

    if (result.isError) {
      // Only acceptable error is WhatsApp not connected — not a missing-param error
      expect(result.content[0].text).not.toContain('chatJid');
    }
    const smCalls = captured.filter((c) => c.method === 'sendMessage');
    if (smCalls.length > 0) {
      expect(smCalls[0]!.jid).toBe(ALICE_JID);
    }
  });

  it('injected tools never expose chatJid in chat-scoped session schema — full sweep', () => {
    const chatScopedTools = registry.listTools(chatSession(ALICE_KEY, ALICE_JID));
    const injectedToolNames = INJECTED_TOOLS.map((t) => t.name);

    for (const tool of chatScopedTools) {
      if (!injectedToolNames.includes(tool.name)) continue;

      const props = (tool.inputSchema as Record<string, unknown>).properties as
        | Record<string, unknown>
        | undefined;
      if (props) {
        expect(
          Object.keys(props),
          `${tool.name}: chatJid must not appear in chat-scoped schema`,
        ).not.toContain('chatJid');
      }

      const required = (tool.inputSchema as Record<string, unknown>).required as
        | string[]
        | undefined;
      if (required) {
        expect(
          required,
          `${tool.name}: chatJid must not be required in chat-scoped schema`,
        ).not.toContain('chatJid');
      }
    }
  });

  it('injected tools always have chatJid as required in global session schema — full sweep', () => {
    const globalTools = registry.listTools(globalSession());
    const injectedToolNames = INJECTED_TOOLS.map((t) => t.name);

    for (const tool of globalTools) {
      if (!injectedToolNames.includes(tool.name)) continue;

      const schema = tool.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown> | undefined;
      expect(
        props,
        `${tool.name}: properties must be defined in global session schema`,
      ).toBeDefined();
      expect(
        Object.keys(props!),
        `${tool.name}: chatJid must appear in global session schema`,
      ).toContain('chatJid');

      const required = schema.required as string[] | undefined;
      expect(
        required,
        `${tool.name}: required array must be defined in global session schema`,
      ).toBeDefined();
      expect(
        required,
        `${tool.name}: chatJid must be required in global session schema`,
      ).toContain('chatJid');
    }
  });
});
