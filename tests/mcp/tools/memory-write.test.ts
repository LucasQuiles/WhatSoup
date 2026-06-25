import { describe, it, expect, vi } from 'vitest';
import { registerMemoryWriteTools, type MemoryWriter } from '../../../src/mcp/tools/memory-write.ts';
import type { ToolDeclaration, SessionContext } from '../../../src/mcp/types.ts';
import { isToolErrorPayload } from '../../../src/mcp/types.ts';
import type { MemoryRecord } from '../../../src/runtimes/chat/providers/pinecone.ts';

function setup(opts: { botJid?: string; upsert?: (r: MemoryRecord[]) => Promise<void> } = {}) {
  const tools: ToolDeclaration[] = [];
  const register = (t: ToolDeclaration) => tools.push(t);
  const upsert = vi.fn(opts.upsert ?? (async () => {}));
  const writer: MemoryWriter = { upsert };
  registerMemoryWriteTools(() => opts.botJid, register, () => writer);
  const tool = tools.find((t) => t.name === 'memory_write')!;
  return { tool, upsert };
}

const chatSession = (over: Partial<SessionContext> = {}): SessionContext => ({
  tier: 'chat-scoped',
  conversationKey: '12345@s.whatsapp.net',
  deliveryJid: '12345@s.whatsapp.net',
  actorJid: 'phil@s.whatsapp.net',
  ...over,
});

describe('memory_write tool', () => {
  it('registers a chat-scoped injected non-core tool', () => {
    const { tool } = setup();
    expect(tool).toBeDefined();
    expect(tool.scope).toBe('chat');
    expect(tool.targetMode).toBe('injected');
    expect(tool.core).toBe(false);
  });

  it('upserts a record using the session conversation + actor as sender', async () => {
    const { tool, upsert } = setup();
    const res = await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'Phil prefers email over calls', memory_type: 'preference' },
      chatSession(),
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const [records] = upsert.mock.calls[0] as [MemoryRecord[]];
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.text).toBe('Phil prefers email over calls');
    expect(r.memoryType).toBe('preference');
    expect(r.chatJid).toBe('12345@s.whatsapp.net');
    expect(r.senderJid).toBe('phil@s.whatsapp.net'); // from session.actorJid, not caller-supplied
    expect(r.confidence).toBe(0.8); // default
    expect(r.superseded).toBe('false');
    expect(typeof r.createdAt).toBe('string');
    expect(res).toMatchObject({ status: 'written', memory_type: 'preference' });
  });

  it('attributes self_fact to the bot JID, not the actor', async () => {
    const { tool, upsert } = setup({ botJid: 'bot@s.whatsapp.net' });
    await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'I am ph-bot', memory_type: 'self_fact' },
      chatSession(),
    );
    const r = (upsert.mock.calls[0] as [MemoryRecord[]])[0][0];
    expect(r.senderJid).toBe('bot@s.whatsapp.net');
  });

  it('does not accept a caller-supplied sender (anti-spoofing)', async () => {
    const { tool, upsert } = setup();
    await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'x', memory_type: 'user_fact', senderJid: 'spoofed@evil' } as Record<string, unknown>,
      chatSession({ actorJid: 'real@s.whatsapp.net' }),
    );
    const r = (upsert.mock.calls[0] as [MemoryRecord[]])[0][0];
    expect(r.senderJid).toBe('real@s.whatsapp.net');
  });

  it('produces a stable, idempotent id for identical content', async () => {
    const { tool, upsert } = setup();
    const args = { chatJid: '12345@s.whatsapp.net', text: 'same fact', memory_type: 'user_fact' as const };
    await tool.handler(args, chatSession());
    await tool.handler(args, chatSession());
    const id1 = (upsert.mock.calls[0] as [MemoryRecord[]])[0][0].id;
    const id2 = (upsert.mock.calls[1] as [MemoryRecord[]])[0][0].id;
    expect(id1).toBe(id2);
    expect(id1.startsWith('user_fact_')).toBe(true);
  });

  it('errors without a conversation context', async () => {
    const { tool, upsert } = setup();
    const res = await tool.handler(
      { chatJid: '', text: 'x', memory_type: 'user_fact' },
      { tier: 'chat-scoped' }, // no conversationKey, no usable chatJid
    );
    expect(isToolErrorPayload(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('surfaces an upsert failure as a tool error', async () => {
    const { tool } = setup({ upsert: async () => { throw new Error('PINECONE_UNAVAILABLE'); } });
    const res = await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'x', memory_type: 'user_fact' },
      chatSession(),
    );
    expect(isToolErrorPayload(res)).toBe(true);
  });

  it('REJECTS a global session even with a caller-supplied chatJid (no cross-conversation write)', async () => {
    const { tool, upsert } = setup({ botJid: 'bot@s.whatsapp.net' });
    const res = await tool.handler(
      { chatJid: '999', text: 'sneaky', memory_type: 'user_fact' },
      { tier: 'global' }, // global session: registry would accept caller chatJid
    );
    expect(isToolErrorPayload(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('REJECTS a chat-scoped session with no bound conversationKey', async () => {
    const { tool, upsert } = setup();
    const res = await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'x', memory_type: 'user_fact' },
      { tier: 'chat-scoped', deliveryJid: '12345@s.whatsapp.net' }, // no conversationKey
    );
    expect(isToolErrorPayload(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when self_fact has no bot JID (no placeholder sender)', async () => {
    const { tool, upsert } = setup({ botJid: undefined });
    const res = await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'I am the bot', memory_type: 'self_fact' },
      chatSession(),
    );
    expect(isToolErrorPayload(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when a non-self_fact write has no session actor', async () => {
    const { tool, upsert } = setup();
    const res = await tool.handler(
      { chatJid: '12345@s.whatsapp.net', text: 'x', memory_type: 'user_fact' },
      chatSession({ actorJid: undefined }),
    );
    expect(isToolErrorPayload(res)).toBe(true);
    expect(upsert).not.toHaveBeenCalled();
  });
});
