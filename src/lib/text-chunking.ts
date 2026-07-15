/**
 * Fence-aware text chunking for outbound messages.
 *
 * Splits long text into platform-sized chunks without breaking code fences
 * or surrogate pairs. Three modes:
 *
 * - `chunkText`: plain text, prefers newlines > whitespace > hard cut.
 *   Paren-aware (won't split inside parentheses). Surrogate-safe.
 * - `chunkByParagraph`: paragraph-boundary aware (breaks on blank lines),
 *   packs multiple paragraphs per chunk up to the limit.
 * - `chunkMarkdownText`: markdown-fence-aware. When a code fence spans the
 *   chunk boundary, closes it at the end of the chunk and reopens it at the
 *   start of the next — so ``` blocks stay valid across splits.
 */

// ── Fence parsing ───────────────────────────────────────────────────────────

export interface FenceSpan {
  /** Index of the opening fence line start (including indentation). */
  start: number;
  /** Index just past the closing fence line. */
  end: number;
  /** The full opening fence line (e.g., "```ts" or "   ```"). */
  openLine: string;
  /** The full closing fence line (e.g., "``` or "   ```"). */
  marker: string;
  /** Indentation before the fence (spaces or tabs). */
  indent: string;
}

const FENCE_LINE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\n]*)?$/gm;

/**
 * Parse all fenced code block spans in the text.
 * Handles both backtick (```) and tilde (~~~) fences.
 */
export function parseFenceSpans(text: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  const openStack: Array<{
    marker: string;
    indent: string;
    openLine: string;
    startIndex: number;
    info: string;
  }> = [];

  let match: RegExpExecArray | null;
  FENCE_LINE_RE.lastIndex = 0;
  while ((match = FENCE_LINE_RE.exec(text)) !== null) {
    const lineStart = match.index;
    const fenceChars = match[1];
    const info = (match[2] ?? '').trim();
    const indentMatch = match[0].match(/^[ \t]*/);
    const indent = indentMatch ? indentMatch[0] : '';

    // Check if this is a closing fence for the top of the stack
    if (openStack.length > 0) {
      const top = openStack[openStack.length - 1];
      // Closing fence must match the same char and have at least as many chars
      const sameChar = fenceChars[0] === top.marker[0];
      const enoughChars = fenceChars.length >= top.marker.length;
      const noInfo = !info; // closing fences have no info string
      if (sameChar && enoughChars && noInfo) {
        openStack.pop();
        const closeLineEnd = lineStart + match[0].length + 1; // +1 for the newline
        spans.push({
          start: top.startIndex,
          end: closeLineEnd,
          openLine: top.openLine,
          marker: top.marker,
          indent: top.indent,
        });
        continue;
      }
    }

    // Opening fence
    openStack.push({
      marker: fenceChars,
      indent,
      openLine: match[0],
      startIndex: lineStart,
      info,
    });
  }

  // Unclosed fences are not included — they can't be split safely.
  return spans;
}

/** Check if a break at the given index is safe (not inside a fence). */
export function isSafeFenceBreak(spans: FenceSpan[], index: number): boolean {
  for (const span of spans) {
    if (index > span.start && index < span.end) {
      return false;
    }
  }
  return true;
}

/** Find the fence span containing the given index, if any. */
export function findFenceSpanAt(
  spans: FenceSpan[],
  index: number,
): FenceSpan | undefined {
  return spans.find((s) => index > s.start && index < s.end);
}

// ── Surrogate safety ────────────────────────────────────────────────────────

/**
 * Back up past a trailing high surrogate (0xD800–0xDBFF) so we don't split
 * a surrogate pair. Returns the adjusted index.
 */
export function avoidTrailingHighSurrogateBreak(
  text: string,
  start: number,
  end: number,
): number {
  if (end <= start || end > text.length) return end;
  const charCode = text.charCodeAt(end - 1);
  if (charCode >= 0xd800 && charCode <= 0xdbff) {
    return end - 1;
  }
  return end;
}

// ── Breakpoint scanning ─────────────────────────────────────────────────────

interface Breakpoints {
  lastNewline: number;
  lastWhitespace: number;
}

/**
 * Scan for the best break point in a window, tracking parenthesis depth.
 * Prefers newlines outside parentheses, then whitespace outside parentheses.
 */
function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
  isAllowed: (index: number) => boolean = () => true,
): Breakpoints {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = start; i < end; i++) {
    if (!isAllowed(i)) continue;
    const char = text[i];
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === '\n') {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}

// ── Plain text chunking ─────────────────────────────────────────────────────

function resolveEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) return [];
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text];
  return undefined;
}

/**
 * Split text into chunks of at most `limit` characters.
 * Prefers newlines > whitespace > hard cut. Paren-aware and surrogate-safe.
 */
export function chunkText(text: string, limit: number): string[] {
  const early = resolveEarlyReturn(text, limit);
  if (early) return early;

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (text.length - start <= limit) {
      chunks.push(text.slice(start));
      break;
    }

    const windowEnd = start + limit;
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
      text,
      start,
      windowEnd,
    );

    let breakIdx: number;
    if (lastNewline > start) {
      breakIdx = lastNewline;
    } else if (lastWhitespace > start) {
      breakIdx = lastWhitespace;
    } else {
      breakIdx = windowEnd;
    }

    breakIdx = avoidTrailingHighSurrogateBreak(text, start, breakIdx);
    if (breakIdx <= start) breakIdx = start + 1; // always make progress

    chunks.push(text.slice(start, breakIdx));

    // Skip the separator character (newline/space) if any
    const nextStart = text[breakIdx] && /\s/.test(text[breakIdx])
      ? breakIdx + 1
      : breakIdx;
    start = nextStart;
  }

  return chunks;
}

// ── Paragraph chunking ──────────────────────────────────────────────────────

/**
 * Split text on paragraph boundaries (blank lines), packing multiple
 * paragraphs per chunk up to `limit`. Falls back to length-based splitting
 * for single paragraphs that exceed the limit.
 */
export function chunkByParagraph(
  text: string,
  limit: number,
  opts?: { splitLongParagraphs?: boolean },
): string[] {
  if (!text) return [];
  if (limit <= 0) return [text];
  const splitLongParagraphs = opts?.splitLongParagraphs !== false;

  const normalized = text.replace(/\r\n?/g, '\n');

  // Fast-path: no paragraph breaks
  if (!/\n[\t ]*\n+/.test(normalized)) {
    if (normalized.length <= limit) return [normalized];
    return splitLongParagraphs ? chunkText(normalized, limit) : [normalized];
  }

  const paragraphRe = /\n[\t ]*\n+/g;
  const parts: string[] = [];
  const separators: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = paragraphRe.exec(normalized)) !== null) {
    parts.push(normalized.slice(lastIndex, match.index));
    separators.push(match[0]);
    lastIndex = match.index + match[0].length;
  }
  parts.push(normalized.slice(lastIndex));

  const chunks: string[] = [];
  let currentChunk = '';

  const pushParagraph = (paragraph: string, separatorBefore?: string) => {
    paragraph = paragraph.replace(/\s+$/g, '');
    if (!paragraph.trim()) return;

    if (!currentChunk) {
      if (paragraph.length <= limit) {
        currentChunk = paragraph;
        return;
      }
      if (splitLongParagraphs) {
        chunks.push(...chunkText(paragraph, limit));
      } else {
        chunks.push(paragraph);
      }
      return;
    }

    const candidate = `${currentChunk}${separatorBefore ?? '\n\n'}${paragraph}`;
    if (candidate.length <= limit) {
      currentChunk = candidate;
      return;
    }

    chunks.push(currentChunk);
    currentChunk = '';
    pushParagraph(paragraph);
  };

  for (const [index, part] of parts.entries()) {
    pushParagraph(part, separators[index - 1]);
  }

  if (currentChunk) chunks.push(currentChunk);

  return chunks;
}

// ── Markdown-fence-aware chunking ───────────────────────────────────────────

/**
 * Split markdown text into chunks of at most `limit` characters.
 *
 * When a code fence spans the chunk boundary, closes it at the end of the
 * chunk and reopens it at the start of the next chunk — so fenced blocks
 * stay syntactically valid across splits.
 */
export function chunkMarkdownText(text: string, limit: number): string[] {
  const early = resolveEarlyReturn(text, limit);
  if (early) return early;

  const chunks: string[] = [];
  const spans = parseFenceSpans(text);
  let start = 0;
  let reopenFence: FenceSpan | undefined;

  while (start < text.length) {
    const reopenPrefix = reopenFence ? `${reopenFence.openLine}\n` : '';
    const contentLimit = Math.max(1, limit - reopenPrefix.length);

    if (text.length - start <= contentLimit) {
      const finalChunk = `${reopenPrefix}${text.slice(start)}`;
      if (finalChunk.length > 0) chunks.push(finalChunk);
      break;
    }

    const windowEnd = Math.min(text.length, start + contentLimit);

    // Find a safe break point (prefer newline outside fences)
    const softBreak = pickSafeBreakIndex(text, start, windowEnd, spans);
    let breakIdx = softBreak > start ? softBreak : windowEnd;

    // Check if we're splitting inside a fence
    const initialFence = isSafeFenceBreak(spans, breakIdx)
      ? undefined
      : findFenceSpanAt(spans, breakIdx);

    let fenceToSplit: FenceSpan | undefined = initialFence;

    if (initialFence) {
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = start + (contentLimit - (closeLine.length + 1));

      if (maxIdxIfNeedNewline <= start) {
        breakIdx = windowEnd;
      } else {
        // Try to find a newline before the fence content that we can break at
        let pickedNewline = false;
        let lastNewline = text.lastIndexOf('\n', Math.max(start, start + (contentLimit - closeLine.length) - 1));
        while (lastNewline >= start) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < start + 1) break;
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = candidateBreak;
            pickedNewline = true;
            break;
          }
          lastNewline = text.lastIndexOf('\n', lastNewline - 1);
        }

        if (!pickedNewline) {
          breakIdx = Math.max(start + 1, maxIdxIfNeedNewline);
        }
      }

      const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
      fenceToSplit =
        fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
    }

    // Surrogate safety
    const safeBreakIdx = avoidTrailingHighSurrogateBreak(text, start, breakIdx);
    if (safeBreakIdx !== breakIdx) {
      breakIdx = safeBreakIdx;
      if (fenceToSplit) {
        const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
        fenceToSplit =
          fenceAtBreak && fenceAtBreak.start === fenceToSplit.start ? fenceAtBreak : undefined;
      }
    }

    if (breakIdx <= start) breakIdx = start + 1; // always make progress

    const rawContent = text.slice(start, breakIdx);
    if (!rawContent) break;

    let rawChunk = `${reopenPrefix}${rawContent}`;
    const brokeOnSeparator = breakIdx < text.length && /\s/.test(text[breakIdx]);
    let nextStart = Math.min(text.length, breakIdx + (brokeOnSeparator ? 1 : 0));

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith('\n') ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      reopenFence = fenceToSplit;
    } else {
      // Skip leading newlines for the next chunk
      while (nextStart < text.length && text[nextStart] === '\n') {
        nextStart++;
      }
      reopenFence = undefined;
    }

    chunks.push(rawChunk);
    start = nextStart;
  }

  return chunks;
}

function pickSafeBreakIndex(
  text: string,
  start: number,
  end: number,
  spans: FenceSpan[],
): number {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
    text,
    start,
    end,
    (index) => isSafeFenceBreak(spans, index),
  );

  if (lastNewline > start) return lastNewline;
  if (lastWhitespace > start) return lastWhitespace;
  return -1;
}
