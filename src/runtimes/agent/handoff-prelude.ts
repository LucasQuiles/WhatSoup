/**
 * Cross-harness handoff prelude composer.
 *
 * When a conversation fails over to a stand-in provider, its session ID is not
 * shareable, so the stand-in starts fresh. To continue with context rather than
 * cold, we seed it across two seams by content type:
 *  - **stable context** (distilled summary + seeded artifacts) → the system
 *    prompt (the only carrier that survives a fresh, non-resumable session);
 *  - **recent verbatim messages** → the first replay turn (conversational
 *    history belongs in a turn, not in steering context).
 *
 * Pure over injected sources (no DB, no LLM, no clock) so the policy decisions
 * are unit-testable. The store / distiller / runtime supply the artifact,
 * messages, clock, and redactor.
 *
 * Consensus-hardening encoded here:
 *  - **Cost-compression**: verbatim is emitted only on the first stand-in turn;
 *    summary-only thereafter — and summary-only even on the first turn when the
 *    backup context window is the same-or-smaller than the primary's.
 *  - **Staleness guard**: a summary older than the TTL is *worse than none*
 *    (it misleads the stand-in), so a stale artifact's summary is dropped; the
 *    verbatim window covers the gap.
 *  - **Degrade-to-verbatim**: a missing/empty artifact yields a null system
 *    block but still a verbatim first-turn block — the handoff never hard-depends
 *    on the artifact.
 *  - **PII**: the injected `redact` is applied to summary and every verbatim
 *    line before they cross into a different provider's prompt.
 */

import type { StoredMessage } from '../../core/messages.ts';

/** Minimal projection of a stored message the composer needs (reuses the core type). */
export type HandoffMessage = Pick<StoredMessage, 'senderName' | 'isFromMe' | 'content'>;

export interface HandoffArtifact {
  conversationKey: string;
  summary: string | null;
  seededArtifacts: string | null;
  /** epoch ms of the last distill. */
  updatedAt: number;
  sourceProvider: string;
  sourceModel: string | null;
  tokenBaseline: number;
}

export interface BuildHandoffPreludeArgs {
  artifact: HandoffArtifact | null;
  /** Chronological (oldest→newest), as getRecentMessages returns. */
  recentMessages: HandoffMessage[];
  verbatimN: number;
  isFirstStandInTurn: boolean;
  backupContextWindow: 'unknown' | 'same_or_smaller' | 'larger';
  now: number;
  staleAfterMs: number;
  redact: (text: string) => string;
}

export interface HandoffPrelude {
  /** Stable context for the system prompt, or null when none is usable. */
  systemBlock: string | null;
  /** Verbatim recent-history block for the first replay turn, or null. */
  firstTurnBlock: string | null;
}

const RECENT_CONTEXT_HEADER = '[Recent chat context — read before responding]';
const HANDOFF_SUMMARY_HEADER = '[Handoff context — prior conversation summary]';

function composeSystemBlock(args: BuildHandoffPreludeArgs): string | null {
  const { artifact, now, staleAfterMs, redact } = args;
  if (!artifact) return null;
  // A stale summary misleads the stand-in — drop it and rely on verbatim.
  if (now - artifact.updatedAt > staleAfterMs) return null;

  const parts: string[] = [];
  const summary = artifact.summary?.trim();
  if (summary) parts.push(redact(summary));
  const seeded = artifact.seededArtifacts?.trim();
  if (seeded) parts.push(redact(seeded));
  if (parts.length === 0) return null;
  return `${HANDOFF_SUMMARY_HEADER}\n${parts.join('\n\n')}`;
}

function composeFirstTurnBlock(args: BuildHandoffPreludeArgs): string | null {
  // Cost-compression: verbatim only on the first stand-in turn, and never when
  // the backup window is the same-or-smaller (summary-only there).
  if (!args.isFirstStandInTurn) return null;
  if (args.backupContextWindow === 'same_or_smaller') return null;
  if (args.verbatimN <= 0) return null;

  const window = args.recentMessages.slice(-args.verbatimN);
  const lines: string[] = [];
  for (const msg of window) {
    const content = msg.content?.trim();
    if (!content) continue;
    const who = msg.isFromMe ? 'Assistant' : (msg.senderName?.trim() || 'User');
    const line = `${who}: ${args.redact(content)}`;
    // Drop exact-adjacent duplicates (repeated identical messages).
    if (lines.length > 0 && lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  if (lines.length === 0) return null;
  return `${RECENT_CONTEXT_HEADER}\n${lines.join('\n')}`;
}

export function buildHandoffPrelude(args: BuildHandoffPreludeArgs): HandoffPrelude {
  return {
    systemBlock: composeSystemBlock(args),
    firstTurnBlock: composeFirstTurnBlock(args),
  };
}
