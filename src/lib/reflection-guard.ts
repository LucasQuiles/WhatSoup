/**
 * Reflection guard: detect leaked agent-internal content in inbound messages.
 *
 * Agents emit internal scaffolding — reasoning tags, role markers, turn
 * boundaries, tool-output separators — that should never be visible to users.
 * When this content leaks into the outbound channel (a bug), it can be
 * reflected back as an inbound message via screenshot, copy-paste, or echo,
 * causing the agent to re-ingest its own scaffolding and loop.
 *
 * This module classifies inbound text as either clean or reflective, and for
 * reflective text reports which label(s) matched. Patterns are matched
 * OUTSIDE code regions (fenced code blocks and inline code), because code
 * legitimately contains tag-like syntax.
 *
 * Two complementary surfaces:
 *
 * 1. detectReflection(text): classify inbound text.
 * 2. sanitizeOutbound(text): strip scaffolding from outbound text before
 *    delivery, preventing the leak at the source.
 *
 * Both are pure functions with no I/O — easy to test and compose.
 */

export interface ReflectionMatch {
  /** The label that matched (e.g. 'thinking-tag', 'role-marker'). */
  label: ReflectionLabel;
  /** The specific pattern string that matched, for telemetry. */
  matchedPattern: string;
}

export type ReflectionLabel =
  | 'internal-separator'
  | 'role-marker'
  | 'thinking-tag'
  | 'memory-tag'
  | 'final-tag'
  | 'acp-error'
  | 'missing-api-key'
  | 'turn-boundary';

export interface ReflectionResult {
  /** True if any reflective pattern matched outside code regions. */
  isReflection: boolean;
  /** All labels that matched. Empty if isReflection is false. */
  matchedLabels: ReflectionLabel[];
  /** All matches with their pattern details. */
  matches: ReflectionMatch[];
}

// ─── Code-region detection ─────────────────────────────────────────────────

export interface CodeRegion {
  /** Inclusive start index. */
  start: number;
  /** Exclusive end index. */
  end: number;
}

/**
 * Find all fenced code block regions in markdown text.
 * Handles ``` and ~~~ fences with optional language tags.
 * Unclosed fences extend to end of text.
 */
export function findFencedCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let inFence = false;
  let fenceMarker = '';
  let fenceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (!inFence) {
      const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
      if (fenceMatch) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
        fenceStart = offset;
      }
    } else {
      // Check for closing fence (same marker, at least same length)
      const closingRe = new RegExp(`^${fenceMarker === '`' ? '`{3,}' : '~{3,}'}`);
      if (closingRe.test(trimmed)) {
        inFence = false;
        regions.push({ start: fenceStart, end: offset + line.length });
      }
    }

    offset += line.length + 1; // +1 for the \n
  }

  // Unclosed fence extends to end
  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

/**
 * Find all inline code regions (single backtick spans) in text that is NOT
 * inside a fenced code block. Operates on the full text but skips regions
 * already identified as fenced.
 */
export function findInlineCodeRegions(text: string, fenced: CodeRegion[]): CodeRegion[] {
  const regions: CodeRegion[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      // Skip if inside a fenced region
      if (fenced.some((r) => i >= r.start && i < r.end)) {
        i++;
        continue;
      }
      // Find the closing backtick
      const close = text.indexOf('`', i + 1);
      if (close === -1) break;
      regions.push({ start: i, end: close + 1 });
      i = close + 1;
    } else {
      i++;
    }
  }
  return regions;
}

/**
 * Test whether a position in text falls inside any code region (fenced or inline).
 */
export function isInsideCode(position: number, regions: readonly CodeRegion[]): boolean {
  return regions.some((r) => position >= r.start && position < r.end);
}

/**
 * Return a copy of text with all code regions replaced by spaces of equal
 * length, preserving offsets so indices remain valid. Useful for running
 * pattern matches without false positives from code content.
 */
export function maskCodeRegions(text: string, regions: readonly CodeRegion[]): string {
  const chars = [...text];
  for (const region of regions) {
    for (let i = region.start; i < region.end && i < chars.length; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ─── Reflection patterns ───────────────────────────────────────────────────

export interface ReflectionPattern {
  label: ReflectionLabel;
  /** Regex pattern. Matched against code-masked text. */
  pattern: RegExp;
  /** Human-readable description for telemetry/debugging. */
  description: string;
}

export const REFLECTION_PATTERNS: readonly ReflectionPattern[] = [
  {
    label: 'internal-separator',
    pattern: /#\+#/,
    description: 'Internal turn separator (e.g. +#+)',
  },
  {
    label: 'role-marker',
    pattern: /^\s*assistant\s+to\s*=/im,
    description: 'Assistant role marker with recipient',
  },
  {
    label: 'thinking-tag',
    pattern: /<\/?(?:antml:|mm:)?thinking>|<\/?(?:antml:|mm:)?thought>/i,
    description: 'Thinking/reasoning tag (with optional provider namespace)',
  },
  {
    label: 'memory-tag',
    pattern: /<\/?relevant_memories>/i,
    description: 'Memory recall tag',
  },
  {
    label: 'final-tag',
    pattern: /<\/?final>/i,
    description: 'Final-answer delimiter tag',
  },
  {
    label: 'acp-error',
    pattern: /ACP error \(ACP_\w+\)/,
    description: 'ACP protocol error',
  },
  {
    label: 'missing-api-key',
    pattern: /Missing API key for .+ on the gateway/i,
    description: 'API key error leaking into visible text',
  },
  {
    label: 'turn-boundary',
    pattern: /^\s*(?:user|system|assistant)\s*:\s*/im,
    description: 'Bare turn-boundary role prefix (user:/system:/assistant:)',
  },
];

// ─── detectReflection ──────────────────────────────────────────────────────

/**
 * Classify inbound text as reflective (contains leaked agent scaffolding) or clean.
 * Patterns are matched against code-masked text to avoid false positives from
 * legitimately tag-like code syntax.
 */
export function detectReflection(
  text: string,
  patterns: readonly ReflectionPattern[] = REFLECTION_PATTERNS,
): ReflectionResult {
  if (!text || text.length === 0) {
    return { isReflection: false, matchedLabels: [], matches: [] };
  }

  const fenced = findFencedCodeRegions(text);
  const inline = findInlineCodeRegions(text, fenced);
  const allRegions = [...fenced, ...inline];
  const masked = maskCodeRegions(text, allRegions);

  const matches: ReflectionMatch[] = [];
  const seenLabels = new Set<ReflectionLabel>();

  for (const { label, pattern } of patterns) {
    const m = pattern.exec(masked);
    if (m && !seenLabels.has(label)) {
      matches.push({ label, matchedPattern: m[0] });
      seenLabels.add(label);
    }
  }

  return {
    isReflection: matches.length > 0,
    matchedLabels: [...seenLabels],
    matches,
  };
}

// ─── sanitizeOutbound ──────────────────────────────────────────────────────

export interface SanitizeOutboundOptions {
  /** Collapse 3+ consecutive newlines to exactly 2. Default: true. */
  collapseNewlines?: boolean;
}

/**
 * Strip agent-internal scaffolding from outbound text before delivery.
 * This is the source-side complement to detectReflection: prevent the leak
 * rather than just detecting it on the way back in.
 *
 * Operations:
 * 1. Remove internal-separator lines (#+#)
 * 2. Remove bare turn-boundary prefixes (user:/system:/assistant:)
 * 3. Remove thinking/thought/relevant_memories/final tags and their content
 * 4. Collapse excessive newlines
 *
 * Code regions are NOT masked here — outbound sanitization applies to the
 * whole message because the scaffolding should never be present at all.
 * If it appears inside a code block, that's still a leak.
 */
export function sanitizeOutbound(
  text: string,
  options: SanitizeOutboundOptions = {},
): string {
  const collapseNewlines = options.collapseNewlines ?? true;
  if (!text) return text;

  let result = text;

  // 1. Remove internal-separator tokens (#+#)
  result = result.replace(/#\+#/g, '');

  // 2. Remove bare turn-boundary prefixes at line starts
  result = result.replace(/^\s*(?:user|system|assistant)\s*:\s*/gim, '');

  // 3. Remove thinking/thought tags and their CONTENT (multi-line)
  result = result.replace(
    /<\/?(?:antml:|mm:)?thinking>[\s\S]*?<\/(?:antml:|mm:)?thinking>/gi,
    '',
  );
  result = result.replace(
    /<\/?(?:antml:|mm:)?thought>[\s\S]*?<\/(?:antml:|mm:)?thought>/gi,
    '',
  );
  // Remove orphaned opening or closing thinking tags (unpaired)
  result = result.replace(/<\/?(?:antml:|mm:)?thinking>/gi, '');
  result = result.replace(/<\/?(?:antml:|mm:)?thought>/gi, '');

  // 4. Remove memory-recall tags and content
  result = result.replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/gi, '');
  result = result.replace(/<\/?relevant_memories>/gi, '');

  // 5. Remove final-answer delimiter tags (but keep their content — it's the answer)
  result = result.replace(/<\/?final>/gi, '');

  // 6. Remove ACP error lines
  result = result.replace(/^.*ACP error \(ACP_\w+\).*$/gim, '');

  // 7. Remove API-key-missing error lines
  result = result.replace(/^.*Missing API key for .+ on the gateway.*$/gim, '');

  // 8. Remove assistant role marker lines
  result = result.replace(/^\s*assistant\s+to\s*=.*$/gim, '');

  // 9. Collapse 3+ consecutive newlines to exactly 2
  if (collapseNewlines) {
    result = result.replace(/\n{3,}/g, '\n\n');
  }

  // 10. Trim leading/trailing whitespace
  return result.trim();
}
