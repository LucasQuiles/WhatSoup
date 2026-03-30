import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerProfileTools } from '../../../src/mcp/tools/profile.ts';
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
    profilePictureUrl: vi.fn().mockResolvedValue('https://example.com/pic.jpg'),
    fetchStatus: vi.fn().mockResolvedValue([{ status: { status: 'Available!' } }]),
    onWhatsApp: vi.fn().mockResolvedValue([{ jid: '111@s.whatsapp.net', exists: true }]),
    updateBlockStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('profile tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerProfileTools(() => mockSock, (tool) => registry.register(tool));
  });

  const globalTools = ['get_profile_picture', 'get_contact_status', 'check_whatsapp', 'block_contact'];

  it.each(globalTools)('%s is global-only (not visible in chat-scoped session)', (name) => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === name)).toBeUndefined();
  });

  it.each(globalTools)('%s is rejected when called from chat-scoped session', async (name) => {
    const params: Record<string, unknown> = { jid: '111@s.whatsapp.net' };
    if (name === 'check_whatsapp') params['phone_numbers'] = ['111'];
    if (name === 'block_contact') params['action'] = 'block';
    const result = await registry.call(name, params, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- get_profile_picture ---

  describe('get_profile_picture', () => {
    it('calls sock.profilePictureUrl and returns url', async () => {
      const result = await registry.call(
        'get_profile_picture',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.profilePictureUrl).toHaveBeenCalledWith('111@s.whatsapp.net', 'preview');
      const data = JSON.parse(result.content[0].text) as { url: string };
      expect(data.url).toBe('https://example.com/pic.jpg');
    });

    it('returns null url when profilePictureUrl returns undefined', async () => {
      (mockSock.profilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const result = await registry.call(
        'get_profile_picture',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { url: null };
      expect(data.url).toBeNull();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerProfileTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('get_profile_picture', { jid: '111@s.whatsapp.net' }, globalSession());
      expect(result.isError).toBe(true);
    });
  });

  // --- get_contact_status ---

  describe('get_contact_status', () => {
    it('calls sock.fetchStatus and returns status', async () => {
      const result = await registry.call(
        'get_contact_status',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.fetchStatus).toHaveBeenCalledWith('111@s.whatsapp.net');
    });

    it('returns null status when fetchStatus returns empty array', async () => {
      (mockSock.fetchStatus as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await registry.call(
        'get_contact_status',
        { jid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { status: null };
      expect(data.status).toBeNull();
    });
  });

  // --- check_whatsapp ---

  describe('check_whatsapp', () => {
    it('calls sock.onWhatsApp with phone numbers', async () => {
      const result = await registry.call(
        'check_whatsapp',
        { phone_numbers: ['111', '222'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.onWhatsApp).toHaveBeenCalledWith('111', '222');
    });
  });

  // --- block_contact ---

  describe('block_contact', () => {
    it('calls sock.updateBlockStatus with block action', async () => {
      const result = await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'block' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.updateBlockStatus).toHaveBeenCalledWith('111@s.whatsapp.net', 'block');
    });

    it('calls sock.updateBlockStatus with unblock action', async () => {
      await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'unblock' },
        globalSession(),
      );
      expect(mockSock.updateBlockStatus).toHaveBeenCalledWith('111@s.whatsapp.net', 'unblock');
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'block_contact',
        { jid: '111@s.whatsapp.net', action: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });
});
