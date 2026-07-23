import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProviderDataBoundary,
  type ProviderBoundaryEvent,
} from '../../../../src/core/provider-data-boundary.ts';
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

const CLOSED_GRAMMAR_CASES = PROVIDERS.flatMap(([providerName, makeProvider]) => {
  const cases = providerName === 'openai-api'
    ? [
        ['empty_object', JSON.stringify({})],
        ['unknown_event', JSON.stringify({ type: 'mystery' })],
        ['duplicate_envelope_key', '{"choices":[],"choices":[],"usage":{}}'],
        ['unknown_nested_field', JSON.stringify({ choices: [{ index: 0, delta: { content: 'x', mystery: true } }] })],
        ['wrong_text_type', JSON.stringify({ choices: [{ delta: { content: 7 } }] })],
        ['wrong_tool_type', JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: '0' }] } }] })],
        ['partial_tool', JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] })],
      ]
    : [
        ['empty_object', JSON.stringify({})],
        ['unknown_event', JSON.stringify({ type: 'mystery' })],
        ['duplicate_envelope_key', '{"type":"ping","type":"ping"}'],
        ['unknown_nested_field', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x', mystery: true } })],
        ['text_without_start', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } })],
        ['wrong_tool_type', JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 7 } })],
        ['partial_tool', JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'noop' } })],
      ];
  return cases.map(([failure, frame]) => ({ providerName, makeProvider, failure, frame }));
});

const NON_DATA_LINES = [
  ['comment', ': keepalive'],
  ['event', 'event: message'],
  ['id', 'id: 7'],
  ['garbage', 'not-sse'],
] as const;

function entropy(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (call * 23 + index) % 256);
  };
}

function bridge(executeTool = vi.fn(async () => ({ content: 'ok', isError: false }))): ProviderMcpBridge {
  return {
    listTools: () => [{
      name: 'noop',
      description: 'No operation',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    }],
    executeTool,
  };
}

function initOptions(
  provider: ManagedProvider,
  events: AgentEvent[],
  mode: 'shadow' | 'enforce' = 'enforce',
  boundaryEvents: ProviderBoundaryEvent[] = [],
  mcpBridge: ProviderMcpBridge = bridge(),
): ProviderSessionOptions {
  const model = provider === 'openai-api' ? 'gpt-test' : 'claude-test';
  const providerSessionId = `${provider}-closed-stream-session`;
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
    instanceName: 'closed-stream-test',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
    mcpBridge,
  };
}

function rawSseResponse(records: readonly string[]): Response {
  return new Response(records.join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function dataRecord(data: string): string {
  return `data: ${data}\n`;
}

function validRecords(provider: ManagedProvider, text = 'complete'): string[] {
  return provider === 'openai-api'
    ? [
        dataRecord(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })),
        dataRecord(JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })),
        dataRecord(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
        dataRecord('[DONE]'),
      ]
    : [
        dataRecord(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })),
        dataRecord(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
        dataRecord(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
        dataRecord(JSON.stringify({ type: 'content_block_stop', index: 0 })),
        dataRecord(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })),
        dataRecord(JSON.stringify({ type: 'message_stop' })),
      ];
}

function hostileRecords(provider: ManagedProvider, hostileFrame: string): string[] {
  const valid = validRecords(provider);
  return [valid[0]!, dataRecord(hostileFrame), ...valid.slice(1)];
}

async function send(provider: ProviderSession): Promise<void> {
  await provider.sendTurn({
    role: 'user',
    conversationKey: 'closed-stream-chat',
    parts: [{ kind: 'text', text: 'respond safely' }],
  });
}

function expectAtomicFailure(
  providerName: ManagedProvider,
  provider: ProviderSession,
  events: readonly AgentEvent[],
  executeTool: ReturnType<typeof vi.fn>,
): void {
  expect(executeTool).not.toHaveBeenCalled();
  expect(events.filter((event) => event.type !== 'init')).toEqual([]);
  expect(provider.getCheckpoint().providerState?.['messageCount'])
    .toBe(providerName === 'openai-api' ? 2 : 1);
}

describe('restricted managed-provider closed SSE grammar', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(CLOSED_GRAMMAR_CASES)(
    'rejects restricted $providerName $failure before response commit',
    async ({ providerName, makeProvider, frame }) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      fetchMock.mockResolvedValueOnce(rawSseResponse(hostileRecords(providerName, frame)));
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        'enforce',
        boundaryEvents,
        bridge(executeTool),
      ));

      await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

      expectAtomicFailure(providerName, provider, events, executeTool);
      expect(boundaryEvents).toContainEqual(expect.objectContaining({
        eventType: 'rehydration_failure',
        success: 0,
      }));
    },
  );

  it.each(PROVIDERS.flatMap(([providerName, makeProvider]) => (
    NON_DATA_LINES.map(([failure, line]) => ({ providerName, makeProvider, failure, line }))
  )))(
    'rejects parser-discarded restricted $providerName $failure lines atomically',
    async ({ providerName, makeProvider, line }) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      const records = validRecords(providerName);
      fetchMock.mockResolvedValueOnce(rawSseResponse([records[0]!, line, '', ...records.slice(1)]));
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        'enforce',
        boundaryEvents,
        bridge(executeTool),
      ));

      await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

      expectAtomicFailure(providerName, provider, events, executeTool);
      expect(boundaryEvents).toContainEqual(expect.objectContaining({ eventType: 'rehydration_failure' }));
    },
  );

  it('rejects Anthropic content blocks before message_start', async () => {
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
    fetchMock.mockResolvedValueOnce(rawSseResponse([
      dataRecord(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
      dataRecord(JSON.stringify({ type: 'content_block_stop', index: 0 })),
      ...validRecords('anthropic-api'),
    ]));
    const provider = new AnthropicApiProvider();
    await provider.initialize(initOptions(
      'anthropic-api',
      events,
      'enforce',
      [],
      bridge(executeTool),
    ));

    await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

    expectAtomicFailure('anthropic-api', provider, events, executeTool);
  });

  it('rejects non-monotonic Anthropic content block indices', async () => {
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
    fetchMock.mockResolvedValueOnce(rawSseResponse([
      dataRecord(JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1 } } })),
      dataRecord(JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })),
      dataRecord(JSON.stringify({ type: 'content_block_stop', index: 1 })),
      dataRecord(JSON.stringify({ type: 'message_stop' })),
    ]));
    const provider = new AnthropicApiProvider();
    await provider.initialize(initOptions(
      'anthropic-api',
      events,
      'enforce',
      [],
      bridge(executeTool),
    ));

    await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

    expectAtomicFailure('anthropic-api', provider, events, executeTool);
  });

  it('accepts matching Anthropic named SSE event lines', async () => {
    const events: AgentEvent[] = [];
    fetchMock.mockResolvedValueOnce(rawSseResponse([
      'event: message_start',
      dataRecord(JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 1, output_tokens: 0 } },
      })),
      'event: content_block_start',
      dataRecord(JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })),
      'event: content_block_delta',
      dataRecord(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'named complete' } })),
      'event: content_block_stop',
      dataRecord(JSON.stringify({ type: 'content_block_stop', index: 0 })),
      'event: message_stop',
      dataRecord(JSON.stringify({ type: 'message_stop' })),
    ]));
    const provider = new AnthropicApiProvider();
    await provider.initialize(initOptions('anthropic-api', events));

    await expect(send(provider)).resolves.toBeUndefined();

    expect(events).toContainEqual({ type: 'assistant_text', text: 'named complete' });
  });

  it('accepts current typed provider usage detail objects in restricted streams', async () => {
    const openAiEvents: AgentEvent[] = [];
    const anthropicEvents: AgentEvent[] = [];
    fetchMock
      .mockResolvedValueOnce(rawSseResponse([
        dataRecord(JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
            prompt_tokens_details: { cached_tokens: 1, audio_tokens: 0 },
            completion_tokens_details: {
              accepted_prediction_tokens: 0,
              audio_tokens: 0,
              reasoning_tokens: 1,
              rejected_prediction_tokens: 0,
            },
          },
        })),
        ...validRecords('openai-api'),
      ]))
      .mockResolvedValueOnce(rawSseResponse([
        dataRecord(JSON.stringify({
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 2,
              output_tokens: 0,
              cache_creation_input_tokens: 1,
              cache_read_input_tokens: 1,
              cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
            },
          },
        })),
        dataRecord(JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1, server_tool_use: { web_search_requests: 0 } },
        })),
        dataRecord(JSON.stringify({ type: 'message_stop' })),
      ]));
    const openAi = new OpenAIApiProvider();
    const anthropic = new AnthropicApiProvider();
    await openAi.initialize(initOptions('openai-api', openAiEvents));
    await anthropic.initialize(initOptions('anthropic-api', anthropicEvents));

    await expect(send(openAi)).resolves.toBeUndefined();
    await expect(send(anthropic)).resolves.toBeUndefined();
  });

  it.each(PROVIDERS)(
    'observes invalid restricted shadow $providerName frames while preserving the response',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      fetchMock.mockResolvedValueOnce(rawSseResponse([
        dataRecord(JSON.stringify(providerName === 'openai-api' ? {} : { type: 'mystery' })),
        'event: discarded-by-legacy-parser',
        '',
        ...validRecords(providerName, 'shadow complete'),
      ]));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, 'shadow', boundaryEvents));

      await expect(send(provider)).resolves.toBeUndefined();

      expect(events).toContainEqual(expect.objectContaining({
        type: 'assistant_text',
        text: 'shadow complete',
      }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'result' }));
      expect(boundaryEvents.filter((event) => event.eventType === 'rehydration_failure')).toHaveLength(1);
    },
  );

  it.each(PROVIDERS)(
    'counts every restricted $providerName wire byte including ignored comments before filtering',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 700) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`:${'x'.repeat(4095)}\n`));
        },
      }, { highWaterMark: 0 });
      fetchMock.mockResolvedValueOnce(new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
      const provider = makeProvider();
      await provider.initialize(initOptions(
        providerName,
        events,
        'enforce',
        [],
        bridge(executeTool),
      ));

      await expect(send(provider)).rejects.toMatchObject({ code: 'invalid_provider_response' });

      expect(pulls).toBeLessThan(700);
      expectAtomicFailure(providerName, provider, events, executeTool);
    },
  );

  it.each(PROVIDERS)(
    'records both invalid-line and aggregate-limit shadow decisions for oversized ignored $providerName records',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const oversizedComments = Array.from({ length: 520 }, () => `:${'x'.repeat(4095)}`);
      fetchMock.mockResolvedValueOnce(rawSseResponse([
        ...oversizedComments,
        ...validRecords(providerName, 'shadow complete'),
      ]));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, 'shadow', boundaryEvents));

      await expect(send(provider)).resolves.toBeUndefined();

      expect(events).toContainEqual(expect.objectContaining({
        type: 'assistant_text',
        text: 'shadow complete',
      }));
      expect(boundaryEvents.filter((event) => event.eventType === 'rehydration_failure')).toHaveLength(2);
    },
  );

  it.each(PROVIDERS)(
    'bounds restricted $providerName non-2xx bodies while preserving static error semantics',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 256) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`credential=do-not-surface-${'x'.repeat(65_536)}`));
        },
      }, { highWaterMark: 0 });
      fetchMock.mockResolvedValueOnce(new Response(body, {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events));

      await expect(send(provider)).resolves.toBeUndefined();

      expect(pulls).toBeLessThan(256);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'result',
        text: '_Service temporarily unavailable - please try again in a moment._',
      }));
      expect(JSON.stringify(events)).not.toContain('do-not-surface');
    },
  );

  it.each(PROVIDERS)(
    'bounds trusted $providerName non-2xx body reads without changing its error result',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 256) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`upstream-${'x'.repeat(65_536)}`));
        },
      }, { highWaterMark: 0 });
      fetchMock.mockResolvedValueOnce(new Response(body, {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }));
      const provider = makeProvider();
      await provider.initialize({
        cwd: '/workspace/LAB/WhatSoup',
        systemPrompt: 'System prompt',
        model: providerName === 'openai-api' ? 'gpt-test' : 'claude-test',
        instanceName: 'trusted-error-body-test',
        onEvent: (event) => events.push(event),
        onCrash: vi.fn(),
      });

      await expect(send(provider)).resolves.toBeUndefined();

      expect(pulls).toBeLessThan(256);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'result',
        text: '_Service temporarily unavailable - please try again in a moment._',
      }));
    },
  );

  it.each(PROVIDERS)(
    'keeps trusted $providerName legacy filtering behavior for unknown and non-data records',
    async (providerName, makeProvider) => {
      const events: AgentEvent[] = [];
      fetchMock.mockResolvedValueOnce(rawSseResponse([
        'event: ignored-in-trusted-mode',
        '',
        dataRecord(JSON.stringify(providerName === 'openai-api' ? {} : { type: 'mystery' })),
        ...validRecords(providerName, 'trusted complete'),
      ]));
      const provider = makeProvider();
      await provider.initialize({
        cwd: '/workspace/LAB/WhatSoup',
        systemPrompt: 'System prompt',
        model: providerName === 'openai-api' ? 'gpt-test' : 'claude-test',
        instanceName: 'trusted-closed-stream-test',
        onEvent: (event) => events.push(event),
        onCrash: vi.fn(),
        mcpBridge: bridge(),
      });

      await expect(send(provider)).resolves.toBeUndefined();

      expect(events).toContainEqual(expect.objectContaining({
        type: 'assistant_text',
        text: 'trusted complete',
      }));
    },
  );
});
