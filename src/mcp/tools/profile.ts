// src/mcp/tools/profile.ts
// Profile, contact info, and block tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';

// ---------------------------------------------------------------------------
// get_profile_picture
// ---------------------------------------------------------------------------

const GetProfilePictureSchema = z.object({
  jid: z.string(),
  type: z.enum(['preview', 'image']).optional(),
});

function makeGetProfilePicture(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_profile_picture',
    description:
      'Get the profile picture URL for a WhatsApp contact or group JID (global).',
    schema: GetProfilePictureSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, type = 'preview' } = GetProfilePictureSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const url = await sock.profilePictureUrl(jid, type);
      return { jid, url: url ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// get_contact_status
// ---------------------------------------------------------------------------

const GetContactStatusSchema = z.object({
  jid: z.string(),
});

function makeGetContactStatus(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_contact_status',
    description: "Fetch a WhatsApp contact's status message (global).",
    schema: GetContactStatusSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid } = GetContactStatusSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const results = await sock.fetchStatus(jid);
      // fetchStatus returns USyncQueryResultList[] | undefined
      if (!results || results.length === 0) {
        return { jid, status: null };
      }

      const first = results[0] as any;
      // Try to extract the status string from the result
      const status = first?.status?.status ?? first?.status ?? null;
      return { jid, status };
    },
  };
}

// ---------------------------------------------------------------------------
// check_whatsapp
// ---------------------------------------------------------------------------

const CheckWhatsAppSchema = z.object({
  phone_numbers: z.array(z.string()),
});

function makeCheckWhatsApp(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'check_whatsapp',
    description:
      'Check which phone numbers are registered on WhatsApp (global). Returns JID for each registered number.',
    schema: CheckWhatsAppSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { phone_numbers } = CheckWhatsAppSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const results = await sock.onWhatsApp(...phone_numbers);
      return { results: results ?? [] };
    },
  };
}

// ---------------------------------------------------------------------------
// block_contact
// ---------------------------------------------------------------------------

const BlockContactSchema = z.object({
  jid: z.string(),
  action: z.enum(['block', 'unblock']),
});

function makeBlockContact(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'block_contact',
    description: 'Block or unblock a WhatsApp contact (global).',
    schema: BlockContactSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      const { jid, action } = BlockContactSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await sock.updateBlockStatus(jid, action);
      return { success: true, jid, action };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerProfileTools(
  getSock: () => WhatsAppSocket | null,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeGetProfilePicture(getSock));
  register(makeGetContactStatus(getSock));
  register(makeCheckWhatsApp(getSock));
  register(makeBlockContact(getSock));
}
