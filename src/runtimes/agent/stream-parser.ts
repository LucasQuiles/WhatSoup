// src/runtimes/agent/stream-parser.ts
// Parses provider stream-json (JSONL) lines into ordered AgentEvent envelopes.

export const IGNORED_BLOCK_REASONS = {
  thinking: 'model-internal, no side effects',
  redacted_thinking: 'model-internal redacted reasoning, no side effects',
  text: 'user-originated context, no provider output side effects',
  image: 'user-originated media, no provider output side effects',
  document: 'user-originated document, no provider output side effects',
} as const;

type IgnoredBlockReason =
  (typeof IGNORED_BLOCK_REASONS)[keyof typeof IGNORED_BLOCK_REASONS];

export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'compact_boundary' }
  | { type: 'assistant_text'; text: string; itemId?: string; complete?: boolean }
  | { type: 'tool_use'; toolName: string; toolId: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; isError: boolean; toolId: string; content: string }
  | { type: 'result'; text: string | null; isError?: boolean; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'token_usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'ignored' }
  | { type: 'ignored'; blockType: string; reason: IgnoredBlockReason }
  | { type: 'unknown_block'; blockType: string; raw: unknown }
  | { type: 'unknown'; raw: unknown }
  | { type: 'parse_error'; line: string };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function describeBlockType(block: unknown): string {
  const record = asRecord(block);
  if (record === null) return '<non-object>';
  if (!Object.hasOwn(record, 'type')) return '<missing>';
  return typeof record['type'] === 'string' ? record['type'] : '<invalid>';
}

function unknownBlock(block: unknown): AgentEvent {
  return { type: 'unknown_block', blockType: describeBlockType(block), raw: block };
}

function ignoredBlock(
  blockType: string,
  reasonKey: keyof typeof IGNORED_BLOCK_REASONS,
): AgentEvent {
  return {
    type: 'ignored',
    blockType,
    reason: IGNORED_BLOCK_REASONS[reasonKey],
  };
}

function parseAssistantBlock(block: unknown): AgentEvent[] {
  const record = asRecord(block);
  if (record === null) return [unknownBlock(block)];

  switch (record['type']) {
    case 'text': {
      const text = record['text'];
      return typeof text === 'string'
        ? [{ type: 'assistant_text', text }]
        : [unknownBlock(block)];
    }
    case 'tool_use': {
      const toolName = record['name'];
      const toolId = record['id'];
      const toolInput = asRecord(record['input']);
      if (!isNonEmptyString(toolName) || !isNonEmptyString(toolId) || toolInput === null) {
        return [unknownBlock(block)];
      }
      return [{
        type: 'tool_use',
        toolName,
        toolId,
        toolInput,
      }];
    }
    case 'thinking':
      return [ignoredBlock('thinking', 'thinking')];
    case 'redacted_thinking':
      return [ignoredBlock('redacted_thinking', 'redacted_thinking')];
    default:
      return [unknownBlock(block)];
  }
}

interface ParsedToolResultContent {
  content: string;
  nestedEvents: AgentEvent[];
}

function parseToolResultContent(value: unknown): ParsedToolResultContent | null {
  if (typeof value === 'string') return { content: value, nestedEvents: [] };
  if (!Array.isArray(value)) return null;

  const text: string[] = [];
  const nestedEvents: AgentEvent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    switch (record?.['type']) {
      case 'text':
        if (typeof record['text'] === 'string') text.push(record['text']);
        else nestedEvents.push(unknownBlock(item));
        break;
      case 'image':
        nestedEvents.push(ignoredBlock('image', 'image'));
        break;
      case 'document':
        nestedEvents.push(ignoredBlock('document', 'document'));
        break;
      default:
        nestedEvents.push(unknownBlock(item));
        break;
    }
  }
  return { content: text.join('\n'), nestedEvents };
}

function parseUserBlock(block: unknown): AgentEvent[] {
  const record = asRecord(block);
  if (record === null) return [unknownBlock(block)];

  switch (record['type']) {
    case 'tool_result': {
      const toolId = record['tool_use_id'];
      const rawIsError = record['is_error'];
      if (
        !isNonEmptyString(toolId) ||
        (Object.hasOwn(record, 'is_error') && typeof rawIsError !== 'boolean')
      ) {
        return [unknownBlock(block)];
      }
      const parsedContent = Object.hasOwn(record, 'content')
        ? parseToolResultContent(record['content'])
        : { content: '', nestedEvents: [] };
      if (parsedContent === null) return [unknownBlock(block)];
      return [{
        type: 'tool_result',
        isError: rawIsError === true,
        toolId,
        content: parsedContent.content,
      }, ...parsedContent.nestedEvents];
    }
    case 'text':
      return [ignoredBlock('text', 'text')];
    case 'image':
      return [ignoredBlock('image', 'image')];
    case 'document':
      return [ignoredBlock('document', 'document')];
    case 'thinking':
      return [ignoredBlock('thinking', 'thinking')];
    case 'redacted_thinking':
      return [ignoredBlock('redacted_thinking', 'redacted_thinking')];
    default:
      return [unknownBlock(block)];
  }
}

function resultEvent(event: JsonRecord): AgentEvent {
  const isError = event['is_error'] === true;
  const rawUsage = asRecord(event['usage']);
  const baseInput = typeof rawUsage?.['input_tokens'] === 'number'
    ? rawUsage['input_tokens']
    : undefined;
  const cacheCreation = typeof rawUsage?.['cache_creation_input_tokens'] === 'number'
    ? rawUsage['cache_creation_input_tokens']
    : 0;
  const cacheRead = typeof rawUsage?.['cache_read_input_tokens'] === 'number'
    ? rawUsage['cache_read_input_tokens']
    : 0;
  const inputTokens = baseInput !== undefined ? baseInput + cacheCreation + cacheRead : undefined;
  const outputTokens = typeof rawUsage?.['output_tokens'] === 'number'
    ? rawUsage['output_tokens']
    : undefined;

  if (!isError) {
    return { type: 'result', text: null, inputTokens, outputTokens };
  }

  const content = event['content'];
  if (typeof content === 'string') {
    return {
      type: 'result',
      text: content || null,
      isError: true,
      inputTokens,
      outputTokens,
    };
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = asRecord(block);
      if (record?.['type'] === 'text') {
        return {
          type: 'result',
          text: String(record['text'] ?? '') || null,
          isError: true,
          inputTokens,
          outputTokens,
        };
      }
    }
  }
  const resultField = event['result'];
  if (typeof resultField === 'string') {
    return {
      type: 'result',
      text: resultField || null,
      isError: true,
      inputTokens,
      outputTokens,
    };
  }
  return { type: 'result', text: null, isError: true, inputTokens, outputTokens };
}

/**
 * Parse one Claude stream-json line into every ordered event represented by it.
 * Empty lines produce an empty envelope; malformed JSON produces one parse_error.
 * Content-array entries are never silently skipped.
 */
export function parseEvents(line: string): AgentEvent[] {
  if (line.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ type: 'parse_error', line }];
  }

  const event = asRecord(parsed);
  if (event === null) return [{ type: 'unknown', raw: parsed }];

  const topType = event['type'];
  if (topType === 'system') {
    const subtype = event['subtype'];
    if (subtype === 'init') {
      return [{ type: 'init', sessionId: String(event['session_id'] ?? '') }];
    }
    if (subtype === 'compact_boundary') return [{ type: 'compact_boundary' }];
    if (typeof subtype === 'string' && subtype.startsWith('hook')) {
      return [{ type: 'ignored' }];
    }
    return [{ type: 'unknown', raw: parsed }];
  }

  if (topType === 'assistant') {
    const message = asRecord(event['message']);
    const content = message?.['content'];
    if (!Array.isArray(content) || content.length === 0) {
      return [{ type: 'unknown', raw: parsed }];
    }
    return content.flatMap(parseAssistantBlock);
  }

  if (topType === 'user') {
    const message = asRecord(event['message']) ?? event;
    const content = message['content'];
    if (typeof content === 'string') {
      const trimmed = content.trim();
      if (/^Unknown skill:\s+/i.test(trimmed)) {
        return [{ type: 'result', text: trimmed, isError: true }];
      }
      return [{ type: 'unknown', raw: parsed }];
    }
    if (!Array.isArray(content) || content.length === 0) {
      return [{ type: 'unknown', raw: parsed }];
    }
    return content.flatMap(parseUserBlock);
  }

  if (topType === 'result') return [resultEvent(event)];

  return [{ type: 'unknown', raw: parsed }];
}

/**
 * @deprecated Migrate consumers to parseEvents so multi-block envelopes are not truncated.
 */
export function parseEvent(line: string): AgentEvent | null {
  return parseEvents(line)[0] ?? null;
}
