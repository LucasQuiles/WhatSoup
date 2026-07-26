/**
 * Direct unit coverage for src/runtimes/agent/providers/opencode-parser.ts.
 *
 * Unlike the gemini/codex parsers, this one is STATEFUL — it tracks a
 * `firstStepSeen` flag so that only the first step_start emits an `init`
 * event (subsequent ones return `ignored`). The module exposes:
 *
 * - createOpenCodeParser(): factory returning { parse, reset } with isolated state
 *
 * Existing parser-interface-conformance.test.ts covers only `init` +
 * `assistant_text` generically. This file pins state-tracking + each
 * event-type branch (step_start / text / tool_use / step_finish).
 */
import { describe, expect, it } from 'vitest';
import {
  createOpenCodeParser,
} from '../../../../src/runtimes/agent/providers/opencode-parser.ts';

describe('createOpenCodeParser — factory + per-instance state isolation', () => {
  it('returns an object exposing parse and reset functions', () => {
    const p = createOpenCodeParser();
    expect(typeof p.parse).toBe('function');
    expect(typeof p.reset).toBe('function');
  });

  it('two parsers track step_start state independently', () => {
    const a = createOpenCodeParser();
    const b = createOpenCodeParser();
    // a sees its first step_start
    expect(a.parse(JSON.stringify({ type: 'step_start', sessionID: 'session-a' }))).toEqual({
      type: 'init',
      sessionId: 'session-a',
    });
    // b has not seen any yet → its first IS a fresh init
    expect(b.parse(JSON.stringify({ type: 'step_start', sessionID: 'session-b' }))).toEqual({
      type: 'init',
      sessionId: 'session-b',
    });
    // a's second is ignored
    expect(a.parse(JSON.stringify({ type: 'step_start', sessionID: 'session-a' }))).toEqual({
      type: 'ignored',
    });
  });

  it('reset() restores first-step behavior on the same instance', () => {
    const p = createOpenCodeParser();
    p.parse(JSON.stringify({ type: 'step_start', sessionID: 'x' }));
    expect(p.parse(JSON.stringify({ type: 'step_start', sessionID: 'y' }))).toEqual({
      type: 'ignored',
    });
    p.reset();
    expect(p.parse(JSON.stringify({ type: 'step_start', sessionID: 'z' }))).toEqual({
      type: 'init',
      sessionId: 'z',
    });
  });
});

describe('createOpenCodeParser — shared instance state + reset()', () => {
  it('tracks step_start state across calls on one instance and respects reset()', () => {
    const parser = createOpenCodeParser();
    parser.reset();
    expect(parser.parse(JSON.stringify({ type: 'step_start', sessionID: 'first' }))).toEqual({
      type: 'init',
      sessionId: 'first',
    });
    // Second step_start on the same instance is ignored (shared state)
    expect(parser.parse(JSON.stringify({ type: 'step_start', sessionID: 'second' }))).toEqual({
      type: 'ignored',
    });
    // After reset, first-step behavior returns
    parser.reset();
    expect(parser.parse(JSON.stringify({ type: 'step_start', sessionID: 'third' }))).toEqual({
      type: 'init',
      sessionId: 'third',
    });
  });
});

describe('OpenCode parser — boundary inputs', () => {
  it('empty string → null', () => {
    expect(createOpenCodeParser().parse('')).toBeNull();
  });

  it('whitespace-only line → null', () => {
    expect(createOpenCodeParser().parse('   ')).toBeNull();
  });

  it('malformed JSON → parse_error with the original line preserved', () => {
    const p = createOpenCodeParser();
    expect(p.parse('{ no')).toEqual({ type: 'parse_error', line: '{ no' });
  });

  it('non-object parsed value → unknown', () => {
    const p = createOpenCodeParser();
    expect(p.parse('"text"')).toEqual({ type: 'unknown', raw: 'text' });
    expect(p.parse('42')).toEqual({ type: 'unknown', raw: 42 });
  });
});

describe('OpenCode parser — text branch', () => {
  it('emits assistant_text from part.text', () => {
    const p = createOpenCodeParser();
    const event = p.parse(JSON.stringify({ type: 'text', part: { text: 'hello world' } }));
    expect(event).toEqual({ type: 'assistant_text', text: 'hello world' });
  });

  it('defaults text to empty string when part.text is missing', () => {
    const p = createOpenCodeParser();
    const event = p.parse(JSON.stringify({ type: 'text', part: {} }));
    expect(event).toEqual({ type: 'assistant_text', text: '' });
  });

  it('ignores the exact synthetic auto-compaction continuation control', () => {
    const p = createOpenCodeParser();
    const event = p.parse(JSON.stringify({
      type: 'text',
      part: {
        type: 'text',
        synthetic: true,
        metadata: { compaction_continue: true },
        text: 'Continue if you have next steps.',
      },
    }));
    expect(event).toEqual({ type: 'ignored' });
  });

  it('preserves synthetic text without the exact auto-compaction marker', () => {
    const p = createOpenCodeParser();
    const event = p.parse(JSON.stringify({
      type: 'text',
      part: {
        synthetic: true,
        metadata: { compaction_continue: false },
        text: 'visible synthetic assistant text',
      },
    }));
    expect(event).toEqual({ type: 'assistant_text', text: 'visible synthetic assistant text' });
  });

  it('returns ignored when part is not a record', () => {
    const p = createOpenCodeParser();
    expect(p.parse(JSON.stringify({ type: 'text', part: 'oops' }))).toEqual({
      type: 'ignored',
    });
    expect(p.parse(JSON.stringify({ type: 'text' }))).toEqual({ type: 'ignored' });
  });
});

describe('OpenCode parser — tool_use branch', () => {
  it('emits tool_result with completed status as not-error', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({
        type: 'tool_use',
        part: { tool: 'bash', callID: 'c-1', state: { status: 'completed', output: 'ok' } },
      }),
    );
    expect(event).toEqual({
      type: 'tool_result',
      isError: false,
      toolId: 'c-1',
      toolName: 'bash',
      content: 'ok',
    });
  });

  it('emits tool_result with isError=true for any non-completed status', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({
        type: 'tool_use',
        part: { tool: 'edit', callID: 'c-1', state: { status: 'failed', output: 'boom' } },
      }),
    );
    expect(event).toEqual({
      type: 'tool_result',
      isError: true,
      toolId: 'c-1',
      toolName: 'edit',
      content: 'boom',
    });
  });

  it('treats a missing state as a malformed failed result with non-empty detail', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({ type: 'tool_use', part: { tool: 'edit', callID: 'c-1' } }),
    );
    expect(event).toMatchObject({
      type: 'tool_result',
      isError: true,
      toolId: 'c-1',
      toolName: 'edit',
    });
    expect((event as Extract<NonNullable<typeof event>, { type: 'tool_result' }>).content.trim())
      .not.toBe('');
  });

  it('prioritizes structured error, output, then metadata in synthetic rejected events', () => {
    // Synthetic: the incident retained WhatSoup logs, but no terminal OpenCode JSON.
    const base: {
      type: string;
      part: {
        type: string;
        tool: string;
        callID: string;
        state: {
          status: string;
          error?: unknown;
          output?: unknown;
          metadata?: unknown;
        };
      };
    } = {
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'edit',
        callID: 'call_rejected_1',
        state: {
          status: 'rejected',
          error: { message: 'permission requested: edit; auto-rejecting' },
          output: 'lower-priority output',
          metadata: { message: 'lowest-priority metadata' },
        },
      },
    };
    const parser = createOpenCodeParser();

    expect(parser.parse(JSON.stringify(base))).toEqual({
      type: 'tool_result',
      isError: true,
      toolId: 'call_rejected_1',
      toolName: 'edit',
      content: 'permission requested: edit; auto-rejecting',
    });

    const withoutError = structuredClone(base);
    delete withoutError.part.state.error;
    expect(parser.parse(JSON.stringify(withoutError))).toMatchObject({
      content: 'lower-priority output',
    });

    const metadataOnly = structuredClone(withoutError);
    delete metadataOnly.part.state.output;
    expect(parser.parse(JSON.stringify(metadataOnly))).toMatchObject({
      content: 'lowest-priority metadata',
    });
  });

  it.each([
    ['empty object', {}],
    ['empty array', []],
    ['whitespace-only nested message', { message: '  \t\n ' }],
    ['default-ignorable-only nested message', { message: '\u034F\uFE0F\u{E0100}\u3164\uFFA0' }],
  ])('falls through a structurally empty %s error to useful output', (_label, error) => {
    const event = createOpenCodeParser().parse(JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'edit',
        callID: 'call_useful_output',
        state: {
          status: 'rejected',
          error,
          output: 'permission requested: edit; auto-rejecting',
          metadata: { message: 'lower-priority metadata' },
        },
      },
    }));

    expect(event).toMatchObject({
      type: 'tool_result',
      isError: true,
      toolId: 'call_useful_output',
      toolName: 'edit',
      content: 'permission requested: edit; auto-rejecting',
    });
  });

  it('normalizes a multiline control-bearing 100k tool name while preserving call identity', () => {
    const rawToolName = `edit\nspoofed\u0000${'x'.repeat(100_000)}`;
    const event = createOpenCodeParser().parse(JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: rawToolName,
        callID: 'call_stable_identity',
        state: { status: 'rejected', output: 'auto-rejecting' },
      },
    }));

    expect(event).toMatchObject({
      type: 'tool_result',
      isError: true,
      toolId: 'call_stable_identity',
      content: 'auto-rejecting',
    });
    const toolName = (event as Extract<NonNullable<typeof event>, { type: 'tool_result' }>).toolName;
    expect(toolName).toMatch(/^edit spoofed/);
    expect(toolName?.length).toBeLessThanOrEqual(48);
    expect(toolName).not.toMatch(/[\r\n\u0000-\u001F\u007F-\u009F\u200B]/u);
  });

  it('uses a bounded non-empty status fallback when a synthetic rejection has no detail', () => {
    // Synthetic: the incident retained WhatSoup logs, but no terminal OpenCode JSON.
    const longStatus = `rejected-${'x'.repeat(500)}`;
    const event = createOpenCodeParser().parse(JSON.stringify({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_rejected_2',
        state: { status: longStatus },
      },
    }));

    expect(event).toMatchObject({
      type: 'tool_result',
      isError: true,
      toolId: 'call_rejected_2',
      toolName: 'bash',
    });
    const content = (event as Extract<NonNullable<typeof event>, { type: 'tool_result' }>).content;
    expect(content.trim()).not.toBe('');
    expect(content.length).toBeLessThanOrEqual(160);
  });

  it('returns unknown when part is not a record', () => {
    const p = createOpenCodeParser();
    expect(p.parse(JSON.stringify({ type: 'tool_use', part: 'oops' }))).toMatchObject({
      type: 'unknown',
    });
  });

  it('stringifies non-string output via stringifyValue', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({
        type: 'tool_use',
        part: { callID: 'c-1', state: { status: 'completed', output: { foo: 'bar' } } },
      }),
    );
    expect(typeof (event as { content: string }).content).toBe('string');
  });
});

describe('OpenCode parser — step_finish branch', () => {
  it('reason="stop" with tokens → result with inputTokens + outputTokens', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({
        type: 'step_finish',
        part: { reason: 'stop', tokens: { input: 123, output: 45 } },
      }),
    );
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: 123,
      outputTokens: 45,
    });
  });

  it('reason="stop" without tokens → result with undefined token counts', () => {
    const p = createOpenCodeParser();
    const event = p.parse(JSON.stringify({ type: 'step_finish', part: { reason: 'stop' } }));
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it('reason="stop" with cost → result with costUsd populated and tokens parsed identically', () => {
    const p = createOpenCodeParser();
    // Live-captured shape from a real opencode step_finish event.
    const event = p.parse(
      JSON.stringify({
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { total: 102512, input: 1941, output: 34, reasoning: 0, cache: { write: 100537, read: 0 } },
          cost: 0.0006231,
        },
      }),
    );
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: 1941,
      outputTokens: 34,
      costUsd: 0.0006231,
    });
  });

  it('reason="stop" with cost=0 → costUsd 0 (zero is a valid cost)', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({ type: 'step_finish', part: { reason: 'stop', cost: 0 } }),
    );
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: undefined,
      outputTokens: undefined,
      costUsd: 0,
    });
  });

  it('reason="stop" without cost → costUsd undefined', () => {
    const p = createOpenCodeParser();
    const event = p.parse(
      JSON.stringify({
        type: 'step_finish',
        part: { reason: 'stop', tokens: { input: 10, output: 5 } },
      }),
    );
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: undefined,
    });
  });

  it.each([
    ['string cost', '"0.5"'],
    ['negative cost', '-0.001'],
    ['null cost', 'null'],
    ['non-finite cost (1e999 → Infinity)', '1e999'],
  ])('reason="stop" with garbage cost (%s) → costUsd undefined, tokens unaffected', (_label, costJson) => {
    const p = createOpenCodeParser();
    const line = `{"type":"step_finish","part":{"reason":"stop","tokens":{"input":7,"output":3},"cost":${costJson}}}`;
    const event = p.parse(line);
    expect(event).toEqual({
      type: 'result',
      text: null,
      inputTokens: 7,
      outputTokens: 3,
      costUsd: undefined,
    });
  });

  it('reason="tool-calls" → ignored (more steps follow)', () => {
    const p = createOpenCodeParser();
    expect(p.parse(JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls' } }))).toEqual({
      type: 'ignored',
    });
  });

  it('non-record part → ignored', () => {
    const p = createOpenCodeParser();
    expect(p.parse(JSON.stringify({ type: 'step_finish', part: null }))).toEqual({
      type: 'ignored',
    });
  });
});

describe('OpenCode parser — unknown event type', () => {
  it('unrecognised event type → unknown with raw value', () => {
    const p = createOpenCodeParser();
    expect(p.parse(JSON.stringify({ type: 'mystery' }))).toMatchObject({ type: 'unknown' });
  });
});
