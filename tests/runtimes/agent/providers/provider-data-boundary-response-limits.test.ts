import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderDataBoundary } from '../../../../src/core/provider-data-boundary.ts';
import type { ProviderBoundaryEvent } from '../../../../src/core/provider-data-boundary.ts';
import { PROVIDER_DATA_POLICY_VERSION } from '../../../../src/core/provider-data-policy.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import type {
  ProviderMcpBridge,
  ProviderSession,
  ProviderSessionOptions,
} from '../../../../src/runtimes/agent/providers/types.ts';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';

type ManagedProvider = 'openai-api' | 'anthropic-api';

const PROVIDERS = [
  ['openai-api', () => new OpenAIApiProvider()],
  ['anthropic-api', () => new AnthropicApiProvider()],
] as const;
const TERMINATION_CASES = PROVIDERS.flatMap(([providerName, makeProvider]) => (
  (['eof', 'malformed', 'stream_error'] as const).map((termination) => ({
    providerName,
    makeProvider,
    termination,
  }))
));
const OVERFLOW_CASES = PROVIDERS.flatMap(([providerName, makeProvider]) => (
  (['response', 'text', 'tool_arguments', 'tool_calls'] as const).map((overflow) => ({
    providerName,
    makeProvider,
    overflow,
  }))
));
const SHADOW_CASES = PROVIDERS.flatMap(([providerName, makeProvider]) => (
  (['missing_terminal', 'text_overflow'] as const).map((failure) => ({
    providerName,
    makeProvider,
    failure,
  }))
));
const MALFORMED_FRAME_CASES = PROVIDERS.flatMap(([providerName, makeProvider]) => (
  ([
    ['malformed_json', '{"broken":'],
    ['malformed_tool_fragment', '{"choices":[{"delta":{"tool_calls":['],
    ['whitespace', ' \t '],
    ['unexpected_json_value', 'null'],
    ['unexpected_marker', providerName === 'openai-api' ? '[DONE] ' : '[DONE]'],
  ] as const).map(([failure, malformedFrame]) => ({
    providerName,
    makeProvider,
    failure,
    malformedFrame,
  }))
));
const MIB = 1024 * 1024;

function entropy(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (call * 19 + index) % 256);
  };
}

function initOptions(
  provider: ManagedProvider,
  events: AgentEvent[],
  mcpBridge: ProviderMcpBridge,
  mode: 'shadow' | 'enforce' = 'enforce',
  boundaryEvents: ProviderBoundaryEvent[] = [],
): ProviderSessionOptions {
  const model = provider === 'openai-api' ? 'gpt-test' : 'claude-test';
  const providerSessionId = `${provider}-response-budget-session`;
  return {
    cwd: '/workspace/LAB/WhatSoup',
    systemPrompt: 'System prompt',
    model,
    routePolicy: Object.freeze({
      provider,
      model,
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
      policyState: 'classified',
    }),
    providerBoundaryMode: mode,
    providerSessionId,
    providerDataBoundary: createProviderDataBoundary({
      binding: {
        provider,
        model,
        dataPolicy: 'restricted',
        policyVersion: PROVIDER_DATA_POLICY_VERSION,
        providerSessionId,
      },
      mode,
      routeSource: 'configured',
      entropy: entropy(),
      eventSink: (event) => boundaryEvents.push(event),
    }),
    instanceName: 'boundary-response-budget-test',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
    mcpBridge,
  };
}

function encodeData(data: string): Uint8Array {
  return new TextEncoder().encode(`data: ${data}\n\n`);
}

function sseResponse(data: readonly string[]): Response {
  return new Response(data.map((item) => `data: ${item}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function pullDrivenSseResponse(data: readonly string[], pulls: { count: number }): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= data.length) {
        controller.close();
        return;
      }
      pulls.count += 1;
      controller.enqueue(encodeData(data[index++]!));
    },
  }, { highWaterMark: 0 });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function streamErrorResponse(data: readonly string[]): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < data.length) {
        controller.enqueue(encodeData(data[index++]!));
        return;
      }
      controller.error(new Error('synthetic restricted stream failure'));
    },
  }, { highWaterMark: 0 }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function terminalData(provider: ManagedProvider): string {
  return provider === 'openai-api'
    ? '[DONE]'
    : JSON.stringify({ type: 'message_stop' });
}

function validFinalResponse(provider: ManagedProvider): Response {
  return provider === 'openai-api'
    ? sseResponse([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'complete' } }] }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        terminalData(provider),
      ])
    : sseResponse([
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        }),
        terminalData(provider),
      ]);
}

function provisionalToolResponseData(provider: ManagedProvider): string[] {
  return provider === 'openai-api'
    ? [JSON.stringify({ choices: [{ index: 0, delta: {
        content: 'provisional text',
        tool_calls: [{
          index: 0,
          id: 'provisional-call',
          type: 'function',
          function: { name: 'noop', arguments: '{}' },
        }],
      } }] })]
    : [
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'provisional text' } }),
        JSON.stringify({ type: 'content_block_stop', index: 0 }),
        JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'provisional-call', name: 'noop' } }),
        JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        JSON.stringify({ type: 'content_block_stop', index: 1 }),
      ];
}

function overflowData(provider: ManagedProvider, overflow: 'response' | 'text' | 'tool_arguments' | 'tool_calls'): string[] {
  if (overflow === 'response') {
    const frames = Array.from({ length: 520 }, () => `${' '.repeat(4096)}${JSON.stringify(provider === 'openai-api'
      ? { choices: [], usage: {} }
      : { type: 'ping' })}`);
    return provider === 'openai-api'
      ? frames
      : [
          JSON.stringify({
            type: 'message_start',
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          }),
          ...frames,
        ];
  }
  if (overflow === 'text') {
    // Each fragment is below the character limit but their aggregate UTF-8
    // representation exceeds one MiB.
    const text = 'é'.repeat(Math.floor(MIB / 4) + 1);
    return provider === 'openai-api'
      ? [
          JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }),
        ]
      : [
          JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
          JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
          JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
        ];
  }
  if (overflow === 'tool_arguments') {
    // JSON.stringify preserves this character, so the raw string stays below
    // the character limit while its UTF-8 representation exceeds one MiB.
    const rawArguments = JSON.stringify({ value: 'é'.repeat(Math.floor(MIB / 2) + 1) });
    const splitAt = Math.floor(rawArguments.length / 2);
    const fragments = [rawArguments.slice(0, splitAt), rawArguments.slice(splitAt)];
    return provider === 'openai-api'
      ? fragments.map((argumentsFragment, index) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          ...(index === 0 ? { id: 'oversized-call', type: 'function', function: { name: 'noop', arguments: argumentsFragment } } : { function: { arguments: argumentsFragment } }),
        }] } }] }))
      : [
          JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
          JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'oversized-call', name: 'noop' } }),
          ...fragments.map((partialJson) => JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: partialJson },
          })),
        ];
  }
  return provider === 'openai-api'
    ? Array.from({ length: 1025 }, (_, index) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
        index,
        id: `call-${index}`,
        type: 'function',
        function: { name: 'noop', arguments: '{}' },
      }] } }] }))
    : [
        JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
        ...Array.from({ length: 1025 }, (_, index) => [
          JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: `call-${index}`, name: 'noop' },
          }),
          JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          }),
          JSON.stringify({ type: 'content_block_stop', index }),
        ]).flat(),
      ];
}

function bridge(executeTool: ProviderMcpBridge['executeTool']): ProviderMcpBridge {
  return {
    listTools: () => [{
      name: 'noop',
      description: 'No operation',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        additionalProperties: false,
      },
    }],
    executeTool,
  };
}

async function send(provider: ProviderSession): Promise<void> {
  await provider.sendTurn({
    role: 'user',
    conversationKey: 'response-budget-chat',
    parts: [{ kind: 'text', text: 'respond safely' }],
  });
}

describe('restricted managed-provider response completion and aggregate budgets', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(TERMINATION_CASES)(
    'requires a valid terminal marker before committing a restricted $providerName $termination response',
    async ({ providerName, makeProvider, termination }) => {
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'must not run',
        isError: false,
      }));
      const data = provisionalToolResponseData(providerName);
      const firstResponse = termination === 'stream_error'
        ? streamErrorResponse(data)
        : sseResponse(termination === 'malformed'
          ? [...data, providerName === 'openai-api' ? '[DONE' : '{"type":"message_stop"']
          : data);
      fetchMock
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(validFinalResponse(providerName));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, bridge(executeTool)));

      await expect(send(provider)).rejects.toBeInstanceOf(Error);

      expect(executeTool).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
      expect(provider.getCheckpoint().providerState?.['messageCount'])
        .toBe(providerName === 'openai-api' ? 2 : 1);
    },
  );

  it.each(OVERFLOW_CASES)(
    'rejects incremental restricted $providerName $overflow overflow atomically',
    async ({ providerName, makeProvider, overflow }) => {
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'must not run',
        isError: false,
      }));
      const data = [...overflowData(providerName, overflow), terminalData(providerName)];
      const pulls = { count: 0 };
      fetchMock
        .mockResolvedValueOnce(pullDrivenSseResponse(data, pulls))
        .mockResolvedValueOnce(validFinalResponse(providerName));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, bridge(executeTool)));

      await expect(send(provider)).rejects.toMatchObject({ code: 'limit_exceeded' });

      expect(pulls.count).toBeLessThan(data.length);
      expect(executeTool).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
      expect(provider.getCheckpoint().providerState?.['messageCount'])
        .toBe(providerName === 'openai-api' ? 2 : 1);
    },
  );

  it.each(MALFORMED_FRAME_CASES)(
    'rejects restricted $providerName $failure atomically between provisional content and a valid terminal',
    async ({ providerName, makeProvider, malformedFrame }) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'must not run',
        isError: false,
      }));
      fetchMock.mockResolvedValueOnce(sseResponse([
        ...provisionalToolResponseData(providerName),
        malformedFrame,
        terminalData(providerName),
      ]));
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        bridge(executeTool),
        'enforce',
        boundaryEvents,
      ));

      await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

      expect(executeTool).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
      expect(boundaryEvents).toContainEqual(expect.objectContaining({
        eventType: 'rehydration_failure',
        success: 0,
      }));
      expect(provider.getCheckpoint().providerState?.['messageCount'])
        .toBe(providerName === 'openai-api' ? 2 : 1);
    },
  );

  it.each(MALFORMED_FRAME_CASES)(
    'observes restricted shadow $providerName $failure while preserving response behavior',
    async ({ providerName, makeProvider, malformedFrame }) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'shadow tool result',
        isError: false,
      }));
      fetchMock
        .mockResolvedValueOnce(sseResponse([
          ...provisionalToolResponseData(providerName),
          malformedFrame,
          terminalData(providerName),
        ]))
        .mockResolvedValueOnce(validFinalResponse(providerName));
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        bridge(executeTool),
        'shadow',
        boundaryEvents,
      ));

      await expect(send(provider)).resolves.toBeUndefined();

      expect(executeTool).toHaveBeenCalledOnce();
      expect(events).toContainEqual(expect.objectContaining({
        type: 'assistant_text',
        text: 'provisional text',
      }));
      expect(events.some((event) => event.type === 'tool_use')).toBe(true);
      expect(events.some((event) => event.type === 'tool_result')).toBe(true);
      expect(events.some((event) => event.type === 'result')).toBe(true);
      expect(boundaryEvents).toContainEqual(expect.objectContaining({
        eventType: 'rehydration_failure',
        success: 0,
      }));
    },
  );

  it.each(PROVIDERS)(
    'counts raw restricted $providerName SSE payload bytes before trimming or parsing',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'must not run',
        isError: false,
      }));
      const payload = providerName === 'openai-api'
        ? JSON.stringify({ choices: [], usage: {} })
        : JSON.stringify({ type: 'ping' });
      const paddedFrames = Array.from({ length: 520 }, () => `${' '.repeat(4096)}${payload}`);
      const pulls = { count: 0 };
      fetchMock.mockResolvedValueOnce(pullDrivenSseResponse(
        [
          ...(providerName === 'anthropic-api'
            ? [JSON.stringify({
                type: 'message_start',
                message: { usage: { input_tokens: 1, output_tokens: 0 } },
              })]
            : []),
          ...paddedFrames,
          terminalData(providerName),
        ],
        pulls,
      ));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, bridge(executeTool)));

      await expect(send(provider)).rejects.toMatchObject({ code: 'limit_exceeded' });

      expect(pulls.count).toBeLessThanOrEqual(paddedFrames.length);
      expect(executeTool).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
    },
  );

  it.each(SHADOW_CASES)(
    'records restricted shadow $providerName $failure without enforcing it',
    async ({ providerName, makeProvider, failure }) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async (_name: string, _params: Record<string, unknown>) => ({
        content: 'shadow tool result',
        isError: false,
      }));
      const firstData = failure === 'missing_terminal'
        ? provisionalToolResponseData(providerName)
        : [...overflowData(providerName, 'text'), terminalData(providerName)];
      fetchMock.mockResolvedValueOnce(sseResponse(firstData));
      if (failure === 'missing_terminal') {
        fetchMock.mockResolvedValueOnce(validFinalResponse(providerName));
      }
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        bridge(executeTool),
        'shadow',
        boundaryEvents,
      ));

      await expect(send(provider)).resolves.toBeUndefined();

      expect(executeTool).toHaveBeenCalledTimes(failure === 'missing_terminal' ? 1 : 0);
      expect(events.some((event) => event.type === 'assistant_text')).toBe(true);
      expect(events.some((event) => event.type === 'result')).toBe(true);
      expect(boundaryEvents).toContainEqual(expect.objectContaining({
        eventType: 'rehydration_failure',
        success: 0,
      }));
    },
  );
});
