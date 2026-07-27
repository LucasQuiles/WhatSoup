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
        // Default-deny: an in-band error update MUST carry isError so the runtime
        // suppresses the raw text and raises a provider_unknown_terminal alert,
        // matching the JSON-RPC error_response path. (BEAD-058)
      ).toEqual({ type: 'result', text: 'model unavailable', isError: true });
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

    it('preserves separate runtime-context and user prompt blocks', () => {
      expect(parseRequest(buildSessionPromptRequest(
        4,
        'session-4',
        ['receipt=2026-05-28T20:26:40.000Z age=95', 'stop that flow now'],
      ))).toMatchObject({
        params: {
          sessionId: 'session-4',
          prompt: [
            { type: 'text', text: 'receipt=2026-05-28T20:26:40.000Z age=95' },
            { type: 'text', text: 'stop that flow now' },
          ],
        },
      });
    });
  });
});

describe('gemini-acp-parser.ts uncovered-branch coverage', () => {
  // ---- parseGeminiAcpEvent: null frame path (line 225) ----
  it('returns null for an empty line so the null-frame branch is exercised', () => {
    expect(parseGeminiAcpEvent('')).toBeNull();
    expect(parseGeminiAcpEvent('   ')).toBeNull();
    expect(parseGeminiAcpEvent('Hook registry initialized')).toBeNull();
  });

  // ---- unknown frame passthrough (lines 289-293, line 269 false branch) ----
  it('passes unknown frames through and falls through the notification check', () => {
    // Bare JSON value (not a record) → parseAcpFrame returns kind:'unknown'
    expect(parseGeminiAcpEvent(frame(['just', 'an', 'array']))).toEqual({
      type: 'unknown',
      raw: { _value: ['just', 'an', 'array'] },
    });

    // Record without jsonrpc: '2.0' → unknown
    expect(parseGeminiAcpEvent(frame({ type: 'log', message: 'noise' }))).toEqual({
      type: 'unknown',
      raw: { type: 'log', message: 'noise' },
    });
  });

  // ---- session/update without sessionId in params → falls back to currentSessionId (line 274) ----
  it('falls back to currentSessionId when params.sessionId is not a string', () => {
    const event = parseGeminiAcpEvent(
      frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: { type: 'agent_message_chunk', chunk: 'no-session' },
        },
      }),
      'fallback-session-id',
    );
    // The sessionId is only observable indirectly via the mapped update; assert concrete mapping.
    expect(event).toEqual({ type: 'assistant_text', text: 'no-session' });
  });

  // ---- agent_message_chunk fallback fields: text and content (line 128) ----
  it('extracts assistant text from the text field when chunk is absent', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-3',
          update: { type: 'agent_message_chunk', text: 'from-text' },
        },
      })),
    ).toEqual({ type: 'assistant_text', text: 'from-text' });
  });

  it('extracts assistant text from the content field when chunk and text are absent', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-3',
          update: {
            type: 'agent_message_chunk',
            content: [{ text: 'from-content' }],
          },
        },
      })),
    ).toEqual({ type: 'assistant_text', text: 'from-content' });
  });

  it('emits an empty assistant_text chunk when no text field is present', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-3',
          update: { type: 'agent_message_chunk' },
        },
      })),
    ).toEqual({ type: 'assistant_text', text: '' });
  });

  // ---- tool_use: name/id fallbacks and non-record input (lines 148, 149, 150) ----
  it('falls back to name/id and an empty toolInput when only name/id are present with non-record input', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: {
            type: 'tool_use',
            name: 'shell',
            id: 'tool-x',
            input: 'not-a-record',
          },
        },
      })),
    ).toEqual({
      type: 'tool_use',
      toolName: 'shell',
      toolId: 'tool-x',
      toolInput: {},
    });
  });

  // ---- tool_result detection via status only (line 156), tool_id via id (line 170) ----
  it('detects a tool_result via tool_id + status alone (output/result absent) and resolves the id fallback', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { id: 'tool-y', tool_id: 'tool-y', status: 'success', payload: 'done' },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'tool-y',
      content: '',
    });
  });

  // ---- tool_result: missing status defaults to non-error (line 159) ----
  it('treats a tool_result with no status as a non-error result', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { tool_id: 'tool-z', output: 'ok-without-status' },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'tool-z',
      content: 'ok-without-status',
    });
  });

  // ---- tool_result content fallback chain: result, error, content (line 161) ----
  it('reads tool_result content from result, then error, then content', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { tool_id: 'tool-r', status: 'completed', result: [{ text: 'from-result' }] },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'tool-r',
      content: 'from-result',
    });

    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { tool_id: 'tool-r', status: 'failed', error: { message: 'from-error' } },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: true,
      toolId: 'tool-r',
      content: 'from-error',
    });

    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { tool_id: 'tool-r', status: 'completed', content: { raw: 42 } },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'tool-r',
      content: '{"raw":42}',
    });
  });

  it('emits an empty content string for a tool_result with no extractable content', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-4',
          update: { tool_id: 'tool-empty', status: 'completed' },
        },
      })),
    ).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'tool-empty',
      content: '',
    });
  });

  // ---- turn_complete usage fallbacks: stats then update itself (line 184) ----
  it('extracts token counts from stats when usage is absent on a turn_complete', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-5',
          update: {
            type: 'turn_complete',
            stats: { input_tokens: 30, output_tokens: 12 },
          },
        },
      })),
    ).toEqual({
      type: 'result',
      text: null,
      inputTokens: 30,
      outputTokens: 12,
    });
  });

  it('reads token counts from the update itself when usage and stats are absent', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-5',
          update: { stop_reason: 'max_tokens', inputTokens: 4, outputTokens: 2 },
        },
      })),
    ).toEqual({
      type: 'result',
      text: null,
      inputTokens: 4,
      outputTokens: 2,
    });
  });

  // ---- error update: message fallback + default text (lines 191, 195) ----
  it('uses the message field and falls back to the default text when error is empty', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-5',
          update: { type: 'error', error: { message: 'from-message-field' } },
        },
      })),
      // In-band errors are flagged for default-deny suppression. (BEAD-058)
    ).toEqual({ type: 'result', text: 'from-message-field', isError: true });
  });

  it('stringifies the whole update when an error update carries no extractable message', () => {
    const event = parseGeminiAcpEvent(
      frame({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'session-5',
          update: { type: 'error', error: { code: 7 } },
        },
      }),
    );
    expect(event?.type).toBe('result');
    // extractMessage(error) returns null, extractMessage(message) returns null,
    // so stringifyValue(update) is used — the result is a JSON string of the update.
    expect(typeof (event as { text: string }).text).toBe('string');
    expect((event as { text: string }).text).toContain('"type":"error"');
  });

  // ---- session/prompt response usage fallback to stats (line 259) ----
  it('reads token counts from stats on a session/prompt completion response when usage is absent', () => {
    expect(
      parseGeminiAcpEvent(frame({
        jsonrpc: '2.0',
        id: 9,
        result: {
          stop_reason: 'end_turn',
          stats: { input_tokens: 40, output_tokens: 15 },
        },
      })),
    ).toEqual({
      type: 'result',
      text: null,
      inputTokens: 40,
      outputTokens: 15,
    });
  });
});
