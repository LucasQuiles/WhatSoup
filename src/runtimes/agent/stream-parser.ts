// src/runtimes/agent/stream-parser.ts
// Parses Claude Code stream-json (JSONL) lines into typed AgentEvents.

export type AgentEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'compact_boundary' }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolName: string; toolId: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; isError: boolean; toolId: string; content: string }
  | { type: 'result'; text: string | null; inputTokens?: number; outputTokens?: number }
  | { type: 'token_usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'ignored' }
  | { type: 'unknown'; raw: unknown }
  | { type: 'parse_error'; line: string };

/**
 * Parse a single JSONL line from a Claude Code stream-json output into an AgentEvent.
 *
 * Returns null for empty/whitespace-only lines.
 * Returns { type: 'parse_error', line } for malformed JSON.
 * Never throws.
 */
export function parseEvent(line: string): AgentEvent | null {
  if (line.trim() === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: 'parse_error', line };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'unknown', raw: parsed };
  }

  const event = parsed as Record<string, unknown>;
  const topType = event['type'];

  if (topType === 'system') {
    const subtype = event['subtype'];
    if (subtype === 'init') {
      const sessionId = String(event['session_id'] ?? '');
      return { type: 'init', sessionId };
    }
    if (subtype === 'compact_boundary') {
      return { type: 'compact_boundary' };
    }
    if (typeof subtype === 'string' && subtype.startsWith('hook')) {
      return { type: 'ignored' };
    }
    return { type: 'unknown', raw: parsed };
  }

  if (topType === 'assistant') {
    const message = event['message'];
    if (typeof message !== 'object' || message === null) {
      return { type: 'unknown', raw: parsed };
    }
    const content = (message as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) {
      return { type: 'unknown', raw: parsed };
    }

    // Return the first recognizable content block
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text') {
        return { type: 'assistant_text', text: String(b['text'] ?? '') };
      }
      if (b['type'] === 'tool_use') {
        const rawInput = b['input'];
        const toolInput: Record<string, unknown> =
          typeof rawInput === 'object' && rawInput !== null && !Array.isArray(rawInput)
            ? (rawInput as Record<string, unknown>)
            : {};
        return {
          type: 'tool_use',
          toolName: String(b['name'] ?? ''),
          toolId: String(b['id'] ?? ''),
          toolInput,
        };
      }
    }
    return { type: 'unknown', raw: parsed };
  }

  if (topType === 'user') {
    const content = event['message'];
    const messageObj =
      typeof content === 'object' && content !== null
        ? (content as Record<string, unknown>)
        : event;
    const directContent = messageObj['content'];
    if (typeof directContent === 'string') {
      const trimmed = directContent.trim();
      // Claude emits unknown slash-skill failures as synthetic user messages
      // before any assistant/result event. Surface them as a terminal result so
      // the WhatsApp runtime does not silently drop the turn.
      if (/^Unknown skill:\s+/i.test(trimmed)) {
        return { type: 'result', text: trimmed };
      }
    }
    const contentArr = messageObj['content'];
    if (Array.isArray(contentArr)) {
      for (const block of contentArr) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result') {
          const isError = b['is_error'] === true;
          const toolId = String(b['tool_use_id'] ?? '');
          // Extract text content from the tool_result
          let content = '';
          const resultContent = b['content'];
          if (typeof resultContent === 'string') {
            content = resultContent;
          } else if (Array.isArray(resultContent)) {
            content = resultContent
              .filter((c: any) => typeof c === 'object' && c?.type === 'text')
              .map((c: any) => String(c.text ?? ''))
              .join('\n');
          }
          return { type: 'tool_result', isError, toolId, content };
        }
      }
    }
    return { type: 'unknown', raw: parsed };
  }

  if (topType === 'result') {
    // Only surface result text for error/non-success outcomes (e.g. context-limit errors).
    // On successful turns the response was already delivered via assistant_text events —
    // re-rendering result.result would send every reply twice.
    const isError = event['is_error'] === true;
    const rawUsage = event['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
    const inputTokens = typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : undefined;
    const outputTokens = typeof rawUsage?.output_tokens === 'number' ? rawUsage.output_tokens : undefined;

    if (!isError) {
      return { type: 'result', text: null, inputTokens, outputTokens };
    }

    // Error result: extract the error message text.
    const content = event['content'];
    if (typeof content === 'string') {
      return { type: 'result', text: content || null, inputTokens, outputTokens };
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text') {
          return { type: 'result', text: String(b['text'] ?? '') || null, inputTokens, outputTokens };
        }
      }
    }
    const resultField = event['result'];
    if (typeof resultField === 'string') {
      return { type: 'result', text: resultField || null, inputTokens, outputTokens };
    }
    return { type: 'result', text: null, inputTokens, outputTokens };
  }

  return { type: 'unknown', raw: parsed };
}
