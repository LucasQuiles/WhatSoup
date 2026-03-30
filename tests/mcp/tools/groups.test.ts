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
    groupCreate: vi.fn().mockResolvedValue({ id: 'newgroup@g.us', subject: 'New Group', participants: [] }),
    groupLeave: vi.fn().mockResolvedValue(undefined),
    groupRevokeInvite: vi.fn().mockResolvedValue('NEWCODE456'),
    groupAcceptInvite: vi.fn().mockResolvedValue('group2@g.us'),
    groupGetInviteInfo: vi.fn().mockResolvedValue({ id: 'group3@g.us', subject: 'Preview Group', participants: [] }),
    groupToggleEphemeral: vi.fn().mockResolvedValue(undefined),
    groupMemberAddMode: vi.fn().mockResolvedValue(undefined),
    groupJoinApprovalMode: vi.fn().mockResolvedValue(undefined),
    groupRequestParticipantsList: vi.fn().mockResolvedValue([{ jid: '111@s.whatsapp.net' }]),
    groupRequestParticipantsUpdate: vi.fn().mockResolvedValue([{ status: '200', jid: '111@s.whatsapp.net' }]),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    groupRevokeInviteV4: vi.fn().mockResolvedValue(undefined),
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
    'group_create',
    'group_leave',
    'group_revoke_invite',
    'group_accept_invite',
    'group_get_invite_info',
    'group_toggle_ephemeral',
    'group_member_add_mode',
    'group_join_approval_mode',
    'group_request_participants_list',
    'group_request_participants_update',
    'group_revoke_invite_v4',
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

  // --- group_create ---

  describe('group_create', () => {
    it('calls sock.groupCreate with subject and participants', async () => {
      const result = await registry.call(
        'group_create',
        { subject: 'My Group', participants: ['111@s.whatsapp.net', '222@s.whatsapp.net'] },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupCreate).toHaveBeenCalledWith(
        'My Group',
        ['111@s.whatsapp.net', '222@s.whatsapp.net'],
      );
    });

    it('returns the created group metadata', async () => {
      const result = await registry.call(
        'group_create',
        { subject: 'My Group', participants: ['111@s.whatsapp.net'] },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { id: string; subject: string };
      expect(data.id).toBe('newgroup@g.us');
      expect(data.subject).toBe('New Group');
    });
  });

  // --- group_leave ---

  describe('group_leave', () => {
    it('calls sock.groupLeave with the group id', async () => {
      const result = await registry.call(
        'group_leave',
        { id: 'group1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupLeave).toHaveBeenCalledWith('group1@g.us');
    });

    it('returns success with the id', async () => {
      const result = await registry.call(
        'group_leave',
        { id: 'group1@g.us' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; id: string };
      expect(data.success).toBe(true);
      expect(data.id).toBe('group1@g.us');
    });
  });

  // --- group_revoke_invite ---

  describe('group_revoke_invite', () => {
    it('calls sock.groupRevokeInvite with the jid', async () => {
      const result = await registry.call(
        'group_revoke_invite',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupRevokeInvite).toHaveBeenCalledWith('group1@g.us');
    });

    it('returns the new invite code', async () => {
      const result = await registry.call(
        'group_revoke_invite',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { inviteCode: string };
      expect(data.inviteCode).toBe('NEWCODE456');
    });
  });

  // --- group_accept_invite ---

  describe('group_accept_invite', () => {
    it('calls sock.groupAcceptInvite with the code', async () => {
      const result = await registry.call(
        'group_accept_invite',
        { code: 'INVITECODE' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupAcceptInvite).toHaveBeenCalledWith('INVITECODE');
    });

    it('returns the group jid', async () => {
      const result = await registry.call(
        'group_accept_invite',
        { code: 'INVITECODE' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { groupJid: string };
      expect(data.groupJid).toBe('group2@g.us');
    });
  });

  // --- group_get_invite_info ---

  describe('group_get_invite_info', () => {
    it('calls sock.groupGetInviteInfo with the code', async () => {
      const result = await registry.call(
        'group_get_invite_info',
        { code: 'PREVIEWCODE' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupGetInviteInfo).toHaveBeenCalledWith('PREVIEWCODE');
    });

    it('returns group metadata preview', async () => {
      const result = await registry.call(
        'group_get_invite_info',
        { code: 'PREVIEWCODE' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { id: string; subject: string };
      expect(data.id).toBe('group3@g.us');
      expect(data.subject).toBe('Preview Group');
    });
  });

  // --- group_toggle_ephemeral ---

  describe('group_toggle_ephemeral', () => {
    it('calls sock.groupToggleEphemeral with jid and expiration', async () => {
      const result = await registry.call(
        'group_toggle_ephemeral',
        { jid: 'group1@g.us', expiration: 86400 },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupToggleEphemeral).toHaveBeenCalledWith('group1@g.us', 86400);
    });

    it('disables ephemeral with expiration 0', async () => {
      await registry.call(
        'group_toggle_ephemeral',
        { jid: 'group1@g.us', expiration: 0 },
        globalSession(),
      );
      expect((mockSock as any).groupToggleEphemeral).toHaveBeenCalledWith('group1@g.us', 0);
    });
  });

  // --- group_member_add_mode ---

  describe('group_member_add_mode', () => {
    it('calls sock.groupMemberAddMode with all_member_add', async () => {
      const result = await registry.call(
        'group_member_add_mode',
        { jid: 'group1@g.us', mode: 'all_member_add' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupMemberAddMode).toHaveBeenCalledWith('group1@g.us', 'all_member_add');
    });

    it('calls sock.groupMemberAddMode with admin_add', async () => {
      await registry.call(
        'group_member_add_mode',
        { jid: 'group1@g.us', mode: 'admin_add' },
        globalSession(),
      );
      expect((mockSock as any).groupMemberAddMode).toHaveBeenCalledWith('group1@g.us', 'admin_add');
    });

    it('rejects invalid mode', async () => {
      const result = await registry.call(
        'group_member_add_mode',
        { jid: 'group1@g.us', mode: 'invalid' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- group_join_approval_mode ---

  describe('group_join_approval_mode', () => {
    it('calls sock.groupJoinApprovalMode with on', async () => {
      const result = await registry.call(
        'group_join_approval_mode',
        { jid: 'group1@g.us', mode: 'on' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupJoinApprovalMode).toHaveBeenCalledWith('group1@g.us', 'on');
    });

    it('calls sock.groupJoinApprovalMode with off', async () => {
      await registry.call(
        'group_join_approval_mode',
        { jid: 'group1@g.us', mode: 'off' },
        globalSession(),
      );
      expect((mockSock as any).groupJoinApprovalMode).toHaveBeenCalledWith('group1@g.us', 'off');
    });

    it('rejects invalid mode', async () => {
      const result = await registry.call(
        'group_join_approval_mode',
        { jid: 'group1@g.us', mode: 'maybe' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- group_request_participants_list ---

  describe('group_request_participants_list', () => {
    it('calls sock.groupRequestParticipantsList with the jid', async () => {
      const result = await registry.call(
        'group_request_participants_list',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupRequestParticipantsList).toHaveBeenCalledWith('group1@g.us');
    });

    it('returns the participants list', async () => {
      const result = await registry.call(
        'group_request_participants_list',
        { jid: 'group1@g.us' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { participants: unknown[] };
      expect(Array.isArray(data.participants)).toBe(true);
      expect(data.participants).toHaveLength(1);
    });
  });

  // --- group_request_participants_update ---

  describe('group_request_participants_update', () => {
    it('calls sock.groupRequestParticipantsUpdate with approve', async () => {
      const result = await registry.call(
        'group_request_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'approve' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupRequestParticipantsUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        ['111@s.whatsapp.net'],
        'approve',
      );
    });

    it('calls sock.groupRequestParticipantsUpdate with reject', async () => {
      await registry.call(
        'group_request_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'reject' },
        globalSession(),
      );
      expect((mockSock as any).groupRequestParticipantsUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        ['111@s.whatsapp.net'],
        'reject',
      );
    });

    it('rejects invalid action', async () => {
      const result = await registry.call(
        'group_request_participants_update',
        { jid: 'group1@g.us', participants: ['111@s.whatsapp.net'], action: 'ban' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
    });
  });

  // --- send_group_invite ---

  describe('send_group_invite', () => {
    it('is visible in chat-scoped session', () => {
      const tools = registry.listTools(chatSession('111'));
      expect(tools.find((t) => t.name === 'send_group_invite')).toBeDefined();
    });

    it('is visible in global session', () => {
      const tools = registry.listTools(globalSession());
      expect(tools.find((t) => t.name === 'send_group_invite')).toBeDefined();
    });

    it('calls sock.sendMessage with groupInvite payload in chat-scoped session', async () => {
      const result = await registry.call(
        'send_group_invite',
        { groupJid: 'group1@g.us', inviteCode: 'CODE123', inviteExpiration: 1234567890, groupName: 'Test' },
        chatSession('111'),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith(
        '111@s.whatsapp.net',
        expect.objectContaining({
          groupInvite: expect.objectContaining({
            groupJid: 'group1@g.us',
            inviteCode: 'CODE123',
          }),
        }),
      );
    });

    it('calls sock.sendMessage with chatJid in global session', async () => {
      const result = await registry.call(
        'send_group_invite',
        {
          chatJid: 'recipient@s.whatsapp.net',
          groupJid: 'group1@g.us',
          inviteCode: 'CODE123',
          inviteExpiration: 1234567890,
          groupName: 'Test',
        },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith(
        'recipient@s.whatsapp.net',
        expect.objectContaining({ groupInvite: expect.anything() }),
      );
    });

    it('includes optional caption and jpegThumbnail when provided', async () => {
      await registry.call(
        'send_group_invite',
        {
          groupJid: 'group1@g.us',
          inviteCode: 'CODE123',
          inviteExpiration: 1234567890,
          groupName: 'Test',
          caption: 'Join us!',
          jpegThumbnail: 'base64data',
        },
        chatSession('111'),
      );
      expect((mockSock as any).sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          groupInvite: expect.objectContaining({
            caption: 'Join us!',
            jpegThumbnail: 'base64data',
          }),
        }),
      );
    });

    it('fails in global session without chatJid', async () => {
      const result = await registry.call(
        'send_group_invite',
        { groupJid: 'group1@g.us', inviteCode: 'CODE123', inviteExpiration: 1234567890, groupName: 'Test' },
        globalSession(),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/requires chatJid/);
    });
  });

  // --- group_revoke_invite_v4 ---

  describe('group_revoke_invite_v4', () => {
    it('calls sock.groupRevokeInviteV4 with groupJid and invitedJid', async () => {
      const result = await registry.call(
        'group_revoke_invite_v4',
        { groupJid: 'group1@g.us', invitedJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      expect(result.isError).toBeUndefined();
      expect((mockSock as any).groupRevokeInviteV4).toHaveBeenCalledWith(
        'group1@g.us',
        '111@s.whatsapp.net',
      );
    });

    it('returns success with both jids', async () => {
      const result = await registry.call(
        'group_revoke_invite_v4',
        { groupJid: 'group1@g.us', invitedJid: '111@s.whatsapp.net' },
        globalSession(),
      );
      const data = JSON.parse(result.content[0].text) as { success: boolean; groupJid: string; invitedJid: string };
      expect(data.success).toBe(true);
      expect(data.groupJid).toBe('group1@g.us');
      expect(data.invitedJid).toBe('111@s.whatsapp.net');
    });

    it('is rejected in chat-scoped session', async () => {
      const result = await registry.call(
        'group_revoke_invite_v4',
        { groupJid: 'group1@g.us', invitedJid: '111@s.whatsapp.net' },
        chatSession('111'),
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
    });
  });
});
