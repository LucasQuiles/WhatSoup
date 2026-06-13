import { describe, it, expect } from 'vitest';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';

describe('parseCodexEvent', () => {
  describe('terminal error results', () => {
    it('marks app-server failed turns as isError so runtime default-denies raw text', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          turn: {
            status: 'failed',
            error: { message: 'raw provider failure detail' },
          },
        },
      });

      expect(parseCodexEvent(line)).toEqual({
        type: 'result',
        text: 'raw provider failure detail',
        isError: true,
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
});
