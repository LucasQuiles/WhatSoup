/**
 * Internal runtime-context delimiter system.
 *
 * Wraps runtime-generated prompt context (health state, session metadata,
 * tool results, internal notices) in begin/end delimiters that:
 *
 * 1. Survive model round-trips — the model is told the block is internal.
 * 2. Can be stripped from model output before delivery to the user, so any
 *    block the model echoes back never reaches the chat surface.
 * 3. Can be escaped when embedding untrusted text inside a context block,
 *    preventing prompt-injection via delimiter spoofing.
 *
 * Depth-aware: nested begin/end pairs are tracked so an outer block can
 * contain inner blocks without premature termination.
 *
 * Factory pattern: callers pick their own delimiter tokens (so each subsystem
 * can have its own namespace) but get the same strip/extract/has/escape
 * helpers.
 */

/** Options for {@link createInternalContextDelimiters}. */
export interface DelimiterOptions {
  /** Opening delimiter token. Required. */
  begin: string;
  /** Closing delimiter token. Required. */
  end: string;
}

export interface InternalContextDelimiters {
  /** Opening delimiter token. */
  readonly begin: string;
  /** Closing delimiter token. */
  readonly end: string;
  /** Escape the begin/end tokens in untrusted text so they cannot spoof a block boundary. */
  escapeDelimiters(value: string): string;
  /** True when `text` contains at least one begin token. */
  hasInternalContext(text: string): boolean;
  /** Remove all begin/end delimited blocks (depth-aware) from `text`. */
  stripInternalContext(text: string): string;
  /** Remove delimited blocks and return them joined, along with the remaining visible text. */
  extractInternalContext(text: string): { text: string; blocks: string[] };
  /** Wrap `inner` in a begin/end block. */
  wrap(inner: string): string;
}

const ESCAPED_PREFIX = '[[WHATSOUPEscaped_';
const ESCAPED_SUFFIX = ']]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the index of `token` in `text`, anchored at a line boundary (start of
 * text or after `\r?\n`). Tokens floating mid-line are ignored so they cannot
 * terminate a block prematurely.
 */
function findDelimitedTokenIndex(text: string, token: string, from: number): number {
  const re = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(token)}(?=\\r?\\n|$)`, 'g');
  re.lastIndex = Math.max(0, from);
  const match = re.exec(text);
  if (!match) {
    return -1;
  }
  // match[0] is `\n<token>` or `<token>`; subtract the newline length to point at the token.
  const prefixLength = match[0].length - token.length;
  return match.index + prefixLength;
}

export function createInternalContextDelimiters(options: DelimiterOptions): InternalContextDelimiters {
  const { begin, end } = options;
  if (!begin || !end) {
    throw new Error('createInternalContextDelimiters: begin and end are required');
  }

  const escapedBegin = `${ESCAPED_PREFIX}BEGIN${ESCAPED_SUFFIX}`;
  const escapedEnd = `${ESCAPED_PREFIX}END${ESCAPED_SUFFIX}`;

  function escapeDelimiters(value: string): string {
    return value.replaceAll(begin, escapedBegin).replaceAll(end, escapedEnd);
  }

  function extractDelimitedBlocks(text: string): { text: string; blocks: string[] } {
    let next = text;
    const blocks: string[] = [];
    for (;;) {
      const start = findDelimitedTokenIndex(next, begin, 0);
      if (start === -1) {
        return { text: next, blocks };
      }
      let cursor = start + begin.length;
      let depth = 1;
      let finish = -1;
      while (depth > 0) {
        const nextBegin = findDelimitedTokenIndex(next, begin, cursor);
        const nextEnd = findDelimitedTokenIndex(next, end, cursor);
        if (nextEnd === -1) {
          break;
        }
        if (nextBegin !== -1 && nextBegin < nextEnd) {
          depth += 1;
          cursor = nextBegin + begin.length;
          continue;
        }
        depth -= 1;
        finish = nextEnd;
        cursor = nextEnd + end.length;
      }
      const before = next.slice(0, start).trimEnd();
      if (finish === -1 || depth !== 0) {
        // Unterminated block — drop it entirely (do not deliver to user).
        return { text: before, blocks };
      }
      const blockEnd = finish + end.length;
      blocks.push(next.slice(start, blockEnd).trim());
      const after = next.slice(blockEnd).trimStart();
      next = before && after ? `${before}\n\n${after}` : `${before}${after}`;
    }
  }

  return {
    begin,
    end,
    escapeDelimiters,
    hasInternalContext(text) {
      if (!text) return false;
      return findDelimitedTokenIndex(text, begin, 0) !== -1;
    },
    stripInternalContext(text) {
      if (!text) return text;
      return extractDelimitedBlocks(text).text;
    },
    extractInternalContext(text) {
      return extractDelimitedBlocks(text);
    },
    wrap(inner) {
      return `${begin}\n${inner}\n${end}`;
    },
  };
}
