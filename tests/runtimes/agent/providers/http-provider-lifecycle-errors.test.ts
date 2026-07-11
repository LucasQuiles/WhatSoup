import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

type HttpProvider = OpenAIApiProvider | AnthropicApiProvider;

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeOpenAiTextResponse(text: string): Response {
  return makeSseResponse([
    { choices: [{ delta: { content: text } }] },
    '[DONE]',
  ]);
}

function makeAnthropicTextResponse(text: string): Response {
  return makeSseResponse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'message_stop' },
  ]);
}

async function initializeProvider(provider: HttpProvider, events: AgentEvent[] = []): Promise<void> {
  await provider.initialize({
    cwd: '/tmp',
    systemPrompt: 'System prompt',
    instanceName: 'test-instance',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
  });
}

async function sendBasicTurn(provider: HttpProvider): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await initializeProvider(provider, events);
  await provider.sendTurn({
    role: 'user',
    conversationKey: 'chat-key',
    parts: [{ kind: 'text', text: 'hello' }],
  });
  return events;
}

function latestResult(events: AgentEvent[]): Extract<AgentEvent, { type: 'result' }> {
  const result = events.filter((event): event is Extract<AgentEvent, { type: 'result' }> => event.type === 'result').at(-1);
  if (!result) throw new Error('missing result event');
  return result;
}

describe('HTTP provider lifecycle and error coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalOpenAiKey: string | undefined;
  let originalAnthropicKey: string | undefined;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    originalOpenAiKey = process.env.OPENAI_API_KEY;
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('%s emits collision-safe session IDs when the wall clock is pinned', async (
    providerId,
    makeProvider,
  ) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const firstEvents: AgentEvent[] = [];
    const secondEvents: AgentEvent[] = [];

    await initializeProvider(makeProvider(), firstEvents);
    await initializeProvider(makeProvider(), secondEvents);

    const firstInit = firstEvents.find(
      (event): event is Extract<AgentEvent, { type: 'init' }> => event.type === 'init',
    );
    const secondInit = secondEvents.find(
      (event): event is Extract<AgentEvent, { type: 'init' }> => event.type === 'init',
    );
    expect(firstInit?.sessionId).toMatch(new RegExp(`^${providerId}-`));
    expect(secondInit?.sessionId).toMatch(new RegExp(`^${providerId}-`));
    expect(secondInit?.sessionId).not.toBe(firstInit?.sessionId);
  });

  it('rejects turns before initialization', async () => {
    await expect(new OpenAIApiProvider().sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toThrow(/not initialized/i);

    await expect(new AnthropicApiProvider().sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toThrow(/not initialized/i);
  });

  it('reports lifecycle state, checkpoints, and env keys without leaking unrelated env', async () => {
    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

    const openaiEvents: AgentEvent[] = [];
    const openai = new OpenAIApiProvider({ baseUrl: 'https://openai.example/v1' });
    await openai.initialize({
      cwd: '/tmp',
      systemPrompt: 'OpenAI system',
      instanceName: 'openai-instance',
      model: 'openai-override',
      onEvent: (event) => openaiEvents.push(event),
      onCrash: vi.fn(),
    });

    expect(openai.isActive()).toBe(true);
    expect(openai.buildEnv()).toEqual({ OPENAI_API_KEY: 'openai-test-key' });
    expect(openai.getCheckpoint()).toMatchObject({
      providerKind: 'openai-api',
      executionMode: 'managed_loop',
      providerState: {
        messageCount: 1,
        model: 'openai-override',
        baseUrl: 'https://openai.example/v1',
      },
    });
    expect(openaiEvents).toEqual([expect.objectContaining({ type: 'init' })]);
    await openai.shutdown('end');
    expect(openai.isActive()).toBe(false);

    const anthropicEvents: AgentEvent[] = [];
    const anthropic = new AnthropicApiProvider({ model: 'anthropic-default' });
    await anthropic.initialize({
      cwd: '/tmp',
      systemPrompt: 'Anthropic system',
      instanceName: 'anthropic-instance',
      model: 'anthropic-override',
      onEvent: (event) => anthropicEvents.push(event),
      onCrash: vi.fn(),
    });

    expect(anthropic.isActive()).toBe(true);
    expect(anthropic.buildEnv()).toEqual({ ANTHROPIC_API_KEY: 'anthropic-test-key' });
    expect(anthropic.getCheckpoint()).toMatchObject({
      providerKind: 'anthropic-api',
      executionMode: 'managed_loop',
      providerState: {
        messageCount: 0,
        model: 'anthropic-override',
      },
    });
    expect(anthropicEvents).toEqual([expect.objectContaining({ type: 'init' })]);
    await anthropic.shutdown('suspend');
    expect(anthropic.isActive()).toBe(false);
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider(), new Response(null, { status: 200 })],
    ['anthropic-api', () => new AnthropicApiProvider(), new Response(null, { status: 200 })],
  ])('%s emits a terminal result when the stream body is missing', async (_name, makeProvider, response) => {
    fetchMock.mockResolvedValueOnce(response);

    const events = await sendBasicTurn(makeProvider());

    expect(latestResult(events)).toMatchObject({ type: 'result', text: 'No response body' });
  });

  it.each([
    ['openai-api server error', () => new OpenAIApiProvider(), new Response('upstream down', { status: 503 }), '_Service temporarily unavailable - please try again in a moment._'],
    ['openai-api generic error', () => new OpenAIApiProvider(), new Response('payment required', { status: 402 }), '_Service error (402) - please try again._'],
    ['anthropic-api auth error', () => new AnthropicApiProvider(), new Response('bad key', { status: 401 }), '_Authentication error - please contact the administrator._'],
    ['anthropic-api server error', () => new AnthropicApiProvider(), new Response('upstream down', { status: 503 }), '_Service temporarily unavailable - please try again in a moment._'],
    ['anthropic-api generic error', () => new AnthropicApiProvider(), new Response('payment required', { status: 402 }), '_Service error (402) - please try again._'],
  ])('%s maps HTTP failures to bounded user-facing results', async (_name, makeProvider, response, expectedText) => {
    fetchMock.mockResolvedValueOnce(response);

    const events = await sendBasicTurn(makeProvider());

    expect(latestResult(events)).toMatchObject({ type: 'result', text: expectedText });
  });

  it.each([
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      () => makeOpenAiTextResponse('openai recovered'),
      'openai recovered',
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      () => makeAnthropicTextResponse('anthropic recovered'),
      'anthropic recovered',
    ],
  ])('%s retries once after surrogate-corruption errors and preserves sanitized recovery', async (
    _name,
    makeProvider,
    makeRecoveryResponse,
    expectedText,
  ) => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        '{"type":"error","error":{"message":"The request body is not valid JSON: no low surrogate in string"}}',
        { status: 400 },
      ))
      .mockResolvedValueOnce(makeRecoveryResponse());

    const events = await sendBasicTurn(makeProvider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({ type: 'assistant_text', text: expectedText }));
    expect(latestResult(events)).toMatchObject({ type: 'result', text: null });
  });

  it.each([
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      () => makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_loop',
                type: 'function',
                function: { name: 'loop_tool', arguments: '{}' },
              }],
            },
          }],
        },
        { usage: { prompt_tokens: 1, completion_tokens: 1 } },
        '[DONE]',
      ]),
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      () => makeSseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_loop', name: 'loop_tool' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    ],
  ])('%s stops managed tool loops at the hard iteration limit', async (_name, makeProvider, makeLoopResponse) => {
    fetchMock.mockImplementation(async () => makeLoopResponse());

    const events = await sendBasicTurn(makeProvider());

    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(latestResult(events)).toMatchObject({
      type: 'result',
      text: '_Tool loop limit reached - please try again or send /new._',
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it('omits env keys when no API key is configured', () => {
    expect(new OpenAIApiProvider().buildEnv()).toEqual({});
    expect(new AnthropicApiProvider().buildEnv()).toEqual({});
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s maps non-Error fetch rejections to the bounded connection result', async (_name, makeProvider) => {
    fetchMock.mockRejectedValueOnce('socket reset');

    const events = await sendBasicTurn(makeProvider());

    expect(latestResult(events)).toMatchObject({
      type: 'result',
      text: '_Connection error - please try again._',
    });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s handles unreadable HTTP error bodies without leaking provider text', async (_name, makeProvider) => {
    const unreadable = new Response(null, { status: 503 });
    vi.spyOn(unreadable, 'text').mockRejectedValueOnce(new Error('body read failed'));
    fetchMock.mockResolvedValueOnce(unreadable);

    const events = await sendBasicTurn(makeProvider());

    expect(latestResult(events)).toMatchObject({
      type: 'result',
      text: '_Service temporarily unavailable - please try again in a moment._',
    });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ])('%s trims oversized message histories before provider calls', async (_name, makeProvider) => {
    fetchMock.mockImplementation(async () => makeSseResponse(['[DONE]']));
    const provider = makeProvider();
    await initializeProvider(provider);

    for (let i = 0; i < 150; i++) {
      await provider.sendTurn({
        role: 'user',
        conversationKey: 'chat-key',
        parts: [{ kind: 'text', text: `history turn ${i}` }],
      });
    }

    expect(fetchMock).toHaveBeenCalledTimes(150);
    // Load-bearing trim proof: 150 turns far exceed MAX_HISTORY_MESSAGES (100), so the
    // retained history must STABILIZE near the cap (~100) instead of growing to 150.
    // A trim regression would let messageCount climb with the turn count.
    expect(provider.getCheckpoint().providerState?.messageCount).toBeLessThanOrEqual(102);
  });

  it('openai-api tolerates split, sparse, and empty tool-call deltas', async () => {
    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_split',
                type: 'function',
                function: { name: 'loop_tool' },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '' } },
                { index: 1 },
              ],
            },
          }],
        },
        { usage: { prompt_tokens: 'not-a-number', completion_tokens: 'not-a-number' } },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeOpenAiTextResponse('recovered'));

    const events = await sendBasicTurn(new OpenAIApiProvider());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      isError: true,
      content: 'Tool "loop_tool" failed: MCP bridge not configured',
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'assistant_text', text: 'recovered' }));
  });

  it('anthropic-api tolerates incomplete SSE blocks and cache-token usage fields', async () => {
    fetchMock.mockResolvedValueOnce(makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      },
      { type: 'content_block_start', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'metadata' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } },
      { type: 'content_block_delta', index: 3 },
      { type: 'content_block_delta', index: 4, delta: { type: 'text_delta', text: '' } },
      { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_delta', index: 6, delta: { type: 'unknown_delta' } },
      { type: 'message_delta', usage: {} },
      { type: 'message_stop' },
    ]));

    const events = await sendBasicTurn(new AnthropicApiProvider());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latestResult(events)).toMatchObject({
      type: 'result',
      text: null,
      inputTokens: 6,
      outputTokens: undefined,
    });
  });

  it('guards internal API calls before initialization', async () => {
    await expect((new OpenAIApiProvider() as unknown as { callApi(model: string): Promise<unknown> })
      .callApi('gpt-test')).rejects.toThrow(/not initialized/i);
    await expect((new AnthropicApiProvider() as unknown as { callApi(model: string): Promise<unknown> })
      .callApi('claude-test')).rejects.toThrow(/not initialized/i);
  });

  it('openai-api blocks null tool arguments without executing a bridge call', async () => {
    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_null',
                type: 'function',
                function: { name: 'null_tool', arguments: 'null' },
              }],
            },
          }],
        },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeOpenAiTextResponse('after null'));

    const events = await sendBasicTurn(new OpenAIApiProvider());

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolId: 'call_null',
      isError: true,
      content: 'Tool "null_tool" failed: provider tool arguments must be a JSON object; the tool was not executed.',
    }));
  });

  it('anthropic-api covers nullish SSE deltas, empty inputs, and null tool arguments', async () => {
    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        { type: 'message_start', message: { usage: { output_tokens: 0 } } },
        { type: 'content_block_delta', index: 99, delta: { type: 'text_delta', text: 'loose text' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_empty', name: 'empty_tool' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_null', name: 'null_tool' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'null' } },
        { type: 'message_stop' },
      ]))
      .mockResolvedValueOnce(makeAnthropicTextResponse('after null'));

    const events = await sendBasicTurn(new AnthropicApiProvider());

    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant_text',
      text: 'loose text',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolId: 'toolu_empty',
      isError: true,
      content: 'Tool "empty_tool" failed: MCP bridge not configured',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolId: 'toolu_null',
      isError: true,
      content: 'Tool "null_tool" failed: provider tool arguments must be a JSON object; the tool was not executed.',
    }));
  });

  it('anthropic-api defensively parses tool input when the accumulated parse result is absent', async () => {
    const provider = new AnthropicApiProvider();
    const events: AgentEvent[] = [];
    await initializeProvider(provider, events);

    vi.spyOn(provider as unknown as {
      callApi(model: string): Promise<unknown>;
    }, 'callApi')
      .mockResolvedValueOnce({
        text: '',
        toolUses: [{
          id: 'toolu_unparsed',
          name: 'missing_bridge_tool',
          inputJson: '{"value":"late-parse"}',
        }],
        inputTokens: 3,
        outputTokens: 1,
      })
      .mockResolvedValueOnce({ text: '', terminalResultText: 'done' });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'late parse' }],
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use',
      toolId: 'toolu_unparsed',
      toolInput: { value: 'late-parse' },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolId: 'toolu_unparsed',
      isError: true,
      content: 'Tool "missing_bridge_tool" failed: MCP bridge not configured',
    }));
  });
});
