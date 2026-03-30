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
    handler: async () => {
      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      // fetchAllGroups returns GroupMetadata[]
      const groups = await (sock as any).fetchAllGroups?.() ?? [];
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
}
