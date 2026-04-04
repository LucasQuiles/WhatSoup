import { describe, it, expect } from 'vitest';
import { parseCodexEvent } from '../../../../src/runtimes/agent/providers/codex-parser.ts';

describe('parseCodexEvent', () => {
  describe('thread/tokenUsage/updated notification', () => {
    it('produces a result event with token counts from nested tokenUsage', () => {
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
        type: 'result',
        text: null,
        inputTokens: 1234,
        outputTokens: 567,
      });
    });

    it('produces a result event with token counts at top level of params', () => {
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
        type: 'result',
        text: null,
        inputTokens: 800,
        outputTokens: 200,
      });
    });

    it('produces a result event with no tokens when params has no token data', () => {
      const line = JSON.stringify({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: {},
      });

      const event = parseCodexEvent(line);
      expect(event).toEqual({
        type: 'result',
        text: null,
      });
    });
  });
});
