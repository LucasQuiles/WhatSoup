/**
 * Self-mention stripping for inbound group messages.
 *
 * When a bot is @mentioned in a group, the raw message text contains the
 * mention token (e.g. `@15550100001 thanks` or `@botname hello`). Passing
 * the mention to the LLM verbatim is noise — the model sees its own
 * identifier as part of the user's intent. This module builds regex patterns
 * that match the bot's own identifiers (both bare and @-prefixed) so the
 * inbound path can strip them before the text reaches the agent.
 *
 * Platform-agnostic: accepts any mix of identifiers (phone numbers, JIDs,
 * handles, display names). Each identifier produces up to two patterns:
 * the bare form and the @-prefixed form.
 *
 * Pattern safety:
 *  - Every identifier is regex-escaped before being embedded.
 *  - Patterns use the global flag and are returned as fresh RegExp instances
 *    (no shared `lastIndex` state across call sites).
 *  - An optional leading/trailing whitespace collapse runs after stripping so
 *    `@bot hello` and `@bot   hello` both become `hello`.
 */

/** Options for {@link buildSelfMentionStripPatterns}. */
export interface SelfMentionStripOptions {
  /**
   * Prefixes to strip from each identifier before building patterns.
   * Default strips `whatsapp:` (Baileys / Twilio-style addressing).
   */
  stripPrefixes?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the set of regex patterns that match the bot's own identifiers.
 *
 * For each identifier, emits up to two patterns:
 *  1. The bare identifier (escaped), anchored as a whole token.
 *  2. The @-prefixed identifier (escaped), anchored as a whole token.
 *
 * Empty / whitespace-only identifiers are skipped. Identifiers are
 * de-duplicated case-insensitively.
 */
export function buildSelfMentionStripPatterns(
  identifiers: readonly string[],
  options: SelfMentionStripOptions = {},
): RegExp[] {
  const stripPrefixes = options.stripPrefixes ?? ['whatsapp:'];
  const seen = new Set<string>();
  const patterns: RegExp[] = [];

  for (const raw of identifiers) {
    if (typeof raw !== 'string') continue;
    let id = raw.trim();
    if (!id) continue;
    for (const prefix of stripPrefixes) {
      if (prefix && id.toLowerCase().startsWith(prefix.toLowerCase())) {
        id = id.slice(prefix.length);
      }
    }
    id = id.trim();
    if (!id) continue;

    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);

    const escaped = escapeRegExp(id);
    // Bare form: word-boundary anchored so we don't shred a substring of a
    // larger token (e.g. stripping "bot" from "robotics").
    patterns.push(new RegExp(`(?<=^|\\s)${escaped}(?=\\s|$)`, 'g'));
    // @-prefixed form: the @ may be preceded by start or whitespace.
    patterns.push(new RegExp(`(?<=^|\\s)@${escaped}(?=\\s|$)`, 'gi'));
  }

  return patterns;
}

/**
 * Strip all self-mention matches from `text` using the supplied patterns,
 * then collapse leading/trailing whitespace and collapse runs of internal
 * whitespace to a single space. Returns the cleaned text.
 *
 * Pure function — does not mutate the input.
 */
export function stripSelfMentions(text: string, patterns: readonly RegExp[]): string {
  if (!text) return text;
  let out = text;
  for (const pattern of patterns) {
    // Reset lastIndex in case a caller passed a previously-used regex.
    pattern.lastIndex = 0;
    out = out.replace(pattern, '');
  }
  // Collapse runs of whitespace to a single space, then trim.
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Convenience: build patterns from identifiers and strip in one call.
 */
export function stripSelfMentionsFrom(
  text: string,
  identifiers: readonly string[],
  options?: SelfMentionStripOptions,
): string {
  return stripSelfMentions(text, buildSelfMentionStripPatterns(identifiers, options));
}
