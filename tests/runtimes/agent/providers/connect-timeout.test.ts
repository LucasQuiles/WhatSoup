/**
 * Connect-phase timeout for the streaming HTTP providers (#2629).
 *
 * Both providers pass the session AbortController signal to fetch for
 * lifecycle cancel, but nothing bounded the connect+headers phase — a
 * SYN-blackholed or header-stalled endpoint hung the turn until the OS
 * gave up. CONNECT_TIMEOUT_MS now aborts a fetch that has not resolved
 * in time; the stream BODY stays unbounded by design (agent turns
 * legitimately run for minutes) and is cancelled via stop().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import type { ProviderSessionOptions, ProviderTurnRequest } from '../../../../src/runtimes/agent/providers/types.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { CONNECT_TIMEOUT_MS } from '../../../../src/runtimes/agent/providers/api-provider-shared.ts';

function sseStreamFromLines(lines: string[], appendDone: boolean): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      if (appendDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** Minimal terminal (no tool-use) turn for each provider's SSE dialect. */
const TERMINAL_STREAMS = {
  anthropic: () =>
    sseStreamFromLines(
      [
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } }),
        JSON.stringify({ type: 'message_stop' }),
      ],
      false,
    ),
  openai: () =>
    sseStreamFromLines(
      [
        JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
        JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] }),
      ],
      true,
    ),
} as const;

const PROVIDERS = [
  { name: 'AnthropicApiProvider', envVar: 'ANTHROPIC_API_KEY', make: () => new AnthropicApiProvider(), stream: TERMINAL_STREAMS.anthropic },
  { name: 'OpenAIApiProvider', envVar: 'OPENAI_API_KEY', make: () => new OpenAIApiProvider(), stream: TERMINAL_STREAMS.openai },
] as const;

function makeRequest(): ProviderTurnRequest {
  return { role: 'user', conversationKey: 'connect-timeout-test', parts: [{ kind: 'text', text: 'hello' }] };
}

describe.each(PROVIDERS)('$name — connect-phase timeout (#2629)', ({ envVar, make, stream }) => {
  const originalApiKey = process.env[envVar];
  let events: AgentEvent[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env[envVar] = 'test-key';
    events = [];
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env[envVar];
    else process.env[envVar] = originalApiKey;
  });

  async function initProvider() {
    const provider = make();
    const opts: ProviderSessionOptions = {
      cwd: '/tmp',
      systemPrompt: 'system',
      instanceName: 'connect-timeout-test',
      onEvent: (event: AgentEvent) => events.push(event),
      onCrash: () => {},
    };
    await provider.initialize(opts);
    return provider;
  }

  it(`aborts a connect that never resolves after ${CONNECT_TIMEOUT_MS}ms and surfaces the connection-error contract`, async () => {
    let fetchSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init.signal;
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    );

    const provider = await initProvider();
    const turn = provider.sendTurn(makeRequest());
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await turn;

    expect(fetchSignal?.aborted).toBe(true);
    const resultEvents = events.filter((e): e is Extract<AgentEvent, { type: 'result' }> => e.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]!.text).toBe('_Connection error - please try again._');
  });

  it('clears the timer once the connect resolves — a completed turn is never aborted retroactively', async () => {
    let fetchSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: unknown, init: { signal?: AbortSignal }) => {
      fetchSignal = init.signal;
      return Promise.resolve({ ok: true, body: stream() } as unknown as Response);
    });

    const provider = await initProvider();
    await provider.sendTurn(makeRequest());

    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(fetchSignal?.aborted).toBe(false);
  });
});
