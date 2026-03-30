// src/mcp/tools/newsletter.ts
// Newsletter/Channels management tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';

// ---------------------------------------------------------------------------
// newsletter_create
// ---------------------------------------------------------------------------

const NewsletterCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

function makeNewsletterCreate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_create',
    description: 'Create a new WhatsApp newsletter channel with the given name and optional description (global).',
    schema: NewsletterCreateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { name, description } = NewsletterCreateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).newsletterCreate(name, description);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_update
// ---------------------------------------------------------------------------

const NewsletterUpdateSchema = z.object({
  jid: z.string(),
  updates: z.record(z.unknown()),
});

function makeNewsletterUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_update',
    description: 'Update metadata for a WhatsApp newsletter by JID (global).',
    schema: NewsletterUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, updates } = NewsletterUpdateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).newsletterUpdate(jid, updates);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_metadata
// ---------------------------------------------------------------------------

const NewsletterMetadataSchema = z.object({
  type: z.enum(['invite', 'jid']),
  key: z.string(),
});

function makeNewsletterMetadata(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_metadata',
    description:
      "Fetch metadata for a WhatsApp newsletter. Use type='jid' with the newsletter JID, or type='invite' with the invite code (global).",
    schema: NewsletterMetadataSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { type, key } = NewsletterMetadataSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).newsletterMetadata(type, key);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_subscribers
// ---------------------------------------------------------------------------

const NewsletterSubscribersSchema = z.object({
  jid: z.string(),
});

function makeNewsletterSubscribers(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_subscribers',
    description: 'Fetch the subscriber list for a WhatsApp newsletter by JID (global).',
    schema: NewsletterSubscribersSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = NewsletterSubscribersSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).newsletterSubscribers(jid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_follow
// ---------------------------------------------------------------------------

const NewsletterFollowSchema = z.object({
  jid: z.string(),
});

function makeNewsletterFollow(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_follow',
    description: 'Follow (subscribe to) a WhatsApp newsletter by JID (global).',
    schema: NewsletterFollowSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = NewsletterFollowSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterFollow(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_unfollow
// ---------------------------------------------------------------------------

const NewsletterUnfollowSchema = z.object({
  jid: z.string(),
});

function makeNewsletterUnfollow(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_unfollow',
    description: 'Unfollow (unsubscribe from) a WhatsApp newsletter by JID (global).',
    schema: NewsletterUnfollowSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = NewsletterUnfollowSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterUnfollow(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_mute
// ---------------------------------------------------------------------------

const NewsletterMuteSchema = z.object({
  jid: z.string(),
});

function makeNewsletterMute(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_mute',
    description: 'Mute a WhatsApp newsletter by JID (global).',
    schema: NewsletterMuteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = NewsletterMuteSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterMute(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_unmute
// ---------------------------------------------------------------------------

const NewsletterUnmuteSchema = z.object({
  jid: z.string(),
});

function makeNewsletterUnmute(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_unmute',
    description: 'Unmute a WhatsApp newsletter by JID (global).',
    schema: NewsletterUnmuteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = NewsletterUnmuteSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterUnmute(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_update_name
// ---------------------------------------------------------------------------

const NewsletterUpdateNameSchema = z.object({
  jid: z.string(),
  name: z.string(),
});

function makeNewsletterUpdateName(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_update_name',
    description: 'Update the name/title of a WhatsApp newsletter by JID (global).',
    schema: NewsletterUpdateNameSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, name } = NewsletterUpdateNameSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterUpdateName(jid, name);
      return { success: true, jid, name };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_update_description
// ---------------------------------------------------------------------------

const NewsletterUpdateDescriptionSchema = z.object({
  jid: z.string(),
  description: z.string(),
});

function makeNewsletterUpdateDescription(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_update_description',
    description: 'Update the description of a WhatsApp newsletter by JID (global).',
    schema: NewsletterUpdateDescriptionSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, description } = NewsletterUpdateDescriptionSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterUpdateDescription(jid, description);
      return { success: true, jid, description };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_update_picture
// ---------------------------------------------------------------------------

const NewsletterUpdatePictureSchema = z.object({
  jid: z.string(),
  content: z.string().describe('Base64-encoded image data'),
});

function makeNewsletterUpdatePicture(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_update_picture',
    description:
      'Update the profile picture for a WhatsApp newsletter. Content is base64-encoded image data (global).',
    schema: NewsletterUpdatePictureSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, content } = NewsletterUpdatePictureSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      // Validate base64 format before decoding — Buffer.from silently drops
      // invalid characters and returns a non-empty buffer for garbage input.
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Regex.test(content)) {
        throw new Error('Invalid base64 content: contains non-base64 characters');
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(content, 'base64');
        if (buffer.length === 0) throw new Error('Empty buffer');
      } catch {
        throw new Error('Invalid base64 content');
      }
      await (sock as any).newsletterUpdatePicture(jid, buffer);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_remove_picture
// ---------------------------------------------------------------------------

const NewsletterRemovePictureSchema = z.object({
  jid: z.string(),
});

function makeNewsletterRemovePicture(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_remove_picture',
    description: 'Remove the profile picture from a WhatsApp newsletter by JID (global).',
    schema: NewsletterRemovePictureSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = NewsletterRemovePictureSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterRemovePicture(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_react_message
// ---------------------------------------------------------------------------

const NewsletterReactMessageSchema = z.object({
  jid: z.string(),
  serverId: z.string(),
  reaction: z.string().optional(),
});

function makeNewsletterReactMessage(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_react_message',
    description:
      'React to a newsletter message by server ID. Pass reaction emoji or omit to remove reaction (global).',
    schema: NewsletterReactMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, serverId, reaction } = NewsletterReactMessageSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterReactMessage(jid, serverId, reaction);
      return { success: true, jid, serverId };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_fetch_messages
// ---------------------------------------------------------------------------

const NewsletterFetchMessagesSchema = z.object({
  jid: z.string(),
  count: z.number().int().positive(),
  since: z.number().optional(),
  after: z.number().optional().describe('Cursor offset as a number (message server ID).'),
});

function makeNewsletterFetchMessages(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_fetch_messages',
    description:
      'Fetch messages from a WhatsApp newsletter. Optionally filter by timestamp (since) or cursor (after) (global).',
    schema: NewsletterFetchMessagesSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid, count, since, after } = NewsletterFetchMessagesSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).newsletterFetchMessages(jid, count, since, after);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// subscribe_newsletter_updates
// ---------------------------------------------------------------------------

const SubscribeNewsletterUpdatesSchema = z.object({
  jid: z.string(),
});

function makeSubscribeNewsletterUpdates(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'subscribe_newsletter_updates',
    description: 'Subscribe to live updates for a WhatsApp newsletter by JID (global).',
    schema: SubscribeNewsletterUpdatesSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = SubscribeNewsletterUpdatesSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).subscribeNewsletterUpdates(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_admin_count
// ---------------------------------------------------------------------------

const NewsletterAdminCountSchema = z.object({
  jid: z.string(),
});

function makeNewsletterAdminCount(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_admin_count',
    description: 'Get the number of admins for a WhatsApp newsletter by JID (global).',
    schema: NewsletterAdminCountSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = NewsletterAdminCountSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const count = await (sock as any).newsletterAdminCount(jid);
      return { jid, adminCount: count };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_change_owner
// ---------------------------------------------------------------------------

const NewsletterChangeOwnerSchema = z.object({
  jid: z.string(),
  newOwnerJid: z.string(),
});

function makeNewsletterChangeOwner(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_change_owner',
    description: 'Transfer ownership of a WhatsApp newsletter to a new owner JID (global).',
    schema: NewsletterChangeOwnerSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, newOwnerJid } = NewsletterChangeOwnerSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterChangeOwner(jid, newOwnerJid);
      return { success: true, jid, newOwnerJid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_demote
// ---------------------------------------------------------------------------

const NewsletterDemoteSchema = z.object({
  jid: z.string(),
  userJid: z.string(),
});

function makeNewsletterDemote(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_demote',
    description: 'Demote an admin from a WhatsApp newsletter to a regular subscriber (global).',
    schema: NewsletterDemoteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, userJid } = NewsletterDemoteSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterDemote(jid, userJid);
      return { success: true, jid, userJid };
    },
  };
}

// ---------------------------------------------------------------------------
// newsletter_delete
// ---------------------------------------------------------------------------

const NewsletterDeleteSchema = z.object({
  jid: z.string(),
});

function makeNewsletterDelete(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'newsletter_delete',
    description: 'Permanently delete a WhatsApp newsletter by JID (global).',
    schema: NewsletterDeleteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid } = NewsletterDeleteSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).newsletterDelete(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerNewsletterTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeNewsletterCreate(getSock));
  register(makeNewsletterUpdate(getSock));
  register(makeNewsletterMetadata(getSock));
  register(makeNewsletterSubscribers(getSock));
  register(makeNewsletterFollow(getSock));
  register(makeNewsletterUnfollow(getSock));
  register(makeNewsletterMute(getSock));
  register(makeNewsletterUnmute(getSock));
  register(makeNewsletterUpdateName(getSock));
  register(makeNewsletterUpdateDescription(getSock));
  register(makeNewsletterUpdatePicture(getSock));
  register(makeNewsletterRemovePicture(getSock));
  register(makeNewsletterReactMessage(getSock));
  register(makeNewsletterFetchMessages(getSock));
  register(makeSubscribeNewsletterUpdates(getSock));
  register(makeNewsletterAdminCount(getSock));
  register(makeNewsletterChangeOwner(getSock));
  register(makeNewsletterDemote(getSock));
  register(makeNewsletterDelete(getSock));
}
