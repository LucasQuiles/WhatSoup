// src/mcp/tools/profile.ts
// Profile, contact info, and block tools (all global scope).

import { z } from 'zod';
import type { ToolDeclaration } from '../types.ts';
import type { WhatsAppSocket } from '../../transport/connection.ts';
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import { validateBase64Image } from '../../core/base64.ts';

const log = createChildLogger('profile');

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
    replayPolicy: 'read_only',
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
    replayPolicy: 'read_only',
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
    replayPolicy: 'read_only',
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
    replayPolicy: 'safe',
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
// update_profile_picture
// ---------------------------------------------------------------------------

const UpdateProfilePictureSchema = z.object({
  jid: z.string(),
  content: z.string().describe('Base64-encoded image content'),
});

function makeUpdateProfilePicture(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_profile_picture',
    description: 'Update the profile picture for a JID (own account or group). Content is base64-encoded image data (global).',
    schema: UpdateProfilePictureSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, content } = UpdateProfilePictureSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const cleanContent = validateBase64Image(content);
      const buffer = Buffer.from(cleanContent, 'base64');
      await (sock as any).updateProfilePicture(jid, buffer);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// remove_profile_picture
// ---------------------------------------------------------------------------

const RemoveProfilePictureSchema = z.object({
  jid: z.string(),
});

function makeRemoveProfilePicture(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'remove_profile_picture',
    description: 'Remove the profile picture for a JID (own account or group) (global).',
    schema: RemoveProfilePictureSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = RemoveProfilePictureSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await (sock as any).removeProfilePicture(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// update_profile_status
// ---------------------------------------------------------------------------

const UpdateProfileStatusSchema = z.object({
  status: z.string().describe('New status text (about/bio)'),
});

function makeUpdateProfileStatus(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_profile_status',
    description: "Update your own WhatsApp profile status (about/bio text) (global).",
    schema: UpdateProfileStatusSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { status } = UpdateProfileStatusSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await (sock as any).updateProfileStatus(status);
      return { success: true, status };
    },
  };
}

// ---------------------------------------------------------------------------
// update_profile_name
// ---------------------------------------------------------------------------

const UpdateProfileNameSchema = z.object({
  name: z.string().describe('New display name'),
});

function makeUpdateProfileName(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_profile_name',
    description: 'Update your own WhatsApp display name (global).',
    schema: UpdateProfileNameSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { name } = UpdateProfileNameSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await (sock as any).updateProfileName(name);
      return { success: true, name };
    },
  };
}

// ---------------------------------------------------------------------------
// update_privacy_settings
// ---------------------------------------------------------------------------

// Per-setting valid values matching Baileys WAPrivacy* types.
// last_seen, profile_picture, status: WAPrivacyValue = 'all' | 'contacts' | 'contact_blacklist' | 'none'
// online: WAPrivacyOnlineValue = 'all' | 'match_last_seen'
// groups_add: WAPrivacyGroupAddValue = 'all' | 'contacts' | 'contact_blacklist'
// read_receipts: WAReadReceiptsValue = 'all' | 'none'
// call: WAPrivacyCallValue = 'all' | 'known'
// messages: WAPrivacyMessagesValue = 'all' | 'contacts'
// link_previews: boolean string — 'true' / 'false' / '1' / '0'
// default_disappearing: duration in seconds as a numeric string, e.g. '0', '86400', '604800', '7776000'

const UpdatePrivacySettingsSchema = z.object({
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
});

function makeUpdatePrivacySettings(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'update_privacy_settings',
    description:
      'Update a specific WhatsApp privacy setting. Use setting to specify which privacy option and value for the new setting (global).',
    schema: UpdatePrivacySettingsSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { setting, value } = UpdatePrivacySettingsSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

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
      const s = sock as any;
      switch (setting) {
        case 'last_seen': await s.updateLastSeenPrivacy(value); break;
        case 'online': await s.updateOnlinePrivacy(value); break;
        case 'profile_picture': await s.updateProfilePicturePrivacy(value); break;
        case 'status': await s.updateStatusPrivacy(value); break;
        case 'read_receipts': await s.updateReadReceiptsPrivacy(value); break;
        case 'groups_add': await s.updateGroupsAddPrivacy(value); break;
        case 'call': await s.updateCallPrivacy(value); break;
        case 'messages': await s.updateMessagesPrivacy(value); break;
        case 'link_previews': await s.updateDisableLinkPreviewsPrivacy(value === 'true' || value === '1'); break;
        case 'default_disappearing': await s.updateDefaultDisappearingMode(parseInt(value, 10) || 0); break;
        default: throw new Error(`Unknown privacy setting: ${setting}`);
      }
      return { success: true, setting, value };
    },
  };
}

// ---------------------------------------------------------------------------
// get_privacy_settings
// ---------------------------------------------------------------------------

function makeGetPrivacySettings(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'get_privacy_settings',
    description: 'Fetch all current WhatsApp privacy settings (global).',
    schema: z.object({}),
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (_params) => {
      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const settings = await (sock as any).fetchPrivacySettings();
      return { settings: settings ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// get_blocklist
// ---------------------------------------------------------------------------

function makeGetBlocklist(getSock: () => WhatsAppSocket | null, db: Database): ToolDeclaration {
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
          const live = await (sock as any).fetchBlocklist();
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
// add_or_edit_contact
// ---------------------------------------------------------------------------

const AddOrEditContactSchema = z.object({
  jid: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
});

function makeAddOrEditContact(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'add_or_edit_contact',
    description: 'Add a new contact or edit an existing contact in the WhatsApp address book (global).',
    schema: AddOrEditContactSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid, firstName, lastName, company, phone } = AddOrEditContactSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const contactAction: Record<string, string> = {};
      if (firstName !== undefined) contactAction.firstName = firstName;
      if (lastName !== undefined) contactAction.lastName = lastName;
      if (company !== undefined) contactAction.company = company;
      if (phone !== undefined) contactAction.phone = phone;

      await (sock as any).addOrEditContact(jid, contactAction);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// remove_contact
// ---------------------------------------------------------------------------

const RemoveContactSchema = z.object({
  jid: z.string(),
});

function makeRemoveContact(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'remove_contact',
    description: 'Remove a contact from the WhatsApp address book (global).',
    schema: RemoveContactSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'safe',
    handler: async (params) => {
      const { jid } = RemoveContactSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      await (sock as any).removeContact(jid);
      return { success: true, jid };
    },
  };
}

// ---------------------------------------------------------------------------
// fetch_disappearing_duration
// ---------------------------------------------------------------------------

const FetchDisappearingDurationSchema = z.object({
  jids: z.array(z.string()).min(1).describe('One or more JIDs to query disappearing message duration for'),
});

function makeFetchDisappearingDuration(getSock: () => WhatsAppSocket | null): ToolDeclaration {
  return {
    name: 'fetch_disappearing_duration',
    description: 'Fetch the disappearing message duration for one or more JIDs (global).',
    schema: FetchDisappearingDurationSchema,
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'read_only',
    handler: async (params) => {
      const { jids } = FetchDisappearingDurationSchema.parse(params);

      const sock = getSock();
      if (!sock) {
        throw new Error('WhatsApp is not connected');
      }

      const result = await (sock as any).fetchDisappearingDuration(...jids);
      return { result: result ?? null };
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function registerProfileTools(
  getSock: () => WhatsAppSocket | null,
  db: Database,
  register: (tool: ToolDeclaration) => void,
): void {
  register(makeGetProfilePicture(getSock));
  register(makeGetContactStatus(getSock));
  register(makeCheckWhatsApp(getSock));
  register(makeBlockContact(getSock));
  register(makeUpdateProfilePicture(getSock));
  register(makeRemoveProfilePicture(getSock));
  register(makeUpdateProfileStatus(getSock));
  register(makeUpdateProfileName(getSock));
  register(makeUpdatePrivacySettings(getSock));
  register(makeGetPrivacySettings(getSock));
  register(makeGetBlocklist(getSock, db));
  register(makeAddOrEditContact(getSock));
  register(makeRemoveContact(getSock));
  register(makeFetchDisappearingDuration(getSock));
}
