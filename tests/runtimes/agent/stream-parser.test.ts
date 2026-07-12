// @check CHK-020
// @traces REQ-005.AC-04
import { describe, it, expect } from 'vitest';
// T2-DEFER(T3/T4): this compatibility suite intentionally exercises the deprecated head shim.
import {
  parseEvent as parseDeprecatedHead,
  parseEvents,
} from '../../../src/runtimes/agent/stream-parser.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseEvent', () => {
  describe('empty / whitespace lines', () => {
    it('returns null for an empty string', () => {
      expect(parseDeprecatedHead('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseDeprecatedHead('   \t\n  ')).toBeNull();
    });
  });

  describe('malformed JSON', () => {
    it('returns parse_error for invalid JSON', () => {
      const result = parseDeprecatedHead('{not valid json}');
      expect(result).toEqual({ type: 'parse_error', line: '{not valid json}' });
    });

    it('returns parse_error and preserves the original line', () => {
      const badLine = 'hello world';
      const result = parseDeprecatedHead(badLine);
      expect(result).toEqual({ type: 'parse_error', line: badLine });
    });

    it('does not throw on malformed input', () => {
      expect(() => parseDeprecatedHead('{bad')).not.toThrow();
    });
  });

  describe('system init event', () => {
    it('maps subtype=init to { type: init, sessionId }', () => {
      const result = parseDeprecatedHead(
        line({ type: 'system', subtype: 'init', session_id: 'ses_abc123' }),
      );
      expect(result).toEqual({ type: 'init', sessionId: 'ses_abc123' });
    });

    it('handles missing session_id gracefully', () => {
      const result = parseDeprecatedHead(line({ type: 'system', subtype: 'init' }));
      expect(result).toEqual({ type: 'init', sessionId: '' });
    });
  });

  describe('system compact_boundary event', () => {
    it('maps subtype=compact_boundary correctly', () => {
      const result = parseDeprecatedHead(line({ type: 'system', subtype: 'compact_boundary' }));
      expect(result).toEqual({ type: 'compact_boundary' });
    });
  });

  describe('system hook events', () => {
    it('maps subtype starting with "hook" to ignored', () => {
      const result = parseDeprecatedHead(
        line({ type: 'system', subtype: 'hook_pre_tool_call' }),
      );
      expect(result).toEqual({ type: 'ignored' });
    });

    it('maps hook_post_tool_call to ignored', () => {
      const result = parseDeprecatedHead(
        line({ type: 'system', subtype: 'hook_post_tool_call' }),
      );
      expect(result).toEqual({ type: 'ignored' });
    });

    it('maps subtype "hooks" (exact prefix) to ignored', () => {
      const result = parseDeprecatedHead(line({ type: 'system', subtype: 'hooks_fired' }));
      expect(result).toEqual({ type: 'ignored' });
    });
  });

  describe('system unknown subtype', () => {
    it('maps unrecognized subtype to unknown', () => {
      const raw = { type: 'system', subtype: 'something_new' };
      const result = parseDeprecatedHead(line(raw));
      expect(result).toEqual({ type: 'unknown', raw });
    });
  });

  describe('assistant text events', () => {
    it('maps text content block to assistant_text', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello!' }],
          },
        }),
      );
      expect(result).toEqual({ type: 'assistant_text', text: 'Hello!' });
    });

    it('extracts the first text block when multiple content blocks exist', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'First block' },
              { type: 'text', text: 'Second block' },
            ],
          },
        }),
      );
      expect(result).toEqual({ type: 'assistant_text', text: 'First block' });
    });

    it('handles empty text field', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '' }] },
        }),
      );
      expect(result).toEqual({ type: 'assistant_text', text: '' });
    });

    it('emits invalid blocks and rejects a text block with a missing text field', () => {
      const malformedText = { type: 'text' };
      const result = parseEvents(
        line({
          type: 'assistant',
          message: { content: [null, 'ignored', malformedText] },
        }),
      );
      expect(result).toEqual([
        { type: 'unknown_block', blockType: '<non-object>', raw: null },
        { type: 'unknown_block', blockType: '<non-object>', raw: 'ignored' },
        { type: 'unknown_block', blockType: 'text', raw: malformedText },
      ]);
    });
  });

  describe('assistant tool_use events', () => {
    it('maps tool_use content block to tool_use event', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} }],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_use', toolName: 'Read', toolId: 'toolu_01', toolInput: {} });
    });

    it('returns tool_use when it appears before text in the content array', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: {} },
              { type: 'text', text: 'some text' },
            ],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_use', toolName: 'Bash', toolId: 'toolu_02', toolInput: {} });
    });

    it('returns unknown when message has no content array', () => {
      const result = parseDeprecatedHead(
        line({ type: 'assistant', message: { content: null } }),
      );
      expect(result).toEqual({
        type: 'unknown',
        raw: { type: 'assistant', message: { content: null } },
      });
    });

    it('emits unknown_block for tool_use blocks with missing or malformed required fields', () => {
      const missingIdentity = { type: 'tool_use', input: { command: 'npm test' } };
      const blankIdentity = { type: 'tool_use', id: ' ', name: '', input: {} };
      const invalidIdentity = { type: 'tool_use', id: 7, name: { tool: 'Bash' }, input: {} };
      const result = parseEvents(
        line({
          type: 'assistant',
          message: {
            content: [
              missingIdentity,
              blankIdentity,
              invalidIdentity,
            ],
          },
        }),
      );
      expect(result).toEqual([
        { type: 'unknown_block', blockType: 'tool_use', raw: missingIdentity },
        { type: 'unknown_block', blockType: 'tool_use', raw: blankIdentity },
        { type: 'unknown_block', blockType: 'tool_use', raw: invalidIdentity },
      ]);
    });

    it('rejects a tool_use block whose input is missing or not a record', () => {
      const missingInput = { type: 'tool_use', id: 'toolu_missing', name: 'Bash' };
      const arrayInput = { type: 'tool_use', id: 'toolu_array', name: 'Bash', input: [] };
      const result = parseDeprecatedHead(
        line({
          type: 'assistant',
          message: {
            content: [missingInput, arrayInput],
          },
        }),
      );
      expect(result).toEqual({ type: 'unknown_block', blockType: 'tool_use', raw: missingInput });
      expect(parseEvents(line({ type: 'assistant', message: { content: [arrayInput] } }))).toEqual([
        { type: 'unknown_block', blockType: 'tool_use', raw: arrayInput },
      ]);
    });

    it('returns one unknown_block per unrecognized assistant content block', () => {
      const raw = {
        type: 'assistant',
        message: { content: [null, { type: 'image', source: 'redacted' }] },
      };
      const result = parseEvents(line(raw));
      expect(result).toEqual([
        { type: 'unknown_block', blockType: '<non-object>', raw: null },
        {
          type: 'unknown_block',
          blockType: 'image',
          raw: { type: 'image', source: 'redacted' },
        },
      ]);
    });
  });

  describe('user tool_result events', () => {
    it('maps unknown skill local-command failure to a terminal result', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'user',
          message: {
            content: 'Unknown skill: sdlc',
          },
        }),
      );
      expect(result).toEqual({ type: 'result', text: 'Unknown skill: sdlc', isError: true });
    });

    it('maps tool_result block (is_error=false) to tool_result', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', is_error: false },
            ],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_result', isError: false, toolId: 'toolu_01', content: '' });
    });

    it('maps tool_result block with is_error=true to isError=true', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', is_error: true },
            ],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_result', isError: true, toolId: 'toolu_01', content: '' });
    });

    it('defaults isError to false when is_error is absent', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_99' }],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_result', isError: false, toolId: 'toolu_99', content: '' });
    });

    it('returns unknown for ordinary direct user text without a message object', () => {
      const raw = { type: 'user', content: 'ordinary user text' };
      const result = parseDeprecatedHead(line(raw));
      expect(result).toEqual({ type: 'unknown', raw });
    });

    it('emits invalid and ignored user blocks and rejects tool_result without an id', () => {
      const missingId = { type: 'tool_result', is_error: true, content: 'tool failed' };
      const result = parseEvents(
        line({
          type: 'user',
          message: {
            content: [
              null,
              { type: 'text', text: 'ignored' },
              missingId,
            ],
          },
        }),
      );
      expect(result).toEqual([
        { type: 'unknown_block', blockType: '<non-object>', raw: null },
        {
          type: 'ignored',
          blockType: 'text',
          reason: 'user-originated context, no provider output side effects',
        },
        { type: 'unknown_block', blockType: 'tool_result', raw: missingId },
      ]);
    });

    it('rejects a tool_result whose is_error or content has the wrong type', () => {
      const invalidError = {
        type: 'tool_result',
        tool_use_id: 'toolu_error',
        is_error: 'true',
      };
      const invalidContent = {
        type: 'tool_result',
        tool_use_id: 'toolu_content',
        content: { text: 'not an allowed content shape' },
      };

      expect(parseEvents(line({
        type: 'user',
        message: { content: [invalidError, invalidContent] },
      }))).toEqual([
        { type: 'unknown_block', blockType: 'tool_result', raw: invalidError },
        { type: 'unknown_block', blockType: 'tool_result', raw: invalidContent },
      ]);
    });

    it('preserves outer tool_result and emits every nested non-text or malformed item in order', () => {
      const malformedText = { type: 'text' };
      const image = { type: 'image', source: 'redacted' };
      const document = { type: 'document', source: 'redacted' };
      const nestedToolResult = {
        type: 'tool_result',
        tool_use_id: 'nested',
        content: 'nested result',
      };
      const future = { type: 'future_payload', sanitized: true };
      const missingType = {};
      const invalidType = { type: 42 };
      const result = parseEvents(
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_array_content',
                content: [
                  null,
                  image,
                  { type: 'text', text: 'first line' },
                  malformedText,
                  document,
                  nestedToolResult,
                  future,
                  missingType,
                  invalidType,
                ],
              },
              { type: 'tool_result', tool_use_id: 'toolu_after' },
            ],
          },
        }),
      );
      expect(result).toEqual([
        {
          type: 'tool_result',
          isError: false,
          toolId: 'toolu_array_content',
          content: 'first line',
        },
        { type: 'unknown_block', blockType: '<non-object>', raw: null },
        {
          type: 'ignored',
          blockType: 'image',
          reason: 'user-originated media, no provider output side effects',
        },
        { type: 'unknown_block', blockType: 'text', raw: malformedText },
        {
          type: 'ignored',
          blockType: 'document',
          reason: 'user-originated document, no provider output side effects',
        },
        { type: 'unknown_block', blockType: 'tool_result', raw: nestedToolResult },
        { type: 'unknown_block', blockType: 'future_payload', raw: future },
        { type: 'unknown_block', blockType: '<missing>', raw: missingType },
        { type: 'unknown_block', blockType: '<invalid>', raw: invalidType },
        {
          type: 'tool_result',
          isError: false,
          toolId: 'toolu_after',
          content: '',
        },
      ]);
    });
  });

  describe('result events', () => {
    // Successful turns: text must be null — response already delivered via assistant_text events.
    // Rendering result.result on success would double-send every reply.

    it('returns text: null for a successful result (is_error absent)', () => {
      const result = parseDeprecatedHead(line({ type: 'result', result: 'Task complete.', is_error: false }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null for a successful result with content field', () => {
      const result = parseDeprecatedHead(line({ type: 'result', content: 'Task complete.' }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null for a successful result with content array', () => {
      const result = parseDeprecatedHead(
        line({ type: 'result', content: [{ type: 'text', text: 'Done!' }] }),
      );
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null when no content or result fields are present', () => {
      const result = parseDeprecatedHead(line({ type: 'result' }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    // Error results: text must be surfaced so the user sees context-limit / turn-error messages.

    it('returns text from result field when is_error is true', () => {
      const result = parseDeprecatedHead(
        line({ type: 'result', result: 'Context window exceeded.', is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Context window exceeded.', isError: true });
    });

    it('returns text from string content field when is_error is true', () => {
      const result = parseDeprecatedHead(
        line({ type: 'result', content: 'Turn error.', is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Turn error.', isError: true });
    });

    it('returns text from content array text block when is_error is true', () => {
      const result = parseDeprecatedHead(
        line({ type: 'result', content: [{ type: 'text', text: 'Error details.' }], is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Error details.', isError: true });
    });

    it('returns text: null for an empty string content error result', () => {
      const result = parseDeprecatedHead(
        line({ type: 'result', content: '', is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: null, isError: true });
    });

    it('skips invalid error content blocks and returns null for empty text', () => {
      const result = parseDeprecatedHead(
        line({
          type: 'result',
          content: [null, { type: 'image' }, { type: 'text' }],
          is_error: true,
        }),
      );
      expect(result).toEqual({ type: 'result', text: null, isError: true });
    });

    it('returns text: null for an empty result field error result', () => {
      const result = parseDeprecatedHead(line({ type: 'result', result: '', is_error: true }));
      expect(result).toEqual({ type: 'result', text: null, isError: true });
    });

    it('returns text: null for error result with no content', () => {
      const result = parseDeprecatedHead(line({ type: 'result', is_error: true }));
      expect(result).toEqual({ type: 'result', text: null, isError: true });
    });

    // Token usage extraction — including cache tokens

    it('extracts inputTokens and outputTokens from usage field', () => {
      const result = parseDeprecatedHead(line({
        type: 'result', is_error: false,
        usage: { input_tokens: 500, output_tokens: 100 },
      }));
      expect(result).toMatchObject({ type: 'result', inputTokens: 500, outputTokens: 100 });
    });

    it('sums cache_creation_input_tokens into inputTokens', () => {
      const result = parseDeprecatedHead(line({
        type: 'result', is_error: false,
        usage: { input_tokens: 3, cache_creation_input_tokens: 33243, output_tokens: 32 },
      }));
      expect(result).toMatchObject({ type: 'result', inputTokens: 33246, outputTokens: 32 });
    });

    it('sums cache_read_input_tokens into inputTokens', () => {
      const result = parseDeprecatedHead(line({
        type: 'result', is_error: false,
        usage: { input_tokens: 3, cache_read_input_tokens: 33346, output_tokens: 5 },
      }));
      expect(result).toMatchObject({ type: 'result', inputTokens: 33349, outputTokens: 5 });
    });

    it('sums both cache creation and read into inputTokens', () => {
      const result = parseDeprecatedHead(line({
        type: 'result', is_error: false,
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 20084,
          cache_read_input_tokens: 13262,
          output_tokens: 5,
        },
      }));
      expect(result).toMatchObject({ type: 'result', inputTokens: 33349, outputTokens: 5 });
    });

    it('returns undefined tokens when usage field is absent', () => {
      const result = parseDeprecatedHead(line({ type: 'result', is_error: false }));
      expect(result).toMatchObject({ type: 'result' });
      expect((result as any).inputTokens).toBeUndefined();
      expect((result as any).outputTokens).toBeUndefined();
    });
  });

  describe('unknown events', () => {
    it('returns unknown for unrecognized top-level type', () => {
      const raw = { type: 'internal_debug', data: 'xyz' };
      const result = parseDeprecatedHead(line(raw));
      expect(result).toEqual({ type: 'unknown', raw });
    });

    it('returns unknown for a JSON primitive (non-object)', () => {
      const result = parseDeprecatedHead('42');
      expect(result).toEqual({ type: 'unknown', raw: 42 });
    });

    it('returns unknown for null JSON value', () => {
      const result = parseDeprecatedHead('null');
      // null parses as non-object, handled as unknown
      expect((result as AgentEvent).type).toBe('unknown');
    });
  });

  describe('edge cases', () => {
    it('never throws on any input', () => {
      const inputs = [
        '',
        '  ',
        'null',
        '{}',
        '[]',
        '{"type":null}',
        '{"type":"assistant","message":null}',
        line({ type: 'system' }),
        line({ type: 'user', message: {} }),
      ];
      for (const input of inputs) {
        expect(() => parseDeprecatedHead(input)).not.toThrow();
      }
    });
  });
});
