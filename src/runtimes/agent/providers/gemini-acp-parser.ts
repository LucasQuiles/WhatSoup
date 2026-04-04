// src/runtimes/agent/providers/gemini-acp-parser.ts
// Parses Gemini CLI ACP (--acp) nd-JSON lines into typed AgentEvents.
//
// ACP protocol: JSON-RPC 2.0 over newline-delimited stdio.
//
// Outbound (to Gemini stdin):
//   {"jsonrpc":"2.0","id":N,"method":"initialize","params":{...}}
//   {"jsonrpc":"2.0","id":N,"method":"session/new","params":{...}}
//   {"jsonrpc":"2.0","id":N,"method":"session/prompt","params":{"sessionId":"...","prompt":[...]}}
//
// Inbound (from Gemini stdout):
//   Responses:     {"jsonrpc":"2.0","id":N,"result":{...}}           (reply to a request)
//   Notifications: {"jsonrpc":"2.0","method":"session/update","params":{...}}  (async push)
//   Error:         {"jsonrpc":"2.0","id":N,"error":{"code":N,"message":"..."}} (RPC error)
//
// stdout also emits non-JSON log lines (e.g. "Hook registry initialized…").
// Those must be silently filtered — never throw on a non-JSON line.

import type { AgentEvent } from '../stream-parser.ts';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** A parsed JSON-RPC frame (notification, response, or error response). */
export type AcpFrame =
  | { kind: 'notification'; method: string; params: JsonObject }
  | { kind: 'response'; id: number | string; result: JsonObject }
  | { kind: 'error_response'; id: number | string | null; code: number; message: string }
  | { kind: 'unknown'; raw: JsonObject };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    const parts = value
      .map((item) => extractMessage(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of ['text', 'message', 'error', 'details', 'content', 'output']) {
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

function extractTokenCounts(
  stats: unknown,
): Pick<Extract<AgentEvent, { type: 'result' }>, 'inputTokens' | 'outputTokens'> {
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

  for (const inputPath of inputPaths) {
    const inputTokens = getNestedNumber(stats, inputPath);
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

  for (const outputPath of outputPaths) {
    const outputTokens = getNestedNumber(stats, outputPath);
    if (outputTokens !== undefined) {
      return { outputTokens };
    }
  }

  return {};
}

// ---------------------------------------------------------------------------
// ACP frame parser — low level
// ---------------------------------------------------------------------------

/**
 * Parse a raw stdout line into a structured ACP frame.
 *
 * Returns null for:
 * - empty / whitespace-only lines
 * - non-JSON log lines (silently filtered per investigation findings)
 *
 * Never throws.
 */
export function parseAcpFrame(line: string): AcpFrame | null {
  if (line.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Non-JSON log line — silently ignore as per investigation recommendation.
    return null;
  }

  if (!isRecord(parsed)) {
    return { kind: 'unknown', raw: { _value: parsed } };
  }

  // Must have "jsonrpc" field to be a JSON-RPC frame.
  if (parsed['jsonrpc'] !== '2.0') {
    return { kind: 'unknown', raw: parsed };
  }

  const hasId = 'id' in parsed;
  const method = parsed['method'];
  const params = parsed['params'];
  const result = parsed['result'];
  const error = parsed['error'];

  // Error response: has id + error field.
  if (hasId && isRecord(error)) {
    const code = typeof error['code'] === 'number' ? error['code'] : 0;
    const message = typeof error['message'] === 'string' ? error['message'] : stringifyValue(error);
    const id = (parsed['id'] as number | string | null) ?? null;
    return { kind: 'error_response', id, code, message };
  }

  // Successful response: has id + result field.
  if (hasId && isRecord(result)) {
    const id = parsed['id'] as number | string;
    return { kind: 'response', id, result };
  }

  // Notification: has method but no id.
  if (!hasId && typeof method === 'string') {
    return {
      kind: 'notification',
      method,
      params: isRecord(params) ? params : {},
    };
  }

  return { kind: 'unknown', raw: parsed };
}

// ---------------------------------------------------------------------------
// session/update update-type handlers
// ---------------------------------------------------------------------------

/**
 * Map a single `session/update` params.update object to an AgentEvent.
 *
 * The `update` field is a discriminated union keyed by an implicit type field
 * or the keys present. Based on the investigation, observed update shapes:
 *   - available_commands_update: session capability info — ignore
 *   - agent_message_chunk:       streaming assistant text
 *   - tool_use:                  tool invocation
 *   - tool_result:               tool result
 *   - turn_complete / stop:      end of turn with optional usage
 */
function mapSessionUpdate(
  update: JsonObject,
  sessionId: string,
): AgentEvent | null {
  // Determine the update type. The Gemini ACP bundle uses a discriminated key.
  const updateType = update['type'] as string | undefined;

  // --- agent_message_chunk: streaming assistant text ---
  if (updateType === 'agent_message_chunk' || 'chunk' in update) {
    const text =
      extractMessage(update['chunk']) ??
      extractMessage(update['text']) ??
      extractMessage(update['content']) ??
      '';
    // Empty chunks are common in streaming — emit them so consumers can
    // decide whether to buffer or forward.
    return { type: 'assistant_text', text };
  }

  // --- available_commands_update: session capability handshake — ignore ---
  if (updateType === 'available_commands_update' || 'available_commands' in update) {
    return { type: 'ignored' };
  }

  // --- tool_use: the model is calling a tool ---
  if (updateType === 'tool_use' || ('tool_name' in update && 'tool_id' in update && !('status' in update))) {
    const rawInput = update['input'] ?? update['tool_input'] ?? update['parameters'];
    return {
      type: 'tool_use',
      toolName: String(update['tool_name'] ?? update['name'] ?? ''),
      toolId: String(update['tool_id'] ?? update['id'] ?? ''),
      toolInput: isRecord(rawInput) ? rawInput : {},
    };
  }

  // --- tool_result: tool execution result ---
  if (
    updateType === 'tool_result' ||
    ('tool_id' in update && ('output' in update || 'result' in update || 'status' in update))
  ) {
    const status = String(update['status'] ?? '').trim().toLowerCase();
    const isError = status !== '' && status !== 'success' && status !== 'ok' && status !== 'completed';
    const content =
      extractMessage(update['output']) ??
      extractMessage(update['result']) ??
      extractMessage(update['error']) ??
      stringifyValue(update['content']) ??
      '';
    return {
      type: 'tool_result',
      isError,
      toolId: String(update['tool_id'] ?? update['id'] ?? ''),
      content,
    };
  }

  // --- turn_complete / stop: end-of-turn signal with optional token usage ---
  if (
    updateType === 'turn_complete' ||
    updateType === 'stop' ||
    updateType === 'end_turn' ||
    'stop_reason' in update ||
    'stopReason' in update
  ) {
    const { inputTokens, outputTokens } = extractTokenCounts(
      update['usage'] ?? update['stats'] ?? update,
    );
    return { type: 'result', text: null, inputTokens, outputTokens };
  }

  // --- error update ---
  if (updateType === 'error' || 'error' in update) {
    const text =
      extractMessage(update['error']) ??
      extractMessage(update['message']) ??
      stringifyValue(update);
    return { type: 'result', text: text ?? 'Gemini ACP error' };
  }

  // Unknown update shape — pass through for diagnostics.
  return { type: 'unknown', raw: update };
}

// ---------------------------------------------------------------------------
// Public high-level parser
// ---------------------------------------------------------------------------

/**
 * Parse a single stdout line from `gemini --acp` into an AgentEvent.
 *
 * Mapping:
 * - Non-JSON lines (log noise)       → null (silently filtered)
 * - Empty lines                      → null
 * - initialize response              → { type: 'init', sessionId: '' }
 *                                      (sessionId is assigned later via session/new)
 * - session/new response             → { type: 'init', sessionId }
 * - session/update notification      → mapped via mapSessionUpdate()
 * - session/prompt response (final)  → { type: 'result', ... } with token counts
 * - JSON-RPC error response          → { type: 'result', text: errorMessage }
 * - other frames                     → { type: 'unknown', raw }
 *
 * Never throws.
 */
export function parseGeminiAcpEvent(line: string, currentSessionId = ''): AgentEvent | null {
  const frame = parseAcpFrame(line);

  if (frame === null) {
    return null;
  }

  // --- JSON-RPC error response ---
  if (frame.kind === 'error_response') {
    return {
      type: 'result',
      text: `Gemini ACP error (code ${frame.code}): ${frame.message}`,
    };
  }

  // --- Successful JSON-RPC response ---
  if (frame.kind === 'response') {
    const result = frame.result;

    // initialize response: {"result":{"protocolVersion":1,"capabilities":{}}}
    if ('protocolVersion' in result) {
      // The real sessionId arrives in the session/new response.
      return { type: 'init', sessionId: '' };
    }

    // session/new response: {"result":{"sessionId":"<uuid>",...}}
    const sessionId =
      typeof result['sessionId'] === 'string' ? result['sessionId'] : undefined;
    if (sessionId !== undefined) {
      return { type: 'init', sessionId };
    }

    // session/prompt final response: stopReason indicates end-of-turn.
    const stopReason = result['stopReason'] ?? result['stop_reason'];
    if (stopReason !== undefined) {
      const { inputTokens, outputTokens } = extractTokenCounts(
        result['usage'] ?? result['stats'] ?? result,
      );
      return { type: 'result', text: null, inputTokens, outputTokens };
    }

    // Other responses (e.g. pong, ack) — ignore.
    return { type: 'ignored' };
  }

  // --- Notification ---
  if (frame.kind === 'notification') {
    if (frame.method === 'session/update') {
      const params = frame.params;
      const update = params['update'];
      const sessionId =
        typeof params['sessionId'] === 'string' ? params['sessionId'] : currentSessionId;

      if (!isRecord(update)) {
        // params itself may be the update when the update key is absent.
        return mapSessionUpdate(params, sessionId);
      }

      return mapSessionUpdate(update, sessionId);
    }

    // Other notifications — ignore for now.
    return { type: 'ignored' };
  }

  // --- Unknown frame ---
  if (frame.kind === 'unknown') {
    return { type: 'unknown', raw: frame.raw };
  }

  return { type: 'unknown', raw: frame };
}

// ---------------------------------------------------------------------------
// ACP request builders — utilities for the session manager
// ---------------------------------------------------------------------------

/** Build a JSON-RPC nd-JSON line (ready to write to Gemini stdin). */
export function buildAcpRequest(
  id: number,
  method: string,
  params: JsonObject,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

/** Build the ACP `initialize` request (must be sent first). */
export function buildInitializeRequest(id: number): string {
  return buildAcpRequest(id, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
}

/** Build the ACP `session/new` request. */
export function buildSessionNewRequest(
  id: number,
  cwd: string,
  mcpServers: JsonObject[] = [],
  systemPrompt?: string,
): string {
  return buildAcpRequest(id, 'session/new', {
    cwd,
    mcpServers,
    ...(systemPrompt ? { systemPrompt } : {}),
  });
}

/** Build the ACP `session/prompt` request for a text turn. */
export function buildSessionPromptRequest(
  id: number,
  sessionId: string,
  text: string,
): string {
  return buildAcpRequest(id, 'session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text }],
  });
}
