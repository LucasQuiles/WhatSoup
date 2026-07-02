// src/runtimes/agent/providers/parser-utils.ts
// Shared utility functions used across multiple provider parsers.

import { isRecord as isRecordBase } from '../../../lib/type-guards.ts';

export type JsonObject = Record<string, unknown>;

// Delegates to the central type-guard. Kept as a `function` declaration
// (rather than a re-exported binding) because sibling parsers import this
// name and the anti-duplication test asserts the `export function` form.
export function isRecord(value: unknown): value is JsonObject {
  return isRecordBase(value);
}

export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function getNestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === 'number' ? current : undefined;
}

const DEFAULT_EXTRACT_MESSAGE_KEYS = [
  'text',
  'message',
  'error',
  'details',
  'content',
  'output',
  'aggregated_output',
] as const;

/**
 * Max recursion depth for {@link extractMessage}. Provider stdout is untrusted
 * (QR-070): a single deeply-nested JSON line parses fine but unbounded recursion
 * here throws an uncaught RangeError in the session stdout handler → instance
 * shutdown (DoS). Past this depth, treat the value as having no extractable
 * message rather than walking it. 64 is far beyond any real provider payload.
 */
const MAX_EXTRACT_DEPTH = 64;

/**
 * Recursively extract a string message from an unknown value.
 * Searches object keys in the provided order; defaults to the union of all
 * per-parser key lists. Recursion is bounded by {@link MAX_EXTRACT_DEPTH} so a
 * deeply-nested (or maliciously-nested) provider payload degrades to `null`
 * instead of overflowing the call stack (QR-070).
 */
export function extractMessage(
  value: unknown,
  keys: readonly string[] = DEFAULT_EXTRACT_MESSAGE_KEYS,
  depth = 0,
): string | null {
  if (typeof value === 'string') return value || null;

  if (depth >= MAX_EXTRACT_DEPTH) return null;

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractMessage(item, keys, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (!isRecord(value)) return null;

  for (const key of keys) {
    const nested = extractMessage(value[key], keys, depth + 1);
    if (nested) return nested;
  }

  return null;
}

/**
 * Extract inputTokens / outputTokens from a usage/stats object.
 * Covers the superset of paths used by all parsers (codex + gemini + gemini-acp).
 */
export function extractTokenCounts(usage: unknown): {
  inputTokens?: number;
  outputTokens?: number;
} {
  const inputPaths = [
    ['input_tokens'],
    ['inputTokens'],
    ['usage', 'input_tokens'],
    ['usage', 'inputTokens'],
    ['tokenUsage', 'input_tokens'],
    ['tokenUsage', 'inputTokens'],
  ] as const;

  const outputPaths = [
    ['output_tokens'],
    ['outputTokens'],
    ['usage', 'output_tokens'],
    ['usage', 'outputTokens'],
    ['tokenUsage', 'output_tokens'],
    ['tokenUsage', 'outputTokens'],
  ] as const;

  // Cache token paths — same prefix as input but with cache-specific keys.
  // When present, these are added to the base input count.
  const cachePaths = [
    { creation: ['cache_creation_input_tokens'], read: ['cache_read_input_tokens'] },
    { creation: ['usage', 'cache_creation_input_tokens'], read: ['usage', 'cache_read_input_tokens'] },
  ] as const;

  for (const path of inputPaths) {
    let inputTokens = getNestedNumber(usage, path);
    if (inputTokens !== undefined) {
      // Add cache tokens if present at a matching depth
      for (const cp of cachePaths) {
        const creation = getNestedNumber(usage, cp.creation) ?? 0;
        const read = getNestedNumber(usage, cp.read) ?? 0;
        if (creation > 0 || read > 0) {
          inputTokens += creation + read;
          break;
        }
      }
      for (const outputPath of outputPaths) {
        const outputTokens = getNestedNumber(usage, outputPath);
        if (outputTokens !== undefined) {
          return { inputTokens, outputTokens };
        }
      }
      return { inputTokens };
    }
  }

  for (const path of outputPaths) {
    const outputTokens = getNestedNumber(usage, path);
    if (outputTokens !== undefined) {
      return { outputTokens };
    }
  }

  return {};
}
