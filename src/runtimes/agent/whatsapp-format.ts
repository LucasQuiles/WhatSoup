/**
 * Markdown-to-WhatsApp text transform.
 *
 * Claude outputs GitHub-flavored markdown. WhatsApp supports a narrow subset:
 *   *bold*  _italic_  ~strikethrough~  ```monospace```  > quote
 *
 * This module converts what's actively broken and strips noise, without
 * attempting a full markdown AST parse.
 */

// ── Ordered transform passes ────────────────────────────────────────────────

/**
 * Convert Claude's markdown to WhatsApp-compatible formatting.
 * Applied before message splitting.
 */
export function markdownToWhatsApp(text: string): string {
  let out = text;

  // Protect code blocks from formatting transforms.
  // Extract triple-backtick blocks, replace with placeholders, transform
  // the rest, then restore. This prevents e.g. **bold** inside code from
  // being converted.
  const codeBlocks: string[] = [];
  out = out.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Also protect inline code spans
  const inlineCode: string[] = [];
  out = out.replace(/`[^`\n]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // --- Fix broken formatting ---

  // **bold** → *bold* (WhatsApp bold uses single asterisk)
  // Must handle **text with spaces** across word boundaries
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // __text__ → _text_ (WhatsApp italic — rare from Claude but possible)
  out = out.replace(/__(.+?)__/g, '_$1_');

  // ~~strikethrough~~ → ~strikethrough~ (WhatsApp uses single tilde)
  out = out.replace(/~~(.+?)~~/g, '~$1~');

  // --- Strip noise ---

  // Headings: # Heading → *Heading* (bold, no hash)
  // Match 1-6 hashes at start of line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Horizontal rules: --- or *** or ___ (3+ chars) → remove entirely
  out = out.replace(/^[\-\*_]{3,}\s*$/gm, '');

  // Image links: ![alt](url) → remove (not useful in WhatsApp text)
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // Links: [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // --- Clean whitespace ---

  // Collapse 3+ consecutive blank lines to 2
  out = out.replace(/\n{3,}/g, '\n\n');

  // Trim leading blank lines
  out = out.replace(/^\n+/, '');

  // --- Restore protected spans ---

  // Restore inline code
  out = out.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[parseInt(idx, 10)]);

  // Restore code blocks
  out = out.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx, 10)]);

  return out;
}

// ── Split-boundary formatting repair ────────────────────────────────────────

/**
 * After splitting a message into chunks, repair unclosed formatting delimiters
 * at chunk boundaries. If a chunk has an odd number of a formatting char
 * (*, _, ~), close it at the end and re-open at the start of the next chunk.
 *
 * This prevents truncated paths like `src/very/long/path...` from breaking
 * formatting for the rest of the message.
 */
export function repairChunkFormatting(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks;

  const result = [...chunks];
  // Formatting delimiters that must be balanced within a chunk.
  // We only check outside of code blocks (triple backtick).
  const delimiters = ['*', '_', '~'] as const;

  for (let i = 0; i < result.length - 1; i++) {
    for (const delim of delimiters) {
      if (hasUnbalancedDelimiter(result[i], delim)) {
        // Close the formatting at the end of this chunk
        result[i] = result[i] + delim;
        // Re-open at the start of the next chunk
        result[i + 1] = delim + result[i + 1];
      }
    }
  }

  return result;
}

/**
 * Check if a text has an unbalanced (odd count) formatting delimiter,
 * ignoring occurrences inside code blocks and inline code.
 */
function hasUnbalancedDelimiter(text: string, delim: string): boolean {
  // Strip code blocks and inline code before counting
  let stripped = text.replace(/```[\s\S]*?```/g, '');
  stripped = stripped.replace(/`[^`\n]+`/g, '');

  let count = 0;
  for (const char of stripped) {
    if (char === delim) count++;
  }
  return count % 2 !== 0;
}
