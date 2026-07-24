// src/runtimes/agent/handoff-notice-prefix.ts
// Handoff-notice prefix helpers for the consolidated one-message handoff.
//
// When a provider fallback schedules a stand-in replay, the structured status
// line is stashed (not sent on its own) and prepended — once — to the stand-in's
// first visible reply, so the user sees ONE message instead of a notice plus an
// answer. These helpers are the thin, stateless delegators over the SQLite-backed
// standby-notice latch (standby-notice.ts): they own the conversation-key
// derivation and the one-message feature gate, and never throw into the
// reply/turn path. Extracted from AgentRuntime as pure functions taking the
// Database explicitly so the persistence seam stays visible and unit-testable.

import { toConversationKey } from '../../core/conversation-key.ts';
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';

import { oneMessageHandoffEnabled } from './fallback-config.ts';
import type { IOutboundQueue } from './outbound-queue.ts';
import { consumeStandbyNotice, stashStandbyNotice } from './standby-notice.ts';

// This logic is a pure extraction from AgentRuntime, so retain the existing
// component binding for operator filters and handoff diagnostics.
const log = createChildLogger('agent-runtime');

/** Stash the handoff notice for prepend-on-first-reply. Returns false on failure. */
export function stashHandoffNotice(db: Database, chatJid: string, message: string, now: number): boolean {
  try {
    stashStandbyNotice(db, toConversationKey(chatJid), message, now);
    return true;
  } catch (err) {
    log.warn({ err, chatJid }, 'failed to stash handoff notice — sending standalone');
    return false;
  }
}

/**
 * Prepend a pending handoff notice (if any) to a stand-in reply, collapsing the
 * fallback notice and the reply into one message. No-op when the flag is off or
 * no notice is pending. Never throws into the reply path.
 */
export function withHandoffPrefix(db: Database, chatJid: string, text: string): string {
  if (!oneMessageHandoffEnabled()) return text;
  let prefix: string | null = null;
  try {
    prefix = consumeStandbyNotice(db, toConversationKey(chatJid));
  } catch (err) {
    log.warn({ err, chatJid }, 'failed to consume handoff notice');
    return text;
  }
  return prefix ? `${prefix}\n\n${text}` : text;
}

/**
 * Flush a still-pending handoff notice as a standalone message at turn end.
 * Closes the empty-turn gap: if the stand-in's turn produced no visible reply,
 * {@link withHandoffPrefix} never consumed the notice, so it would otherwise
 * defer to the next reply. Consume-once means this is a no-op when a reply
 * already prepended the notice this turn. Never throws into the turn.
 */
export function flushPendingHandoffNotice(db: Database, queue: IOutboundQueue): void {
  if (!oneMessageHandoffEnabled()) return;
  let pending: string | null = null;
  try {
    pending = consumeStandbyNotice(db, toConversationKey(queue.targetChatJid));
  } catch (err) {
    log.warn({ err, chatJid: queue.targetChatJid }, 'failed to flush pending handoff notice');
    return;
  }
  if (pending) queue.enqueueText(pending);
}
