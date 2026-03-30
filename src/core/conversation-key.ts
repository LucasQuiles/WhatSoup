export function toConversationKey(jid: string): string {
  if (!jid || !jid.includes('@')) {
    throw new Error(`Invalid JID: "${jid}" -- must contain @`);
  }

  const atIndex = jid.indexOf('@');
  const local = jid.substring(0, atIndex);
  const domain = jid.substring(atIndex + 1);

  switch (domain) {
    case 's.whatsapp.net':
      return local;
    case 'lid': {
      const colonIndex = local.indexOf(':');
      return colonIndex >= 0 ? local.substring(0, colonIndex) : local;
    }
    case 'g.us':
      return `${local}_at_g.us`;
    default:
      return `${local}_at_${domain}`;
  }
}
