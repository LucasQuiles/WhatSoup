// src/runtimes/agent/stream-parser.ts
// Parses provider stream-json (JSONL) lines into ordered AgentEvent envelopes.

import { createChildLogger } from '../../logger.ts';

const parserLog = createChildLogger('stream-parser');

// ── Unclassified-event observability (id-only) ───────────────────────────────
// A live canary shows 256+ events/hour classified as unknown / unknown_block /
// parse_error, and the offending TYPE is currently invisible — impossible to
// tell whether the provider added a benign new block kind or is emitting real
// errors. Surface the TYPE STRING ONLY (never the raw payload, never any other
// field — id-only discipline), at warn, deduped per (classification+type) per
// process so a steady stream of the same type warns once, not 256×/hour. The
// key space is bounded (a small set of type strings), so the dedupe set is too.
const observedUnclassified = new Set<string>();

/** Reset the per-process unclassified-type dedupe (tests only). */
export function _resetStreamParserObservability(): void {
  observedUnclassified.clear();
}

function observeUnclassified(
  classification: 'unknown' | 'unknown_block' | 'parse_error',
  blockType: string,
): void {
  const key = `${classification}:${blockType}`;
  if (observedUnclassified.has(key)) return;
  observedUnclassified.add(key);
  // id-only: `blockType` is a type discriminant, never payload content or fields.
  parserLog.warn({ classification, blockType }, 'stream-parser: unclassified provider event (id-only)');
}

export const IGNORED_BLOCK_REASONS = {
  thinking: 'model-internal, no side effects',
  redacted_thinking: 'model-internal redacted reasoning, no side effects',
  thinking_tokens: 'model-internal token estimate, no runtime side effects',
  rate_limit_event: 'provider rate-limit telemetry, no runtime side effects',
  tool_reference: 'tool-discovery metadata, no runtime side effects',
  text: 'user-originated context, no provider output side effects',
  image: 'user-originated media, no provider output side effects',
  document: 'user-originated document, no provider output side effects',
} as const;

type IgnoredBlockReason =
  (typeof IGNORED_BLOCK_REASONS)[keyof typeof IGNORED_BLOCK_REASONS];

export interface ProviderTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
}

export type ProviderTurnTerminalStatus =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'unknown';

export interface ProviderTurnTerminalIdentity extends ProviderTurnIdentity {
  readonly status: ProviderTurnTerminalStatus;
}

export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'provider_turn_accepted'; requestId: string | number; turnId: string }
  | { type: 'provider_turn_started'; identity: ProviderTurnIdentity }
  | { type: 'compact_boundary' }
  | { type: 'assistant_text'; text: string; itemId?: string; complete?: boolean }
  | { type: 'tool_use'; toolName: string; toolId: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; isError: boolean; toolId: string; toolName?: string; content: string }
  | {
      type: 'result';
      text: string | null;
      isError?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      /**
       * The portion of inputTokens that is a cache re-read of prior context
       * (Anthropic's cache_read_input_tokens), not new consumption. Always a
       * subset of inputTokens — inputTokens itself is unchanged (still the
       * full billable total) so cost/budget consumers keep the accurate
       * figure. See #1774: this field exists so DB accumulators can stop
       * summing repeated context re-reads into a "total input" column.
       */
      cacheReadTokens?: number;
      costUsd?: number;
      /** Exact native identity and terminal status when the provider exposes it. */
      providerTurn?: ProviderTurnTerminalIdentity;
      /** Session-owned request token attached only after exact native terminal admission. */
      providerTurnOwnerToken?: number;
      /** Exact JSON-RPC request identity when a request fails before native turn creation. */
      providerRequestId?: string | number;
      /** Native terminal notification could not establish the identity required for admission. */
      providerTurnProtocolError?: 'missing_identity' | 'missing_request_identity';
    }
  | { type: 'token_usage'; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
  | { type: 'ignored' }
  | { type: 'ignored'; blockType: string; reason: IgnoredBlockReason }
  | { type: 'unknown_block'; blockType: string; raw: unknown }
  | { type: 'unknown'; raw: unknown }
  | { type: 'parse_error'; line: string };

/**
 * Split a provider event's combined inputTokens into the genuinely-new
 * portion and the cache-read portion. inputTokens/cacheReadTokens on the
 * event are both left at their original (combined) meaning — this is the
 * one place that derives "new tokens" for accumulators that must not sum
 * the same re-read context on every turn (#1774).
 */
export function splitInputTokenUsage(event: {
  inputTokens?: number;
  cacheReadTokens?: number;
}): { newInputTokens: number; cacheReadTokens: number } {
  const cacheReadTokens = event.cacheReadTokens ?? 0;
  const totalInputTokens = event.inputTokens ?? 0;
  return {
    newInputTokens: Math.max(0, totalInputTokens - cacheReadTokens),
    cacheReadTokens,
  };
}

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
  const blockType = describeBlockType(block);
  observeUnclassified('unknown_block', blockType);
  return { type: 'unknown_block', blockType, raw: block };
}

/** Top-level unclassified event envelope — logs the event TYPE STRING (id-only). */
function unknownEvent(parsed: unknown): AgentEvent {
  observeUnclassified('unknown', describeBlockType(parsed));
  return { type: 'unknown', raw: parsed };
}

/** Malformed-JSON envelope — logs the classification only, NEVER the raw line. */
function parseErrorEvent(line: string): AgentEvent {
  observeUnclassified('parse_error', 'parse_error');
  return { type: 'parse_error', line };
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
      case 'tool_reference':
        nestedEvents.push(isNonEmptyString(record['tool_name'])
          ? ignoredBlock('tool_reference', 'tool_reference')
          : unknownBlock(item));
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
  // Only meaningful alongside inputTokens — undefined whenever usage itself
  // is undefined, so a DB accumulator's `?? 0` fallback stays correct.
  const cacheReadTokens = baseInput !== undefined ? cacheRead : undefined;

  if (!isError) {
    return { type: 'result', text: null, inputTokens, outputTokens, cacheReadTokens };
  }

  const content = event['content'];
  if (typeof content === 'string') {
    return {
      type: 'result',
      text: content || null,
      isError: true,
      inputTokens,
      outputTokens,
      cacheReadTokens,
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
          cacheReadTokens,
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
      cacheReadTokens,
    };
  }
  return { type: 'result', text: null, isError: true, inputTokens, outputTokens, cacheReadTokens };
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
    return [parseErrorEvent(line)];
  }

  const event = asRecord(parsed);
  if (event === null) return [unknownEvent(parsed)];

  const topType = event['type'];
  if (topType === 'system') {
    const subtype = event['subtype'];
    if (subtype === 'init') {
      return [{ type: 'init', sessionId: String(event['session_id'] ?? '') }];
    }
    if (subtype === 'compact_boundary') return [{ type: 'compact_boundary' }];
    if (
      subtype === 'thinking_tokens'
      && typeof event['estimated_tokens'] === 'number'
      && typeof event['estimated_tokens_delta'] === 'number'
    ) {
      return [ignoredBlock('thinking_tokens', 'thinking_tokens')];
    }
    if (typeof subtype === 'string' && subtype.startsWith('hook')) {
      return [{ type: 'ignored' }];
    }
    return [unknownEvent(parsed)];
  }

  if (topType === 'assistant') {
    const message = asRecord(event['message']);
    const content = message?.['content'];
    if (!Array.isArray(content) || content.length === 0) {
      return [unknownEvent(parsed)];
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
      return [unknownEvent(parsed)];
    }
    if (!Array.isArray(content) || content.length === 0) {
      return [unknownEvent(parsed)];
    }
    return content.flatMap(parseUserBlock);
  }

  if (topType === 'result') return [resultEvent(event)];
  if (topType === 'rate_limit_event') {
    const rateLimitInfo = asRecord(event['rate_limit_info']);
    return rateLimitInfo?.['status'] === 'allowed'
      ? [ignoredBlock('rate_limit_event', 'rate_limit_event')]
      : [unknownEvent(parsed)];
  }

  return [unknownEvent(parsed)];
}

/**
 * @deprecated Migrate consumers to parseEvents so multi-block envelopes are not truncated.
 */
export function parseEvent(line: string): AgentEvent | null {
  return parseEvents(line)[0] ?? null;
}
