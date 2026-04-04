// src/runtimes/agent/providers/gemini-parser.ts
// Parses Gemini CLI stream-json (JSONL) lines into typed AgentEvents.

import type { AgentEvent } from '../stream-parser.ts';
import { type JsonObject, isRecord, stringifyValue, extractMessage, extractTokenCounts } from './parser-utils.ts';

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
