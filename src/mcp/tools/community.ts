// src/mcp/tools/community.ts
// Community management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';

// ---------------------------------------------------------------------------
// community_metadata
// ---------------------------------------------------------------------------

const CommunityMetadataSchema = z.object({
  jid: z.string(),
});

function makeCommunityMetadata(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_metadata',
    description: 'Get metadata for a WhatsApp community by JID (global).',
    schema: CommunityMetadataSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = CommunityMetadataSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityMetadata(jid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_create
// ---------------------------------------------------------------------------

const CommunityCreateSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

function makeCommunityCreate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_create',
    description: 'Create a new WhatsApp community with the given subject and description body (global).',
    schema: CommunityCreateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { subject, body } = CommunityCreateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityCreate(subject, body);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_create_group
// ---------------------------------------------------------------------------

const CommunityCreateGroupSchema = z.object({
  subject: z.string(),
  participants: z.array(z.string()),
  parentJid: z.string(),
});

function makeCommunityCreateGroup(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_create_group',
    description: 'Create a new group within a community (global).',
    schema: CommunityCreateGroupSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { subject, participants, parentJid } = CommunityCreateGroupSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityCreateGroup(subject, participants, parentJid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_leave
// ---------------------------------------------------------------------------

const CommunityLeaveSchema = z.object({
  id: z.string(),
});

function makeCommunityLeave(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_leave',
    description: 'Leave a WhatsApp community (global).',
    schema: CommunityLeaveSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { id } = CommunityLeaveSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).communityLeave(id);
      return { success: true, id };
    },
  };
}

// ---------------------------------------------------------------------------
// community_link_group
// ---------------------------------------------------------------------------

const CommunityLinkGroupSchema = z.object({
  groupJid: z.string(),
  communityJid: z.string(),
});

function makeCommunityLinkGroup(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_link_group',
    description: 'Link an existing group into a community (global).',
    schema: CommunityLinkGroupSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { groupJid, communityJid } = CommunityLinkGroupSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityLinkGroup(groupJid, communityJid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_unlink_group
// ---------------------------------------------------------------------------

const CommunityUnlinkGroupSchema = z.object({
  groupJid: z.string(),
  communityJid: z.string(),
});

function makeCommunityUnlinkGroup(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_unlink_group',
    description: 'Unlink a group from a community (global).',
    schema: CommunityUnlinkGroupSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { groupJid, communityJid } = CommunityUnlinkGroupSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityUnlinkGroup(groupJid, communityJid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_fetch_linked_groups
// ---------------------------------------------------------------------------

const CommunityFetchLinkedGroupsSchema = z.object({
  jid: z.string(),
});

function makeCommunityFetchLinkedGroups(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_fetch_linked_groups',
    description: 'Fetch all groups linked to a community by JID (global).',
    schema: CommunityFetchLinkedGroupsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = CommunityFetchLinkedGroupsSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityFetchLinkedGroups(jid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// community_participants_update
// ---------------------------------------------------------------------------

const CommunityParticipantsUpdateSchema = z.object({
  jid: z.string(),
  participants: z.array(z.string()),
  action: z.enum(['add', 'remove', 'promote', 'demote']),
});

function makeCommunityParticipantsUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_participants_update',
    description: 'Add, remove, promote, or demote participants in a WhatsApp community (global).',
    schema: CommunityParticipantsUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, participants, action } = CommunityParticipantsUpdateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).communityParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  };
}

// ---------------------------------------------------------------------------
// community_invite_code — get, revoke, or accept a community invite
// ---------------------------------------------------------------------------

const CommunityInviteCodeSchema = z.object({
  jid: z.string().describe('Community JID — required for get and revoke actions; unused for accept'),
  action: z
    .enum(['get', 'revoke', 'accept'])
    .optional()
    .describe('get (default): fetch current invite code; revoke: rotate and return new code; accept: join via invite code'),
  code: z.string().optional().describe('Invite code — required for accept action'),
});

function makeCommunityInviteCode(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_invite_code',
    description:
      'Get, revoke, or accept a WhatsApp community invite. action=get (default) returns the current invite code; action=revoke rotates it and returns the new code; action=accept joins the community via an invite code (requires code param).',
    schema: CommunityInviteCodeSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    // revoke and accept are mutating — use the most conservative policy
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, action = 'get', code } = CommunityInviteCodeSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      if (action === 'get') {
        const inviteCode = await (sock as any).communityInviteCode(jid);
        const inviteLink = inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null;
        return { jid, inviteCode: inviteCode ?? null, inviteLink };
      }

      if (action === 'revoke') {
        const newCode = await (sock as any).communityRevokeInvite(jid);
        const inviteLink = newCode ? `https://chat.whatsapp.com/${newCode}` : null;
        return { jid, inviteCode: newCode ?? null, inviteLink, revoked: true };
      }

      // action === 'accept'
      if (!code) throw new Error('code is required for action=accept');
      const communityJid = await (sock as any).communityAcceptInvite(code);
      return { communityJid: communityJid ?? null, code, accepted: true };
    },
  };
}

// ---------------------------------------------------------------------------
// community_settings_update
// ---------------------------------------------------------------------------

const CommunitySettingsUpdateSchema = z.object({
  jid: z.string(),
  setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']),
});

function makeCommunitySettingsUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_settings_update',
    description:
      'Update WhatsApp community settings: announcement mode (only admins can send) or locked (only admins can edit info) (global).',
    schema: CommunitySettingsUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, setting } = CommunitySettingsUpdateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).communitySettingUpdate(jid, setting);
      return { success: true, jid, setting };
    },
  };
}

// ---------------------------------------------------------------------------
// community_fetch_all_participating
// ---------------------------------------------------------------------------

const CommunityFetchAllParticipatingSchema = z.object({});

function makeCommunityFetchAllParticipating(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_fetch_all_participating',
    description: 'Fetch all communities the bot is participating in (global).',
    schema: CommunityFetchAllParticipatingSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async () => {
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const communityMap = await (sock as any).communityFetchAllParticipating();
      const communities = Object.values(communityMap as Record<string, unknown>);
      return { communities };
    },
  };
}

// ---------------------------------------------------------------------------
// community_update_metadata
// ---------------------------------------------------------------------------

const CommunityUpdateMetadataSchema = z.object({
  jid: z.string(),
  subject: z.string().optional(),
  description: z.string().optional(),
});

function makeCommunityUpdateMetadata(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'community_update_metadata',
    description:
      "Update a WhatsApp community's subject and/or description. Provide at least one of subject or description (global).",
    schema: CommunityUpdateMetadataSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, subject, description } = CommunityUpdateMetadataSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      if (subject !== undefined) {
        await (sock as any).communityUpdateSubject(jid, subject);
      }
      if (description !== undefined) {
        await (sock as any).communityUpdateDescription(jid, description);
      }
      return { success: true, jid, subject, description };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerCommunityTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeCommunityMetadata(getSock));
  register(makeCommunityCreate(getSock));
  register(makeCommunityCreateGroup(getSock));
  register(makeCommunityLeave(getSock));
  register(makeCommunityLinkGroup(getSock));
  register(makeCommunityUnlinkGroup(getSock));
  register(makeCommunityFetchLinkedGroups(getSock));
  register(makeCommunityParticipantsUpdate(getSock));
  register(makeCommunityInviteCode(getSock));
  register(makeCommunitySettingsUpdate(getSock));
  register(makeCommunityFetchAllParticipating(getSock));
  register(makeCommunityUpdateMetadata(getSock));
}
