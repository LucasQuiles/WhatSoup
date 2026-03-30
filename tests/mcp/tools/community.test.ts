import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerCommunityTools } from '../../../src/mcp/tools/community.ts';
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
    communityMetadata: vi.fn().mockResolvedValue({ id: 'community1@g.us', subject: 'Test Community' }),
    communityCreate: vi.fn().mockResolvedValue({ id: 'new-community@g.us' }),
    communityCreateGroup: vi.fn().mockResolvedValue({ id: 'new-group@g.us' }),
    communityLeave: vi.fn().mockResolvedValue(undefined),
    communityLinkGroup: vi.fn().mockResolvedValue({ status: 'success' }),
    communityUnlinkGroup: vi.fn().mockResolvedValue({ status: 'success' }),
    communityFetchLinkedGroups: vi.fn().mockResolvedValue([{ id: 'group1@g.us', subject: 'Linked Group' }]),
    communityParticipantsUpdate: vi.fn().mockResolvedValue([{ status: '200', jid: '111@s.whatsapp.net' }]),
    communityInviteCode: vi.fn().mockResolvedValue('COMM123'),
    communitySettingUpdate: vi.fn().mockResolvedValue(undefined),
    communityFetchAllParticipating: vi.fn().mockResolvedValue({
      'community1@g.us': { id: 'community1@g.us', subject: 'Test Community' },
    }),
    communityUpdateSubject: vi.fn().mockResolvedValue(undefined),
    communityUpdateDescription: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('community tools', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerCommunityTools(() => mockSock, (tool) => registry.register(tool));
  });

  const globalTools = [
    'community_metadata',
    'community_create',
    'community_create_group',
    'community_leave',
    'community_link_group',
    'community_unlink_group',
    'community_fetch_linked_groups',
    'community_participants_update',
    'community_invite_code',
    'community_settings_update',
    'community_fetch_all_participating',
    'community_update_metadata',
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
    const result = await registry.call(name, { jid: 'community1@g.us' }, chatSession('111'));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  // --- community_metadata ---

  describe('community_metadata', () => {
    it('calls communityMetadata with the jid', async () => {
      const result = await registry.call(
        'community_metadata',
        { jid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityMetadata).toHaveBeenCalledWith('community1@g.us');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerCommunityTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('community_metadata', { jid: 'community1@g.us' }, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- community_create ---

  describe('community_create', () => {
    it('calls communityCreate with subject and body', async () => {
      const result = await registry.call(
        'community_create',
        { subject: 'My Community', body: 'Welcome!' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityCreate).toHaveBeenCalledWith('My Community', 'Welcome!');
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerCommunityTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'community_create',
        { subject: 'My Community', body: 'Welcome!' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- community_create_group ---

  describe('community_create_group', () => {
    it('calls communityCreateGroup with subject, participants, and parentJid', async () => {
      const result = await registry.call(
        'community_create_group',
        {
          subject: 'Sub Group',
          participants: ['111@s.whatsapp.net'],
          parentJid: 'community1@g.us',
        },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityCreateGroup).toHaveBeenCalledWith(
        'Sub Group',
        ['111@s.whatsapp.net'],
        'community1@g.us',
      );
    });
  });

  // --- community_leave ---

  describe('community_leave', () => {
    it('calls communityLeave with the id', async () => {
      const result = await registry.call(
        'community_leave',
        { id: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityLeave).toHaveBeenCalledWith('community1@g.us');
    });

    it('returns success with id', async () => {
      const result = await registry.call(
        'community_leave',
        { id: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { success: boolean; id: string };
      expect(data.success).toBe(true);
      expect(data.id).toBe('community1@g.us');
    });
  });

  // --- community_link_group ---

  describe('community_link_group', () => {
    it('calls communityLinkGroup with groupJid and communityJid', async () => {
      const result = await registry.call(
        'community_link_group',
        { groupJid: 'group1@g.us', communityJid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityLinkGroup).toHaveBeenCalledWith('group1@g.us', 'community1@g.us');
    });
  });

  // --- community_unlink_group ---

  describe('community_unlink_group', () => {
    it('calls communityUnlinkGroup with groupJid and communityJid', async () => {
      const result = await registry.call(
        'community_unlink_group',
        { groupJid: 'group1@g.us', communityJid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityUnlinkGroup).toHaveBeenCalledWith('group1@g.us', 'community1@g.us');
    });
  });

  // --- community_fetch_linked_groups ---

  describe('community_fetch_linked_groups', () => {
    it('calls communityFetchLinkedGroups with the jid', async () => {
      const result = await registry.call(
        'community_fetch_linked_groups',
        { jid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityFetchLinkedGroups).toHaveBeenCalledWith('community1@g.us');
    });
  });

  // --- community_participants_update ---

  describe('community_participants_update', () => {
    it('calls communityParticipantsUpdate with add action', async () => {
      const result = await registry.call(
        'community_participants_update',
        { jid: 'community1@g.us', participants: ['111@s.whatsapp.net'], action: 'add' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityParticipantsUpdate).toHaveBeenCalledWith(
        'community1@g.us',
        ['111@s.whatsapp.net'],
        'add',
      );
    });

    it('calls communityParticipantsUpdate with remove action', async () => {
      await registry.call(
        'community_participants_update',
        { jid: 'community1@g.us', participants: ['111@s.whatsapp.net'], action: 'remove' },
        globalSession(),
      );
      expect((mockSock as any).communityParticipantsUpdate).toHaveBeenCalledWith(
        'community1@g.us',
        ['111@s.whatsapp.net'],
        'remove',
      );
    });

    it('calls communityParticipantsUpdate with promote action', async () => {
      await registry.call(
        'community_participants_update',
        { jid: 'community1@g.us', participants: ['111@s.whatsapp.net'], action: 'promote' },
        globalSession(),
      );
      expect((mockSock as any).communityParticipantsUpdate).toHaveBeenCalledWith(
        'community1@g.us',
        ['111@s.whatsapp.net'],
        'promote',
      );
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'community_participants_update',
        { jid: 'community1@g.us', participants: ['111@s.whatsapp.net'], action: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- community_invite_code ---

  describe('community_invite_code', () => {
    it('returns formatted invite link', async () => {
      const result = await registry.call(
        'community_invite_code',
        { jid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text) as { inviteCode: string; inviteLink: string };
      expect(data.inviteCode).toBe('COMM123');
      expect(data.inviteLink).toBe('https://chat.whatsapp.com/COMM123');
    });

    it('calls communityInviteCode with the jid', async () => {
      await registry.call('community_invite_code', { jid: 'community1@g.us' }, globalSession());
      expect((mockSock as any).communityInviteCode).toHaveBeenCalledWith('community1@g.us');
    });

    it('returns null invite link when code is falsy', async () => {
      (mockSock as any).communityInviteCode = vi.fn().mockResolvedValue(null);
      const result = await registry.call(
        'community_invite_code',
        { jid: 'community1@g.us' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { inviteCode: null; inviteLink: null };
      expect(data.inviteCode).toBeNull();
      expect(data.inviteLink).toBeNull();
    });
  });

  // --- community_settings_update ---

  describe('community_settings_update', () => {
    it('calls communitySettingUpdate with announcement', async () => {
      const result = await registry.call(
        'community_settings_update',
        { jid: 'community1@g.us', setting: 'announcement' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communitySettingUpdate).toHaveBeenCalledWith('community1@g.us', 'announcement');
    });

    it('calls communitySettingUpdate with locked', async () => {
      await registry.call(
        'community_settings_update',
        { jid: 'community1@g.us', setting: 'locked' },
        globalSession(),
      );
      expect((mockSock as any).communitySettingUpdate).toHaveBeenCalledWith('community1@g.us', 'locked');
    });

    it('rejects invalid setting', async () => {
      const result = await registry.call(
        'community_settings_update',
        { jid: 'community1@g.us', setting: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- community_fetch_all_participating ---

  describe('community_fetch_all_participating', () => {
    it('calls communityFetchAllParticipating', async () => {
      const result = await registry.call('community_fetch_all_participating', {}, globalSession());
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityFetchAllParticipating).toHaveBeenCalled();
    });

    it('returns array of communities', async () => {
      const result = await registry.call('community_fetch_all_participating', {}, globalSession());
      const data = JSON.parse(result.content[0].text) as { communities: unknown[] };
      expect(Array.isArray(data.communities)).toBe(true);
      expect(data.communities).toHaveLength(1);
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerCommunityTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call('community_fetch_all_participating', {}, globalSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });

  // --- community_update_metadata ---

  describe('community_update_metadata', () => {
    it('calls communityUpdateSubject when subject is provided', async () => {
      const result = await registry.call(
        'community_update_metadata',
        { jid: 'community1@g.us', subject: 'New Name' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityUpdateSubject).toHaveBeenCalledWith('community1@g.us', 'New Name');
      expect((mockSock as any).communityUpdateDescription).not.toHaveBeenCalled();
    });

    it('calls communityUpdateDescription when description is provided', async () => {
      const result = await registry.call(
        'community_update_metadata',
        { jid: 'community1@g.us', description: 'New description' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityUpdateDescription).toHaveBeenCalledWith('community1@g.us', 'New description');
      expect((mockSock as any).communityUpdateSubject).not.toHaveBeenCalled();
    });

    it('calls both methods when both fields are provided', async () => {
      const result = await registry.call(
        'community_update_metadata',
        { jid: 'community1@g.us', subject: 'New Name', description: 'New description' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityUpdateSubject).toHaveBeenCalledWith('community1@g.us', 'New Name');
      expect((mockSock as any).communityUpdateDescription).toHaveBeenCalledWith('community1@g.us', 'New description');
    });

    it('succeeds with neither subject nor description (no-op)', async () => {
      const result = await registry.call(
        'community_update_metadata',
        { jid: 'community1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).communityUpdateSubject).not.toHaveBeenCalled();
      expect((mockSock as any).communityUpdateDescription).not.toHaveBeenCalled();
    });

    it('errors when sock is null', async () => {
      const nullRegistry = new ToolRegistry();
      registerCommunityTools(() => null, (tool) => nullRegistry.register(tool));
      const result = await nullRegistry.call(
        'community_update_metadata',
        { jid: 'community1@g.us', subject: 'New Name' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/);
    });
  });
});
