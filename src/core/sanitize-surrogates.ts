/**
 * Surrogate pair sanitization for JSON-safe serialization.
 *
 * JavaScript strings can contain lone surrogates (U+D800–U+DBFF without a
 * matching U+DC00–U+DFFF, or vice versa). JSON.stringify() emits these as-is,
 * but server-side JSON parsers (Python, Rust) reject them with errors like
 * "no low surrogate in string".
 *
 * This module provides fast, allocation-efficient sanitization at three layers:
 * 1. Ingestion — strip lone surrogates from WhatsApp message content at parse time
 * 2. Serialization — sanitize before JSON.stringify() in API providers
 * 3. Detection — identify surrogate errors for self-heal recovery
 */

import { createChildLogger } from '../logger.ts';

const log = createChildLogger('sanitize-surrogates');

/**
 * Strip lone surrogates from a string, replacing them with U+FFFD (REPLACEMENT CHARACTER).
 *
 * A "lone surrogate" is:
 * - A high surrogate (U+D800–U+DBFF) NOT followed by a low surrogate (U+DC00–U+DFFF)
 * - A low surrogate (U+DC00–U+DFFF) NOT preceded by a high surrogate (U+D800–U+DBFF)
 *
 * Valid surrogate pairs are preserved as-is.
 *
 * Fast path: returns the original string reference if no lone surrogates are found.
 */
export function stripLoneSurrogates(str: string): string {
  // Fast path: scan for any surrogates first — most strings have none
  let hasSurrogates = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDFFF) {
      hasSurrogates = true;
      break;
    }
  }
  if (!hasSurrogates) return str;

  // Slow path: rebuild string, replacing lone surrogates
  let result = '';
  let modified = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      // High surrogate — check for matching low surrogate
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        // Valid pair — keep both
        result += str[i] + str[i + 1];
        i++; // skip the low surrogate
      } else {
        // Lone high surrogate
        result += '\uFFFD';
        modified = true;
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Lone low surrogate (no preceding high)
      result += '\uFFFD';
      modified = true;
    } else {
      result += str[i];
    }
  }

  return modified ? result : str;
}

/**
 * Check if a string contains any lone surrogates.
 */
export function hasLoneSurrogates(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next < 0xDC00 || next > 0xDFFF) return true;
      i++; // skip valid low surrogate
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively sanitize all string values in a JSON-compatible structure.
 * Preserves object identity for non-string leaves (numbers, booleans, null).
 *
 * WARNING: Does not handle circular references — only use on serializable data.
 */
export function sanitizeForJson<T>(value: T): T {
  if (typeof value === 'string') return stripLoneSurrogates(value) as unknown as T;
  if (Array.isArray(value)) return value.map(sanitizeForJson) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = sanitizeForJson(obj[k]);
    }
    return out as T;
  }
  return value;
}

/**
 * Detect whether an API error response indicates surrogate corruption.
 * Matches Anthropic's "no low surrogate" and similar JSON parse errors.
 */
export function isSurrogateError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return lower.includes('surrogate')
    || lower.includes('lone surrogate')
    || /\\ud[89ab][0-9a-f]{2}/i.test(errorText);
}

/**
 * Sanitize an array of message objects in place (mutates the array).
 * Returns the count of strings that were modified.
 *
 * Used for self-heal recovery when a surrogate error is detected in
 * an existing conversation history.
 */
export function sanitizeMessageHistory(messages: Array<{ role: string; content: unknown }>): number {
  let repaired = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      const cleaned = stripLoneSurrogates(msg.content);
      if (cleaned !== msg.content) {
        msg.content = cleaned;
        repaired++;
      }
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object') {
          // Text blocks (Anthropic format)
          if ('text' in block && typeof block.text === 'string') {
            const cleaned = stripLoneSurrogates(block.text);
            if (cleaned !== block.text) {
              block.text = cleaned;
              repaired++;
            }
          }
          // Tool result blocks (Anthropic format)
          if ('content' in block && typeof block.content === 'string') {
            const cleaned = stripLoneSurrogates(block.content);
            if (cleaned !== block.content) {
              block.content = cleaned;
              repaired++;
            }
          }
          // Tool input blocks (Anthropic format — nested object)
          // Only scan if the serialized form actually contains surrogates
          if ('input' in block && block.input && typeof block.input === 'object') {
            const inputJson = JSON.stringify(block.input);
            if (hasLoneSurrogates(inputJson)) {
              block.input = sanitizeForJson(block.input);
              repaired++;
            }
          }
        }
      }
    }

    // OpenAI tool_calls on assistant messages — arguments is a JSON string
    // assembled from streaming deltas that can contain lone surrogates.
    const anyMsg = msg as Record<string, unknown>;
    if ('tool_calls' in anyMsg && Array.isArray(anyMsg.tool_calls)) {
      for (const tc of anyMsg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc?.function as Record<string, unknown> | undefined;
        if (fn && typeof fn.arguments === 'string') {
          const cleaned = stripLoneSurrogates(fn.arguments);
          if (cleaned !== fn.arguments) {
            fn.arguments = cleaned;
            repaired++;
          }
        }
      }
    }
  }

  if (repaired > 0) {
    log.warn({ repairedFields: repaired }, 'sanitized lone surrogates from message history');
  }

  return repaired;
}
