/**
 * Pins multi-iteration usage preservation for the OpenAI provider (#2182).
 *
 * This is the same defect `#1775 Mechanism B` fixed for the Anthropic provider
 * — see `anthropic-api.test.ts`, "preserves real usage from an earlier
 * tool-loop iteration when a later call reports none". `anthropic-api.ts:177`
 * carries usage forward with `result.inputTokens ?? lastInputTokens`; the
 * OpenAI sibling assigned unconditionally and therefore erased it.
 *
 * `sendTurn()` loops until a terminal result. Several terminal paths in
 * `callApi()` deliberately report no usage — a connection failure, a
 * non-success response after retry handling, a missing body. When one of those
 * follows a successful tool-use iteration, the turn's already-measured tokens
 * were overwritten with `undefined`, and turn finalization records usage only
 * when a counter is defined, so they were lost outright rather than merely
 * under-reported.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderSessionOptions, ProviderTurnRequest } from '../../../../src/runtimes/agent/providers/types.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';

function sseStreamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** One iteration that reports usage AND requests a tool, so the loop continues. */
function usageThenToolCallLines(): string[] {
  return [
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'noop', arguments: '{}' } }] } }],
    }),
    JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 40 } }),
  ];
}

function makeRequest(): ProviderTurnRequest {
  return { role: 'user', conversationKey: 'openai-api-test', parts: [{ kind: 'text', text: 'hello' }] };
}

describe('OpenAIApiProvider — multi-iteration token usage (#2182, = #1775 Mechanism B)', () => {
  const originalApiKey = process.env['OPENAI_API_KEY'];
  let events: AgentEvent[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    events = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = originalApiKey;
  });

  async function initProvider(): Promise<OpenAIApiProvider> {
    const provider = new OpenAIApiProvider();
    const opts: ProviderSessionOptions = {
      cwd: '/tmp',
      systemPrompt: 'system',
      instanceName: 'openai-api-test',
      onEvent: (event) => events.push(event),
      onCrash: () => {},
    };
    await provider.initialize(opts);
    return provider;
  }

  function soleResult(): Extract<AgentEvent, { type: 'result' }> {
    const results = events.filter((e): e is Extract<AgentEvent, { type: 'result' }> => e.type === 'result');
    expect(results).toHaveLength(1);
    return results[0];
  }

  it('preserves usage when a later iteration fails to connect', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, body: sseStreamFromLines(usageThenToolCallLines()) } as unknown as Response);
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    const result = soleResult();
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(40);
  });

  it('preserves usage when a later iteration returns no response body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, body: sseStreamFromLines(usageThenToolCallLines()) } as unknown as Response);
    fetchMock.mockResolvedValue({ ok: true, body: null } as unknown as Response);

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    const result = soleResult();
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(40);
  });

  it('still UPDATES usage when a later iteration reports fresh counters', async () => {
    // The guard must not freeze the first value. `x = new ?? x` updates on every
    // reported figure; `x ??= new` — the phrasing the issue uses — would keep 500
    // forever and silently under-report. This is the case that separates them.
    fetchMock.mockResolvedValueOnce({ ok: true, body: sseStreamFromLines(usageThenToolCallLines()) } as unknown as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: sseStreamFromLines([
        JSON.stringify({ choices: [{ delta: { content: 'done' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 70 } }),
      ]),
    } as unknown as Response);

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    const result = soleResult();
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(70);
  });

  it('reports undefined when NO iteration ever reported usage', async () => {
    // Absence of a measurement must stay absent — the fix carries forward what
    // was measured, it does not invent a value.
    fetchMock.mockResolvedValue({
      ok: true,
      body: sseStreamFromLines([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }),
      ]),
    } as unknown as Response);

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    const result = soleResult();
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();

    // Closing on the POSITIVE assertion, not the two absences: the turn ran to
    // completion and streamed its text, so the counters are undefined by design
    // rather than because the turn died before usage could be reported. A test
    // that ends on `toBeUndefined()` cannot distinguish those, which is exactly
    // what the test-integrity guard flags as a terminal weak assertion.
    const streamed = events
      .filter((e): e is Extract<AgentEvent, { type: 'assistant_text' }> => e.type === 'assistant_text')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe('hi');
  });
});
