// src/mcp/tools/business.ts
// Business profile, catalog, quick reply, and label tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';

// ---------------------------------------------------------------------------
// get_business_profile
// ---------------------------------------------------------------------------

const GetBusinessProfileSchema = z.object({
  jid: z.string(),
});

function makeGetBusinessProfile(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_business_profile',
    description: 'Get the WhatsApp Business profile for a contact JID (global).',
    schema: GetBusinessProfileSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jid } = GetBusinessProfileSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).getBusinessProfile(jid);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// update_business_profile
// ---------------------------------------------------------------------------

const UpdateBusinessProfileSchema = z.object({
  category: z.string().optional(),
  description: z.string().optional(),
  email: z.string().optional(),
  website: z.array(z.string()).optional(),
  address: z.string().optional(),
});

function makeUpdateBusinessProfile(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_business_profile',
    description: 'Update the WhatsApp Business profile fields (category, description, email, website, address) (global).',
    schema: UpdateBusinessProfileSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const args = UpdateBusinessProfileSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).updateBussinesProfile(args);
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// update_cover_photo
// ---------------------------------------------------------------------------

const UpdateCoverPhotoSchema = z.object({
  photo: z.string().describe('Base64-encoded image data for the cover photo.'),
});

function makeUpdateCoverPhoto(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_cover_photo',
    description: 'Update the WhatsApp Business cover photo. Provide the image as a base64 string (global).',
    schema: UpdateCoverPhotoSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { photo } = UpdateCoverPhotoSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      let buffer: Buffer;
      try {
        buffer = Buffer.from(photo, 'base64');
        if (buffer.length === 0) throw new Error('Empty buffer');
      } catch {
        throw new Error('Invalid base64 content');
      }
      await (sock as any).updateCoverPhoto(buffer);
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// remove_cover_photo
// ---------------------------------------------------------------------------

const RemoveCoverPhotoSchema = z.object({
  id: z.string().describe('Cover photo asset ID to remove.'),
});

function makeRemoveCoverPhoto(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'remove_cover_photo',
    description: 'Remove a WhatsApp Business cover photo by asset ID (global).',
    schema: RemoveCoverPhotoSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { id } = RemoveCoverPhotoSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).removeCoverPhoto(id);
      return { success: true, id };
    },
  };
}

// ---------------------------------------------------------------------------
// get_catalog
// ---------------------------------------------------------------------------

const GetCatalogSchema = z.object({
  jid: z.string().optional().describe('Business JID. Omit to get own catalog.'),
  limit: z.number().optional().describe('Max products to return.'),
  cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
});

function makeGetCatalog(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_catalog',
    description: 'Get the product catalog for a WhatsApp Business account (global).',
    schema: GetCatalogSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const args = GetCatalogSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).getCatalog({
        jid: args.jid,
        limit: args.limit,
        cursor: args.cursor,
      });
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// get_collections
// ---------------------------------------------------------------------------

const GetCollectionsSchema = z.object({
  jid: z.string().optional().describe('Business JID. Omit to use own JID.'),
  limit: z.number().optional().describe('Max collections to return.'),
});

function makeGetCollections(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_collections',
    description: 'Get product collections for a WhatsApp Business account (global).',
    schema: GetCollectionsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const args = GetCollectionsSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).getCollections(args.jid, args.limit);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// product_create
// ---------------------------------------------------------------------------

const ProductCreateSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  price: z.number().optional().describe('Price in smallest currency unit (e.g. cents).'),
  currency: z.string().optional().describe('ISO 4217 currency code, e.g. USD.'),
  retailerId: z.string().optional().describe('Your internal product/SKU identifier.'),
  url: z.string().optional().describe('URL to the product listing.'),
  imageUrls: z.array(z.string()).optional().describe('List of product image URLs.'),
  isHidden: z.boolean().optional(),
});

function makeProductCreate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'product_create',
    description: 'Create a new product in the WhatsApp Business catalog (global).',
    schema: ProductCreateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const args = ProductCreateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).productCreate(args);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// product_update
// ---------------------------------------------------------------------------

const ProductUpdateSchema = z.object({
  productId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  price: z.number().optional(),
  currency: z.string().optional(),
  retailerId: z.string().optional(),
  url: z.string().optional(),
  imageUrls: z.array(z.string()).optional(),
  isHidden: z.boolean().optional(),
});

function makeProductUpdate(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'product_update',
    description: 'Update an existing product in the WhatsApp Business catalog by product ID (global).',
    schema: ProductUpdateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { productId, ...update } = ProductUpdateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).productUpdate(productId, update);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// product_delete
// ---------------------------------------------------------------------------

const ProductDeleteSchema = z.object({
  productIds: z.array(z.string()).describe('List of product IDs to delete.'),
});

function makeProductDelete(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'product_delete',
    description: 'Delete one or more products from the WhatsApp Business catalog (global).',
    schema: ProductDeleteSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { productIds } = ProductDeleteSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).productDelete(productIds);
      return result ?? { success: true, deleted: productIds.length };
    },
  };
}

// ---------------------------------------------------------------------------
// get_order_details
// ---------------------------------------------------------------------------

const GetOrderDetailsSchema = z.object({
  orderId: z.string(),
  tokenBase64: z.string().describe('Order token in base64, received in the order message.'),
});

function makeGetOrderDetails(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_order_details',
    description: 'Fetch details for a WhatsApp order by order ID and token (global).',
    schema: GetOrderDetailsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { orderId, tokenBase64 } = GetOrderDetailsSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).getOrderDetails(orderId, tokenBase64);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// add_or_edit_quick_reply
// ---------------------------------------------------------------------------

const AddOrEditQuickReplySchema = z.object({
  shortcut: z.string().describe('Trigger shortcut (e.g. /hello).'),
  message: z.string().describe('Full message text for the quick reply.'),
  keywords: z.array(z.string()).optional().describe('Optional keywords for search.'),
  count: z.number().optional(),
});

function makeAddOrEditQuickReply(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'add_or_edit_quick_reply',
    description: 'Add or edit a quick reply shortcut for the WhatsApp Business account (global).',
    schema: AddOrEditQuickReplySchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const quickReply = AddOrEditQuickReplySchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).addOrEditQuickReply(quickReply);
      return { success: true, shortcut: quickReply.shortcut };
    },
  };
}

// ---------------------------------------------------------------------------
// remove_quick_reply
// ---------------------------------------------------------------------------

const RemoveQuickReplySchema = z.object({
  timestamp: z.string().describe('Timestamp identifier of the quick reply to remove.'),
});

function makeRemoveQuickReply(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'remove_quick_reply',
    description: 'Remove a quick reply shortcut by its timestamp identifier (global).',
    schema: RemoveQuickReplySchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { timestamp } = RemoveQuickReplySchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).removeQuickReply(timestamp);
      return { success: true, timestamp };
    },
  };
}

// ---------------------------------------------------------------------------
// manage_labels
// ---------------------------------------------------------------------------

const ManageLabelsSchema = z.object({
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
});

function makeManageLabels(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
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
    schema: ManageLabelsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const args = ManageLabelsSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');

      switch (args.action) {
        case 'add_label': {
          if (!args.labels || args.labels.length === 0) {
            throw new Error('add_label requires a non-empty labels array');
          }
          await (sock as any).addLabel(args.labels);
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
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerBusinessTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeGetBusinessProfile(getSock));
  register(makeUpdateBusinessProfile(getSock));
  register(makeUpdateCoverPhoto(getSock));
  register(makeRemoveCoverPhoto(getSock));
  register(makeGetCatalog(getSock));
  register(makeGetCollections(getSock));
  register(makeProductCreate(getSock));
  register(makeProductUpdate(getSock));
  register(makeProductDelete(getSock));
  register(makeGetOrderDetails(getSock));
  register(makeAddOrEditQuickReply(getSock));
  register(makeRemoveQuickReply(getSock));
  register(makeManageLabels(getSock));
}
