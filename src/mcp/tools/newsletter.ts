// src/mcp/tools/newsletter.ts
// Newsletter/Channels management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import { validateBase64Image } from '../../core/base64.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// ---------------------------------------------------------------------------
// NOTE: newsletter_update, newsletter_update_name, and newsletter_update_description
// are intentionally separate tools. They call three distinct Baileys methods:
//   - newsletterUpdate(jid, record)      -- low-level, freeform metadata patch
//   - newsletterUpdateName(jid, string)  -- typed name-only update
//   - newsletterUpdateDescription(jid, string) -- typed description-only update
// newsletter_update is NOT a superset that makes the others redundant: the specific
// tools have stricter schemas (required typed fields) and invoke dedicated Baileys
// handlers. Keep all three.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const newsletterConfigs: SockToolConfig<any>[] = [
  {
    name: 'newsletter_create',
    description: 'Create a new WhatsApp newsletter channel with the given name and optional description (global).',
    schema: z.object({
      name: z.string(),
      description: z.string().optional(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ name, description }, sock) => {
      return sock.newsletterCreate(name, description);
    },
  },
  {
    name: 'newsletter_update',
    description: 'Update metadata for a WhatsApp newsletter by JID (global).',
    schema: z.object({
      jid: z.string(),
      updates: z.record(z.unknown()),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, updates }, sock) => {
      return sock.newsletterUpdate(jid, updates);
    },
  },
  {
    name: 'newsletter_metadata',
    description:
      "Fetch metadata for a WhatsApp newsletter. Use type='jid' with the newsletter JID, or type='invite' with the invite code (global).",
    schema: z.object({
      type: z.enum(['invite', 'jid']),
      key: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ type, key }, sock) => {
      return sock.newsletterMetadata(type, key);
    },
  },
  {
    name: 'newsletter_subscribers',
    description: 'Fetch the subscriber list for a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      return sock.newsletterSubscribers(jid);
    },
  },
  {
    name: 'newsletter_follow',
    description: 'Follow (subscribe to) a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.newsletterFollow(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_unfollow',
    description: 'Unfollow (unsubscribe from) a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.newsletterUnfollow(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_mute',
    description: 'Mute a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.newsletterMute(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_unmute',
    description: 'Unmute a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.newsletterUnmute(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_update_name',
    description: 'Update the name/title of a WhatsApp newsletter by JID (global).',
    schema: z.object({
      jid: z.string(),
      name: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, name }, sock) => {
      await sock.newsletterUpdateName(jid, name);
      return { success: true, jid, name };
    },
  },
  {
    name: 'newsletter_update_description',
    description: 'Update the description of a WhatsApp newsletter by JID (global).',
    schema: z.object({
      jid: z.string(),
      description: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, description }, sock) => {
      await sock.newsletterUpdateDescription(jid, description);
      return { success: true, jid, description };
    },
  },
  {
    name: 'newsletter_update_picture',
    description:
      'Update the profile picture for a WhatsApp newsletter. Content is base64-encoded image data (global).',
    schema: z.object({
      jid: z.string(),
      content: z.string().describe('Base64-encoded image data'),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, content }, sock) => {
      const cleanContent = validateBase64Image(content);
      const buffer = Buffer.from(cleanContent, 'base64');
      await sock.newsletterUpdatePicture(jid, buffer);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_remove_picture',
    description: 'Remove the profile picture from a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.newsletterRemovePicture(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_react_message',
    description:
      'React to a newsletter message by server ID. Pass reaction emoji or omit to remove reaction (global).',
    schema: z.object({
      jid: z.string(),
      serverId: z.string(),
      reaction: z.string().optional(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, serverId, reaction }, sock) => {
      await sock.newsletterReactMessage(jid, serverId, reaction);
      return { success: true, jid, serverId };
    },
  },
  {
    name: 'newsletter_fetch_messages',
    description:
      'Fetch messages from a WhatsApp newsletter. Optionally filter by timestamp (since) or cursor (after) (global).',
    schema: z.object({
      jid: z.string(),
      count: z.number().int().positive(),
      since: z.number().optional(),
      after: z.number().optional().describe('Cursor offset as a number (message server ID).'),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid, count, since, after }, sock) => {
      return sock.newsletterFetchMessages(jid, count, since, after);
    },
  },
  {
    name: 'subscribe_newsletter_updates',
    description: 'Subscribe to live updates for a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.subscribeNewsletterUpdates(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'newsletter_admin_count',
    description: 'Get the number of admins for a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      const count = await sock.newsletterAdminCount(jid);
      return { jid, adminCount: count };
    },
  },
  {
    name: 'newsletter_change_owner',
    description: 'Transfer ownership of a WhatsApp newsletter to a new owner JID (global).',
    schema: z.object({
      jid: z.string(),
      newOwnerJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, newOwnerJid }, sock) => {
      await sock.newsletterChangeOwner(jid, newOwnerJid);
      return { success: true, jid, newOwnerJid };
    },
  },
  {
    name: 'newsletter_demote',
    description: 'Demote an admin from a WhatsApp newsletter to a regular subscriber (global).',
    schema: z.object({
      jid: z.string(),
      userJid: z.string(),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, userJid }, sock) => {
      await sock.newsletterDemote(jid, userJid);
      return { success: true, jid, userJid };
    },
  },
  {
    name: 'newsletter_delete',
    description: 'Permanently delete a WhatsApp newsletter by JID (global).',
    schema: z.object({ jid: z.string() }),
    replayPolicy: 'unsafe',
    call: async ({ jid }, sock) => {
      await sock.newsletterDelete(jid);
      return { success: true, jid };
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerNewsletterTools(
  getSock: () => ExtendedBaileysSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, newsletterConfigs, register);
}
