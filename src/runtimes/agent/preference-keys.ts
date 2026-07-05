import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { canonicalizeChatJid } from '../../core/lid-resolver.ts';
import type { Database } from '../../core/database.ts';

/**
 * Canonical identity keys for the per-sender preference store.
 *
 * Preference rows must ride the runtime's existing identity spine — never raw
 * wire JIDs, which alias (the same DM presents as `<n>@lid` before LID→PN
 * resolution and `<phone>@s.whatsapp.net` after; senders flip form the same
 * way and may carry `:device` suffixes). Raw keys split one human into two
 * rows and orphan preferences when the chat re-keys (handleJidAliasChanged).
 *
 * chatKey: the same canonicalization the runtime uses for its own per-chat
 * maps (resolvePerChatMapKey → canonicalizeChatJid — LID DMs resolve to the
 * phone JID when mapped, graceful pass-through otherwise).
 * senderKey: LID→PN resolution first, then the same jidNormalizedUser
 * predicate the poll/admin actor paths use (strips `:device` suffixes).
 */
export function preferenceKeys(
  db: Database,
  chatJid: string,
  senderJid: string,
): { chatKey: string; senderKey: string } {
  return {
    chatKey: canonicalizeChatJid(chatJid, db),
    senderKey: jidNormalizedUser(canonicalizeChatJid(senderJid, db)),
  };
}
