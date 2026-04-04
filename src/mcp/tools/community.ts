// src/mcp/tools/community.ts
// Community management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const communityConfigs: SockToolConfig<any>[] = [
  {
    name: 'community_metadata',
    description: 'Get metadata for a WhatsApp community by JID (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      return (sock as any).communityMetadata(jid);
    },
  },
  {
    name: 'community_create',
    description: 'Create a new WhatsApp community with the given subject and description body (global).',
    schema: z.object({
      subject: z.string(),
      body: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ subject, body }, sock) => {
      return (sock as any).communityCreate(subject, body);
    },
  },
  {
    name: 'community_create_group',
    description: 'Create a new group within a community (global).',
    schema: z.object({
      subject: z.string(),
      participants: z.array(z.string()),
      parentJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ subject, participants, parentJid }, sock) => {
      return (sock as any).communityCreateGroup(subject, participants, parentJid);
    },
  },
  {
    name: 'community_leave',
    description: 'Leave a WhatsApp community (global).',
    schema: z.object({
      id: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ id }, sock) => {
      await (sock as any).communityLeave(id);
      return { success: true, id };
    },
  },
  {
    name: 'community_link_group',
    description: 'Link an existing group into a community (global).',
    schema: z.object({
      groupJid: z.string(),
      communityJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ groupJid, communityJid }, sock) => {
      return (sock as any).communityLinkGroup(groupJid, communityJid);
    },
  },
  {
    name: 'community_unlink_group',
    description: 'Unlink a group from a community (global).',
    schema: z.object({
      groupJid: z.string(),
      communityJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ groupJid, communityJid }, sock) => {
      return (sock as any).communityUnlinkGroup(groupJid, communityJid);
    },
  },
  {
    name: 'community_fetch_linked_groups',
    description: 'Fetch all groups linked to a community by JID (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      return (sock as any).communityFetchLinkedGroups(jid);
    },
  },
  {
    name: 'community_participants_update',
    description: 'Add, remove, promote, or demote participants in a WhatsApp community (global).',
    schema: z.object({
      jid: z.string(),
      participants: z.array(z.string()),
      action: z.enum(['add', 'remove', 'promote', 'demote']),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, participants, action }, sock) => {
      const result = await (sock as any).communityParticipantsUpdate(jid, participants, action);
      return { success: true, jid, action, participants, result };
    },
  },
  {
    name: 'community_invite_code',
    description:
      'Get, revoke, or accept a WhatsApp community invite. action=get (default) returns the current invite code; action=revoke rotates it and returns the new code; action=accept joins the community via an invite code (requires code param).',
    schema: z.object({
      jid: z.string().describe('Community JID — required for get and revoke actions; unused for accept'),
      action: z
        .enum(['get', 'revoke', 'accept'])
        .optional()
        .describe('get (default): fetch current invite code; revoke: rotate and return new code; accept: join via invite code'),
      code: z.string().optional().describe('Invite code — required for accept action'),
    }),
    // revoke and accept are mutating — use the most conservative policy
    replayPolicy: 'unsafe',
    call: async ({ jid, action = 'get', code }, sock) => {
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
  },
  {
    name: 'community_settings_update',
    description:
      'Update WhatsApp community settings: announcement mode (only admins can send) or locked (only admins can edit info) (global).',
    schema: z.object({
      jid: z.string(),
      setting: z.enum(['announcement', 'not_announcement', 'locked', 'unlocked']),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, setting }, sock) => {
      await (sock as any).communitySettingUpdate(jid, setting);
      return { success: true, jid, setting };
    },
  },
  {
    name: 'community_fetch_all_participating',
    description: 'Fetch all communities the bot is participating in (global).',
    schema: z.object({}),
    replayPolicy: 'read_only',
    call: async (_parsed, sock) => {
      const communityMap = await (sock as any).communityFetchAllParticipating();
      const communities = Object.values(communityMap as Record<string, unknown>);
      return { communities };
    },
  },
  {
    name: 'community_update_metadata',
    description:
      "Update a WhatsApp community's subject and/or description. Provide at least one of subject or description (global).",
    schema: z.object({
      jid: z.string(),
      subject: z.string().optional(),
      description: z.string().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, subject, description }, sock) => {
      if (subject !== undefined) {
        await (sock as any).communityUpdateSubject(jid, subject);
      }
      if (description !== undefined) {
        await (sock as any).communityUpdateDescription(jid, description);
      }
      return { success: true, jid, subject, description };
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerCommunityTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, communityConfigs, register);
}
