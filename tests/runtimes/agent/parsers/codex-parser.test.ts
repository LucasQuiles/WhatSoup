import { describe, it, expect } from 'vitest';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';

function line(payload: unknown): string {
  return JSON.stringify(payload);
}

describe('parseCodexEvent', () => {
  it('binds an accepted native turn to the exact turn/start request response', () => {
    expect(parseCodexEvent(line({
      jsonrpc: '2.0',
      id: 'request-3',
      result: {
        turn: {
          id: 'turn-accepted',
          status: 'inProgress',
        },
      },
    }))).toEqual({
      type: 'provider_turn_accepted',
      requestId: 'request-3',
      turnId: 'turn-accepted',
    });
  });

  describe('terminal error results', () => {
    it('marks app-server failed turns as isError so runtime default-denies raw text', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: { message: 'raw provider failure detail' },
          },
        },
      });

      expect(parseCodexEvent(line)).toEqual({
        type: 'result',
        text: 'raw provider failure detail',
        isError: true,
        providerTurn: {
          sessionId: 'thread-1',
          turnId: 'turn-1',
          status: 'failed',
        },
      });
    });

    it('marks JSON-RPC error responses as isError', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        error: { message: 'server rejected request' },
      });

      expect(parseCodexEvent(line)).toEqual({
        type: 'result',
        text: 'Codex error: server rejected request',
        isError: true,
        providerRequestId: 7,
      });
    });

    it('marks legacy turn.failed events as isError while preserving usage', () => {
      const line = JSON.stringify({
        type: 'turn.failed',
        error: 'legacy failure',
        usage: { input_tokens: 4, output_tokens: 2 },
      });

      expect(parseCodexEvent(line)).toEqual({
        type: 'result',
        text: 'legacy failure',
        isError: true,
        inputTokens: 4,
        outputTokens: 2,
        providerTurnProtocolError: 'missing_identity',
      });
    });
  });

  describe('thread/tokenUsage/updated notification', () => {
    it('produces a token_usage event with token counts from nested tokenUsage', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            input_tokens: 1234,
            output_tokens: 567,
          },
        },
      });

      const event = parseCodexEvent(line);
      expect(event).toEqual({
        type: 'token_usage',
        inputTokens: 1234,
        outputTokens: 567,
      });
    });

    it('produces a token_usage event with token counts at top level of params', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {
          input_tokens: 800,
          output_tokens: 200,
        },
      });

      const event = parseCodexEvent(line);
      expect(event).toEqual({
        type: 'token_usage',
        inputTokens: 800,
        outputTokens: 200,
      });
    });

    it('produces a token_usage event with no tokens when params has no token data', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {},
      });

      const event = parseCodexEvent(line);
      expect(event).toEqual({
        type: 'token_usage',
      });
    });
  });

  describe('app-server defensive parsing paths', () => {
    it('returns unknown for non-object JSON payloads', () => {
      expect(parseCodexEvent('42')).toEqual({ type: 'unknown', raw: 42 });
    });

    it('keeps malformed thread/started notifications observable as empty init events', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: {},
      }))).toEqual({ type: 'init', sessionId: '' });
    });

    it('ignores non-string assistant deltas', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { delta: { text: 'not streamed' } },
      }))).toEqual({ type: 'ignored' });
    });

    it('returns unknown when item/started does not contain an item object', () => {
      const params = { item: 'bad-shape', traceId: 'trace-1' };
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params,
      }))).toEqual({ type: 'unknown', raw: params });
    });

    it('returns unknown when item/completed does not contain an item object', () => {
      const params = { item: null, traceId: 'trace-2' };
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params,
      }))).toEqual({ type: 'unknown', raw: params });
    });

    it('ignores unsupported app-server item types', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { type: 'webSearch', id: 'search-1' } },
      }))).toEqual({ type: 'ignored' });
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'webSearch', id: 'search-1', status: 'completed' } },
      }))).toEqual({ type: 'ignored' });
    });

    it('preserves generic dynamic tool inputs while omitting parser bookkeeping fields', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          item: {
            type: 'dynamicToolCall',
            id: 'dyn-1',
            status: 'running',
            name: 'search',
            input: { q: 'recovery state' },
          },
        },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'dynamicToolCall',
        toolId: 'dyn-1',
        toolInput: {
          name: 'search',
          input: { q: 'recovery state' },
        },
      });
    });

    it('spreads object MCP arguments into app-server tool input', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-1',
            server: 'filesystem',
            tool: 'read_file',
            arguments: { path: '/tmp/proof.txt' },
          },
        },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'mcpToolCall',
        toolId: 'mcp-1',
        toolInput: {
          server: 'filesystem',
          tool: 'read_file',
          path: '/tmp/proof.txt',
        },
      });
    });

    it('keeps non-object MCP arguments under an arguments field', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-2',
            server: 'filesystem',
            tool: 'read_file',
            arguments: 'raw path',
          },
        },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'mcpToolCall',
        toolId: 'mcp-2',
        toolInput: {
          server: 'filesystem',
          tool: 'read_file',
          arguments: 'raw path',
        },
      });
    });

    it('surfaces command execution exit-code fallbacks as error tool results', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'cmd-2',
            status: 'failed',
            exitCode: 17,
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'cmd-2',
        content: 'Exit code 17',
      });
    });

    it('serializes command execution results when output and exit code are absent', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'commandExecution',
            id: 'cmd-serialized',
            status: 'failed',
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'cmd-serialized',
        content: '{"type":"commandExecution","id":"cmd-serialized","status":"failed"}',
      });
    });

    it('falls back to completed for file-change results without status text', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'fileChange',
            id: 'file-2',
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'file-2',
        content: 'completed',
      });
    });

    it('extracts MCP result text and structured fallback content', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-result',
            status: 'completed',
            result: { content: 'checkpoint sent' },
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'mcp-result',
        content: 'checkpoint sent',
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-json',
            status: 'completed',
            result: { values: [1, 2] },
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'mcp-json',
        content: '{"values":[1,2]}',
      });
    });

    it('surfaces MCP error records as error tool results', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-error',
            status: 'failed',
            error: { message: 'permission denied' },
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'mcp-error',
        content: 'permission denied',
      });
    });

    it('uses MCP error text and structured fallbacks when message is absent', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-error-text',
            status: 'failed',
            error: { text: 'text failure' },
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'mcp-error-text',
        content: 'text failure',
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-error-json',
            status: 'failed',
            error: { code: 'E_DENIED' },
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'mcp-error-json',
        content: '{"code":"E_DENIED"}',
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-error-raw',
            status: 'failed',
            error: 'raw failure',
          },
        },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'mcp-error-raw',
        content: '{"type":"mcpToolCall","id":"mcp-error-raw","status":"failed","error":"raw failure"}',
      });
    });

    it.each([
      'thread/status/changed',
      'thread/name/updated',
      'thread/closed',
      'error',
    ])('ignores non-actionable "%s" notifications', (method) => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method,
        params: { threadId: 'thread-1' },
      }))).toEqual({ type: 'ignored' });
    });

    it('returns unknown for unrecognized app-server notifications', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'thread/custom',
        params: { value: true },
      }))).toEqual({
        type: 'unknown',
        raw: { method: 'thread/custom', params: { value: true } },
      });
    });

    it('returns unknown for JSON-RPC objects without a routable method, result, or error', () => {
      const parsed = { jsonrpc: '2.0', meta: { ignored: true } };
      expect(parseCodexEvent(line(parsed))).toEqual({ type: 'unknown', raw: parsed });
    });

    it('fails closed when a terminal event lacks an exact native identity', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { status: 'failed' } },
      }))).toEqual({
        type: 'result',
        text: 'Provider turn completed without an exact native identity',
        isError: true,
        providerTurnProtocolError: 'missing_identity',
      });
    });

    it('uses fallback error text for exactly identified failed turns and sparse JSON-RPC errors', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'failed' },
        },
      }))).toEqual({
        type: 'result',
        text: 'Codex turn failed',
        isError: true,
        providerTurn: {
          sessionId: 'thread-1',
          turnId: 'turn-1',
          status: 'failed',
        },
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        id: 'req-1',
        error: {},
      }))).toEqual({
        type: 'result',
        text: 'Codex error: Unknown error',
        isError: true,
        providerRequestId: 'req-1',
      });
    });

    it('covers app-server default identifiers and non-record params without throwing', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: { thread: {} },
      }))).toEqual({ type: 'init', sessionId: '' });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'thread/started',
        params: 'not-an-object',
      }))).toEqual({ type: 'init', sessionId: '' });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { delta: 'hello', itemId: 123 },
      }))).toEqual({ type: 'assistant_text', text: 'hello', itemId: undefined });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { type: 'commandExecution', command: 'pwd' } },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'commandExecution',
        toolId: '',
        toolInput: { command: 'pwd' },
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { type: 'commandExecution', status: 'completed', aggregatedOutput: 'ok' } },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: '',
        content: 'ok',
      });
    });

    it('ignores app-server item events with missing type and fails closed on malformed terminal turns', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/started',
        params: { item: { id: 'missing-start', command: 'pwd' } },
      }))).toEqual({ type: 'ignored' });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'item/completed',
        params: { item: { id: 'missing-complete', status: 'completed' } },
      }))).toEqual({ type: 'ignored' });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {},
      }))).toEqual({
        type: 'result',
        text: 'Provider turn completed without an exact native identity',
        isError: true,
        providerTurnProtocolError: 'missing_identity',
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: {} },
      }))).toEqual({
        type: 'result',
        text: 'Provider turn completed without an exact native identity',
        isError: true,
        providerTurnProtocolError: 'missing_identity',
      });
    });

    it('uses fallback messages for failed turns and JSON-RPC errors with sparse shapes', () => {
      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'failed', error: {} },
        },
      }))).toEqual({
        type: 'result',
        text: 'Codex turn failed',
        isError: true,
        providerTurn: {
          sessionId: 'thread-1',
          turnId: 'turn-1',
          status: 'failed',
        },
      });

      expect(parseCodexEvent(line({
        jsonrpc: '2.0',
        id: 'req-2',
        error: 'fatal',
      }))).toEqual({
        type: 'result',
        text: 'Codex error: fatal',
        isError: true,
        providerRequestId: 'req-2',
      });
    });
  });

  describe('legacy defensive parsing paths', () => {
    it('covers legacy default identifiers and content fallbacks', () => {
      expect(parseCodexEvent(line({
        type: 'thread.started',
      }))).toEqual({ type: 'init', sessionId: '' });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'agent_message', content: 'from content' },
      }))).toEqual({
        type: 'assistant_text',
        text: 'from content',
        itemId: '',
        complete: true,
      });

      expect(parseCodexEvent(line({
        type: 'item.started',
        item: { type: 'command_execution', command: 'pwd' },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'command_execution',
        toolId: '',
        toolInput: { command: 'pwd' },
      });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'command_execution', status: 'completed', output: 'done' },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: '',
        content: 'done',
      });
    });

    it('uses object legacy MCP input directly when present', () => {
      expect(parseCodexEvent(line({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'legacy-mcp',
          input: { server: 'codex', tool: 'list_mcp_resources' },
        },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'mcp_tool_call',
        toolId: 'legacy-mcp',
        toolInput: { server: 'codex', tool: 'list_mcp_resources' },
      });
    });

    it('falls back to generic legacy MCP input when raw input is not an object', () => {
      expect(parseCodexEvent(line({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'legacy-mcp-raw',
          input: 'raw input',
        },
      }))).toEqual({
        type: 'tool_use',
        toolName: 'mcp_tool_call',
        toolId: 'legacy-mcp-raw',
        toolInput: { input: 'raw input' },
      });
    });

    it('returns unknown for malformed legacy item events', () => {
      const parsed = { type: 'item.completed', item: 'bad-shape' };
      expect(parseCodexEvent(line(parsed))).toEqual({ type: 'unknown', raw: parsed });
    });

    it('ignores unsupported legacy item types', () => {
      expect(parseCodexEvent(line({
        type: 'item.started',
        item: { id: 'legacy-missing-type', command: 'pwd' },
      }))).toEqual({ type: 'ignored' });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { id: 'legacy-completed-missing-type', status: 'completed' },
      }))).toEqual({ type: 'ignored' });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'web_search', id: 'legacy-search', status: 'completed' },
      }))).toEqual({ type: 'ignored' });
    });

    it('emits an empty legacy agent message when text and content are absent', () => {
      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'agent_message', id: 'legacy-empty-message' },
      }))).toEqual({
        type: 'assistant_text',
        text: '',
        itemId: 'legacy-empty-message',
        complete: true,
      });
    });

    it('surfaces legacy exit-code, status, and structured fallbacks for tool results', () => {
      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'legacy-exit', exit_code: 19 },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'legacy-exit',
        content: 'Exit code 19',
      });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'file_change', id: 'legacy-status', status: 'patched' },
      }))).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'legacy-status',
        content: 'patched',
      });

      expect(parseCodexEvent(line({
        type: 'item.completed',
        item: { type: 'mcp_tool_call', id: 'legacy-json', payload: { ok: true } },
      }))).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'legacy-json',
        content: '{"type":"mcp_tool_call","id":"legacy-json","payload":{"ok":true}}',
      });
    });

    it('falls through legacy turn.failed message sources before the default text', () => {
      expect(parseCodexEvent(line({
        type: 'turn.failed',
        details: { message: 'details failure' },
      }))).toEqual({
        type: 'result',
        text: 'details failure',
        isError: true,
        inputTokens: undefined,
        outputTokens: undefined,
        providerTurnProtocolError: 'missing_identity',
      });
    });

    it('returns unknown for unrecognized legacy event types', () => {
      const parsed = { type: 'mystery.event', payload: true };
      expect(parseCodexEvent(line(parsed))).toEqual({ type: 'unknown', raw: parsed });
    });
  });
});
