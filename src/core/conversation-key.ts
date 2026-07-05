import { DOMAIN_PERSONAL, DOMAIN_LID, DOMAIN_GROUP } from './jid-constants.ts';

/**
 * Reserved conversation-key-space sentinel for global-tier (non-chat) scopes:
 * tool_calls telemetry rows for operator-agent/primary-line sessions and the
 * runtime's global tool/crash scope keys. Never a real conversation.
 * toConversationKey refuses to mint it from a JID, so the reservation is
 * enforced, not assumed.
 */
export const GLOBAL_CONVERSATION_KEY = '__global__';

export function isGroupConversationKey(key: string): boolean {
  return key.includes('_at_g.us') || key.includes('@g.us')
}

export function conversationKeyToJid(key: string): string {
  return key.replace('_at_g.us', '@g.us')
}

export function toConversationKey(jid: string): string {
  if (!jid || !jid.includes('@')) {
    throw new Error(`Invalid JID: "${jid}" -- must contain @`);
  }

  const atIndex = jid.indexOf('@');
  const local = jid.substring(0, atIndex);
  if (!local) throw new Error(`Invalid JID: "${jid}" — empty local part`);
  const domain = jid.substring(atIndex + 1);

  switch (domain) {
    case DOMAIN_PERSONAL:
    case DOMAIN_LID: {
      // QR-027: the canonical conversation_key is a chat identity and must never
      // carry a device qualifier — strip the `:device` suffix for BOTH personal
      // and LID JIDs (previously only @lid stripped it, so a `123:5@s.whatsapp.net`
      // leaked the suffix into contacts.canonical_phone and missed the bare-phone
      // outbound warm-check). No-op for the common bare JID (no colon).
      const colonIndex = local.indexOf(':');
      const key = colonIndex >= 0 ? local.substring(0, colonIndex) : local;
      // Only this branch returns the bare local part, so only it could mint a
      // key colliding with the reserved global sentinel. Real WhatsApp JIDs
      // carry numeric locals; refuse rather than silently file a "chat" under
      // the global telemetry bucket.
      if (key === GLOBAL_CONVERSATION_KEY) {
        throw new Error(`Invalid JID: "${jid}" — local part collides with the reserved '${GLOBAL_CONVERSATION_KEY}' conversation key`);
      }
      return key;
    }
    case DOMAIN_GROUP:
      return `${local}_at_g.us`;
    default:
      return `${local}_at_${domain}`;
  }
}
