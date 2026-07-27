// F-STICKY-ACTOR (QR-247) / conversation-bound confinement: SessionContext
// builder for the per-chat actor socket (runtime.ts createPerChatActorSocket).
// Extracted so the two shapes — and the invariant that the default shape is
// EXACTLY the #1785 rec-3 status quo — are unit-testable without the runtime.

import { toConversationKey } from '../../core/conversation-key.ts';
import { makeConversationBinding, type SessionContext } from '../../mcp/types.ts';

/**
 * Build the per-chat actor socket's base SessionContext.
 *
 * `conversationBound=false` (default): the #1785 rec-3 shape, unchanged —
 * tier:'global' with a statically pinned conversationKey (injected-send
 * confinement only). `conversationBound=true`: additionally carries the
 * frozen conversation binding; the enforcement semantics live at the
 * CONVERSATION_SAFE_GLOBAL_TOOLS block in src/mcp/registry.ts.
 */
export function perChatActorSession(
  conversationJid: string,
  allowedRoot: string,
  conversationBound: boolean,
  deliveryJid: string = conversationJid,
): SessionContext {
  const conversationKey = toConversationKey(conversationJid);
  if (!conversationBound) {
    return { tier: 'global', allowedRoot, conversationKey };
  }
  return {
    tier: 'global',
    allowedRoot,
    conversationKey,
    deliveryJid,
    binding: makeConversationBinding(conversationKey, deliveryJid),
  };
}
