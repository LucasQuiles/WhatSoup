// src/mcp/tools/advanced.ts
// Wave 7: Advanced / Misc tools — call links, pairing, interactive messages, protocol.
// Also includes admin enrichment tools (P0-3).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import type { Database } from '../../core/database.ts';
import { resetEnrichmentErrors } from '../../core/messages.ts';

// ---------------------------------------------------------------------------
// create_call_link
// ---------------------------------------------------------------------------

const CreateCallLinkSchema = z.object({
  type: z.enum(['audio', 'video']).describe('Type of call link to create'),
  event: z.object({ startTime: z.number() }).optional().describe('Optional event with startTime (Unix seconds)'),
  timeoutMs: z.number().optional().describe('Optional timeout in milliseconds'),
});

function makeCreateCallLink(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'create_call_link',
    description: 'Create a WhatsApp call link for audio or video calls (global).',
    schema: CreateCallLinkSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { type, event, timeoutMs } = CreateCallLinkSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).createCallLink(type, event, timeoutMs);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// share_phone_number
// ---------------------------------------------------------------------------

const SharePhoneNumberSchema = z.object({
  jid: z.string().describe('JID of the contact to share your phone number with'),
});

function makeSharePhoneNumber(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'share_phone_number',
    description: 'Share your phone number with a contact via a WhatsApp message (global).',
    schema: SharePhoneNumberSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid } = SharePhoneNumberSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(jid, { sharePhoneNumber: true } as any);
      return { sent: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// request_phone_number
// ---------------------------------------------------------------------------

const RequestPhoneNumberSchema = z.object({
  jid: z.string().describe('JID of the contact whose phone number you are requesting'),
});

function makeRequestPhoneNumber(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'request_phone_number',
    description: 'Request a contact to share their phone number with you (global).',
    schema: RequestPhoneNumberSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = RequestPhoneNumberSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(jid, { requestPhoneNumber: true } as any);
      return { sent: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// send_product_message
// ---------------------------------------------------------------------------

const ProductSchema = z.object({
  productId: z.string().describe('Catalog product ID'),
  title: z.string().optional(),
  description: z.string().optional(),
  currencyCode: z.string().optional(),
  priceAmount1000: z.number().optional().describe('Price * 1000 (e.g. 9990 = $9.99)'),
  retailerId: z.string().optional(),
  url: z.string().optional(),
  productImageCount: z.number().optional(),
  firstImageId: z.string().optional(),
  salePriceAmount1000: z.number().optional(),
});

const SendProductMessageSchema = z.object({
  jid: z.string().describe('JID of the recipient chat'),
  product: ProductSchema.describe('Product object from the business catalog'),
});

function makeSendProductMessage(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_product_message',
    description: 'Send a product catalog message to a WhatsApp chat (global).',
    schema: SendProductMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, product } = SendProductMessageSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(jid, { product } as any);
      return { sent: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// request_pairing_code
// ---------------------------------------------------------------------------

const RequestPairingCodeSchema = z.object({
  phoneNumber: z.string().describe('Phone number to pair with (international format, e.g. 14155551234)'),
  customCode: z.string().optional().describe('Optional custom pairing code'),
});

function makeRequestPairingCode(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'request_pairing_code',
    description: 'Request a pairing code for linking a device by phone number (global).',
    schema: RequestPairingCodeSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { phoneNumber, customCode } = RequestPairingCodeSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const code = await (sock as any).requestPairingCode(phoneNumber, customCode);
      return { pairingCode: code };
    },
  };
}

// ---------------------------------------------------------------------------
// get_bots_list
// ---------------------------------------------------------------------------

const GetBotsListSchema = z.object({});

function makeGetBotsList(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_bots_list',
    description: 'Retrieve the list of available WhatsApp bots (global).',
    schema: GetBotsListSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async () => {
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const bots = await (sock as any).getBotListV2();
      return { bots };
    },
  };
}

// ---------------------------------------------------------------------------
// send_button_reply
// ---------------------------------------------------------------------------

const SendButtonReplySchema = z.object({
  chatJid: z.string().describe('JID of the chat to send the button reply to'),
  displayText: z.string().describe('Display text of the selected button'),
  id: z.string().describe('Button ID that was selected'),
  type: z.number().int().describe('Button type (1 = reply button)'),
});

function makeSendButtonReply(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_button_reply',
    description: 'Send a button reply message to a WhatsApp chat (chat scope).',
    schema: SendButtonReplySchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { chatJid, displayText, id, type } = SendButtonReplySchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(chatJid, {
        buttonReply: { displayText, id, type },
      } as any);
      return { sent: true, chatJid, id };
    },
  };
}

// ---------------------------------------------------------------------------
// send_list_reply
// ---------------------------------------------------------------------------

const SendListReplySchema = z.object({
  chatJid: z.string().describe('JID of the chat to send the list reply to'),
  title: z.string().describe('Title of the list reply'),
  listType: z.number().int().describe('List type (1 = single select)'),
  selectedRowId: z.string().describe('ID of the selected row'),
});

function makeSendListReply(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_list_reply',
    description: 'Send a list reply message (selected list item) to a WhatsApp chat (chat scope).',
    schema: SendListReplySchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { chatJid, title, listType, selectedRowId } = SendListReplySchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(chatJid, {
        listReply: {
          title,
          listType,
          singleSelectReply: { selectedRowId },
        },
      } as any);
      return { sent: true, chatJid, selectedRowId };
    },
  };
}

// ---------------------------------------------------------------------------
// send_limit_sharing
// ---------------------------------------------------------------------------

const SendLimitSharingSchema = z.object({
  chatJid: z.string().describe('JID of the chat to send the limit sharing message to'),
});

function makeSendLimitSharing(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'send_limit_sharing',
    description: 'Send a limit-sharing message to a WhatsApp chat, restricting content forwarding (chat scope).',
    schema: SendLimitSharingSchema,
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { chatJid } = SendLimitSharingSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await sock.sendMessage(chatJid, { limitSharing: true } as any);
      return { sent: true, chatJid };
    },
  };
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

const LogoutSchema = z.object({
  msg: z.string().optional().describe('Optional logout message'),
});

function makeLogout(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'logout',
    description:
      'WARNING: This will log out the WhatsApp session. You will need to re-authenticate. Disconnects the current WhatsApp session and invalidates credentials (global).',
    schema: LogoutSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { msg } = LogoutSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).logout(msg);
      return { loggedOut: true };
    },
  };
}

// ---------------------------------------------------------------------------
// resync_app_state
// ---------------------------------------------------------------------------

const WAPatchName = z.enum([
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
]);

const ResyncAppStateSchema = z.object({
  collections: z
    .array(WAPatchName)
    .describe(
      'List of app-state collection names to resync. Valid values: critical_block, critical_unblock_low, regular_high, regular_low, regular',
    ),
  isInitialSync: z.boolean().describe('Whether this is an initial sync (true) or incremental (false)'),
});

function makeResyncAppState(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'resync_app_state',
    description: 'Resync one or more WhatsApp app-state collections (global).',
    schema: ResyncAppStateSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { collections, isInitialSync } = ResyncAppStateSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      await (sock as any).resyncAppState(collections, isInitialSync);
      return { synced: true, collections };
    },
  };
}

// ---------------------------------------------------------------------------
// relay_message
// ---------------------------------------------------------------------------

const RelayMessageOptsSchema = z.object({
  messageId: z.string().optional().describe('Custom message ID'),
  participant: z.string().optional().describe('Participant JID (for group messages)'),
  additionalAttributes: z.record(z.string()).optional().describe('Extra attributes to attach'),
  useUserDevicesCache: z.boolean().optional().describe('Whether to use the user-devices cache'),
});

const RelayMessageSchema = z.object({
  jid: z.string().describe('Recipient JID'),
  proto: z.record(z.unknown()).describe('Raw protobuf message as a JSON object'),
  opts: RelayMessageOptsSchema.optional().describe('Optional relay options'),
});

function makeRelayMessage(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'relay_message',
    description:
      'Low-level: relay a raw protobuf message to a JID. Use only for advanced protocol operations (global).',
    schema: RelayMessageSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { jid, proto, opts } = RelayMessageSchema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      const result = await (sock as any).relayMessage(jid, proto, opts ?? {});
      return { relayed: true, jid, result: result ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// reset_enrichment_errors (admin tool)
// ---------------------------------------------------------------------------

const ResetEnrichmentErrorsSchema = z.object({
  pks: z
    .array(z.number())
    .optional()
    .describe('Optional array of message primary keys to reset. If omitted, resets ALL failed messages.'),
});

function makeResetEnrichmentErrors(db: Database): ToolDeclaration {
  return {
    name: 'reset_enrichment_errors',
    description:
      'Reset enrichment errors so failed messages can be re-enriched. ' +
      'Clears enrichment_processed_at, enrichment_error, and enrichment_retries. ' +
      'Pass specific PKs to reset individual messages, or omit to reset all failed messages (global).',
    schema: ResetEnrichmentErrorsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    handler: async (params) => {
      const { pks } = ResetEnrichmentErrorsSchema.parse(params);
      const count = resetEnrichmentErrors(db, pks);
      return { reset: count, message: `${count} message(s) reset for re-enrichment` };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerAdvancedTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
  db?: Database,
): void {
  // User-facing tools (global)
  register(makeCreateCallLink(getSock));
  register(makeSharePhoneNumber(getSock));
  register(makeRequestPhoneNumber(getSock));
  register(makeSendProductMessage(getSock));
  register(makeRequestPairingCode(getSock));
  register(makeGetBotsList(getSock));

  // Interactive message types (chat scope)
  register(makeSendButtonReply(getSock));
  register(makeSendListReply(getSock));
  register(makeSendLimitSharing(getSock));

  // Low-level / protocol (global)
  register(makeLogout(getSock));
  register(makeResyncAppState(getSock));
  register(makeRelayMessage(getSock));
  // Note: fetch_message_history already exists in chat-operations.ts (Wave 2). Skipped here.

  // Admin tools (require DB)
  if (db) {
    register(makeResetEnrichmentErrors(db));
  }
}
