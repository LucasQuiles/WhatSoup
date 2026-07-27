import { describe, expect, it } from 'vitest';
import { parseEvents } from '../../../src/runtimes/agent/stream-parser.ts';

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe('Claude CLI informational stream events', () => {
  it('treats rate-limit telemetry as inert while terminal failures remain separate', () => {
    expect(
      parseEvents(
        line({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed',
            rateLimitType: 'five_hour',
            overageStatus: 'rejected',
          },
          uuid: 'sanitized-uuid',
          session_id: 'sanitized-session',
        }),
      ),
    ).toEqual([
      {
        type: 'ignored',
        blockType: 'rate_limit_event',
        reason: 'provider rate-limit telemetry, no runtime side effects',
      },
    ]);
  });

  it('keeps non-allowed or malformed rate-limit events fail-closed', () => {
    const rejected = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    };
    const malformed = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 42 },
    };

    expect(parseEvents(line(rejected))).toEqual([{ type: 'unknown', raw: rejected }]);
    expect(parseEvents(line(malformed))).toEqual([{ type: 'unknown', raw: malformed }]);
  });

  it('treats system thinking-token estimates as inert model telemetry', () => {
    expect(
      parseEvents(
        line({
          type: 'system',
          subtype: 'thinking_tokens',
          estimated_tokens: 123,
          estimated_tokens_delta: 7,
          uuid: 'sanitized-uuid',
          session_id: 'sanitized-session',
        }),
      ),
    ).toEqual([
      {
        type: 'ignored',
        blockType: 'thinking_tokens',
        reason: 'model-internal token estimate, no runtime side effects',
      },
    ]);
  });

  it('keeps malformed thinking-token telemetry fail-closed', () => {
    const malformed = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: '123',
      estimated_tokens_delta: 7,
    };

    expect(parseEvents(line(malformed))).toEqual([{ type: 'unknown', raw: malformed }]);
  });

  it('preserves a tool result and treats its nested tool reference as inert discovery metadata', () => {
    expect(
      parseEvents(
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'sanitized-tool-use',
                content: [
                  { type: 'text', text: 'tool schema loaded' },
                  {
                    type: 'tool_reference',
                    tool_name: 'mcp__sanitized__read_tool',
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        isError: false,
        toolId: 'sanitized-tool-use',
        content: 'tool schema loaded',
      },
      {
        type: 'ignored',
        blockType: 'tool_reference',
        reason: 'tool-discovery metadata, no runtime side effects',
      },
    ]);
  });

  it('keeps a malformed nested tool reference fail-closed', () => {
    const malformedReference = { type: 'tool_reference' };

    expect(
      parseEvents(
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'sanitized-tool-use',
                content: [malformedReference],
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        type: 'tool_result',
        isError: false,
        toolId: 'sanitized-tool-use',
        content: '',
      },
      {
        type: 'unknown_block',
        blockType: 'tool_reference',
        raw: malformedReference,
      },
    ]);
  });

  it('keeps unknown system subtypes and content blocks fail-closed', () => {
    const unknownSystem = { type: 'system', subtype: 'future_side_effect' };
    const unknownBlock = { type: 'future_side_effect', payload: 'sanitized' };

    expect(parseEvents(line(unknownSystem))).toEqual([{ type: 'unknown', raw: unknownSystem }]);
    expect(
      parseEvents(
        line({
          type: 'assistant',
          message: { content: [unknownBlock] },
        }),
      ),
    ).toEqual([
      {
        type: 'unknown_block',
        blockType: 'future_side_effect',
        raw: unknownBlock,
      },
    ]);
  });
});
