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

function entropy(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (call * 29 + index) % 256);
  };
}

function bridge(): ProviderMcpBridge {
  return {
    listTools: () => [],
    executeTool: vi.fn(async () => ({ content: 'must not run', isError: false })),
  };
}

function initOptions(
  provider: ManagedProvider,
  events: AgentEvent[],
  mode: 'shadow' | 'enforce' = 'enforce',
  boundaryEvents: ProviderBoundaryEvent[] = [],
): ProviderSessionOptions {
  const model = provider === 'openai-api' ? 'gpt-test' : 'claude-test';
  const providerSessionId = `${provider}-terminal-grammar`;
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
    instanceName: 'terminal-grammar-test',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
    mcpBridge: bridge(),
  };
}

function data(value: unknown): string {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return `data: ${payload}\n`;
}

function response(records: readonly string[]): Response {
  return new Response(records.join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const OPENAI_START = data({
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  service_tier: 'default',
  system_fingerprint: null,
  choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
});
const OPENAI_TEXT = data({
  choices: [{ index: 0, delta: { content: 'complete' }, finish_reason: null }],
});
const OPENAI_FINISH = data({
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
});
const OPENAI_DONE = data('[DONE]');

const ANTHROPIC_START = data({
  type: 'message_start',
  message: {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  },
});
const ANTHROPIC_BLOCK_START = data({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
});
const ANTHROPIC_TEXT = data({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text: 'complete' },
});
const ANTHROPIC_BLOCK_STOP = data({ type: 'content_block_stop', index: 0 });
const ANTHROPIC_DELTA = data({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn', stop_sequence: null },
  usage: { output_tokens: 1 },
});
const ANTHROPIC_STOP = data({ type: 'message_stop' });

const INVALID_STREAMS: ReadonlyArray<{
  provider: ManagedProvider;
  failure: string;
  records: readonly string[];
}> = [
  {
    provider: 'openai-api',
    failure: 'event name attached to DONE',
    records: [OPENAI_START, OPENAI_FINISH, 'event: done', OPENAI_DONE],
  },
  {
    provider: 'openai-api',
    failure: 'DONE without a choice lifecycle',
    records: [OPENAI_DONE],
  },
  {
    provider: 'openai-api',
    failure: 'unsupported choice index',
    records: [
      data({ choices: [{ index: 1, delta: { content: 'wrong' }, finish_reason: null }] }),
      OPENAI_FINISH,
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'multiple choices',
    records: [
      data({
        choices: [
          { index: 0, delta: { content: 'first' }, finish_reason: null },
          { index: 1, delta: { content: 'second' }, finish_reason: null },
        ],
      }),
      OPENAI_FINISH,
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'unfinished choice at DONE',
    records: [OPENAI_START, OPENAI_TEXT, OPENAI_DONE],
  },
  {
    provider: 'openai-api',
    failure: 'content after finish',
    records: [OPENAI_START, OPENAI_FINISH, OPENAI_TEXT, OPENAI_DONE],
  },
  {
    provider: 'openai-api',
    failure: 'unrecognized finish reason',
    records: [
      OPENAI_START,
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'arbitrary' }] }),
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'ignored logprobs payload',
    records: [
      OPENAI_START,
      data({
        choices: [{
          index: 0,
          delta: { content: 'ignored' },
          logprobs: { content: [{ token: 'leak' }] },
          finish_reason: null,
        }],
      }),
      OPENAI_FINISH,
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'invalid envelope metadata type',
    records: [
      data({ object: 7, choices: [{ index: 0, delta: { content: 'wrong' }, finish_reason: null }] }),
      OPENAI_FINISH,
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'fractional token usage',
    records: [
      OPENAI_START,
      OPENAI_FINISH,
      data({ choices: [], usage: { completion_tokens: 0.5 } }),
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'tool call with non-tool terminal reason',
    records: [
      data({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'noop', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
      }),
      OPENAI_FINISH,
      OPENAI_DONE,
    ],
  },
  {
    provider: 'openai-api',
    failure: 'tool terminal reason without a tool call',
    records: [
      OPENAI_START,
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      OPENAI_DONE,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'nonempty message_start content',
    records: [
      data({
        type: 'message_start',
        message: {
          content: [{ type: 'text', text: 'ignored startup text' }],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      ANTHROPIC_DELTA,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'initial text payload',
    records: [
      ANTHROPIC_START,
      data({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ignored' } }),
      ANTHROPIC_BLOCK_STOP,
      ANTHROPIC_DELTA,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'initial tool input payload',
    records: [
      ANTHROPIC_START,
      data({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'noop', input: { hidden: true } },
      }),
      data({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      ANTHROPIC_BLOCK_STOP,
      ANTHROPIC_DELTA,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'message_stop without message_delta',
    records: [ANTHROPIC_START, ANTHROPIC_STOP],
  },
  {
    provider: 'anthropic-api',
    failure: 'content blocks followed by no message_delta',
    records: [
      ANTHROPIC_START,
      ANTHROPIC_BLOCK_START,
      ANTHROPIC_TEXT,
      ANTHROPIC_BLOCK_STOP,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'unrecognized stop reason',
    records: [
      ANTHROPIC_START,
      data({
        type: 'message_delta',
        delta: { stop_reason: 'arbitrary', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'empty terminal delta',
    records: [
      ANTHROPIC_START,
      data({ type: 'message_delta', delta: {}, usage: { output_tokens: 1 } }),
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'invalid message metadata type',
    records: [
      data({
        type: 'message_start',
        message: { id: 7, content: [], usage: { input_tokens: 1, output_tokens: 0 } },
      }),
      ANTHROPIC_DELTA,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'stop sequence paired with the wrong reason',
    records: [
      ANTHROPIC_START,
      data({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: 'ignored' },
        usage: { output_tokens: 1 },
      }),
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'tool use with non-tool stop reason',
    records: [
      ANTHROPIC_START,
      data({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-1', name: 'noop', input: {} },
      }),
      data({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      ANTHROPIC_BLOCK_STOP,
      ANTHROPIC_DELTA,
      ANTHROPIC_STOP,
    ],
  },
  {
    provider: 'anthropic-api',
    failure: 'tool stop reason without a tool use',
    records: [
      ANTHROPIC_START,
      data({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      ANTHROPIC_STOP,
    ],
  },
];

async function send(provider: ProviderSession): Promise<void> {
  await provider.sendTurn({
    role: 'user',
    conversationKey: 'terminal-grammar-chat',
    parts: [{ kind: 'text', text: 'respond safely' }],
  });
}

describe('restricted managed-provider terminal and nested grammar', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(INVALID_STREAMS)(
    'atomically rejects $provider $failure',
    async ({ provider, records }) => {
      const events: AgentEvent[] = [];
      fetchMock.mockResolvedValueOnce(response(records));
      const session = provider === 'openai-api'
        ? new OpenAIApiProvider()
        : new AnthropicApiProvider();
      await session.initialize(initOptions(provider, events));

      await expect(send(session)).rejects.toMatchObject({ code: 'invalid_provider_response' });

      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
      expect(session.getCheckpoint().providerState?.['messageCount'])
        .toBe(provider === 'openai-api' ? 2 : 1);
    },
  );

  it.each(PROVIDERS)(
    'accepts a complete official $provider lifecycle and emits only validated choice content',
    async (provider, makeProvider) => {
      const events: AgentEvent[] = [];
      const records = provider === 'openai-api'
        ? [
            OPENAI_START,
            OPENAI_TEXT,
            OPENAI_FINISH,
            data({
              service_tier: null,
              choices: [],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            }),
            OPENAI_DONE,
          ]
        : [
            ANTHROPIC_START,
            ANTHROPIC_BLOCK_START,
            ANTHROPIC_TEXT,
            ANTHROPIC_BLOCK_STOP,
            ANTHROPIC_DELTA,
            ANTHROPIC_STOP,
          ];
      fetchMock.mockResolvedValueOnce(response(records));
      const session = makeProvider();
      await session.initialize(initOptions(provider, events));

      await expect(send(session)).resolves.toBeUndefined();

      expect(events).toContainEqual({ type: 'assistant_text', text: 'complete' });
    },
  );

  it.each(PROVIDERS)(
    'records invalid $provider terminal grammar in shadow without changing legacy output',
    async (provider, makeProvider) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const records = provider === 'openai-api'
        ? [OPENAI_START, OPENAI_FINISH, OPENAI_TEXT, OPENAI_DONE]
        : [
            ANTHROPIC_START,
            ANTHROPIC_BLOCK_START,
            ANTHROPIC_TEXT,
            ANTHROPIC_BLOCK_STOP,
            ANTHROPIC_STOP,
          ];
      fetchMock.mockResolvedValueOnce(response(records));
      const session = makeProvider();
      await session.initialize(initOptions(provider, events, 'shadow', boundaryEvents));

      await expect(send(session)).resolves.toBeUndefined();

      expect(events).toContainEqual({ type: 'assistant_text', text: 'complete' });
      expect(boundaryEvents.filter((event) => event.eventType === 'rehydration_failure'))
        .toHaveLength(1);
    },
  );

  it.each(PROVIDERS)(
    'preserves exact $provider assistant chunk order and granularity in shadow',
    async (provider, makeProvider) => {
      const events: AgentEvent[] = [];
      const records = provider === 'openai-api'
        ? [
            OPENAI_START,
            data({ choices: [{ index: 0, delta: { content: 'first-' }, finish_reason: null }] }),
            data({ choices: [{ index: 0, delta: { content: 'second' }, finish_reason: null }] }),
            OPENAI_FINISH,
            OPENAI_DONE,
          ]
        : [
            ANTHROPIC_START,
            ANTHROPIC_BLOCK_START,
            data({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'first-' },
            }),
            data({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'second' },
            }),
            ANTHROPIC_BLOCK_STOP,
            ANTHROPIC_DELTA,
            ANTHROPIC_STOP,
          ];
      fetchMock.mockResolvedValueOnce(response(records));
      const session = makeProvider();
      await session.initialize(initOptions(provider, events, 'shadow'));

      await expect(send(session)).resolves.toBeUndefined();

      expect(events.filter((event) => event.type === 'assistant_text')).toEqual([
        { type: 'assistant_text', text: 'first-' },
        { type: 'assistant_text', text: 'second' },
      ]);
    },
  );

  it.each(PROVIDERS)(
    'emits one constrained $provider failure decision when the response body is missing',
    async (provider, makeProvider) => {
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
      const session = makeProvider();
      await session.initialize(initOptions(provider, events, 'enforce', boundaryEvents));

      await expect(send(session)).resolves.toBeUndefined();

      expect(events).toContainEqual(expect.objectContaining({
        type: 'result',
        text: 'No response body',
      }));
      expect(boundaryEvents.filter((event) => event.eventType === 'rehydration_failure'))
        .toHaveLength(1);
    },
  );
});
