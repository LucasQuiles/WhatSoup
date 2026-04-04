// src/mcp/tools/groups.ts
// Group management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const groupConfigs: SockToolConfig<any>[] = [
  {
    name: 'list_groups',
    description: 'List all WhatsApp groups the bot is a member of (global).',
    schema: z.object({}),
    replayPolicy: 'read_only',
    call: async (_parsed, sock) => {
      // groupFetchAllParticipating returns Record<string, GroupMetadata>
      const groupMap = await sock.groupFetchAllParticipating();
      return { groups: Object.values(groupMap) };
    },
  },
  {
    name: 'get_group_metadata',
    description: 'Get metadata for a WhatsApp group by JID (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      return sock.groupMetadata(jid);
    },
  },
  {
    name: 'group_update_subject',
    description: "Update a WhatsApp group's subject (name) (global).",
    schema: z.object({
      jid: z.string(),
      subject: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, subject }, sock) => {
      await sock.groupUpdateSubject(jid, subject);
      return { success: true, jid, subject };
    },
  },
  {
    name: 'group_update_description',
    description: "Update a WhatsApp group's description (global). Omit description to clear it.",
    schema: z.object({
      jid: z.string(),
      description: z.string().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, description }, sock) => {
      await sock.groupUpdateDescription(jid, description);
      return { success: true, jid };
    },
  },
  {
    name: 'group_participants_update',
    description:
      'Add, remove, promote, or demote participants in a WhatsApp group (global).',
    schema: z.object({
      jid: z.string(),
      participants: z.array(z.string()),
      action: z.enum(['add', 'remove', 'promote', 'demote']),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, participants, action }, sock) => {
      const result = await sock.groupParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  },
  {
    name: 'group_settings_update',
    description:
      'Update WhatsApp group settings: announcement mode (only admins can send) or locked (only admins can edit info) (global).',
    schema: z.object({
      jid: z.string(),
      setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, setting }, sock) => {
      await sock.groupSettingUpdate(jid, setting);
      return { success: true, jid, setting };
    },
  },
  {
    name: 'get_group_invite_link',
    description: 'Get the invite link for a WhatsApp group (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      const code = await sock.groupInviteCode(jid);
      const link = code ? `https://chat.whatsapp.com/${code}` : null;
      return { jid, inviteCode: code ?? null, inviteLink: link };
    },
  },
  {
    name: 'group_create',
    description: 'Create a new WhatsApp group with a given subject and initial participants (global).',
    schema: z.object({
      subject: z.string(),
      participants: z.array(z.string()),
    }),
    replayPolicy: 'unsafe',
    call: async ({ subject, participants }, sock) => {
      return sock.groupCreate(subject, participants);
    },
  },
  {
    name: 'group_leave',
    description: 'Leave a WhatsApp group (global).',
    schema: z.object({
      id: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ id }, sock) => {
      await sock.groupLeave(id);
      return { success: true, id };
    },
  },
  {
    name: 'group_revoke_invite',
    description: 'Revoke the invite link for a WhatsApp group and return the new invite code (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid }, sock) => {
      const newCode = await sock.groupRevokeInvite(jid);
      return { jid, inviteCode: newCode ?? null };
    },
  },
  {
    name: 'group_accept_invite',
    description: 'Accept a WhatsApp group invite by code and return the group JID (global).',
    schema: z.object({
      code: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ code }, sock) => {
      const groupJid = await sock.groupAcceptInvite(code);
      return { code, groupJid: groupJid ?? null };
    },
  },
  {
    name: 'group_get_invite_info',
    description: 'Get group metadata preview from a WhatsApp group invite code (global).',
    schema: z.object({
      code: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ code }, sock) => {
      return sock.groupGetInviteInfo(code);
    },
  },
  {
    name: 'group_toggle_ephemeral',
    description:
      'Enable or disable disappearing messages in a WhatsApp group (global). Pass expiration in seconds (0 = off).',
    schema: z.object({
      jid: z.string(),
      expiration: z.number(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, expiration }, sock) => {
      await sock.groupToggleEphemeral(jid, expiration);
      return { success: true, jid, expiration };
    },
  },
  {
    name: 'group_member_add_mode',
    description:
      "Set whether all members or only admins can add participants to a WhatsApp group (global). Mode: 'all_member_add' or 'admin_add'.",
    schema: z.object({
      jid: z.string(),
      mode: z.enum(['all_member_add', 'admin_add']),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, mode }, sock) => {
      await sock.groupMemberAddMode(jid, mode);
      return { success: true, jid, mode };
    },
  },
  {
    name: 'group_join_approval_mode',
    description:
      "Enable or disable join approval (admin must approve new members) for a WhatsApp group (global). Mode: 'on' or 'off'.",
    schema: z.object({
      jid: z.string(),
      mode: z.enum(['on', 'off']),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, mode }, sock) => {
      await sock.groupJoinApprovalMode(jid, mode);
      return { success: true, jid, mode };
    },
  },
  {
    name: 'group_request_participants_list',
    description: 'Get the list of pending join requests for a WhatsApp group (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      const participants = await sock.groupRequestParticipantsList(jid);
      return { jid, participants };
    },
  },
  {
    name: 'group_request_participants_update',
    description:
      "Approve or reject pending join requests for a WhatsApp group (global). Action: 'approve' or 'reject'.",
    schema: z.object({
      jid: z.string(),
      participants: z.array(z.string()),
      action: z.enum(['approve', 'reject']),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, participants, action }, sock) => {
      const result = await sock.groupRequestParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  },
  {
    name: 'send_group_invite',
    description:
      'Send a group invite message to a chat. Works in both chat-scoped and global sessions (chatJid required in global sessions).',
    schema: z.object({
      chatJid: z.string().optional(),
      groupJid: z.string(),
      inviteCode: z.string(),
      inviteExpiration: z.number(),
      groupName: z.string(),
      jpegThumbnail: z.string().optional(),
      caption: z.string().optional(),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, groupJid, inviteCode, inviteExpiration, groupName, jpegThumbnail, caption }, sock) => {
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

      return sock.sendMessage(jid, { groupInvite } as any);
    },
  },
  {
    name: 'group_revoke_invite_v4',
    description:
      'Revoke a v4 group invite previously sent to a specific participant (global).',
    schema: z.object({
      groupJid: z.string(),
      invitedJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ groupJid, invitedJid }, sock) => {
      await sock.groupRevokeInviteV4(groupJid, invitedJid);
      return { success: true, groupJid, invitedJid };
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerGroupTools(
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, groupConfigs, register);
}
