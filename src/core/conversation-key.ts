import { DOMAIN_PERSONAL, DOMAIN_LID, DOMAIN_GROUP } from './jid-constants.ts';

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
      return colonIndex >= 0 ? local.substring(0, colonIndex) : local;
    }
    case DOMAIN_GROUP:
      return `${local}_at_g.us`;
    default:
      return `${local}_at_${domain}`;
  }
}
