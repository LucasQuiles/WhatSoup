// @check CHK-020
// @traces REQ-005.AC-04
import { describe, it, expect } from 'vitest';
import { parseEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseEvent', () => {
  describe('empty / whitespace lines', () => {
    it('returns null for an empty string', () => {
      expect(parseEvent('')).toBeNull();
    });

    it('returns null for a whitespace-only string', () => {
      expect(parseEvent('   \t\n  ')).toBeNull();
    });
  });

  describe('malformed JSON', () => {
    it('returns parse_error for invalid JSON', () => {
      const result = parseEvent('{not valid json}');
      expect(result).toEqual({ type: 'parse_error', line: '{not valid json}' });
    });

    it('returns parse_error and preserves the original line', () => {
      const badLine = 'hello world';
      const result = parseEvent(badLine);
      expect(result).toEqual({ type: 'parse_error', line: badLine });
    });

    it('does not throw on malformed input', () => {
      expect(() => parseEvent('{bad')).not.toThrow();
    });
  });

  describe('system init event', () => {
    it('maps subtype=init to { type: init, sessionId }', () => {
      const result = parseEvent(
        line({ type: 'system', subtype: 'init', session_id: 'ses_abc123' }),
      );
      expect(result).toEqual({ type: 'init', sessionId: 'ses_abc123' });
    });

    it('handles missing session_id gracefully', () => {
      const result = parseEvent(line({ type: 'system', subtype: 'init' }));
      expect(result).toEqual({ type: 'init', sessionId: '' });
    });
  });

  describe('system compact_boundary event', () => {
    it('maps subtype=compact_boundary correctly', () => {
      const result = parseEvent(line({ type: 'system', subtype: 'compact_boundary' }));
      expect(result).toEqual({ type: 'compact_boundary' });
    });
  });

  describe('system hook events', () => {
    it('maps subtype starting with "hook" to ignored', () => {
      const result = parseEvent(
        line({ type: 'system', subtype: 'hook_pre_tool_call' }),
      );
      expect(result).toEqual({ type: 'ignored' });
    });

    it('maps hook_post_tool_call to ignored', () => {
      const result = parseEvent(
        line({ type: 'system', subtype: 'hook_post_tool_call' }),
      );
      expect(result).toEqual({ type: 'ignored' });
    });

    it('maps subtype "hooks" (exact prefix) to ignored', () => {
      const result = parseEvent(line({ type: 'system', subtype: 'hooks_fired' }));
      expect(result).toEqual({ type: 'ignored' });
    });
  });

  describe('system unknown subtype', () => {
    it('maps unrecognized subtype to unknown', () => {
      const raw = { type: 'system', subtype: 'something_new' };
      const result = parseEvent(line(raw));
      expect(result).toEqual({ type: 'unknown', raw });
    });
  });

  describe('assistant text events', () => {
    it('maps text content block to assistant_text', () => {
      const result = parseEvent(
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
      const result = parseEvent(
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
      const result = parseEvent(
        line({
          type: 'assistant',
          message: { content: [{ type: 'text', text: '' }] },
        }),
      );
      expect(result).toEqual({ type: 'assistant_text', text: '' });
    });
  });

  describe('assistant tool_use events', () => {
    it('maps tool_use content block to tool_use event', () => {
      const result = parseEvent(
        line({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'Read' }],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_use', toolName: 'Read', toolId: 'toolu_01', toolInput: {} });
    });

    it('returns tool_use when it appears before text in the content array', () => {
      const result = parseEvent(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'toolu_02', name: 'Bash' },
              { type: 'text', text: 'some text' },
            ],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_use', toolName: 'Bash', toolId: 'toolu_02', toolInput: {} });
    });

    it('returns unknown when message has no content array', () => {
      const result = parseEvent(
        line({ type: 'assistant', message: { content: null } }),
      );
      expect(result).toEqual({
        type: 'unknown',
        raw: { type: 'assistant', message: { content: null } },
      });
    });
  });

  describe('user tool_result events', () => {
    it('maps unknown skill local-command failure to a terminal result', () => {
      const result = parseEvent(
        line({
          type: 'user',
          message: {
            content: 'Unknown skill: sdlc',
          },
        }),
      );
      expect(result).toEqual({ type: 'result', text: 'Unknown skill: sdlc' });
    });

    it('maps tool_result block (is_error=false) to tool_result', () => {
      const result = parseEvent(
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
      const result = parseEvent(
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
      const result = parseEvent(
        line({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_99' }],
          },
        }),
      );
      expect(result).toEqual({ type: 'tool_result', isError: false, toolId: 'toolu_99', content: '' });
    });
  });

  describe('result events', () => {
    // Successful turns: text must be null — response already delivered via assistant_text events.
    // Rendering result.result on success would double-send every reply.

    it('returns text: null for a successful result (is_error absent)', () => {
      const result = parseEvent(line({ type: 'result', result: 'Task complete.', is_error: false }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null for a successful result with content field', () => {
      const result = parseEvent(line({ type: 'result', content: 'Task complete.' }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null for a successful result with content array', () => {
      const result = parseEvent(
        line({ type: 'result', content: [{ type: 'text', text: 'Done!' }] }),
      );
      expect(result).toEqual({ type: 'result', text: null });
    });

    it('returns text: null when no content or result fields are present', () => {
      const result = parseEvent(line({ type: 'result' }));
      expect(result).toEqual({ type: 'result', text: null });
    });

    // Error results: text must be surfaced so the user sees context-limit / turn-error messages.

    it('returns text from result field when is_error is true', () => {
      const result = parseEvent(
        line({ type: 'result', result: 'Context window exceeded.', is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Context window exceeded.' });
    });

    it('returns text from string content field when is_error is true', () => {
      const result = parseEvent(
        line({ type: 'result', content: 'Turn error.', is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Turn error.' });
    });

    it('returns text from content array text block when is_error is true', () => {
      const result = parseEvent(
        line({ type: 'result', content: [{ type: 'text', text: 'Error details.' }], is_error: true }),
      );
      expect(result).toEqual({ type: 'result', text: 'Error details.' });
    });

    it('returns text: null for error result with no content', () => {
      const result = parseEvent(line({ type: 'result', is_error: true }));
      expect(result).toEqual({ type: 'result', text: null });
    });
  });

  describe('unknown events', () => {
    it('returns unknown for unrecognized top-level type', () => {
      const raw = { type: 'internal_debug', data: 'xyz' };
      const result = parseEvent(line(raw));
      expect(result).toEqual({ type: 'unknown', raw });
    });

    it('returns unknown for a JSON primitive (non-object)', () => {
      const result = parseEvent('42');
      expect(result).toEqual({ type: 'unknown', raw: 42 });
    });

    it('returns unknown for null JSON value', () => {
      const result = parseEvent('null');
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
        expect(() => parseEvent(input)).not.toThrow();
      }
    });
  });
});
