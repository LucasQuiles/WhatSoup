import { sanitizeProviderPreviewText } from './provider-preview-sanitizer.ts';

export interface ContextLineMessage {
  timestamp: number;
  senderName: string | null;
  senderJid: string;
  content: string | null;
}

// Formatted context is injected into BRAND-NEW provider sessions (fresh-turn
// preamble, missed-message injection, respawn context recovery). Without a
// budget, a single oversized chat message re-overflows the fresh session and
// the context-overflow kill-and-respawn cycle never converges (observed live
// 2026-08-25: giant document-sized messages re-injected verbatim). Both caps
// are load-bearing; the total stays far below any provider context floor.
export const CONTEXT_LINE_MAX_CHARS_PER_MESSAGE = 1500;
export const CONTEXT_LINE_MAX_TOTAL_CHARS = 12000;

function capMessageText(text: string): string {
  if (text.length <= CONTEXT_LINE_MAX_CHARS_PER_MESSAGE) return text;
  const omitted = text.length - CONTEXT_LINE_MAX_CHARS_PER_MESSAGE;
  return `${text.slice(0, CONTEXT_LINE_MAX_CHARS_PER_MESSAGE)}… [truncated ${omitted} chars]`;
}

/** Format recent chat context; callers control chronological ordering. */
export function formatContextLines(
  messages: ReadonlyArray<ContextLineMessage>,
  redactForBackup: boolean,
): string {
  const lines = messages.map((message) => {
    const timestamp = new Date(message.timestamp * 1000).toTimeString().slice(0, 5);
    const content = message.content ?? '[media]';
    const safe = redactForBackup ? sanitizeProviderPreviewText(content) : content;
    return `[${timestamp}] ${message.senderName ?? message.senderJid}: ${capMessageText(safe)}`;
  });
  // Enforce the total budget newest-first so the most recent context survives;
  // the per-message cap guarantees at least the newest line always fits.
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i]!.length + 1;
    if (total + cost > CONTEXT_LINE_MAX_TOTAL_CHARS) break;
    kept.push(lines[i]!);
    total += cost;
  }
  kept.reverse();
  const dropped = lines.length - kept.length;
  if (dropped > 0) kept.unshift(`[context truncated: ${dropped} older messages omitted]`);
  return kept.join('\n');
}
