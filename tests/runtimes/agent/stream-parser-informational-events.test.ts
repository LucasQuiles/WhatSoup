import { beforeEach, describe, expect, it } from 'vitest';
import {
  _observedUnclassifiedKeys,
  _resetStreamParserObservability,
  parseEvents,
} from '../../../src/runtimes/agent/stream-parser.ts';

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

  it('treats tool_progress as inert tool-execution telemetry (Claude CLI 2.x)', () => {
    // Claude CLI >= 2.1.x streams `tool_progress` envelopes while an MCP tool runs
    // (e.g. downloading a large media attachment). They carry no model output — the
    // request is a separate `tool_use` and the outcome a separate `tool_result` — so
    // the deployed 4fc1e7ff parser classified them `unknown` -> `ambiguous_event`,
    // flooding rejections on every tool-heavy turn. They are inert progress telemetry.
    expect(
      parseEvents(
        line({
          type: 'tool_progress',
          tool_use_id: 'sanitized-tool-use',
          progress: 0.5,
          uuid: 'sanitized-uuid',
          session_id: 'sanitized-session',
        }),
      ),
    ).toEqual([
      {
        type: 'ignored',
        blockType: 'tool_progress',
        reason: 'tool-execution progress telemetry, no runtime side effects',
      },
    ]);
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

  // Protocol-compatibility hardening for Claude CLI 2.1.x `{"type":"system",
  // "subtype":"api_retry"}` — a documented, side-effect-free event emitted when an API
  // request hits a retryable error before the CLI auto-retries. The parser recognizes it
  // as inert ONLY when the full documented envelope validates; any missing, malformed,
  // out-of-range, or unknown field keeps it fail-closed (`unknown`). NOTE: this does not
  // assert api_retry is the cause of any historically-observed rejection — that requires a
  // captured production envelope, which the new subtype observability below enables.
  describe('system/api_retry full-schema validation', () => {
    const validApiRetry = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 1000,
      error_status: 429,
      error: 'rate_limit',
      uuid: 'sanitized-uuid',
      session_id: 'sanitized-session',
    };
    const inert = [
      { type: 'ignored', blockType: 'api_retry', reason: 'provider API retry telemetry, no runtime side effects' },
    ];

    it('classifies a fully-valid api_retry envelope inert', () => {
      expect(parseEvents(line(validApiRetry))).toEqual(inert);
    });

    it('allows null error_status (documented integer-or-null)', () => {
      expect(parseEvents(line({ ...validApiRetry, error_status: null }))).toEqual(inert);
    });

    it('accepts every documented error category', () => {
      const categories = [
        'authentication_failed', 'oauth_org_not_allowed', 'billing_error', 'rate_limit',
        'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens',
      ];
      const results = categories.map((error) => parseEvents(line({ ...validApiRetry, error })));
      expect(results).toEqual(categories.map(() => inert));
    });

    const malformed: Array<[string, Record<string, unknown>]> = [
      ['missing max_retries', (() => { const e: Record<string, unknown> = { ...validApiRetry }; delete e.max_retries; return e; })()],
      ['missing retry_delay_ms', (() => { const e: Record<string, unknown> = { ...validApiRetry }; delete e.retry_delay_ms; return e; })()],
      ['fractional attempt', { ...validApiRetry, attempt: 1.5 }],
      ['negative attempt', { ...validApiRetry, attempt: -1 }],
      ['unsafe-integer attempt', { ...validApiRetry, attempt: Number.MAX_SAFE_INTEGER + 1 }],
      ['attempt beyond max_retries', { ...validApiRetry, attempt: 11, max_retries: 10 }],
      ['string counter', { ...validApiRetry, retry_delay_ms: '1000' }],
      ['unknown error category', { ...validApiRetry, error: 'not_a_real_code' }],
      ['null error category', { ...validApiRetry, error: null }],
      ['fractional error_status', { ...validApiRetry, error_status: 429.5 }],
      ['string error_status', { ...validApiRetry, error_status: '429' }],
      ['out-of-range error_status', { ...validApiRetry, error_status: 700 }],
      ['blank uuid', { ...validApiRetry, uuid: '' }],
      ['blank session_id', { ...validApiRetry, session_id: '' }],
    ];
    it.each(malformed)('keeps a malformed api_retry fail-closed: %s', (_label, envelope) => {
      expect(parseEvents(line(envelope))).toEqual([{ type: 'unknown', raw: envelope }]);
    });
  });

  describe('bounded unclassified-event observability', () => {
    beforeEach(() => _resetStreamParserObservability());

    it('captures the system SUBTYPE (not just "system") for unknown system events', () => {
      parseEvents(line({ type: 'system', subtype: 'future_side_effect' }));
      expect(_observedUnclassifiedKeys()).toContain('unknown:system:future_side_effect');
    });

    it('charset-bounds an unsafe or oversized subtype to a safe placeholder', () => {
      parseEvents(line({ type: 'system', subtype: 'BAD sub!\u202Eevil' })); // control/bidi
      parseEvents(line({ type: 'system', subtype: 'x'.repeat(200) })); // oversized
      const keys = _observedUnclassifiedKeys();
      expect(keys).toContain('unknown:system:<unsafe>');
      expect(keys.every((k) => k.length < 80)).toBe(true);
    });

    it('caps dedupe cardinality so a hostile type stream cannot grow the set unbounded', () => {
      for (let i = 0; i < 400; i++) parseEvents(line({ type: `unknown_type_${i}` }));
      expect(_observedUnclassifiedKeys().length).toBeLessThanOrEqual(128);
    });
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
