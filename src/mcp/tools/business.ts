// src/mcp/tools/business.ts
// Business profile, catalog, quick reply, and label tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import { validateBase64Image } from '../../core/base64.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const businessConfigs: SockToolConfig<any>[] = [
  {
    name: 'get_business_profile',
    description: 'Get the WhatsApp Business profile for a contact JID (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
      return (sock as any).getBusinessProfile(jid);
    },
  },
  {
    name: 'update_business_profile',
    description:
      'Update the WhatsApp Business profile fields (category, description, email, website, address) (global).',
    schema: z.object({
      category: z.string().optional(),
      description: z.string().optional(),
      email: z.string().optional(),
      websites: z.array(z.string()).optional().describe('List of website URLs for the business profile.'),
      address: z.string().optional(),
    }),
    replayPolicy: 'safe',
    call: async (args, sock) => {
      await (sock as any).updateBussinesProfile(args);
      return { success: true };
    },
  },
  {
    name: 'update_cover_photo',
    description:
      'Update the WhatsApp Business cover photo. Provide the image as a base64 string (global).',
    schema: z.object({
      photo: z.string().describe('Base64-encoded image data for the cover photo.'),
    }),
    replayPolicy: 'safe',
    call: async ({ photo }, sock) => {
      const cleanPhoto = validateBase64Image(photo);
      const buffer = Buffer.from(cleanPhoto, 'base64');
      await (sock as any).updateCoverPhoto(buffer);
      return { success: true };
    },
  },
  {
    name: 'remove_cover_photo',
    description: 'Remove a WhatsApp Business cover photo by asset ID (global).',
    schema: z.object({
      id: z.string().describe('Cover photo asset ID to remove.'),
    }),
    replayPolicy: 'safe',
    call: async ({ id }, sock) => {
      await (sock as any).removeCoverPhoto(id);
      return { success: true, id };
    },
  },
  {
    name: 'get_catalog',
    description: 'Get the product catalog for a WhatsApp Business account (global).',
    schema: z.object({
      jid: z.string().optional().describe('Business JID. Omit to get own catalog.'),
      limit: z.number().optional().describe('Max products to return.'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
    }),
    replayPolicy: 'read_only',
    call: async (args, sock) => {
      return (sock as any).getCatalog({
        jid: args.jid,
        limit: args.limit,
        cursor: args.cursor,
      });
    },
  },
  {
    name: 'get_collections',
    description: 'Get product collections for a WhatsApp Business account (global).',
    schema: z.object({
      jid: z.string().optional().describe('Business JID. Omit to use own JID.'),
      limit: z.number().optional().describe('Max collections to return.'),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid, limit }, sock) => {
      return (sock as any).getCollections(jid, limit);
    },
  },
  {
    name: 'product_create',
    description: 'Create a new product in the WhatsApp Business catalog (global).',
    schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      price: z.number().optional().describe('Price in smallest currency unit (e.g. cents).'),
      currency: z.string().optional().describe('ISO 4217 currency code, e.g. USD.'),
      retailerId: z.string().optional().describe('Your internal product/SKU identifier.'),
      url: z.string().optional().describe('URL to the product listing.'),
      images: z.array(z.string()).optional().describe('List of product image URLs (WAMediaUpload).'),
      isHidden: z.boolean().optional(),
    }),
    replayPolicy: 'unsafe',
    call: async (args, sock) => {
      return (sock as any).productCreate(args);
    },
  },
  {
    name: 'product_update',
    description:
      'Update an existing product in the WhatsApp Business catalog by product ID (global).',
    schema: z.object({
      productId: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().optional(),
      currency: z.string().optional(),
      retailerId: z.string().optional(),
      url: z.string().optional(),
      images: z.array(z.string()).optional().describe('List of product image URLs (WAMediaUpload).'),
      isHidden: z.boolean().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ productId, ...update }, sock) => {
      return (sock as any).productUpdate(productId, update);
    },
  },
  {
    name: 'product_delete',
    description: 'Delete one or more products from the WhatsApp Business catalog (global).',
    schema: z.object({
      productIds: z.array(z.string()).describe('List of product IDs to delete.'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ productIds }, sock) => {
      const result = await (sock as any).productDelete(productIds);
      return result ?? { success: true, deleted: productIds.length };
    },
  },
  {
    name: 'get_order_details',
    description: 'Fetch details for a WhatsApp order by order ID and token (global).',
    schema: z.object({
      orderId: z.string(),
      tokenBase64: z.string().describe('Order token in base64, received in the order message.'),
    }),
    replayPolicy: 'read_only',
    call: async ({ orderId, tokenBase64 }, sock) => {
      return (sock as any).getOrderDetails(orderId, tokenBase64);
    },
  },
  {
    name: 'add_or_edit_quick_reply',
    description:
      'Add or edit a quick reply shortcut for the WhatsApp Business account (global).',
    schema: z.object({
      shortcut: z.string().describe('Trigger shortcut (e.g. /hello).'),
      message: z.string().describe('Full message text for the quick reply.'),
      keywords: z.array(z.string()).optional().describe('Optional keywords for search.'),
      count: z.number().optional(),
    }),
    replayPolicy: 'safe',
    call: async (quickReply, sock) => {
      await (sock as any).addOrEditQuickReply(quickReply);
      return { success: true, shortcut: quickReply.shortcut };
    },
  },
  {
    name: 'remove_quick_reply',
    description: 'Remove a quick reply shortcut by its timestamp identifier (global).',
    schema: z.object({
      timestamp: z.string().describe('Timestamp identifier of the quick reply to remove.'),
    }),
    replayPolicy: 'safe',
    call: async ({ timestamp }, sock) => {
      await (sock as any).removeQuickReply(timestamp);
      return { success: true, timestamp };
    },
  },
  {
    name: 'manage_labels',
    description: [
      'Manage WhatsApp Business labels. Actions:',
      '  add_label — create/update labels (provide labels array)',
      '  add_chat_label — apply a label to a chat (label_id + chat_jid)',
      '  remove_chat_label — remove a label from a chat (label_id + chat_jid)',
      '  add_message_label — apply a label to a message (label_id + chat_jid + message_id)',
      '  remove_message_label — remove a label from a message (label_id + chat_jid + message_id)',
      '(global)',
    ].join('\n'),
    schema: z.object({
      action: z.enum([
        'add_label',
        'add_chat_label',
        'remove_chat_label',
        'add_message_label',
        'remove_message_label',
      ]),
      label_id: z.string().optional().describe('Label ID for chat/message label actions.'),
      chat_jid: z.string().optional().describe('Chat JID for chat/message label actions.'),
      message_id: z.string().optional().describe('Message ID for message label actions.'),
      labels: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            color: z.number().optional(),
          }),
        )
        .optional()
        .describe('Label definitions for add_label action.'),
    }),
    replayPolicy: 'safe',
    call: async (args, sock) => {
      switch (args.action) {
        case 'add_label': {
          if (!args.labels || args.labels.length === 0) {
            throw new Error('add_label requires a non-empty labels array');
          }
          if (!args.chat_jid) throw new Error('add_label requires chat_jid');
          for (const label of args.labels) {
            await (sock as any).addLabel(args.chat_jid, label);
          }
          return { success: true, action: args.action, count: args.labels.length };
        }

        case 'add_chat_label': {
          if (!args.label_id) throw new Error('add_chat_label requires label_id');
          if (!args.chat_jid) throw new Error('add_chat_label requires chat_jid');
          await (sock as any).addChatLabel(args.chat_jid, args.label_id);
          return { success: true, action: args.action, label_id: args.label_id, chat_jid: args.chat_jid };
        }

        case 'remove_chat_label': {
          if (!args.label_id) throw new Error('remove_chat_label requires label_id');
          if (!args.chat_jid) throw new Error('remove_chat_label requires chat_jid');
          await (sock as any).removeChatLabel(args.chat_jid, args.label_id);
          return { success: true, action: args.action, label_id: args.label_id, chat_jid: args.chat_jid };
        }

        case 'add_message_label': {
          if (!args.label_id) throw new Error('add_message_label requires label_id');
          if (!args.chat_jid) throw new Error('add_message_label requires chat_jid');
          if (!args.message_id) throw new Error('add_message_label requires message_id');
          await (sock as any).addMessageLabel(args.chat_jid, args.message_id, args.label_id);
          return {
            success: true,
            action: args.action,
            label_id: args.label_id,
            chat_jid: args.chat_jid,
            message_id: args.message_id,
          };
        }

        case 'remove_message_label': {
          if (!args.label_id) throw new Error('remove_message_label requires label_id');
          if (!args.chat_jid) throw new Error('remove_message_label requires chat_jid');
          if (!args.message_id) throw new Error('remove_message_label requires message_id');
          await (sock as any).removeMessageLabel(args.chat_jid, args.message_id, args.label_id);
          return {
            success: true,
            action: args.action,
            label_id: args.label_id,
            chat_jid: args.chat_jid,
            message_id: args.message_id,
          };
        }
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerBusinessTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, businessConfigs, register);
}
