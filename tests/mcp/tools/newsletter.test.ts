import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerNewsletterTools } from '../../../src/mcp/tools/newsletter.ts';
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
    newsletterCreate: vi.fn().mockResolvedValue({ id: 'newsletter1@newsletter' }),
    newsletterUpdate: vi.fn().mockResolvedValue({ id: 'newsletter1@newsletter' }),
    newsletterMetadata: vi.fn().mockResolvedValue({ id: 'newsletter1@newsletter', name: 'Test Newsletter' }),
    newsletterSubscribers: vi.fn().mockResolvedValue([{ jid: '111@s.whatsapp.net' }]),
    newsletterFollow: vi.fn().mockResolvedValue(undefined),
    newsletterUnfollow: vi.fn().mockResolvedValue(undefined),
    newsletterMute: vi.fn().mockResolvedValue(undefined),
    newsletterUnmute: vi.fn().mockResolvedValue(undefined),
    newsletterUpdateName: vi.fn().mockResolvedValue(undefined),
    newsletterUpdateDescription: vi.fn().mockResolvedValue(undefined),
    newsletterUpdatePicture: vi.fn().mockResolvedValue(undefined),
    newsletterRemovePicture: vi.fn().mockResolvedValue(undefined),
    newsletterReactMessage: vi.fn().mockResolvedValue(undefined),
    newsletterFetchMessages: vi.fn().mockResolvedValue([]),
    subscribeNewsletterUpdates: vi.fn().mockResolvedValue(undefined),
    newsletterAdminCount: vi.fn().mockResolvedValue(3),
    newsletterChangeOwner: vi.fn().mockResolvedValue(undefined),
    newsletterDemote: vi.fn().mockResolvedValue(undefined),
    newsletterDelete: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('newsletter tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerNewsletterTools(() => mockSock, (tool) => registry.register(tool));
  });

  const globalTools = [
    'newsletter_create',
    'newsletter_update',
    'newsletter_metadata',
    'newsletter_subscribers',
    'newsletter_follow',
    'newsletter_unfollow',
    'newsletter_mute',
    'newsletter_unmute',
    'newsletter_update_name',
    'newsletter_update_description',
    'newsletter_update_picture',
    'newsletter_remove_picture',
    'newsletter_react_message',
    'newsletter_fetch_messages',
    'subscribe_newsletter_updates',
    'newsletter_admin_count',
    'newsletter_change_owner',
    'newsletter_demote',
    'newsletter_delete',
  ];

  it.each(globalTools)('%s is registered', (name) => {
    const tools = registry.listTools(globalSession());
    expect(tools.find((t) => t.name === name)).toBeDefined();
  });

  it.each(globalTools)('%s is NOT visible in chat-scoped session', (name) => {
    const tools = registry.listTools(chatSession('111'));
    expect(tools.find((t) => t.name === name)).toBeUndefined();
  });

  it.each(globalTools)('%s is rejected when called from chat-scoped session', async (name) => {
    const result = await registry.call(name, { jid: 'newsletter1@newsletter' }, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- newsletter_create ---

  describe('newsletter_create', () => {
    it('calls newsletterCreate with name only', async () => {
      const result = await registry.call(
        'newsletter_create',
        { name: 'My Newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterCreate).toHaveBeenCalledWith('My Newsletter', undefined);
    });

    it('calls newsletterCreate with name and description', async () => {
      const result = await registry.call(
        'newsletter_create',
        { name: 'My Newsletter', description: 'All the news' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterCreate).toHaveBeenCalledWith('My Newsletter', 'All the news');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerNewsletterTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('newsletter_create', { name: 'Test' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- newsletter_update ---

  describe('newsletter_update', () => {
    it('calls newsletterUpdate with jid and updates', async () => {
      const result = await registry.call(
        'newsletter_update',
        { jid: 'newsletter1@newsletter', updates: { name: 'Updated' } },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterUpdate).toHaveBeenCalledWith('newsletter1@newsletter', { name: 'Updated' });
    });
  });

  // --- newsletter_metadata ---

  describe('newsletter_metadata', () => {
    it('calls newsletterMetadata with type=jid', async () => {
      const result = await registry.call(
        'newsletter_metadata',
        { type: 'jid', key: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterMetadata).toHaveBeenCalledWith('jid', 'newsletter1@newsletter');
    });

    it('calls newsletterMetadata with type=invite', async () => {
      const result = await registry.call(
        'newsletter_metadata',
        { type: 'invite', key: 'ABC123' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterMetadata).toHaveBeenCalledWith('invite', 'ABC123');
    });

    it('rejects invalid type', async () => {
      const result = await registry.call(
        'newsletter_metadata',
        { type: 'unknown', key: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerNewsletterTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'newsletter_metadata',
        { type: 'jid', key: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- newsletter_subscribers ---

  describe('newsletter_subscribers', () => {
    it('calls newsletterSubscribers with jid', async () => {
      const result = await registry.call(
        'newsletter_subscribers',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterSubscribers).toHaveBeenCalledWith('newsletter1@newsletter');
    });
  });

  // --- newsletter_follow ---

  describe('newsletter_follow', () => {
    it('calls newsletterFollow with jid', async () => {
      const result = await registry.call(
        'newsletter_follow',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterFollow).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_follow',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
      expect(data.jid).toBe('newsletter1@newsletter');
    });
  });

  // --- newsletter_unfollow ---

  describe('newsletter_unfollow', () => {
    it('calls newsletterUnfollow with jid', async () => {
      const result = await registry.call(
        'newsletter_unfollow',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterUnfollow).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_unfollow',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
      expect(data.jid).toBe('newsletter1@newsletter');
    });
  });

  // --- newsletter_mute ---

  describe('newsletter_mute', () => {
    it('calls newsletterMute with jid', async () => {
      const result = await registry.call(
        'newsletter_mute',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterMute).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_mute',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
    });
  });

  // --- newsletter_unmute ---

  describe('newsletter_unmute', () => {
    it('calls newsletterUnmute with jid', async () => {
      const result = await registry.call(
        'newsletter_unmute',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterUnmute).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_unmute',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
    });
  });

  // --- newsletter_update_name ---

  describe('newsletter_update_name', () => {
    it('calls newsletterUpdateName with jid and name', async () => {
      const result = await registry.call(
        'newsletter_update_name',
        { jid: 'newsletter1@newsletter', name: 'New Title' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterUpdateName).toHaveBeenCalledWith('newsletter1@newsletter', 'New Title');
    });

    it('returns success with jid and name', async () => {
      const result = await registry.call(
        'newsletter_update_name',
        { jid: 'newsletter1@newsletter', name: 'New Title' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string; name: string };
      expect(data.success).toBe(true);
      expect(data.name).toBe('New Title');
    });
  });

  // --- newsletter_update_description ---

  describe('newsletter_update_description', () => {
    it('calls newsletterUpdateDescription with jid and description', async () => {
      const result = await registry.call(
        'newsletter_update_description',
        { jid: 'newsletter1@newsletter', description: 'New desc' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterUpdateDescription).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        'New desc',
      );
    });

    it('returns success with jid and description', async () => {
      const result = await registry.call(
        'newsletter_update_description',
        { jid: 'newsletter1@newsletter', description: 'New desc' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; description: string };
      expect(data.success).toBe(true);
      expect(data.description).toBe('New desc');
    });
  });

  // --- newsletter_update_picture ---

  describe('newsletter_update_picture', () => {
    it('decodes base64 and calls newsletterUpdatePicture', async () => {
      const imageBytes = Buffer.from('fake-image-data');
      const base64Content = imageBytes.toString('base64');

      const result = await registry.call(
        'newsletter_update_picture',
        { jid: 'newsletter1@newsletter', content: base64Content },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();

      const calledWith = (mockSock as any).newsletterUpdatePicture.mock.calls[0];
      expect(calledWith[0]).toBe('newsletter1@newsletter');
      expect(Buffer.isBuffer(calledWith[1])).toBe(true);
      expect(calledWith[1]).toEqual(imageBytes);
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_update_picture',
        { jid: 'newsletter1@newsletter', content: Buffer.from('x').toString('base64') },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
      expect(data.jid).toBe('newsletter1@newsletter');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerNewsletterTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'newsletter_update_picture',
        { jid: 'newsletter1@newsletter', content: 'dGVzdA==' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- newsletter_remove_picture ---

  describe('newsletter_remove_picture', () => {
    it('calls newsletterRemovePicture with jid', async () => {
      const result = await registry.call(
        'newsletter_remove_picture',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterRemovePicture).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_remove_picture',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
    });
  });

  // --- newsletter_react_message ---

  describe('newsletter_react_message', () => {
    it('calls newsletterReactMessage with jid, serverId, and reaction', async () => {
      const result = await registry.call(
        'newsletter_react_message',
        { jid: 'newsletter1@newsletter', serverId: 'server123', reaction: '👍' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterReactMessage).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        'server123',
        '👍',
      );
    });

    it('calls newsletterReactMessage without reaction (remove)', async () => {
      const result = await registry.call(
        'newsletter_react_message',
        { jid: 'newsletter1@newsletter', serverId: 'server123' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterReactMessage).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        'server123',
        undefined,
      );
    });

    it('returns success with jid and serverId', async () => {
      const result = await registry.call(
        'newsletter_react_message',
        { jid: 'newsletter1@newsletter', serverId: 'server123', reaction: '❤️' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string; serverId: string };
      expect(data.success).toBe(true);
      expect(data.serverId).toBe('server123');
    });
  });

  // --- newsletter_fetch_messages ---

  describe('newsletter_fetch_messages', () => {
    it('calls newsletterFetchMessages with jid and count', async () => {
      const result = await registry.call(
        'newsletter_fetch_messages',
        { jid: 'newsletter1@newsletter', count: 20 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterFetchMessages).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        20,
        undefined,
        undefined,
      );
    });

    it('calls newsletterFetchMessages with optional since and after', async () => {
      await registry.call(
        'newsletter_fetch_messages',
        { jid: 'newsletter1@newsletter', count: 10, since: 1700000000, after: 'cursor123' },
        globalSession(),
      );
      expect((mockSock as any).newsletterFetchMessages).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        10,
        1700000000,
        'cursor123',
      );
    });

    it('rejects non-integer count', async () => {
      const result = await registry.call(
        'newsletter_fetch_messages',
        { jid: 'newsletter1@newsletter', count: 0 },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- subscribe_newsletter_updates ---

  describe('subscribe_newsletter_updates', () => {
    it('calls subscribeNewsletterUpdates with jid', async () => {
      const result = await registry.call(
        'subscribe_newsletter_updates',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).subscribeNewsletterUpdates).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'subscribe_newsletter_updates',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
      expect(data.jid).toBe('newsletter1@newsletter');
    });
  });

  // --- newsletter_admin_count ---

  describe('newsletter_admin_count', () => {
    it('calls newsletterAdminCount with jid', async () => {
      const result = await registry.call(
        'newsletter_admin_count',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterAdminCount).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns jid and adminCount', async () => {
      const result = await registry.call(
        'newsletter_admin_count',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { jid: string; adminCount: number };
      expect(data.jid).toBe('newsletter1@newsletter');
      expect(data.adminCount).toBe(3);
    });
  });

  // --- newsletter_change_owner ---

  describe('newsletter_change_owner', () => {
    it('calls newsletterChangeOwner with jid and newOwnerJid', async () => {
      const result = await registry.call(
        'newsletter_change_owner',
        { jid: 'newsletter1@newsletter', newOwnerJid: '999@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterChangeOwner).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        '999@s.whatsapp.net',
      );
    });

    it('returns success with jid and newOwnerJid', async () => {
      const result = await registry.call(
        'newsletter_change_owner',
        { jid: 'newsletter1@newsletter', newOwnerJid: '999@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as {
        success: boolean;
        jid: string;
        newOwnerJid: string;
      };
      expect(data.success).toBe(true);
      expect(data.newOwnerJid).toBe('999@s.whatsapp.net');
    });
  });

  // --- newsletter_demote ---

  describe('newsletter_demote', () => {
    it('calls newsletterDemote with jid and userJid', async () => {
      const result = await registry.call(
        'newsletter_demote',
        { jid: 'newsletter1@newsletter', userJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterDemote).toHaveBeenCalledWith(
        'newsletter1@newsletter',
        '111@s.whatsapp.net',
      );
    });

    it('returns success with jid and userJid', async () => {
      const result = await registry.call(
        'newsletter_demote',
        { jid: 'newsletter1@newsletter', userJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; userJid: string };
      expect(data.success).toBe(true);
      expect(data.userJid).toBe('111@s.whatsapp.net');
    });
  });

  // --- newsletter_delete ---

  describe('newsletter_delete', () => {
    it('calls newsletterDelete with jid', async () => {
      const result = await registry.call(
        'newsletter_delete',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).newsletterDelete).toHaveBeenCalledWith('newsletter1@newsletter');
    });

    it('returns success with jid', async () => {
      const result = await registry.call(
        'newsletter_delete',
        { jid: 'newsletter1@newsletter' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; jid: string };
      expect(data.success).toBe(true);
      expect(data.jid).toBe('newsletter1@newsletter');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerNewsletterTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('newsletter_delete', { jid: 'newsletter1@newsletter' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });
});
