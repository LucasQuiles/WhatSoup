import {
  DOMAIN_PERSONAL,
  DOMAIN_LID,
  DOMAIN_GROUP,
  JID_IMESSAGE,
  fromImessageJid,
  hasKnownTransportJidSuffix,
  isGroupJid,
} from './jid-constants.ts';

/**
 * Reserved conversation-key-space sentinel for global-tier (non-chat) scopes:
 * tool_calls telemetry rows for operator-agent/primary-line sessions and the
 * runtime's global tool/crash scope keys. Never a real conversation.
 * toConversationKey refuses to mint it from a JID, so the reservation is
 * enforced, not assumed.
 */
export const GLOBAL_CONVERSATION_KEY = '__global__';

/** Distinguish supported raw JIDs from encoded keys that may themselves contain @. */
export function isRawTransportJidReference(ref: string): boolean {
  if (!hasKnownTransportJidSuffix(ref)) return false;
  // The deployed AppleID key encoding replaces the AppleID's @ and therefore
  // ends in @imessage with only one at-sign.
  if (
    ref.endsWith('@imessage')
    && ref.includes('_at_')
    && ref.indexOf('@') === ref.lastIndexOf('@')
  ) return false;
  return true;
}

/** Accept a raw supported JID or a transport-neutral conversation key. */
export function conversationRefToJid(ref: string): string {
  return isRawTransportJidReference(ref) ? ref : conversationKeyToJid(ref);
}

/** Normalize raw or alternate references to the deployed conversation key. */
export function conversationRefToKey(ref: string): string {
  if (isRawTransportJidReference(ref)) return toConversationKey(ref);
  const jid = conversationKeyToJid(ref);
  return jid === ref ? ref : toConversationKey(jid);
}

export function isGroupConversationKey(key: string): boolean {
  return isGroupJid(conversationRefToJid(key));
}

export function conversationKeyToJid(key: string): string {
  const separator = key.lastIndexOf('_at_');
  if (separator <= 0 || separator + 4 >= key.length) return key;
  return `${key.slice(0, separator)}@${key.slice(separator + 4)}`;
}

export function toConversationKey(jid: string): string {
  if (!jid || !jid.includes('@')) {
    throw new Error(`Invalid JID: "${jid}" -- must contain @`);
  }

  const normalizedJid = jid.endsWith(JID_IMESSAGE)
    ? `${fromImessageJid(jid)}${JID_IMESSAGE}`
    : jid;

  // Preserve the deployed encoding for identities whose local address contains
  // an @ (notably AppleID email): owner@example.test@imessage becomes
  // owner_at_example.test@imessage. Changing this would split existing
  // conversation-indexed history and session state without a database migration.
  const atIndex = normalizedJid.indexOf('@');
  const local = normalizedJid.substring(0, atIndex);
  if (!local) throw new Error(`Invalid JID: "${jid}" — empty local part`);
  const domain = normalizedJid.substring(atIndex + 1);

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
