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
import { extractMessage, isRecord, stringifyValue } from './parser-utils.ts';

const OPENCODE_STATUS_EXCERPT_CHARS = 96;

function toolResultDetail(value: unknown): string | null {
  const extracted = extractMessage(value)?.trim();
  if (extracted) return extracted;
  const serialized = stringifyValue(value).trim();
  return serialized || null;
}

function statusFallback(status: string): string {
  const normalized = status.trim().replace(/\s+/g, ' ');
  if (!normalized) return 'OpenCode tool failed without status or error detail.';
  const bounded = normalized.length > OPENCODE_STATUS_EXCERPT_CHARS
    ? `${normalized.slice(0, OPENCODE_STATUS_EXCERPT_CHARS - 1)}…`
    : normalized;
  return `OpenCode tool failed with status "${bounded}".`;
}

export interface OpenCodeParser {
  parse: (line: string) => AgentEvent | null;
  reset: () => void;
}

/**
 * Create an isolated OpenCode parser instance.
 *
 * Each instance tracks its own `firstStepSeen` flag, so concurrent sessions
 * (different chats) do not interfere with each other.
 */
export function createOpenCodeParser(): OpenCodeParser {
  let firstStepSeen = false;

  return {
    parse(line: string): AgentEvent | null {
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

      // ── step_start ──────────────────────────────────────────────────────────
      // First step_start → emit init with the session ID.
      // Subsequent step_starts follow tool-call rounds and are ignored.
      if (eventType === 'step_start') {
        if (!firstStepSeen) {
          firstStepSeen = true;
          return { type: 'init', sessionId: String(parsed['sessionID'] ?? '') };
        }
        return { type: 'ignored' };
      }

      // ── text ──────────────────────────────────────────────────────────────────
      if (eventType === 'text') {
        const part = parsed['part'];
        if (isRecord(part)) {
          return { type: 'assistant_text', text: String(part['text'] ?? '') };
        }
        return { type: 'ignored' };
      }

      // ── tool_use ────────────────────────────────────────────────────────────
      // OpenCode emits completed tool calls with both input and output in a single event.
      // Emit tool_result since the tool has already completed and both sides are available.
      if (eventType === 'tool_use') {
        const part = parsed['part'];
        if (!isRecord(part)) {
          return { type: 'unknown', raw: parsed };
        }

        const callID = String(part['callID'] ?? '');
        const toolName = String(part['tool'] ?? '').trim();
        const state = part['state'];

        if (!isRecord(state)) {
          return {
            type: 'tool_result',
            isError: true,
            toolId: callID,
            ...(toolName ? { toolName } : {}),
            content: 'OpenCode tool result had missing or malformed state.',
          };
        }

        const status = String(state['status'] ?? '');
        const isError = status !== 'completed';
        const content = isError
          ? toolResultDetail(state['error'])
            ?? toolResultDetail(state['output'])
            ?? toolResultDetail(state['metadata'])
            ?? statusFallback(status)
          : stringifyValue(state['output']);

        return {
          type: 'tool_result',
          isError,
          toolId: callID,
          ...(toolName ? { toolName } : {}),
          content,
        };
      }

      // ── step_finish ─────────────────────────────────────────────────────────
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

          // part.cost is the per-turn USD cost reported by opencode.
          // Accept only finite, non-negative numbers; anything else stays undefined.
          let costUsd: number | undefined;
          const cost = part['cost'];
          if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
            costUsd = cost;
          }

          return { type: 'result', text: null, inputTokens, outputTokens, costUsd };
        }

        // reason="tool-calls": more steps follow
        return { type: 'ignored' };
      }

      return { type: 'unknown', raw: parsed };
    },

    reset() {
      firstStepSeen = false;
    },
  };
}
