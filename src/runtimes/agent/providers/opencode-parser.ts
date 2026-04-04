// src/runtimes/agent/providers/opencode-parser.ts
// Parses OpenCode `run --format json` JSONL lines into typed AgentEvents.
//
// OpenCode emits newline-delimited JSON with these event types:
//   step_start  — marks the beginning of a step (first = session init)
//   text        — assistant text content
//   tool_use    — completed tool call (input + output both present in one event)
//   step_finish — end of step; reason="stop" → final result, reason="tool-calls" → more steps follow
//
// Because OpenCode's tool_use events carry both input and output (already completed),
// we emit a single tool_result event per tool_use line. This keeps the parser interface
// compatible with (line: string) => AgentEvent | null.

import type { AgentEvent } from '../stream-parser.ts';
import { type JsonObject, isRecord, stringifyValue } from './parser-utils.ts';

// Module-level flag: tracks whether the first step_start has been seen.
let _firstStepSeen = false;

/** Reset parser state (use between test cases). */
export function resetParserState(): void {
  _firstStepSeen = false;
}

/**
 * Parse a single JSONL line from OpenCode `run --format json` into an AgentEvent.
 *
 * Returns null for empty/whitespace-only lines.
 * Returns { type: 'parse_error', line } for malformed JSON.
 * Never throws.
 */
export function parseOpenCodeEvent(line: string): AgentEvent | null {
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

  // ── step_start ──────────────────────────────────────────────────────────────
  // First step_start → emit init with the session ID.
  // Subsequent step_starts follow tool-call rounds and are ignored.
  if (eventType === 'step_start') {
    if (!_firstStepSeen) {
      _firstStepSeen = true;
      return { type: 'init', sessionId: String(parsed['sessionID'] ?? '') };
    }
    return { type: 'ignored' };
  }

  // ── text ────────────────────────────────────────────────────────────────────
  if (eventType === 'text') {
    const part = parsed['part'];
    if (isRecord(part)) {
      return { type: 'assistant_text', text: String(part['text'] ?? '') };
    }
    return { type: 'ignored' };
  }

  // ── tool_use ─────────────────────────────────────────────────────────────────
  // OpenCode emits completed tool calls with both input and output in a single event.
  // Emit tool_result since the tool has already completed and both sides are available.
  if (eventType === 'tool_use') {
    const part = parsed['part'];
    if (!isRecord(part)) {
      return { type: 'unknown', raw: parsed };
    }

    const callID = String(part['callID'] ?? '');
    const state = part['state'];

    if (!isRecord(state)) {
      return {
        type: 'tool_result',
        isError: false,
        toolId: callID,
        content: '',
      };
    }

    const status = String(state['status'] ?? '');
    const isError = status !== 'completed';
    const content = stringifyValue(state['output']);

    return {
      type: 'tool_result',
      isError,
      toolId: callID,
      content,
    };
  }

  // ── step_finish ─────────────────────────────────────────────────────────────
  if (eventType === 'step_finish') {
    const part = parsed['part'];
    if (!isRecord(part)) {
      return { type: 'ignored' };
    }

    const reason = String(part['reason'] ?? '');

    if (reason === 'stop') {
      const tokens = part['tokens'];
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      if (isRecord(tokens)) {
        const inp = tokens['input'];
        const out = tokens['output'];
        if (typeof inp === 'number') inputTokens = inp;
        if (typeof out === 'number') outputTokens = out;
      }

      return { type: 'result', text: null, inputTokens, outputTokens };
    }

    // reason="tool-calls": more steps follow
    return { type: 'ignored' };
  }

  return { type: 'unknown', raw: parsed };
}
