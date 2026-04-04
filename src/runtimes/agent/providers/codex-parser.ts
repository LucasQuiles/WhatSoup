// src/runtimes/agent/providers/codex-parser.ts
// Parses Codex CLI --json JSONL lines into typed AgentEvents.

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

  for (const key of ['text', 'message', 'error', 'details', 'content', 'aggregated_output', 'output']) {
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

function extractTokenCounts(usage: unknown): Pick<
  Extract<AgentEvent, { type: 'result' }>,
  'inputTokens' | 'outputTokens'
> {
  const inputPaths = [
    ['input_tokens'],
    ['inputTokens'],
    ['usage', 'input_tokens'],
    ['usage', 'inputTokens'],
  ] as const;

  const outputPaths = [
    ['output_tokens'],
    ['outputTokens'],
    ['usage', 'output_tokens'],
    ['usage', 'outputTokens'],
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

function extractToolInput(item: JsonObject): Record<string, unknown> {
  const itemType = String(item['type'] ?? '');

  if (itemType === 'command_execution') {
    return {
      command: item['command'],
    };
  }

  if (itemType === 'file_change') {
    return {
      changes: item['changes'],
    };
  }

  if (itemType === 'mcp_tool_call') {
    const rawInput = item['input'];
    if (isRecord(rawInput)) {
      return rawInput;
    }
  }

  const toolInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'type' || key === 'status') {
      continue;
    }
    toolInput[key] = value;
  }
  return toolInput;
}

function extractToolResultContent(item: JsonObject): string {
  const direct =
    extractMessage(item['aggregated_output']) ??
    extractMessage(item['output']) ??
    extractMessage(item['result']) ??
    extractMessage(item['error']) ??
    extractMessage(item['message']);

  if (direct) {
    return direct;
  }

  const exitCode = item['exit_code'];
  if (typeof exitCode === 'number') {
    return `Exit code ${exitCode}`;
  }

  const status = item['status'];
  if (typeof status === 'string' && status) {
    return status;
  }

  return stringifyValue(item);
}

function isToolItemType(itemType: string): boolean {
  return itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call';
}

function isErrorStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized !== '' && normalized !== 'completed' && normalized !== 'success' && normalized !== 'ok';
}

function extractTurnFailureText(event: JsonObject): string | null {
  return (
    extractMessage(event['error']) ??
    extractMessage(event['message']) ??
    extractMessage(event['details']) ??
    extractMessage(event['reason']) ??
    'Codex CLI turn failed'
  );
}

/**
 * Parse a single JSONL line from Codex CLI --json output into an AgentEvent.
 *
 * Returns null for empty/whitespace-only lines.
 * Returns { type: 'parse_error', line } for malformed JSON.
 * Never throws.
 */
export function parseCodexEvent(line: string): AgentEvent | null {
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

  if (eventType === 'thread.started') {
    return { type: 'init', sessionId: String(parsed['thread_id'] ?? '') };
  }

  if (eventType === 'turn.started') {
    return { type: 'ignored' };
  }

  if (eventType === 'item.started' || eventType === 'item.completed') {
    const item = parsed['item'];
    if (!isRecord(item)) {
      return { type: 'unknown', raw: parsed };
    }

    const itemType = String(item['type'] ?? '');

    if (eventType === 'item.completed' && itemType === 'agent_message') {
      return {
        type: 'assistant_text',
        text: extractMessage(item['text']) ?? extractMessage(item['content']) ?? '',
      };
    }

    if (!isToolItemType(itemType)) {
      return { type: 'ignored' };
    }

    if (eventType === 'item.started') {
      return {
        type: 'tool_use',
        toolName: itemType,
        toolId: String(item['id'] ?? ''),
        toolInput: extractToolInput(item),
      };
    }

    return {
      type: 'tool_result',
      isError: isErrorStatus(String(item['status'] ?? '')),
      toolId: String(item['id'] ?? ''),
      content: extractToolResultContent(item),
    };
  }

  if (eventType === 'turn.completed') {
    const { inputTokens, outputTokens } = extractTokenCounts(parsed['usage']);
    return { type: 'result', text: null, inputTokens, outputTokens };
  }

  if (eventType === 'turn.failed') {
    const { inputTokens, outputTokens } = extractTokenCounts(parsed['usage']);
    return {
      type: 'result',
      text: extractTurnFailureText(parsed),
      inputTokens,
      outputTokens,
    };
  }

  return { type: 'unknown', raw: parsed };
}
