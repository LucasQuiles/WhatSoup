import { DOMAIN_PERSONAL, DOMAIN_LID, DOMAIN_GROUP } from './jid-constants.ts';

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
      return local;
    case DOMAIN_LID: {
      const colonIndex = local.indexOf(':');
      return colonIndex >= 0 ? local.substring(0, colonIndex) : local;
    }
    case DOMAIN_GROUP:
      return `${local}_at_g.us`;
    default:
      return `${local}_at_${domain}`;
  }
}
