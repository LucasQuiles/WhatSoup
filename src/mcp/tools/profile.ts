// src/mcp/tools/profile.ts
// Profile, contact info, and block tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { ExtendedBaileysSocket } from '../types.ts';
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import { validateBase64Image } from '../../core/base64.ts';
import { type SockToolConfig, registerSockTools } from './sock-tool-factory.ts';

const log = createChildLogger('profile');

// ---------------------------------------------------------------------------
// Factory configs for the 13 standard sock-pattern tools
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- configs have heterogeneous ZodRawShape types; shared array requires any; expires 2026-12-31
const profileConfigs: SockToolConfig<any>[] = [
  {
    name: 'get_profile_picture',
    description:
      'Get the profile picture URL for a WhatsApp contact or group JID (global).',
    schema: z.object({
      jid: z.string(),
      type: z.enum(['preview', 'image']).optional(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid, type = 'preview' }, sock) => {
      const url = await sock.profilePictureUrl(jid, type);
      return { jid, url: url ?? null };
    },
  },
  {
    name: 'get_contact_status',
    description: "Fetch a WhatsApp contact's status message (global).",
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'read_only',
    call: async ({ jid }, sock) => {
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
  },
  {
    name: 'check_whatsapp',
    description:
      'Check which phone numbers are registered on WhatsApp (global). Returns JID for each registered number.',
    schema: z.object({
      phone_numbers: z.array(z.string()),
    }),
    replayPolicy: 'read_only',
    call: async ({ phone_numbers }, sock) => {
      const results = await sock.onWhatsApp(...phone_numbers);
      return { results: results ?? [] };
    },
  },
  {
    name: 'block_contact',
    description: 'Block or unblock a WhatsApp contact (global).',
    schema: z.object({
      jid: z.string(),
      action: z.enum(['block', 'unblock']),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, action }, sock) => {
      await sock.updateBlockStatus(jid, action);
      return { success: true, jid, action };
    },
  },
  {
    name: 'update_profile_picture',
    description: 'Update the profile picture for a JID (own account or group). Content is base64-encoded image data (global).',
    schema: z.object({
      jid: z.string(),
      content: z.string().describe('Base64-encoded image content'),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, content }, sock) => {
      const cleanContent = validateBase64Image(content);
      const buffer = Buffer.from(cleanContent, 'base64');
      await sock.updateProfilePicture(jid, buffer);
      return { success: true, jid };
    },
  },
  {
    name: 'remove_profile_picture',
    description: 'Remove the profile picture for a JID (own account or group) (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.removeProfilePicture(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'update_profile_status',
    description: "Update your own WhatsApp profile status (about/bio text) (global).",
    schema: z.object({
      status: z.string().describe('New status text (about/bio)'),
    }),
    replayPolicy: 'safe',
    call: async ({ status }, sock) => {
      await sock.updateProfileStatus(status);
      return { success: true, status };
    },
  },
  {
    name: 'update_profile_name',
    description: 'Update your own WhatsApp display name (global).',
    schema: z.object({
      name: z.string().describe('New display name'),
    }),
    replayPolicy: 'safe',
    call: async ({ name }, sock) => {
      await sock.updateProfileName(name);
      return { success: true, name };
    },
  },
  {
    name: 'update_privacy_settings',
    description:
      'Update a specific WhatsApp privacy setting. Use setting to specify which privacy option and value for the new setting (global).',
    schema: z.object({
      setting: z.enum([
        'last_seen',
        'online',
        'profile_picture',
        'status',
        'read_receipts',
        'groups_add',
        'call',
        'messages',
        'link_previews',
        'default_disappearing',
      ]),
      value: z
        .string()
        .describe(
          [
            'Value for the chosen setting:',
            '  last_seen / profile_picture / status: "all" | "contacts" | "contact_blacklist" | "none"',
            '  online: "all" | "match_last_seen"',
            '  groups_add: "all" | "contacts" | "contact_blacklist"',
            '  read_receipts: "all" | "none"',
            '  call: "all" | "known"',
            '  messages: "all" | "contacts"',
            '  link_previews: "true" | "false"',
            '  default_disappearing: duration seconds as string, e.g. "0", "86400", "604800", "7776000"',
          ].join('\n'),
        )
        .superRefine((val, ctx) => {
          // Setting-specific validation is deferred to the handler because zod
          // doesn't have access to the sibling `setting` field here without
          // using z.discriminatedUnion or a top-level refine. Validation is
          // performed in the handler instead.
          void val;
          void ctx;
        }),
    }),
    replayPolicy: 'safe',
    call: async ({ setting, value }, sock) => {
      // Per-setting value validation (strict enum settings only).
      // link_previews and default_disappearing accept free-form values and are not validated here.
      const stdPrivacy = ['all', 'contacts', 'contact_blacklist', 'none'] as const;
      const strictValidValues: Record<string, readonly string[]> = {
        last_seen: stdPrivacy,
        profile_picture: stdPrivacy,
        status: stdPrivacy,
        online: ['all', 'match_last_seen'],
        groups_add: ['all', 'contacts', 'contact_blacklist'],
        read_receipts: ['all', 'none'],
        call: ['all', 'known'],
        messages: ['all', 'contacts'],
      };

      const allowed = strictValidValues[setting];
      if (allowed && !allowed.includes(value)) {
        throw new Error(
          `Invalid value "${value}" for setting "${setting}". Valid values: ${allowed.join(', ')}`,
        );
      }

      // Baileys exposes individual privacy methods, not a unified updatePrivacySettings
      switch (setting) {
        case 'last_seen': await sock.updateLastSeenPrivacy(value); break;
        case 'online': await sock.updateOnlinePrivacy(value); break;
        case 'profile_picture': await sock.updateProfilePicturePrivacy(value); break;
        case 'status': await sock.updateStatusPrivacy(value); break;
        case 'read_receipts': await sock.updateReadReceiptsPrivacy(value); break;
        case 'groups_add': await sock.updateGroupsAddPrivacy(value); break;
        case 'call': await sock.updateCallPrivacy(value); break;
        case 'messages': await sock.updateMessagesPrivacy(value); break;
        case 'link_previews': await sock.updateDisableLinkPreviewsPrivacy(value === 'true' || value === '1'); break;
        case 'default_disappearing': await sock.updateDefaultDisappearingMode(parseInt(value, 10) || 0); break;
        default: throw new Error(`Unknown privacy setting: ${setting}`);
      }
      return { success: true, setting, value };
    },
  },
  {
    name: 'get_privacy_settings',
    description: 'Fetch all current WhatsApp privacy settings (global).',
    schema: z.object({}),
    replayPolicy: 'read_only',
    call: async (_parsed, sock) => {
      const settings = await sock.fetchPrivacySettings();
      return { settings: settings ?? null };
    },
  },
  {
    name: 'add_or_edit_contact',
    description: 'Add a new contact or edit an existing contact in the WhatsApp address book (global).',
    schema: z.object({
      jid: z.string(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      company: z.string().optional(),
      phone: z.string().optional(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid, firstName, lastName, company, phone }, sock) => {
      const contactAction: Record<string, string> = {};
      if (firstName !== undefined) contactAction.firstName = firstName;
      if (lastName !== undefined) contactAction.lastName = lastName;
      if (company !== undefined) contactAction.company = company;
      if (phone !== undefined) contactAction.phone = phone;

      await sock.addOrEditContact(jid, contactAction);
      return { success: true, jid };
    },
  },
  {
    name: 'remove_contact',
    description: 'Remove a contact from the WhatsApp address book (global).',
    schema: z.object({
      jid: z.string(),
    }),
    replayPolicy: 'safe',
    call: async ({ jid }, sock) => {
      await sock.removeContact(jid);
      return { success: true, jid };
    },
  },
  {
    name: 'fetch_disappearing_duration',
    description: 'Fetch the disappearing message duration for one or more JIDs (global).',
    schema: z.object({
      jids: z.array(z.string()).min(1).describe('One or more JIDs to query disappearing message duration for'),
    }),
    replayPolicy: 'read_only',
    call: async ({ jids }, sock) => {
      const result = await sock.fetchDisappearingDuration(...jids);
      return { result: result ?? null };
    },
  },
];

// ---------------------------------------------------------------------------
// get_blocklist — custom handler (live fetch with DB fallback)
// ---------------------------------------------------------------------------

function makeGetBlocklist(getSock: () => ExtendedBaileysSocket | null, db: Database): ToolDeclaration {
  return {
    name: 'get_blocklist',
    description: 'Fetch the list of blocked contacts (global). Returns live data when connected, cached DB data otherwise.',
    schema: z.object({}),
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (_params) => {
      const sock = getSock();

      if (sock) {
        // Live fetch — also sync to DB
        try {
          const live = await sock.fetchBlocklist();
          const jids = Array.isArray(live) ? live : [];
          return { blocklist: jids, source: 'live' };
        } catch (err) {
          log.warn({ err }, 'live blocklist fetch failed, falling back to DB');
        }
      }

      // Fallback: read from DB
      const rows = db.raw
        .prepare('SELECT jid FROM blocklist ORDER BY blocked_at')
        .all() as Array<{ jid: string }>;
      return { blocklist: rows.map(r => r.jid), source: 'cached' };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerProfileTools(
  getSock: () => ExtendedBaileysSocket | null,
  db: Database,
  register: (tool: ToolDeclaration) => void,
): void {
  registerSockTools(getSock, profileConfigs, register);
  register(makeGetBlocklist(getSock, db));
}
