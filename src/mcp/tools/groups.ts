// src/mcp/tools/groups.ts
// Group management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';

// ---------------------------------------------------------------------------
// list_groups
// ---------------------------------------------------------------------------

const ListGroupsSchema = z.object({});

function makeListGroups(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'list_groups',
    description: 'List all WhatsApp groups the bot is a member of (global).',
    schema: ListGroupsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async () => {
      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      // groupFetchAllParticipating returns Record<string, GroupMetadata>
      const groupMap = await sock.groupFetchAllParticipating();
      const groups = Object.values(groupMap);
      return { groups };
    },
  };
}

// ---------------------------------------------------------------------------
// get_group_metadata
// ---------------------------------------------------------------------------

const GetGroupMetadataSchema = z.object({
  jid: z.string(),
});

function makeGetGroupMetadata(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_group_metadata',
    description: 'Get metadata for a WhatsApp group by JID (global).',
    schema: GetGroupMetadataSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = GetGroupMetadataSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const metadata = await sock.groupMetadata(jid);
      return metadata;
    },
  };
}

// ---------------------------------------------------------------------------
// group_update_subject
// ---------------------------------------------------------------------------

const GroupUpdateSubjectSchema = z.object({
  jid: z.string(),
  subject: z.string(),
});

function makeGroupUpdateSubject(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_update_subject',
    description: "Update a WhatsApp group's subject (name) (global).",
    schema: GroupUpdateSubjectSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, subject } = GroupUpdateSubjectSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupUpdateSubject(jid, subject);
      return { success: true, jid, subject };
    },
  };
}

// ---------------------------------------------------------------------------
// group_update_description
// ---------------------------------------------------------------------------

const GroupUpdateDescriptionSchema = z.object({
  jid: z.string(),
  description: z.string().optional(),
});

function makeGroupUpdateDescription(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_update_description',
    description: "Update a WhatsApp group's description (global). Omit description to clear it.",
    schema: GroupUpdateDescriptionSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, description } = GroupUpdateDescriptionSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupUpdateDescription(jid, description);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// group_participants_update
// ---------------------------------------------------------------------------

const GroupParticipantsUpdateSchema = z.object({
  jid: z.string(),
  participants: z.array(z.string()),
  action: z.enum(['add', 'remove', 'promote', 'demote']),
});

function makeGroupParticipantsUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_participants_update',
    description:
      'Add, remove, promote, or demote participants in a WhatsApp group (global).',
    schema: GroupParticipantsUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, participants, action } = GroupParticipantsUpdateSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const result = await sock.groupParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  };
}

// ---------------------------------------------------------------------------
// group_settings_update
// ---------------------------------------------------------------------------

const GroupSettingsUpdateSchema = z.object({
  jid: z.string(),
  setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']),
});

function makeGroupSettingsUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_settings_update',
    description:
      'Update WhatsApp group settings: announcement mode (only admins can send) or locked (only admins can edit info) (global).',
    schema: GroupSettingsUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, setting } = GroupSettingsUpdateSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupSettingUpdate(jid, setting);
      return { success: true, jid, setting };
    },
  };
}

// ---------------------------------------------------------------------------
// get_group_invite_link
// ---------------------------------------------------------------------------

const GetGroupInviteLinkSchema = z.object({
  jid: z.string(),
});

function makeGetGroupInviteLink(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_group_invite_link',
    description: 'Get the invite link for a WhatsApp group (global).',
    schema: GetGroupInviteLinkSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = GetGroupInviteLinkSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const code = await sock.groupInviteCode(jid);
      const link = code ? `https://chat.whatsapp.com/${code}` : null;
      return { jid, inviteCode: code ?? null, inviteLink: link };
    },
  };
}

// ---------------------------------------------------------------------------
// group_create
// ---------------------------------------------------------------------------

const GroupCreateSchema = z.object({
  subject: z.string(),
  participants: z.array(z.string()),
});

function makeGroupCreate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_create',
    description: 'Create a new WhatsApp group with a given subject and initial participants (global).',
    schema: GroupCreateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { subject, participants } = GroupCreateSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const result = await sock.groupCreate(subject, participants);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// group_leave
// ---------------------------------------------------------------------------

const GroupLeaveSchema = z.object({
  id: z.string(),
});

function makeGroupLeave(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_leave',
    description: 'Leave a WhatsApp group (global).',
    schema: GroupLeaveSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { id } = GroupLeaveSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupLeave(id);
      return { success: true, id };
    },
  };
}

// ---------------------------------------------------------------------------
// group_revoke_invite
// ---------------------------------------------------------------------------

const GroupRevokeInviteSchema = z.object({
  jid: z.string(),
});

function makeGroupRevokeInvite(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_revoke_invite',
    description: 'Revoke the invite link for a WhatsApp group and return the new invite code (global).',
    schema: GroupRevokeInviteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid } = GroupRevokeInviteSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const newCode = await sock.groupRevokeInvite(jid);
      return { jid, inviteCode: newCode ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// group_accept_invite
// ---------------------------------------------------------------------------

const GroupAcceptInviteSchema = z.object({
  code: z.string(),
});

function makeGroupAcceptInvite(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_accept_invite',
    description: 'Accept a WhatsApp group invite by code and return the group JID (global).',
    schema: GroupAcceptInviteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { code } = GroupAcceptInviteSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const groupJid = await sock.groupAcceptInvite(code);
      return { code, groupJid: groupJid ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// group_get_invite_info
// ---------------------------------------------------------------------------

const GroupGetInviteInfoSchema = z.object({
  code: z.string(),
});

function makeGroupGetInviteInfo(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_get_invite_info',
    description: 'Get group metadata preview from a WhatsApp group invite code (global).',
    schema: GroupGetInviteInfoSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { code } = GroupGetInviteInfoSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const metadata = await sock.groupGetInviteInfo(code);
      return metadata;
    },
  };
}

// ---------------------------------------------------------------------------
// group_toggle_ephemeral
// ---------------------------------------------------------------------------

const GroupToggleEphemeralSchema = z.object({
  jid: z.string(),
  expiration: z.number(),
});

function makeGroupToggleEphemeral(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_toggle_ephemeral',
    description:
      'Enable or disable disappearing messages in a WhatsApp group (global). Pass expiration in seconds (0 = off).',
    schema: GroupToggleEphemeralSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, expiration } = GroupToggleEphemeralSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupToggleEphemeral(jid, expiration);
      return { success: true, jid, expiration };
    },
  };
}

// ---------------------------------------------------------------------------
// group_member_add_mode
// ---------------------------------------------------------------------------

const GroupMemberAddModeSchema = z.object({
  jid: z.string(),
  mode: z.enum(['all_member_add', 'admin_add']),
});

function makeGroupMemberAddMode(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_member_add_mode',
    description:
      "Set whether all members or only admins can add participants to a WhatsApp group (global). Mode: 'all_member_add' or 'admin_add'.",
    schema: GroupMemberAddModeSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, mode } = GroupMemberAddModeSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupMemberAddMode(jid, mode);
      return { success: true, jid, mode };
    },
  };
}

// ---------------------------------------------------------------------------
// group_join_approval_mode
// ---------------------------------------------------------------------------

const GroupJoinApprovalModeSchema = z.object({
  jid: z.string(),
  mode: z.enum(['on', 'off']),
});

function makeGroupJoinApprovalMode(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_join_approval_mode',
    description:
      "Enable or disable join approval (admin must approve new members) for a WhatsApp group (global). Mode: 'on' or 'off'.",
    schema: GroupJoinApprovalModeSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, mode } = GroupJoinApprovalModeSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupJoinApprovalMode(jid, mode);
      return { success: true, jid, mode };
    },
  };
}

// ---------------------------------------------------------------------------
// group_request_participants_list
// ---------------------------------------------------------------------------

const GroupRequestParticipantsListSchema = z.object({
  jid: z.string(),
});

function makeGroupRequestParticipantsList(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_request_participants_list',
    description: 'Get the list of pending join requests for a WhatsApp group (global).',
    schema: GroupRequestParticipantsListSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = GroupRequestParticipantsListSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const participants = await sock.groupRequestParticipantsList(jid);
      return { jid, participants };
    },
  };
}

// ---------------------------------------------------------------------------
// group_request_participants_update
// ---------------------------------------------------------------------------

const GroupRequestParticipantsUpdateSchema = z.object({
  jid: z.string(),
  participants: z.array(z.string()),
  action: z.enum(['approve', 'reject']),
});

function makeGroupRequestParticipantsUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_request_participants_update',
    description:
      "Approve or reject pending join requests for a WhatsApp group (global). Action: 'approve' or 'reject'.",
    schema: GroupRequestParticipantsUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, participants, action } = GroupRequestParticipantsUpdateSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const result = await sock.groupRequestParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  };
}

// ---------------------------------------------------------------------------
// send_group_invite
// ---------------------------------------------------------------------------

const SendGroupInviteSchema = z.object({
  chatJid: z.string().optional(),
  groupJid: z.string(),
  inviteCode: z.string(),
  inviteExpiration: z.number(),
  groupName: z.string(),
  jpegThumbnail: z.string().optional(),
  caption: z.string().optional(),
});

function makeSendGroupInvite(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_group_invite',
    description:
      'Send a group invite message to a chat. Works in both chat-scoped and global sessions (chatJid required in global sessions).',
    schema: SendGroupInviteSchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { chatJid, groupJid, inviteCode, inviteExpiration, groupName, jpegThumbnail, caption } =
        SendGroupInviteSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const jid = chatJid!;
      const groupInvite: Record<string, unknown> = {
        groupJid,
        inviteCode,
        inviteExpiration,
        groupName,
      };
      if (jpegThumbnail !== undefined) {
        groupInvite.jpegThumbnail = jpegThumbnail;
      }
      if (caption !== undefined) {
        groupInvite.caption = caption;
      }

      const result = await sock.sendMessage(jid, { groupInvite } as any);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// group_revoke_invite_v4
// ---------------------------------------------------------------------------

const GroupRevokeInviteV4Schema = z.object({
  groupJid: z.string(),
  invitedJid: z.string(),
});

function makeGroupRevokeInviteV4(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'group_revoke_invite_v4',
    description:
      'Revoke a v4 group invite previously sent to a specific participant (global).',
    schema: GroupRevokeInviteV4Schema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { groupJid, invitedJid } = GroupRevokeInviteV4Schema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.groupRevokeInviteV4(groupJid, invitedJid);
      return { success: true, groupJid, invitedJid };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerGroupTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeListGroups(getSock));
  register(makeGetGroupMetadata(getSock));
  register(makeGroupUpdateSubject(getSock));
  register(makeGroupUpdateDescription(getSock));
  register(makeGroupParticipantsUpdate(getSock));
  register(makeGroupSettingsUpdate(getSock));
  register(makeGetGroupInviteLink(getSock));
  register(makeGroupCreate(getSock));
  register(makeGroupLeave(getSock));
  register(makeGroupRevokeInvite(getSock));
  register(makeGroupAcceptInvite(getSock));
  register(makeGroupGetInviteInfo(getSock));
  register(makeGroupToggleEphemeral(getSock));
  register(makeGroupMemberAddMode(getSock));
  register(makeGroupJoinApprovalMode(getSock));
  register(makeGroupRequestParticipantsList(getSock));
  register(makeGroupRequestParticipantsUpdate(getSock));
  register(makeSendGroupInvite(getSock));
  register(makeGroupRevokeInviteV4(getSock));
}
