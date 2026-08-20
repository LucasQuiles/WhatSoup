// src/runtimes/agent/stream-parser.ts
// Parses provider stream-json (JSONL) lines into ordered AgentEvent envelopes.

import { createChildLogger } from '../../logger.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';

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
// Hard cardinality cap: a hostile or buggy provider emitting many distinct type strings
// must not grow this set without bound.
const MAX_OBSERVED_UNCLASSIFIED = 128;
// Saturation telemetry: preserving the memory bound above must not let observability go
// SILENTLY dark. 128 syntactically-valid distinct types exhaust the set just as a hostile
// stream would; once saturated, novel types can no longer be recorded — so count the
// novel-but-unrecordable drops (saturating at MAX_SAFE_INTEGER, never overflowing) and warn
// only at power-of-two milestones (1, 2, 4, 8, ...) for bounded log volume. No LRU eviction:
// evicting to admit new types would let an unbounded type stream log without bound.
let suppressedNovelEventCount = 0;
let nextSuppressionNotifyAt = 1;

/** Reset the per-process unclassified-type dedupe + saturation telemetry (tests only). */
export function _resetStreamParserObservability(): void {
  observedUnclassified.clear();
  suppressedNovelEventCount = 0;
  nextSuppressionNotifyAt = 1;
}

/** Snapshot the observed unclassified keys, id-only (tests only). */
export function _observedUnclassifiedKeys(): readonly string[] {
  return [...observedUnclassified];
}

/** Count of novel unclassified events dropped after the set saturated (tests only). */
export function _suppressedNovelEventCount(): number {
  return suppressedNovelEventCount;
}

function observeUnclassified(
  classification: 'unknown' | 'unknown_block' | 'parse_error',
  blockType: string,
): void {
  const key = `${classification}:${blockType}`;
  if (observedUnclassified.has(key)) return;
  if (observedUnclassified.size >= MAX_OBSERVED_UNCLASSIFIED) {
    // Saturated — cannot record this novel type. Do NOT vanish silently: count the drop
    // (saturating, never overflowing) and warn only at power-of-two milestones.
    if (suppressedNovelEventCount < Number.MAX_SAFE_INTEGER) suppressedNovelEventCount += 1;
    if (suppressedNovelEventCount >= nextSuppressionNotifyAt) {
      // id-only: `blockType` is a bounded discriminant; the count conveys saturation pressure.
      parserLog.warn(
        { classification, blockType, suppressedNovelEventCount },
        'stream-parser: unclassified-event observability saturated (id-only, power-of-two sampled)',
      );
      nextSuppressionNotifyAt *= 2;
    }
    return;
  }
  observedUnclassified.add(key);
  // id-only: `blockType` is a bounded type discriminant, never payload content or fields.
  parserLog.warn({ classification, blockType }, 'stream-parser: unclassified provider event (id-only)');
}

export const IGNORED_BLOCK_REASONS = {
  thinking: 'model-internal, no side effects',
  redacted_thinking: 'model-internal redacted reasoning, no side effects',
  thinking_tokens: 'model-internal token estimate, no runtime side effects',
  rate_limit_event: 'provider rate-limit telemetry, no runtime side effects',
  tool_progress: 'tool-execution progress telemetry, no runtime side effects',
  api_retry: 'provider API retry telemetry, no runtime side effects',
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

// Strict discriminant charset: a lowercase ascii word, bounded length. Anything outside
// it (control chars, bidi marks, punctuation, unicode, oversized) collapses to a safe
// placeholder so the observability key space stays legible and bounded.
const SAFE_DISCRIMINANT = /^[a-z][a-z0-9_]{0,39}$/;
function boundedDiscriminant(value: unknown): string {
  return typeof value === 'string' && SAFE_DISCRIMINANT.test(value) ? value : '<unsafe>';
}

function describeBlockType(block: unknown): string {
  const record = asRecord(block);
  if (record === null) return '<non-object>';
  if (!Object.hasOwn(record, 'type')) return '<missing>';
  const type = record['type'];
  if (typeof type !== 'string') return '<invalid>';
  // Surface the system SUBTYPE (bounded) so an unknown system event is diagnosable in
  // production instead of collapsing to an opaque 'system'. Type/subtype only — never
  // any other envelope field.
  if (type === 'system' && record['subtype'] !== undefined) {
    return `system:${boundedDiscriminant(record['subtype'])}`;
  }
  // Bound the top-level type too (not just the system subtype): this is the dominant
  // unclassified path, and an unbounded raw type would defeat the key-space bound —
  // storing/logging arbitrary-length, control/bidi, or sentinel-forging strings.
  return boundedDiscriminant(type);
}

// Documented Claude CLI 2.1.x system/api_retry error categories (closed enum).
const API_RETRY_ERROR_CATEGORIES = new Set<string>([
  'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit',
  'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown',
  'max_output_tokens',
]);

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// Full-schema validation for Claude CLI 2.1.x `{"type":"system","subtype":"api_retry"}`:
// safe nonnegative integer counters with a coherent attempt range (attempt <= max_retries),
// an HTTP-range-or-null error_status, a documented error category, and present session
// identifiers. Anything outside the documented shape stays fail-closed (`unknown`).
function isInertApiRetry(event: JsonRecord): boolean {
  const attempt = event['attempt'];
  const maxRetries = event['max_retries'];
  const errorStatus = event['error_status'];
  const error = event['error'];
  return (
    isSafeNonNegativeInt(attempt)
    && isSafeNonNegativeInt(maxRetries)
    && isSafeNonNegativeInt(event['retry_delay_ms'])
    && attempt <= maxRetries
    && (errorStatus === null
      || (typeof errorStatus === 'number' && Number.isInteger(errorStatus)
        && errorStatus >= 100 && errorStatus <= 599))
    && typeof error === 'string' && API_RETRY_ERROR_CATEGORIES.has(error)
    && isNonEmptyString(event['uuid'])
    && isNonEmptyString(event['session_id'])
  );
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
    // Claude CLI 2.1.x `api_retry`: documented, side-effect-free retry telemetry emitted
    // when an API request hits a retryable error before the CLI auto-retries. Classify it
    // inert ONLY when the full documented envelope validates; any malformed, out-of-range,
    // or unknown field stays fail-closed. This recognizes a real protocol event — it does
    // NOT assert api_retry caused any particular historically-observed rejection.
    if (subtype === 'api_retry') {
      return isInertApiRetry(event) ? [ignoredBlock('api_retry', 'api_retry')] : [unknownEvent(parsed)];
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
  if (topType === 'tool_progress') {
    // Tool-execution progress telemetry (Claude CLI >= 2.1.x, streamed while an MCP
    // tool runs — e.g. a large media download). The tool request (tool_use) and its
    // outcome (tool_result) are separate events, so a progress envelope carries no
    // model output or runtime side effect. Classify it inert rather than unknown so
    // it stops flooding ambiguous_event rejections on every tool-heavy turn.
    return [ignoredBlock('tool_progress', 'tool_progress')];
  }

  return [unknownEvent(parsed)];
}

/**
 * @deprecated Migrate consumers to parseEvents so multi-block envelopes are not truncated.
 */
export function parseEvent(line: string): AgentEvent | null {
  return parseEvents(line)[0] ?? null;
}
