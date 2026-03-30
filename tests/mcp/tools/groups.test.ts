import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerGroupTools } from '../../../src/mcp/tools/groups.ts';
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
    groupFetchAllParticipating: vi.fn().mockResolvedValue({
      'group1@g.us': { id: 'group1@g.us', subject: 'Test Group', participants: [] },
    }),
    groupMetadata: vi.fn().mockResolvedValue({ id: 'group1@g.us', subject: 'Test Group', participants: [] }),
    groupUpdateSubject: vi.fn().mockResolvedValue(undefined),
    groupUpdateDescription: vi.fn().mockResolvedValue(undefined),
    groupParticipantsUpdate: vi.fn().mockResolvedValue([{ status: '200', jid: '111@s.whatsapp.net' }]),
    groupSettingUpdate: vi.fn().mockResolvedValue(undefined),
    groupInviteCode: vi.fn().mockResolvedValue('ABC123'),
  } as unknown as WhatsAppSocket;
}

describe('group tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerGroupTools(() => mockSock, (tool) => registry.register(tool));
  });

  const globalTools = [
    'list_groups',
    'get_group_metadata',
    'group_update_subject',
    'group_update_description',
    'group_participants_update',
    'group_settings_update',
    'get_group_invite_link',
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
    const result = await registry.call(name, { jid: 'group1@g.us' }, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- list_groups ---

  describe('list_groups', () => {
    it('calls groupFetchAllParticipating', async () => {
      const result = await registry.call('list_groups', {}, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupFetchAllParticipating).toHaveBeenCalled();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerGroupTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('list_groups', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- get_group_metadata ---

  describe('get_group_metadata', () => {
    it('calls sock.groupMetadata with the jid', async () => {
      const result = await registry.call(
        'get_group_metadata',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.groupMetadata).toHaveBeenCalledWith('group1@g.us');
    });
  });

  // --- group_update_subject ---

  describe('group_update_subject', () => {
    it('calls sock.groupUpdateSubject', async () => {
      const result = await registry.call(
        'group_update_subject',
        { jid: 'group1@g.us', subject: 'New Name' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.groupUpdateSubject).toHaveBeenCalledWith('group1@g.us', 'New Name');
    });
  });

  // --- group_update_description ---

  describe('group_update_description', () => {
    it('calls sock.groupUpdateDescription', async () => {
      const result = await registry.call(
        'group_update_description',
        { jid: 'group1@g.us', description: 'A new description' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.groupUpdateDescription).toHaveBeenCalledWith('group1@g.us', 'A new description');
    });
  });

  // --- group_participants_update ---

  describe('group_participants_update', () => {
    it('calls sock.groupParticipantsUpdate with add action', async () => {
      const result = await registry.call(
        'group_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'add' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.groupParticipantsUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        ['111@s.whatsapp.net'],
        'add',
      );
    });

    it('calls sock.groupParticipantsUpdate with remove action', async () => {
      await registry.call(
        'group_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'remove' },
        globalSession(),
      );
      expect(mockSock.groupParticipantsUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        ['111@s.whatsapp.net'],
        'remove',
      );
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'group_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- group_settings_update ---

  describe('group_settings_update', () => {
    it('calls sock.groupSettingUpdate with announcement', async () => {
      const result = await registry.call(
        'group_settings_update',
        { jid: 'group1@g.us', setting: 'announcement' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect(mockSock.groupSettingUpdate).toHaveBeenCalledWith('group1@g.us', 'announcement');
    });

    it('calls sock.groupSettingUpdate with locked', async () => {
      await registry.call(
        'group_settings_update',
        { jid: 'group1@g.us', setting: 'locked' },
        globalSession(),
      );
      expect(mockSock.groupSettingUpdate).toHaveBeenCalledWith('group1@g.us', 'locked');
    });
  });

  // --- get_group_invite_link ---

  describe('get_group_invite_link', () => {
    it('returns formatted invite link', async () => {
      const result = await registry.call(
        'get_group_invite_link',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { inviteCode: string; inviteLink: string };
      expect(data.inviteCode).toBe('ABC123');
      expect(data.inviteLink).toBe('https://chat.whatsapp.com/ABC123');
    });

    it('calls sock.groupInviteCode with the jid', async () => {
      await registry.call('get_group_invite_link', { jid: 'group1@g.us' }, globalSession());
      expect(mockSock.groupInviteCode).toHaveBeenCalledWith('group1@g.us');
    });
  });
});
