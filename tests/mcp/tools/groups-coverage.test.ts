// DRAFT — intended repo path: tests/mcp/tools/groups.test.ts (EXTEND existing file)
// These tests target the 4 uncovered branches in src/mcp/tools/groups.ts:
//
//   branch 0[1] line 97: code is falsy → ternary → null (get_group_invite_link when code=null)
//   branch 1[1] line 98: code ?? null → right side → inviteCode=null (same case)
//   branch 2[1] line 134: newCode ?? null → right side → inviteCode=null (group_revoke_invite when newCode=null)
//   branch 3[1] line 146: groupJid ?? null → right side → groupJid=null (group_accept_invite when returns null)
//
// Merge these describe blocks into the existing groups.test.ts file.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerGroupTools } from '../../../src/mcp/tools/groups.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

function globalSession(): SessionContext {
  return { tier: 'global' };
}

function makeMockSock(): WhatsAppSocket {
  return {
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    groupMetadata: vi.fn().mockResolvedValue({ id: 'group1@g.us', subject: 'Test Group', participants: [] }),
    groupUpdateSubject: vi.fn().mockResolvedValue(undefined),
    groupUpdateDescription: vi.fn().mockResolvedValue(undefined),
    groupParticipantsUpdate: vi.fn().mockResolvedValue([]),
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
    groupRequestParticipantsList: vi.fn().mockResolvedValue([]),
    groupRequestParticipantsUpdate: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'msg1' } }),
    groupRevokeInviteV4: vi.fn().mockResolvedValue(undefined),
  } as unknown as WhatsAppSocket;
}

describe('group tools — null/falsy return coverage gaps', () => {
  let registry: ToolRegistry;
  let mockSock: WhatsAppSocket;

  beforeEach(() => {
    mockSock = makeMockSock();
    registry = new ToolRegistry();
    registerGroupTools(() => mockSock, (tool) => registry.register(tool));
  });

  // -----------------------------------------------------------------------
  // get_group_invite_link: sock.groupInviteCode returns null/undefined
  // Covers branch 0[1] (line 97) and branch 1[1] (line 98):
  //   const link = code ? `...` : null   → null arm
  //   return { ..., inviteCode: code ?? null, inviteLink: link }  → ?? null arm
  // -----------------------------------------------------------------------
  describe('get_group_invite_link', () => {
    it('returns null inviteCode and null inviteLink when groupInviteCode returns null', async () => {
      (mockSock.groupInviteCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const result = await registry.call(
        'get_group_invite_link',
        { jid: 'group1@g.us' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        jid: 'group1@g.us',
        inviteCode: null,
        inviteLink: null,
      });
    });

    it('returns null inviteCode and null inviteLink when groupInviteCode returns undefined', async () => {
      (mockSock.groupInviteCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      const result = await registry.call(
        'get_group_invite_link',
        { jid: 'group1@g.us' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        jid: 'group1@g.us',
        inviteCode: null,
        inviteLink: null,
      });
    });
  });

  // -----------------------------------------------------------------------
  // group_revoke_invite: sock.groupRevokeInvite returns null/undefined
  // Covers branch 2[1] (line 134):
  //   return { jid, inviteCode: newCode ?? null }  → ?? null arm
  // -----------------------------------------------------------------------
  describe('group_revoke_invite', () => {
    it('returns null inviteCode when groupRevokeInvite returns null', async () => {
      (mockSock as any).groupRevokeInvite.mockResolvedValueOnce(null);

      const result = await registry.call(
        'group_revoke_invite',
        { jid: 'group1@g.us' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        jid: 'group1@g.us',
        inviteCode: null,
      });
    });

    it('returns null inviteCode when groupRevokeInvite returns undefined', async () => {
      (mockSock as any).groupRevokeInvite.mockResolvedValueOnce(undefined);

      const result = await registry.call(
        'group_revoke_invite',
        { jid: 'group1@g.us' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        jid: 'group1@g.us',
        inviteCode: null,
      });
    });
  });

  // -----------------------------------------------------------------------
  // group_accept_invite: sock.groupAcceptInvite returns null/undefined
  // Covers branch 3[1] (line 146):
  //   return { code, groupJid: groupJid ?? null }  → ?? null arm
  // -----------------------------------------------------------------------
  describe('group_accept_invite', () => {
    it('returns null groupJid when groupAcceptInvite returns null', async () => {
      (mockSock as any).groupAcceptInvite.mockResolvedValueOnce(null);

      const result = await registry.call(
        'group_accept_invite',
        { code: 'SOMECODE' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: 'SOMECODE',
        groupJid: null,
      });
    });

    it('returns null groupJid when groupAcceptInvite returns undefined', async () => {
      (mockSock as any).groupAcceptInvite.mockResolvedValueOnce(undefined);

      const result = await registry.call(
        'group_accept_invite',
        { code: 'SOMECODE' },
        globalSession(),
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({
        code: 'SOMECODE',
        groupJid: null,
      });
    });
  });
});
