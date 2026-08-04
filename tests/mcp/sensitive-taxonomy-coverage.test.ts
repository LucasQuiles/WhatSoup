/**
 * Coverage guard for the R1 sensitive-tool taxonomy on global caller-supplied
 * tools. This is a RATCHET — zero behavior change. Every tool with
 * scope:'global' + targetMode:'caller-supplied' must either carry
 * sensitive: true OR be listed in the reviewed allowlist below with an
 * explicit review reason.
 *
 * Adding a tool to the allowlist requires either (a) flipping sensitive: true
 * on the declaration after per-tool owner review, or (b) recording the
 * reviewed justification here. Never add silently.
 */
import { describe, it, expect } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Minimal ConnectionManager mock — mirrors register-all.test.ts
// ---------------------------------------------------------------------------

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

/**
 * Allowlist for global caller-supplied tools that are NOT yet flagged
 * sensitive: true. Each entry documents the reviewed justification.
 *
 * ➡ To remove an entry, either:
 *    1. Set sensitive: true on the tool declaration (preferred — the
 *       R1 gate then enforces it), or
 *    2. Record an explicit review decision here approving the exception.
 *
 * NEVER add a tool silently.
 */
const REVIEWED_GRANDFATHERED: string[] = [
  // Tools awaiting per-tool owner review (#2773 P2 residual). Each must be
  // evaluated individually: either flagged sensitive: true or have a recorded
  // reason here explaining why the flag is not needed.
  'add_or_edit_contact',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'add_or_edit_quick_reply',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'archive_chat',                // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'block_contact',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'check_whatsapp',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'cleanup_media',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_create',            // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_create_group',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_fetch_all_participating', // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_fetch_linked_groups',    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_invite_code',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_leave',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_link_group',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_metadata',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_participants_update',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_settings_update',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_unlink_group',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'community_update_metadata',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'create_call_link',            // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'download_media',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'fetch_disappearing_duration', // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'fetch_message_history',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'forward_message',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_activity',                // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_bead',                    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_blocklist',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_bots_list',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_business_profile',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_catalog',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_chat',                    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_collections',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_contact_status',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_group_invite_link',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_group_metadata',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_message_receipts',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_order_details',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_presence',                // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_privacy_settings',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_profile',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_profile_picture',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'get_reactions',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_accept_invite',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_create',                // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_get_invite_info',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_join_approval_mode',    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_leave',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_member_add_mode',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_participants_update',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_request_participants_list',  // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_request_participants_update', // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_revoke_invite',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_revoke_invite_v4',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_settings_update',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_toggle_ephemeral',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_update_description',    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'group_update_subject',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_beads',                  // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_chats',                  // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_entities',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_groups',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_statuses',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'list_triggers',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'logout',                      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'manage_labels',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'mark_messages_read',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'mute_chat',                   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_admin_count',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_change_owner',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_create',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_delete',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_demote',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_fetch_messages',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_follow',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_metadata',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_mute',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_react_message',    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_remove_picture',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_subscribers',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_unfollow',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_unmute',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_update',           // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_update_description',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_update_name',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'newsletter_update_picture',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'pin_chat',                    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'post_status',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'product_create',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'product_delete',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'product_update',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'read_outbound_sends',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'reject_call',                 // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'relay_message',               // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'remove_contact',              // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'remove_cover_photo',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'remove_profile_picture',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'remove_quick_reply',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'request_pairing_code',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'request_phone_number',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'request_placeholder_resend',  // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'reset_enrichment_errors',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'resync_app_state',            // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'search_contacts',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'search_messages',             // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'search_messages_advanced',    // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'send_product_message',        // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'set_disappearing_messages',   // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'share_phone_number',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'star_message',                // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'subscribe_newsletter_updates', // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'subscribe_presence',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'transcribe_audio',            // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_business_profile',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_cover_photo',          // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_privacy_settings',     // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_profile_name',         // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_profile_picture',      // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_profile_status',       // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
  'update_push_name',            // grandfathered 2026-08-04 pending per-tool review (#2773 P2 residual)
];

describe('sensitive-tool taxonomy coverage', () => {
  it('every global caller-supplied tool is sensitive:true or reviewed', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();

    // Capture every ToolDeclaration as it registers (same interceptor as
    // register-all.test.ts's scope/replayPolicy check).
    const captured: ToolDeclaration[] = [];
    const origRegister = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      captured.push(tool);
      origRegister(tool);
    };

    registerAllTools(registry, makeConnection(), db);
    db.raw.close();

    // Collect offenders: global + caller-supplied tools without sensitive:true
    // that are NOT in the reviewed allowlist.
    const offenders = captured
      .filter((t) => t.scope === 'global' && t.targetMode === 'caller-supplied')
      .filter((t) => !t.sensitive && !REVIEWED_GRANDFATHERED.includes(t.name))
      .map((t) => t.name)
      .sort();

    expect(
      offenders,
      `global caller-supplied tools missing sensitive:true or reviewed-allowlist entry:\n${
        offenders.join('\n')
      }`,
    ).toEqual([]);
  });
});
