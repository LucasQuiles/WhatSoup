// src/runtimes/agent/providers/gemini-parser.ts
// Parses Gemini CLI stream-json (JSONL) lines into typed AgentEvents.

import type { AgentEvent } from '../stream-parser.ts';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringifyValue(value: unknown): string {
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

function extractMessage(value: unknown): string | null {
  if (typeof value === 'string') {
    return value || null;
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => extractMessage(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ['message', 'error', 'details', 'content', 'text']) {
    const nested = extractMessage(value[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function getNestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let current: unknown = value;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return typeof current === 'number' ? current : undefined;
}

function extractTokenCounts(stats: unknown): Pick<
  Extract<AgentEvent, { type: 'result' }>,
  'inputTokens' | 'outputTokens'
> {
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
    const inputTokens = getNestedNumber(stats, path);
    if (inputTokens !== undefined) {
      for (const outputPath of outputPaths) {
        const outputTokens = getNestedNumber(stats, outputPath);
        if (outputTokens !== undefined) {
          return { inputTokens, outputTokens };
        }
      }
      return { inputTokens };
    }
  }

  for (const path of outputPaths) {
    const outputTokens = getNestedNumber(stats, path);
    if (outputTokens !== undefined) {
      return { outputTokens };
    }
  }

  return {};
}

function extractAssistantText(event: JsonObject): string {
  const directText =
    extractMessage(event['text']) ??
    extractMessage(event['content']) ??
    extractMessage(event['message']);

  return directText ?? '';
}

/**
 * Parse a single JSONL line from Gemini CLI --output-format stream-json into an AgentEvent.
 *
 * Returns null for empty/whitespace-only lines.
 * Returns { type: 'parse_error', line } for malformed JSON.
 * Never throws.
 */
export function parseGeminiEvent(line: string): AgentEvent | null {
  if (line.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: 'parse_error', line };
  }

  if (!isRecord(parsed)) {
    return { type: 'unknown', raw: parsed };
  }

  const eventType = parsed['type'];

  if (eventType === 'init') {
    return { type: 'init', sessionId: String(parsed['session_id'] ?? '') };
  }

  if (eventType === 'message') {
    if (parsed['role'] === 'assistant' && parsed['delta'] === true) {
      return { type: 'assistant_text', text: extractAssistantText(parsed) };
    }
    return { type: 'unknown', raw: parsed };
  }

  if (eventType === 'tool_use') {
    const rawInput = parsed['input'];
    return {
      type: 'tool_use',
      toolName: String(parsed['tool_name'] ?? ''),
      toolId: String(parsed['tool_id'] ?? ''),
      toolInput: isRecord(rawInput) ? rawInput : {},
    };
  }

  if (eventType === 'tool_result') {
    const status = String(parsed['status'] ?? '').trim().toLowerCase();
    const isError = status !== '' && status !== 'success' && status !== 'ok';
    return {
      type: 'tool_result',
      isError,
      toolId: String(parsed['tool_id'] ?? ''),
      content: stringifyValue(parsed['output']),
    };
  }

  if (eventType === 'result') {
    const status = String(parsed['status'] ?? '').trim().toLowerCase();
    const { inputTokens, outputTokens } = extractTokenCounts(parsed['stats']);
    const text =
      status === '' || status === 'success' || status === 'ok'
        ? null
        : extractMessage(parsed['error']) ??
          extractMessage(parsed['message']) ??
          (status ? `Gemini CLI result status: ${status}` : null);

    return { type: 'result', text, inputTokens, outputTokens };
  }

  if (eventType === 'error') {
    return {
      type: 'result',
      text:
        extractMessage(parsed['error']) ??
        extractMessage(parsed['message']) ??
        stringifyValue(parsed) ??
        'Gemini CLI error',
    };
  }

  return { type: 'unknown', raw: parsed };
}
