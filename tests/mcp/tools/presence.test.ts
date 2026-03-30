import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerPresenceTools } from '../../../src/mcp/tools/presence.ts';
import { PresenceCache } from '../../../src/transport/presence-cache.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function chatSession(conversationKey: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid: `${conversationKey}@s.whatsapp.net` };
}

function makeMockSock(): WhatsAppSocket {
  return {
    presenceSubscribe: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('presence tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;
  let presenceCache: PresenceCache;

  beforeEach(() => {
    mockSock = makeMockSock();
    presenceCache = new PresenceCache();
    registry = new ToolRegistry();
    registerPresenceTools(() => mockSock, presenceCache, (tool) => registry.register(tool));
  });

  it('subscribe_presence is global-only', () => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === 'subscribe_presence')).toBeUndefined();
  });

  it('get_presence is global-only', () => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === 'get_presence')).toBeUndefined();
  });

  it('subscribe_presence is rejected in chat-scoped session', async () => {
    const result = await registry.call('subscribe_presence', { jid: '111@s.whatsapp.net' }, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- subscribe_presence ---

  describe('subscribe_presence', () => {
    it('calls sock.presenceSubscribe with the jid', async () => {
      const result = await registry.call(
        'subscribe_presence',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.presenceSubscribe).toHaveBeenCalledWith('111@s.whatsapp.net');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerPresenceTools(() => null, presenceCache, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('subscribe_presence', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- get_presence ---

  describe('get_presence', () => {
    it('returns null fields when jid not in cache', async () => {
      const result = await registry.call(
        'get_presence',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { status: null; lastSeen: null; stale: null };
      expect(data.status).toBeNull();
      expect(data.lastSeen).toBeNull();
      expect(data.stale).toBeNull();
    });

    it('returns cached presence data for known jid', async () => {
      presenceCache.update('111@s.whatsapp.net', { status: 'available', lastSeen: 9999 });

      const result = await registry.call(
        'get_presence',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as {
        jid: string;
        status: string;
        lastSeen: number;
        stale: boolean;
      };
      expect(data.jid).toBe('111@s.whatsapp.net');
      expect(data.status).toBe('available');
      expect(data.lastSeen).toBe(9999);
      expect(data.stale).toBe(false);
    });
  });
});
