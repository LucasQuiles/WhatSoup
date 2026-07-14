import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderSessionOptions, ProviderTurnRequest } from '../../../../src/runtimes/agent/providers/types.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';

function sseStreamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
}

/** A single successful turn: one tool_use block plus real usage. */
function successWithToolUseLines(): string[] {
  return [
    JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 500, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } },
    }),
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'noop' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }),
    JSON.stringify({ type: 'content_block_stop', index: 0 }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 40 } }),
    JSON.stringify({ type: 'message_stop' }),
  ];
}

function makeRequest(): ProviderTurnRequest {
  return {
    role: 'user',
    conversationKey: 'anthropic-api-test',
    parts: [{ kind: 'text', text: 'hello' }],
  };
}

describe('AnthropicApiProvider — multi-iteration token usage (#1775 Mechanism B)', () => {
  const originalApiKey = process.env['ANTHROPIC_API_KEY'];
  let events: AgentEvent[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    events = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = originalApiKey;
  });

  async function initProvider(): Promise<AnthropicApiProvider> {
    const provider = new AnthropicApiProvider();
    const opts: ProviderSessionOptions = {
      cwd: '/tmp',
      systemPrompt: 'system',
      instanceName: 'anthropic-api-test',
      onEvent: (event) => events.push(event),
      onCrash: () => {},
    };
    await provider.initialize(opts);
    return provider;
  }

  it('preserves real usage from an earlier tool-loop iteration when a later call reports none', async () => {
    // First callApi(): success, real usage, one tool_use → loop continues.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: sseStreamFromLines(successWithToolUseLines()),
    } as unknown as Response);
    // Second callApi() (post tool-result): the connection drops before any
    // usage is reported — the real bug: this used to clobber the FIRST
    // call's already-recorded usage down to undefined.
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    const resultEvents = events.filter((e): e is Extract<AgentEvent, { type: 'result' }> => e.type === 'result');
    expect(resultEvents).toHaveLength(1);
    const [result] = resultEvents;
    // 500 base + 100 cache_creation + 50 cache_read from the FIRST call —
    // must survive the second call's usage-less connection error.
    expect(result.inputTokens).toBe(650);
    expect(result.outputTokens).toBe(40);
    expect(result.text).toBe('_Connection error - please try again._');
  });
});
