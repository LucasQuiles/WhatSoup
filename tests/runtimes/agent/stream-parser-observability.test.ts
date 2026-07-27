/**
 * RIDER — stream-parser unknown-block observability. Live canary shows 256+
 * events/hour classified as unknown/unknown_block/parse_error, and the TYPE is
 * currently invisible. Log the block/event TYPE STRING ONLY (warn, deduped per
 * type per process) — never the payload, never other fields (id-only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() }),
}));

import {
  parseEvents,
  _resetStreamParserObservability,
} from '../../../src/runtimes/agent/stream-parser.ts';

beforeEach(() => {
  warnSpy.mockClear();
  _resetStreamParserObservability();
});

function warnArgsString(): string {
  return JSON.stringify(warnSpy.mock.calls);
}

describe('stream-parser observability (id-only)', () => {
  it('warns the unknown BLOCK type string but NEVER the payload content', () => {
    const payloadSentinel = 'PAYLOAD_SENTINEL_abc123';
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'weird_block_type', data: payloadSentinel }] },
    });

    const events = parseEvents(line);
    expect(events.some((e) => e.type === 'unknown_block')).toBe(true);

    expect(warnSpy).toHaveBeenCalled();
    // The block TYPE STRING is surfaced …
    expect(warnArgsString()).toContain('weird_block_type');
    // … and the payload content is NOT.
    expect(warnArgsString()).not.toContain(payloadSentinel);
  });

  it('warns the top-level unknown event TYPE STRING but not the payload', () => {
    const payloadSentinel = 'TOPLEVEL_SENTINEL_xyz789';
    const line = JSON.stringify({ type: 'brand_new_top_type', blob: payloadSentinel });

    const events = parseEvents(line);
    expect(events).toEqual([{ type: 'unknown', raw: { type: 'brand_new_top_type', blob: payloadSentinel } }]);

    expect(warnSpy).toHaveBeenCalled();
    expect(warnArgsString()).toContain('brand_new_top_type');
    expect(warnArgsString()).not.toContain(payloadSentinel);
  });

  it('warns on a parse_error WITHOUT logging the raw line', () => {
    const line = '{ this is not valid json SENTINEL_LINE_CONTENT';
    const events = parseEvents(line);
    expect(events).toEqual([{ type: 'parse_error', line }]);

    expect(warnSpy).toHaveBeenCalled();
    expect(warnArgsString()).toContain('parse_error');
    expect(warnArgsString()).not.toContain('SENTINEL_LINE_CONTENT');
  });

  it('dedupes: the same unknown_block type warns once per process, not per occurrence', () => {
    const mk = (i: number) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'repeated_unknown', n: i }] } });
    parseEvents(mk(1));
    parseEvents(mk(2));
    parseEvents(mk(3));
    const repeatedWarns = warnSpy.mock.calls.filter((c) => JSON.stringify(c).includes('repeated_unknown'));
    expect(repeatedWarns).toHaveLength(1);
  });

  it('does NOT warn for a well-formed known event', () => {
    parseEvents(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for current Claude informational event shapes', () => {
    parseEvents(JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed' },
      session_id: 'sanitized-session',
    }));
    parseEvents(JSON.stringify({
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 12,
      estimated_tokens_delta: 3,
      session_id: 'sanitized-session',
    }));
    parseEvents(JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'sanitized-tool-use',
          content: [{
            type: 'tool_reference',
            tool_name: 'mcp__sanitized__read_tool',
          }],
        }],
      },
    }));

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
