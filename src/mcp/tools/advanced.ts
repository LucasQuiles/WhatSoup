// src/mcp/tools/advanced.ts
// Wave 7: Advanced / Misc tools — call links, pairing, interactive messages, protocol.
// Also includes admin enrichment tools (P0-3).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import type { Database } from '../../core/database.ts';
import { resetEnrichmentErrors } from '../../core/messages.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

// ---------------------------------------------------------------------------
// Nested schemas (reused by configs below)
// ---------------------------------------------------------------------------

const RelayMessageOptsSchema = z.object({
  messageId: z.string().optional().describe('Custom message ID'),
  participant: z.string().optional().describe('Participant JID (for group messages)'),
  additionalAttributes: z.record(z.string()).optional().describe('Extra attributes to attach'),
  useUserDevicesCache: z.boolean().optional().describe('Whether to use the user-devices cache'),
});

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

const WAPatchName = z.enum([
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
]);

// ---------------------------------------------------------------------------
// Sock tool configs
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const advancedConfigs: SockToolConfig<any>[] = [
  // --- Global scope tools ---
  {
    name: 'create_call_link',
    description: 'Create a WhatsApp call link for audio or video calls (global).',
    schema: z.object({
      type: z.enum(['audio', 'video']).describe('Type of call link to create'),
      event: z.object({ startTime: z.number() }).optional().describe('Optional event with startTime (Unix seconds)'),
      timeoutMs: z.number().optional().describe('Optional timeout in milliseconds'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ type, event, timeoutMs }, sock) => {
      return (sock as any).createCallLink(type, event, timeoutMs);
    },
  },
  {
    name: 'share_phone_number',
    description: 'Share your phone number with a contact via a WhatsApp message (global).',
    schema: z.object({
      jid: z.string().describe('JID of the contact to share your phone number with'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid }, sock) => {
      await sock.sendMessage(jid, { sharePhoneNumber: true } as any);
      return { sent: true, jid };
    },
  },
  {
    name: 'request_phone_number',
    description: 'Request a contact to share their phone number with you (global).',
    schema: z.object({
      jid: z.string().describe('JID of the contact whose phone number you are requesting'),
    }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.sendMessage(jid, { requestPhoneNumber: true } as any);
      return { sent: true, jid };
    },
  },
  {
    name: 'send_product_message',
    description: 'Send a product catalog message to a WhatsApp chat (global).',
    schema: z.object({
      jid: z.string().describe('JID of the recipient chat'),
      product: ProductSchema.describe('Product object from the business catalog'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, product }, sock) => {
      await sock.sendMessage(jid, { product } as any);
      return { sent: true, jid };
    },
  },
  {
    name: 'request_pairing_code',
    description: 'Request a pairing code for linking a device by phone number (global).',
    schema: z.object({
      phoneNumber: z.string().describe('Phone number to pair with (international format, e.g. 14155551234)'),
      customCode: z.string().optional().describe('Optional custom pairing code'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ phoneNumber, customCode }, sock) => {
      const code = await (sock as any).requestPairingCode(phoneNumber, customCode);
      return { pairingCode: code };
    },
  },
  {
    name: 'get_bots_list',
    description: 'Retrieve the list of available WhatsApp bots (global).',
    schema: z.object({}),
    replayPolicy: 'read_only',
    call: async (_parsed, sock) => {
      const bots = await (sock as any).getBotListV2();
      return { bots };
    },
  },

  // --- Chat scope tools (injected targetMode) ---
  {
    name: 'send_button_reply',
    description: 'Send a button reply message to a WhatsApp chat (chat scope).',
    schema: z.object({
      chatJid: z.string().describe('JID of the chat to send the button reply to'),
      displayText: z.string().describe('Display text of the selected button'),
      id: z.string().describe('Button ID that was selected'),
      type: z.number().int().describe('Button type (1 = reply button)'),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, displayText, id, type }, sock) => {
      await sock.sendMessage(chatJid, {
        buttonReply: { displayText, id, type },
      } as any);
      return { sent: true, chatJid, id };
    },
  },
  {
    name: 'send_list_reply',
    description: 'Send a list reply message (selected list item) to a WhatsApp chat (chat scope).',
    schema: z.object({
      chatJid: z.string().describe('JID of the chat to send the list reply to'),
      title: z.string().describe('Title of the list reply'),
      listType: z.number().int().describe('List type (1 = single select)'),
      selectedRowId: z.string().describe('ID of the selected row'),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    call: async ({ chatJid, title, listType, selectedRowId }, sock) => {
      await sock.sendMessage(chatJid, {
        listReply: {
          title,
          listType,
          singleSelectReply: { selectedRowId },
        },
      } as any);
      return { sent: true, chatJid, selectedRowId };
    },
  },
  {
    name: 'send_limit_sharing',
    description: 'Send a limit-sharing message to a WhatsApp chat, restricting content forwarding (chat scope).',
    schema: z.object({
      chatJid: z.string().describe('JID of the chat to send the limit sharing message to'),
    }),
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'safe',
    call: async ({ chatJid }, sock) => {
      await sock.sendMessage(chatJid, { limitSharing: true } as any);
      return { sent: true, chatJid };
    },
  },

  // --- Low-level / protocol (global) ---
  {
    name: 'logout',
    description:
      'WARNING: This will log out the WhatsApp session. You will need to re-authenticate. Disconnects the current WhatsApp session and invalidates credentials (global).',
    schema: z.object({
      msg: z.string().optional().describe('Optional logout message'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ msg }, sock) => {
      await (sock as any).logout(msg);
      return { loggedOut: true };
    },
  },
  {
    name: 'resync_app_state',
    description: 'Resync one or more WhatsApp app-state collections (global).',
    schema: z.object({
      collections: z
        .array(WAPatchName)
        .describe(
          'List of app-state collection names to resync. Valid values: critical_block, critical_unblock_low, regular_high, regular_low, regular',
        ),
      isInitialSync: z.boolean().describe('Whether this is an initial sync (true) or incremental (false)'),
    }),
    replayPolicy: 'safe',
    call: async ({ collections, isInitialSync }, sock) => {
      await (sock as any).resyncAppState(collections, isInitialSync);
      return { synced: true, collections };
    },
  },
  {
    name: 'relay_message',
    description:
      'Low-level: relay a raw protobuf message to a JID. Use only for advanced protocol operations (global).',
    schema: z.object({
      jid: z.string().describe('Recipient JID'),
      proto: z.record(z.unknown()).describe('Raw protobuf message as a JSON object'),
      opts: RelayMessageOptsSchema.optional().describe('Optional relay options'),
    }),
    replayPolicy: 'unsafe',
    call: async ({ jid, proto, opts }, sock) => {
      const result = await (sock as any).relayMessage(jid, proto, opts ?? {});
      return { relayed: true, jid, result: result ?? null };
    },
  },
];

// ---------------------------------------------------------------------------
// reset_enrichment_errors (admin tool — uses db, not sock)
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
  registerSockTools(getSock, advancedConfigs, register);
  // Note: fetch_message_history already exists in chat-operations.ts (Wave 2). Skipped here.

  // Admin tools (require DB)
  if (db) {
    register(makeResetEnrichmentErrors(db));
  }
}
