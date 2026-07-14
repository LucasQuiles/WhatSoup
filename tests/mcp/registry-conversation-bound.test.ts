import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// A per-chat actor socket keeps tier:'global' but carries a conversation-bound
// binding. Such a session must be restricted to: chat-scoped tools, injected-
// target tools (target filled from the binding; any supplied target rejected),
// and a default-deny allowlist of reviewed conversation-safe global tools.
// Cross-conversation global tools (search_messages, list_chats, …) are denied.
//
// A plain global session — INCLUDING one whose conversationKey is turn-pinned
// by bindActiveGlobalMcpConversation — is NOT bound and keeps full access.

const BOUND_KEY = '12345';
const BOUND_JID = '12345@s.whatsapp.net';

const boundSession = (over: Partial<SessionContext> = {}): SessionContext => ({
  tier: 'global',
  conversationKey: BOUND_KEY,
  deliveryJid: BOUND_JID,
  binding: Object.freeze({
    kind: 'conversation-bound' as const,
    conversationKey: BOUND_KEY,
    deliveryJid: BOUND_JID,
  }),
  ...over,
});

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({ message: z.string() }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => ({ echo: params['message'] }),
    ...overrides,
  };
}

describe('ToolRegistry — conversation-bound eligibility', () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('DENIES a cross-conversation global caller-supplied tool by default (search_messages regression)', async () => {
    registry.register(makeTool({ name: 'search_messages', scope: 'global', targetMode: 'caller-supplied' }));
    const res = await registry.call('search_messages', { message: 'x' }, boundSession());
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('conversation-bound');
  });

  it('hides non-eligible global tools from listTools but keeps chat-scoped tools', () => {
    registry.register(makeTool({ name: 'chat_tool', scope: 'chat' }));
    registry.register(makeTool({ name: 'search_messages', scope: 'global', targetMode: 'caller-supplied' }));
    const names = registry.listTools(boundSession()).map((t) => t.name);
    expect(names).toContain('chat_tool');
    expect(names).not.toContain('search_messages');
  });

  it('a plain operator global session (no binding) keeps full global tool access', () => {
    registry.register(makeTool({ name: 'search_messages', scope: 'global', targetMode: 'caller-supplied' }));
    const names = registry.listTools({ tier: 'global' }).map((t) => t.name);
    expect(names).toContain('search_messages');
  });

  it('a turn-pinned global session (conversationKey set, NO binding) keeps full global tool access — restriction is binding-keyed', async () => {
    registry.register(makeTool({ name: 'search_messages', scope: 'global', targetMode: 'caller-supplied' }));
    const operatorMidTurn: SessionContext = { tier: 'global', conversationKey: BOUND_KEY };
    const names = registry.listTools(operatorMidTurn).map((t) => t.name);
    expect(names).toContain('search_messages');
    const res = await registry.call('search_messages', { message: 'x' }, operatorMidTurn);
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).toContain('"echo": "x"');
  });

  it('REJECTS any caller-supplied target on an injected tool (no silent coerce), even one matching the binding', async () => {
    registry.register(
      makeTool({
        name: 'send_message',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), text: z.string() }),
        handler: async (p) => ({ sentTo: p['chatJid'] }),
      }),
    );
    const res = await registry.call(
      'send_message',
      { chatJid: BOUND_JID, text: 'x' }, // supplied target — must be rejected, not coerced
      boundSession(),
    );
    expect(res.isError).toBe(true);
  });

  it('REJECTS a caller-supplied alias target (`to`) on an injected tool that supports it', async () => {
    registry.register(
      makeTool({
        name: 'send_alias',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string().optional(), to: z.string().optional(), text: z.string() }),
        handler: async () => ({ ok: true }),
      }),
    );
    const res = await registry.call('send_alias', { to: 'someone', text: 'x' }, boundSession());
    expect(res.isError).toBe(true);
  });

  it('fills an injected target from the BINDING deliveryJid when the caller supplies none', async () => {
    let receivedChatJid: unknown;
    registry.register(
      makeTool({
        name: 'send_message',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), text: z.string() }),
        handler: async (p) => {
          receivedChatJid = p['chatJid'];
          return { ok: true };
        },
      }),
    );
    // Top-level deliveryJid diverges — the frozen binding must win (SSOT).
    const res = await registry.call('send_message', { text: 'x' }, boundSession({ deliveryJid: 'stale@s.whatsapp.net' }));
    expect(res.isError).toBeFalsy();
    expect(receivedChatJid).toBe(BOUND_JID);
  });

  it('strips injected targets from the listed schema for bound sessions (model never sees chatJid)', () => {
    registry.register(
      makeTool({
        name: 'send_message',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), text: z.string() }),
      }),
    );
    const listed = registry.listTools(boundSession()).find((t) => t.name === 'send_message');
    expect(listed).toBeDefined();
    const props = (listed!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).not.toContain('chatJid');
  });

  it('admits an allowlisted conversation-safe global tool (transcribe_audio) at list AND call', async () => {
    // transcribe_audio is scope:'global'/caller-supplied; its real handler
    // self-enforces the binding via assertConversationAccess (see the
    // real-handler proof in tests/mcp/tools/media.test.ts). The registry
    // admits it because it is on the reviewed default-deny allowlist.
    let ran = false;
    registry.register(
      makeTool({
        name: 'transcribe_audio',
        scope: 'global',
        targetMode: 'caller-supplied',
        schema: z.object({ message_id: z.string() }),
        handler: async () => { ran = true; return { text: 'transcript' }; },
      }),
    );
    const names = registry.listTools(boundSession()).map((t) => t.name);
    expect(names).toContain('transcribe_audio');
    const res = await registry.call('transcribe_audio', { message_id: 'm1' }, boundSession());
    expect(res.isError).toBeFalsy();
    expect(ran).toBe(true);
  });
});
