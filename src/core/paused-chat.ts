// src/core/paused-chat.ts
// The paused-chat admission rule: whether ingest dispatches a message in a chat
// listed in config.pausedChats. Ingest applies it to every inbound message. The
// queued-turn receipt asks the same rule before it tells a reader to send /stop,
// so the receipt never offers a command that ingest would drop.

import RE2 from 're2';
import { createChildLogger } from '../logger.ts';
import { config } from '../config.ts';

const log = createChildLogger('paused-chat');

// Cache keyed on the config array reference: patterns compile once at first
// use (or after a config swap), never per-message. An entry that fails to
// compile is dropped with a single warn here — the validator rejects bad
// regex at startup, this is the defensive runtime backstop so a bad entry
// can never throw inside ingest.
let pausedChatBypassCache: { source: readonly string[]; regexes: RegExp[] } | null = null;

function getPausedChatBypassRegexes(): RegExp[] {
  const source = config.pausedChatBypassPatterns ?? [];
  if (pausedChatBypassCache?.source === source) return pausedChatBypassCache.regexes;
  const regexes: RegExp[] = [];
  for (const pattern of source) {
    try {
      // RE2 (linear-time, no backtracking): operator patterns run against
      // member-supplied content, so the match engine must be ReDoS-safe. The
      // validator compiles with the same engine, so a validated config always
      // lands here — this try/catch stays as the defensive runtime backstop.
      regexes.push(new RE2(pattern, 'i'));
    } catch (err) {
      log.warn({ err, pattern }, 'invalid pausedChatBypassPatterns entry — skipping');
    }
  }
  pausedChatBypassCache = { source, regexes };
  return regexes;
}

// Operator patterns run against member-supplied content from paused (usually
// bot-noise) groups, so bound the tested window: a backtracking-heavy pattern
// against a crafted long message must not stall ingest. Directed-traffic
// markers sit at the head of a message in practice.
const PAUSED_CHAT_BYPASS_SCAN_LIMIT = 4096;

/** True when paused-chat content matches a configured bypass pattern. Null/absent content (media) never matches. */
function matchesPausedChatBypass(content: string | null | undefined): boolean {
  if (!content) return false;
  const scanWindow = content.slice(0, PAUSED_CHAT_BYPASS_SCAN_LIMIT);
  return getPausedChatBypassRegexes().some((re) => re.test(scanWindow));
}

/**
 * How the paused-chat rule treats `content` in this chat:
 * - 'not_paused': neither the conversation key nor the chat JID is listed in
 *   pausedChats.
 * - 'bypassed': the chat is paused, but the content matches a
 *   pausedChatBypassPatterns entry, so it dispatches as if the chat were not
 *   paused.
 * - 'held': the chat is paused and the content matches no bypass pattern, so
 *   ingest stores it and does not dispatch it.
 * The bypass patterns are read and matched only for a paused chat. Admin
 * commands are exempt in ingest itself, which checks them separately.
 */
export function pausedChatAdmission(
  chat: { readonly conversationKey: string; readonly chatJid: string },
  content: string | null | undefined,
): 'not_paused' | 'bypassed' | 'held' {
  const pausedChats = config.pausedChats ?? new Set<string>();
  if (!pausedChats.has(chat.conversationKey) && !pausedChats.has(chat.chatJid)) return 'not_paused';
  return matchesPausedChatBypass(content) ? 'bypassed' : 'held';
}
