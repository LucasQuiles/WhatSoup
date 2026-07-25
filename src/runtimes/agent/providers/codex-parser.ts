// src/runtimes/agent/providers/codex-parser.ts
// Parses Codex app-server JSON-RPC nd-JSON lines into typed AgentEvents.
//
// The app-server protocol uses JSON-RPC 2.0 over newline-delimited JSON:
// - Server notifications: { jsonrpc: "2.0", method: "...", params: {...} }
// - Server responses:     { jsonrpc: "2.0", id: "...", result: {...} }
// - Server requests:      { jsonrpc: "2.0", id: "...", method: "...", params: {...} }

import type {
  AgentEvent,
  ProviderTurnIdentity,
  ProviderTurnTerminalStatus,
} from '../stream-parser.ts';
import { type JsonObject, isRecord, stringifyValue, extractMessage, extractTokenCounts } from './parser-utils.ts';

// ─── Item helpers ─────────────────────────────────────────────────────────────

/**
 * Extract tool input from a ThreadItem (commandExecution, fileChange, mcpToolCall).
 */
function extractToolInput(item: JsonObject): Record<string, unknown> {
  const itemType = String(item['type'] ?? '');

  if (itemType === 'commandExecution') {
    return {
      command: item['command'],
      ...(item['cwd'] ? { cwd: item['cwd'] } : {}),
    };
  }

  if (itemType === 'fileChange') {
    return {
      changes: item['changes'],
    };
  }

  if (itemType === 'mcpToolCall') {
    const args = item['arguments'];
    return {
      server: item['server'],
      tool: item['tool'],
      ...(isRecord(args) ? args : { arguments: args }),
    };
  }

  // Generic fallback
  const toolInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'type' || key === 'status') continue;
    toolInput[key] = value;
  }
  return toolInput;
}

/**
 * Extract content from a completed ThreadItem for tool_result.
 */
function extractToolResultContent(item: JsonObject): string {
  const itemType = String(item['type'] ?? '');

  if (itemType === 'commandExecution') {
    const output = item['aggregatedOutput'];
    if (typeof output === 'string' && output) return output;
    const exitCode = item['exitCode'];
    if (typeof exitCode === 'number') return `Exit code ${exitCode}`;
  }

  if (itemType === 'fileChange') {
    const status = item['status'];
    return typeof status === 'string' ? status : 'completed';
  }

  if (itemType === 'mcpToolCall') {
    const result = item['result'];
    if (isRecord(result)) {
      const text = result['text'] ?? result['content'] ?? result['output'];
      if (typeof text === 'string') return text;
      return stringifyValue(result);
    }
    const error = item['error'];
    if (isRecord(error)) {
      return String(error['message'] ?? error['text'] ?? stringifyValue(error));
    }
  }

  // Fallback
  return stringifyValue(item);
}

function isToolItemType(itemType: string): boolean {
  return (
    itemType === 'commandExecution' ||
    itemType === 'fileChange' ||
    itemType === 'mcpToolCall' ||
    itemType === 'dynamicToolCall'
  );
}

function isErrorStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized !== '' && normalized !== 'completed' && normalized !== 'success' && normalized !== 'ok';
}

function exactTurnIdentity(
  params: JsonObject,
  turn: JsonObject | null,
): ProviderTurnIdentity | null {
  const sessionId = params['threadId'];
  const turnId = turn?.['id'];
  if (
    typeof sessionId !== 'string'
    || sessionId.trim() === ''
    || typeof turnId !== 'string'
    || turnId.trim() === ''
  ) {
    return null;
  }
  return { sessionId, turnId };
}

function terminalStatus(value: unknown): ProviderTurnTerminalStatus {
  switch (value) {
    case 'completed':
    case 'failed':
    case 'interrupted':
      return value;
    default:
      return 'unknown';
  }
}

// ─── JSON-RPC notification handlers ──────────────────────────────────────────

function handleNotification(method: string, params: JsonObject): AgentEvent {
  switch (method) {
    case 'thread/started': {
      const thread = params['thread'];
      if (isRecord(thread)) {
        return { type: 'init', sessionId: String(thread['id'] ?? '') };
      }
      return { type: 'init', sessionId: '' };
    }

    case 'turn/started': {
      const turn = isRecord(params['turn']) ? params['turn'] : null;
      const identity = exactTurnIdentity(params, turn);
      return identity === null
        ? { type: 'unknown', raw: { method, params } }
        : { type: 'provider_turn_started', identity };
    }

    case 'item/agentMessage/delta': {
      const delta = params['delta'];
      if (typeof delta === 'string') {
        return {
          type: 'assistant_text',
          text: delta,
          itemId: typeof params['itemId'] === 'string' ? String(params['itemId']) : undefined,
        };
      }
      return { type: 'ignored' };
    }

    case 'item/started': {
      const item = params['item'];
      if (!isRecord(item)) return { type: 'unknown', raw: params };

      const itemType = String(item['type'] ?? '');
      if (!isToolItemType(itemType)) return { type: 'ignored' };

      return {
        type: 'tool_use',
        toolName: itemType,
        toolId: String(item['id'] ?? ''),
        toolInput: extractToolInput(item),
      };
    }

    case 'item/completed': {
      const item = params['item'];
      if (!isRecord(item)) return { type: 'unknown', raw: params };

      const itemType = String(item['type'] ?? '');

      // agentMessage completed: completion signal only.
      // The text itself is already streamed via item/agentMessage/delta.
      if (itemType === 'agentMessage') {
        return { type: 'ignored' };
      }

      if (!isToolItemType(itemType)) return { type: 'ignored' };

      return {
        type: 'tool_result',
        isError: isErrorStatus(String(item['status'] ?? '')),
        toolId: String(item['id'] ?? ''),
        content: extractToolResultContent(item),
      };
    }

    case 'turn/completed': {
      // turn field contains a Turn object with status
      const turn = isRecord(params['turn']) ? params['turn'] : null;
      const identity = exactTurnIdentity(params, turn);
      if (identity === null) {
        return {
          type: 'result',
          text: 'Provider turn completed without an exact native identity',
          isError: true,
          providerTurnProtocolError: 'missing_identity',
        };
      }
      const status = terminalStatus(turn?.['status']);
      const providerTurn = { ...identity, status };

      // Neither branch below carries inputTokens/outputTokens — that is NOT
      // the #1775 zero-token defect. Codex reports usage on a separate
      // notification, 'thread/tokenUsage/updated' (handled below, emits a
      // 'token_usage' event), which the runtime accumulates independently of
      // turn completion (see the 'token_usage' case in runtime.ts). Adding
      // usage fields here would double-count against that path.
      if (status === 'failed') {
        const error = isRecord(turn?.['error'])
          ? String((turn['error'] as JsonObject)['message'] ?? 'Codex turn failed')
          : 'Codex turn failed';
        return { type: 'result', text: error, isError: true, providerTurn };
      }

      if (status === 'interrupted') {
        return { type: 'result', text: null, isError: true, providerTurn };
      }
      if (status === 'unknown') {
        return {
          type: 'result',
          text: 'Provider turn completed with an unrecognized terminal status',
          isError: true,
          providerTurn,
        };
      }
      return { type: 'result', text: null, providerTurn };
    }

    case 'thread/compacted':
      return { type: 'compact_boundary' };

    case 'thread/tokenUsage/updated': {
      const { inputTokens, outputTokens } = extractTokenCounts(params);
      return { type: 'token_usage', inputTokens, outputTokens };
    }

    case 'thread/status/changed':
    case 'thread/name/updated':
    case 'thread/closed':
    case 'error':
      return { type: 'ignored' };

    default:
      return { type: 'unknown', raw: { method, params } };
  }
}

// ─── JSON-RPC response handlers ─────────────────────────────────────────────

function handleResponse(id: unknown, result: unknown): AgentEvent {
  // Responses to our requests (initialize, thread/start, turn/start, etc.)
  // Most are informational; the key one is thread/start which returns
  // the thread object. But we capture threadId from the thread/started
  // notification instead, so responses are generally ignored.

  if (isRecord(result)) {
    const turn = result['turn'];
    if (isRecord(turn)) {
      const turnId = turn['id'];
      if (
        (typeof id === 'string' || typeof id === 'number')
        && typeof turnId === 'string'
        && turnId.trim() !== ''
      ) {
        return {
          type: 'provider_turn_accepted',
          requestId: id,
          turnId,
        };
      }
      return {
        type: 'result',
        text: 'Provider accepted a turn without an exact request and turn identity',
        isError: true,
        ...(typeof id === 'string' || typeof id === 'number' ? { providerRequestId: id } : {}),
        providerTurnProtocolError: 'missing_identity',
      };
    }

    // Current responses wrap the Thread object, while historical fixtures
    // used the Thread object itself.
    const thread = result['thread'];
    if (isRecord(thread) && typeof thread['id'] === 'string') {
      return { type: 'init', sessionId: thread['id'] };
    }
    if (typeof result['id'] === 'string') {
      return { type: 'init', sessionId: result['id'] };
    }
  }

  return { type: 'ignored' };
}

// ─── Public parser ──────────────────────────────────────────────────────────

/**
 * Parse a single nd-JSON line from the Codex app-server into an AgentEvent.
 *
 * Handles three JSON-RPC message types:
 * - Notifications (method + params, no id)
 * - Responses (id + result)
 * - Server requests (id + method + params) — returned as 'approval_request'
 *   for upstream handling
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

  // ── Legacy exec --json format (type-based events) ─────────────────────
  // Support the old exec format for backward compatibility with fixtures/tests.
  if (parsed['type'] !== undefined && parsed['jsonrpc'] === undefined) {
    return parseLegacyExecEvent(parsed);
  }

  // ── JSON-RPC 2.0 (app-server format) ──────────────────────────────────
  const method = parsed['method'];
  const id = parsed['id'];
  const params = parsed['params'];
  const result = parsed['result'];

  // Notification: has method but no id
  if (typeof method === 'string' && id === undefined) {
    return handleNotification(method, isRecord(params) ? params : {});
  }

  // Response: has id and result (no method)
  if (id !== undefined && result !== undefined && method === undefined) {
    return handleResponse(id, result);
  }

  // Server request: has both id and method (approval requests etc.)
  // These need to be responded to by the session manager.
  if (id !== undefined && typeof method === 'string') {
    return { type: 'unknown', raw: parsed };
  }

  // Error response — a JSON-RPC transport/protocol error, not a completed
  // turn. No usage exists to report (see the 'turn/completed' comment above
  // for why Codex's usage signal is a separate notification anyway).
  if (id !== undefined && parsed['error'] !== undefined) {
    const error = parsed['error'];
    const errorMsg = isRecord(error) ? String(error['message'] ?? 'Unknown error') : String(error);
    return typeof id === 'string' || typeof id === 'number'
      ? {
        type: 'result',
        text: `Codex error: ${errorMsg}`,
        isError: true,
        providerRequestId: id,
      }
      : {
        type: 'result',
        text: `Codex error: ${errorMsg}`,
        isError: true,
        providerTurnProtocolError: 'missing_request_identity',
      };
  }

  return { type: 'unknown', raw: parsed };
}

// ─── Legacy exec --json parser ──────────────────────────────────────────────
// Kept for backward compatibility with existing test fixtures that use the
// old `codex exec --json` JSONL format.

function extractLegacyToolInput(item: JsonObject): Record<string, unknown> {
  const itemType = String(item['type'] ?? '');

  if (itemType === 'command_execution') {
    return { command: item['command'] };
  }

  if (itemType === 'file_change') {
    return { changes: item['changes'] };
  }

  if (itemType === 'mcp_tool_call') {
    const rawInput = item['input'];
    if (isRecord(rawInput)) return rawInput;
  }

  const toolInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id' || key === 'type' || key === 'status') continue;
    toolInput[key] = value;
  }
  return toolInput;
}

function extractLegacyToolResultContent(item: JsonObject): string {
  const direct =
    extractMessage(item['aggregated_output']) ??
    extractMessage(item['output']) ??
    extractMessage(item['result']) ??
    extractMessage(item['error']) ??
    extractMessage(item['message']);

  if (direct) return direct;

  const exitCode = item['exit_code'];
  if (typeof exitCode === 'number') return `Exit code ${exitCode}`;

  const status = item['status'];
  if (typeof status === 'string' && status) return status;

  return stringifyValue(item);
}

function isLegacyToolItemType(itemType: string): boolean {
  return itemType === 'command_execution' || itemType === 'file_change' || itemType === 'mcp_tool_call';
}

function parseLegacyExecEvent(parsed: JsonObject): AgentEvent {
  const eventType = parsed['type'];

  if (eventType === 'thread.started') {
    return { type: 'init', sessionId: String(parsed['thread_id'] ?? '') };
  }

  if (eventType === 'turn.started') {
    return { type: 'ignored' };
  }

  if (eventType === 'item.started' || eventType === 'item.completed') {
    const item = parsed['item'];
    if (!isRecord(item)) return { type: 'unknown', raw: parsed };

    const itemType = String(item['type'] ?? '');

    if (eventType === 'item.completed' && itemType === 'agent_message') {
      return {
        type: 'assistant_text',
        text: extractMessage(item['text']) ?? extractMessage(item['content']) ?? '',
        itemId: String(item['id'] ?? ''),
        complete: true,
      };
    }

    if (!isLegacyToolItemType(itemType)) return { type: 'ignored' };

    if (eventType === 'item.started') {
      return {
        type: 'tool_use',
        toolName: itemType,
        toolId: String(item['id'] ?? ''),
        toolInput: extractLegacyToolInput(item),
      };
    }

    return {
      type: 'tool_result',
      isError: isErrorStatus(String(item['status'] ?? '')),
      toolId: String(item['id'] ?? ''),
      content: extractLegacyToolResultContent(item),
    };
  }

  if (eventType === 'turn.completed') {
    const { inputTokens, outputTokens } = extractTokenCounts(parsed['usage']);
    return {
      type: 'result',
      text: null,
      inputTokens,
      outputTokens,
      providerTurnProtocolError: 'missing_identity',
    };
  }

  if (eventType === 'turn.failed') {
    const { inputTokens, outputTokens } = extractTokenCounts(parsed['usage']);
    return {
      type: 'result',
      text:
        extractMessage(parsed['error']) ??
        extractMessage(parsed['message']) ??
        extractMessage(parsed['details']) ??
        extractMessage(parsed['reason']) ??
        'Codex CLI turn failed',
      isError: true,
      inputTokens,
      outputTokens,
      providerTurnProtocolError: 'missing_identity',
    };
  }

  return { type: 'unknown', raw: parsed };
}
