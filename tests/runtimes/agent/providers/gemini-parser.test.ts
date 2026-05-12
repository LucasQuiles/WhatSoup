/**
 * Direct unit coverage for src/runtimes/agent/providers/gemini-parser.ts.
 *
 * `parseGeminiEvent(line)` parses one JSONL line from Gemini CLI
 * `--output-format stream-json` into an AgentEvent. The function has 8
 * distinct branches:
 *   - empty/whitespace → null
 *   - malformed JSON → { type: 'parse_error', line }
 *   - non-object parsed → { type: 'unknown', raw }
 *   - type='init' → { type: 'init', sessionId }
 *   - type='message' + role='assistant' + delta=true → assistant_text
 *   - type='message' (other) → unknown
 *   - type='tool_use' → tool_use with toolName/toolId/toolInput
 *   - type='tool_result' → tool_result with isError flag
 *   - type='result' → result with text + token counts
 *   - type='error' → result with text from error/message
 *   - unrecognised type → unknown
 *
 * Existing parser-interface-conformance.test.ts covers init + assistant_text
 * only (2 of 8 branches generically). This file pins each remaining
 * gemini-specific branch.
 */
import { describe, expect, it } from 'vitest';
import { parseGeminiEvent } from '../../../../src/runtimes/agent/providers/gemini-parser.ts';

describe('parseGeminiEvent — boundary inputs', () => {
  it('returns null for empty string', () => {
    expect(parseGeminiEvent('')).toBeNull();
  });

  it('returns null for whitespace-only line', () => {
    expect(parseGeminiEvent('   \t\n   ')).toBeNull();
  });

  it('returns { type: "parse_error", line } for malformed JSON', () => {
    expect(parseGeminiEvent('{not valid json}')).toEqual({
      type: 'parse_error',
      line: '{not valid json}',
    });
  });

  it('returns { type: "unknown", raw } when parsed JSON is not an object', () => {
    expect(parseGeminiEvent('"a string"')).toEqual({ type: 'unknown', raw: 'a string' });
    expect(parseGeminiEvent('42')).toEqual({ type: 'unknown', raw: 42 });
    expect(parseGeminiEvent('[1,2,3]')).toEqual({ type: 'unknown', raw: [1, 2, 3] });
  });
});

describe('parseGeminiEvent — init', () => {
  it('extracts session_id into sessionId', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'init', session_id: 'gemini-abc' }));
    expect(event).toEqual({ type: 'init', sessionId: 'gemini-abc' });
  });

  it('defaults sessionId to empty string when session_id is missing', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'init' }));
    expect(event).toEqual({ type: 'init', sessionId: '' });
  });
});

describe('parseGeminiEvent — message branch', () => {
  it('emits assistant_text for role=assistant + delta=true with text payload', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'message', role: 'assistant', delta: true, text: 'hello' }),
    );
    expect(event).toEqual({ type: 'assistant_text', text: 'hello' });
  });

  it('falls back to content field then message field when text is absent', () => {
    const fromContent = parseGeminiEvent(
      JSON.stringify({ type: 'message', role: 'assistant', delta: true, content: 'via content' }),
    );
    const fromMessage = parseGeminiEvent(
      JSON.stringify({ type: 'message', role: 'assistant', delta: true, message: 'via message' }),
    );
    expect(fromContent).toEqual({ type: 'assistant_text', text: 'via content' });
    expect(fromMessage).toEqual({ type: 'assistant_text', text: 'via message' });
  });

  it('returns assistant_text with empty text when all fields are missing', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'message', role: 'assistant', delta: true }),
    );
    expect(event).toEqual({ type: 'assistant_text', text: '' });
  });

  it('non-assistant role or delta=false drops to unknown', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'message', role: 'user', delta: true, text: 'hi' }),
    );
    expect(event).toMatchObject({ type: 'unknown' });
  });
});

describe('parseGeminiEvent — tool_use branch', () => {
  it('emits tool_use with all fields populated', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        type: 'tool_use',
        tool_name: 'edit_file',
        tool_id: 't-123',
        input: { path: '/tmp/foo.ts' },
      }),
    );
    expect(event).toEqual({
      type: 'tool_use',
      toolName: 'edit_file',
      toolId: 't-123',
      toolInput: { path: '/tmp/foo.ts' },
    });
  });

  it('defaults toolName/toolId to empty string when missing', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'tool_use' }));
    expect(event).toEqual({
      type: 'tool_use',
      toolName: '',
      toolId: '',
      toolInput: {},
    });
  });

  it('coerces non-object input to empty object', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_use', tool_name: 't', tool_id: 'id', input: 'not-an-object' }),
    );
    expect(event).toMatchObject({ toolInput: {} });
  });
});

describe('parseGeminiEvent — tool_result branch', () => {
  it('treats status "success" as not-error', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' }),
    );
    expect(event).toEqual({ type: 'tool_result', isError: false, toolId: 't1', content: 'ok' });
  });

  it('treats status "ok" as not-error', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'ok', output: 'fine' }),
    );
    expect(event).toMatchObject({ isError: false });
  });

  it('treats empty/missing status as not-error', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', output: 'fine' }),
    );
    expect(event).toMatchObject({ isError: false });
  });

  it('treats any other non-empty status as error', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'failed', output: 'boom' }),
    );
    expect(event).toEqual({ type: 'tool_result', isError: true, toolId: 't1', content: 'boom' });
  });

  it('stringifies non-string output', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'tool_result', tool_id: 't1', status: 'success', output: { a: 1 } }),
    );
    expect(typeof (event as { content: string }).content).toBe('string');
  });
});

describe('parseGeminiEvent — result branch', () => {
  it('emits result with null text on success status + extracts token counts', () => {
    const event = parseGeminiEvent(
      JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    expect(event).toMatchObject({ type: 'result', text: null });
    // Token extraction is delegated to extractTokenCounts; just confirm
    // numbers are populated rather than asserting an exact mapping (since
    // extractTokenCounts has its own canonical input-path superset).
    expect(typeof (event as { inputTokens: number | null }).inputTokens).toBe('number');
  });

  it('emits result with error message when status is non-success and error field is present', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'result', status: 'failed', error: 'API timeout' }),
    );
    expect((event as { text: string | null }).text).toBe('API timeout');
  });

  it('falls back to status-derived message when no error/message fields present', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'result', status: 'timeout' }));
    expect((event as { text: string | null }).text).toContain('timeout');
  });
});

describe('parseGeminiEvent — error event branch', () => {
  it('maps error event to result with message from error field', () => {
    const event = parseGeminiEvent(
      JSON.stringify({ type: 'error', error: 'quota exhausted' }),
    );
    expect(event).toMatchObject({ type: 'result', text: 'quota exhausted' });
  });

  it('falls back to "Gemini CLI error" when no error/message field is present', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'error' }));
    expect(event).toMatchObject({ type: 'result' });
    expect((event as { text: string | null }).text).not.toBe(null);
  });
});

describe('parseGeminiEvent — unknown event type', () => {
  it('returns { type: "unknown", raw } for unrecognised event types', () => {
    const event = parseGeminiEvent(JSON.stringify({ type: 'definitely-not-a-real-event' }));
    expect(event).toMatchObject({ type: 'unknown' });
  });
});
