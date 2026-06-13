import { describe, expect, it } from 'vitest';
import {
  buildInitializeRequest,
  buildSessionNewRequest,
  buildSessionPromptRequest,
  parseAcpFrame,
  parseGeminiAcpEvent,
} from '../../../../src/runtimes/agent/providers/gemini-acp-parser.ts';

function frame(value: unknown): string {
  return JSON.stringify(value);
}

function parseRequest(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('Gemini ACP parser', () => {
  describe('parseAcpFrame', () => {
    it('filters empty, whitespace, and non-JSON log lines', () => {
      expect(parseAcpFrame('')).toBeNull();
      expect(parseAcpFrame(' \t ')).toBeNull();
      expect(parseAcpFrame('Hook registry initialized')).toBeNull();
    });

    it('classifies non-JSON-RPC JSON as unknown', () => {
      expect(parseAcpFrame(frame({ type: 'log', message: 'ready' }))).toEqual({
        kind: 'unknown',
        raw: { type: 'log', message: 'ready' },
      });
      expect(parseAcpFrame(frame(['not', 'an', 'object']))).toEqual({
        kind: 'unknown',
        raw: { _value: ['not', 'an', 'object'] },
      });
    });

    it('parses notifications with object params and defaults missing params to empty object', () => {
      expect(
        parseAcpFrame(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'session-1' },
        })),
      ).toEqual({
        kind: 'notification',
        method: 'session/update',
        params: { sessionId: 'session-1' },
      });

      expect(parseAcpFrame(frame({ jsonrpc: '2.0', method: 'session/update' }))).toEqual({
        kind: 'notification',
        method: 'session/update',
        params: {},
      });
    });

    it('parses successful and error responses', () => {
      expect(
        parseAcpFrame(frame({
          jsonrpc: '2.0',
          id: 7,
          result: { sessionId: 'session-7' },
        })),
      ).toEqual({
        kind: 'response',
        id: 7,
        result: { sessionId: 'session-7' },
      });

      expect(
        parseAcpFrame(frame({
          jsonrpc: '2.0',
          id: 'turn-1',
          error: { code: -32000, message: 'turn failed' },
        })),
      ).toEqual({
        kind: 'error_response',
        id: 'turn-1',
        code: -32000,
        message: 'turn failed',
      });
    });

    it('classifies server-request frames without results as unknown', () => {
      const raw = {
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'session/request_permission',
        params: { toolCallId: 'tool-1' },
      };

      expect(parseAcpFrame(frame(raw))).toEqual({
        kind: 'unknown',
        raw,
      });
    });

    it('normalizes malformed error response fields', () => {
      expect(
        parseAcpFrame(frame({
          jsonrpc: '2.0',
          id: null,
          error: { details: 'missing message' },
        })),
      ).toEqual({
        kind: 'error_response',
        id: null,
        code: 0,
        message: '{"details":"missing message"}',
      });
    });
  });

  describe('parseGeminiAcpEvent', () => {
    it('maps initialize and session/new responses to init events', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: 1, capabilities: {} },
        })),
      ).toEqual({ type: 'init', sessionId: '' });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          id: 2,
          result: { sessionId: 'session-2' },
        })),
      ).toEqual({ type: 'init', sessionId: 'session-2' });
    });

    it('maps session/prompt completion responses to result events with usage', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          id: 3,
          result: {
            stopReason: 'end_turn',
            usage: { input_tokens: 12, output_tokens: 6 },
          },
        })),
      ).toEqual({
        type: 'result',
        text: null,
        inputTokens: 12,
        outputTokens: 6,
      });
    });

    it('maps JSON-RPC error responses to terminal result text', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          id: 4,
          error: { code: -32602, message: 'invalid params' },
        })),
      ).toEqual({
        type: 'result',
        text: 'Gemini ACP error (code -32602): invalid params',
        isError: true,
      });
    });

    it('maps session/update assistant text and available command updates', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-3',
            update: { type: 'agent_message_chunk', chunk: 'hello' },
          },
        })),
      ).toEqual({ type: 'assistant_text', text: 'hello' });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-3',
            update: { type: 'available_commands_update', available_commands: [] },
          },
        })),
      ).toEqual({ type: 'ignored' });
    });

    it('maps session/update params itself when the nested update object is absent', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-3',
            type: 'agent_message_chunk',
            chunk: { content: [{ text: 'from params' }] },
          },
        })),
      ).toEqual({ type: 'assistant_text', text: 'from params' });
    });

    it('maps tool use and tool result updates', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-4',
            update: {
              type: 'tool_use',
              tool_name: 'run_shell_command',
              tool_id: 'tool-1',
              input: { command: 'pwd' },
            },
          },
        })),
      ).toEqual({
        type: 'tool_use',
        toolName: 'run_shell_command',
        toolId: 'tool-1',
        toolInput: { command: 'pwd' },
      });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-4',
            update: {
              type: 'tool_result',
              tool_id: 'tool-1',
              status: 'error',
              output: 'command failed',
            },
          },
        })),
      ).toEqual({
        type: 'tool_result',
        isError: true,
        toolId: 'tool-1',
        content: 'command failed',
      });
    });

    it('maps implicit tool update shapes without a type discriminator', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-4',
            update: {
              tool_name: 'read_file',
              tool_id: 'tool-2',
              parameters: { path: 'README.md' },
            },
          },
        })),
      ).toEqual({
        type: 'tool_use',
        toolName: 'read_file',
        toolId: 'tool-2',
        toolInput: { path: 'README.md' },
      });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-4',
            update: {
              tool_id: 'tool-2',
              status: 'completed',
              result: [{ text: 'README contents' }],
            },
          },
        })),
      ).toEqual({
        type: 'tool_result',
        isError: false,
        toolId: 'tool-2',
        content: 'README contents',
      });
    });

    it('maps turn completion and error updates', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-5',
            update: {
              type: 'turn_complete',
              usage: { inputTokens: 20, outputTokens: 8 },
            },
          },
        })),
      ).toEqual({
        type: 'result',
        text: null,
        inputTokens: 20,
        outputTokens: 8,
      });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-5',
            update: { type: 'error', message: 'model unavailable' },
          },
        })),
      ).toEqual({ type: 'result', text: 'model unavailable' });
    });

    it('passes unknown session/update shapes through for diagnostics', () => {
      const raw = { type: 'new_update_shape', payload: { value: 1 } };

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'session-6',
            update: raw,
          },
        })),
      ).toEqual({ type: 'unknown', raw });
    });

    it('ignores unrelated successful responses and notifications', () => {
      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          id: 5,
          result: { ack: true },
        })),
      ).toEqual({ type: 'ignored' });

      expect(
        parseGeminiAcpEvent(frame({
          jsonrpc: '2.0',
          method: 'window/logMessage',
          params: { message: 'ready' },
        })),
      ).toEqual({ type: 'ignored' });
    });
  });

  describe('request builders', () => {
    it('builds initialize requests as JSON-RPC nd-json lines', () => {
      expect(parseRequest(buildInitializeRequest(1))).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
        },
      });
      expect(buildInitializeRequest(1).endsWith('\n')).toBe(true);
    });

    it('builds session/new requests with cwd, MCP servers, and optional system prompt', () => {
      expect(
        parseRequest(buildSessionNewRequest(2, '/tmp/project', [{ name: 'whatsoup' }], 'be concise')),
      ).toEqual({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: {
          cwd: '/tmp/project',
          mcpServers: [{ name: 'whatsoup' }],
          systemPrompt: 'be concise',
        },
      });

      expect(parseRequest(buildSessionNewRequest(3, '/tmp/project'))).toEqual({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/new',
        params: {
          cwd: '/tmp/project',
          mcpServers: [],
        },
      });
    });

    it('builds session/prompt requests with a text prompt block', () => {
      expect(parseRequest(buildSessionPromptRequest(3, 'session-3', 'hello'))).toEqual({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId: 'session-3',
          prompt: [{ type: 'text', text: 'hello' }],
        },
      });
    });
  });
});
