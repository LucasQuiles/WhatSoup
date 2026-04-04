// src/runtimes/agent/providers/parser-utils.ts
// Shared utility functions used across multiple provider parsers.

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Recursively extract a string message from an unknown value.
 * Searches object keys in the provided order; defaults to the union of all
 * per-parser key lists.
 */
export function extractMessage(
  value: unknown,
  keys: readonly string[] = DEFAULT_EXTRACT_MESSAGE_KEYS,
): string | null {
  if (typeof value === 'string') return value || null;

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractMessage(item, keys))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (!isRecord(value)) return null;

  for (const key of keys) {
    const nested = extractMessage(value[key], keys);
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

  for (const path of inputPaths) {
    const inputTokens = getNestedNumber(usage, path);
    if (inputTokens !== undefined) {
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
