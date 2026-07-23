import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderDataBoundary } from '../../../../src/core/provider-data-boundary.ts';
import type { ProviderBoundaryEvent } from '../../../../src/core/provider-data-boundary.ts';
import { MAX_TOOL_NODES } from '../../../../src/core/provider-data-boundary-detection.ts';
import {
  PROVIDER_DATA_POLICY_VERSION,
  type ProviderRoutePolicy,
} from '../../../../src/core/provider-data-policy.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import type {
  ProviderMcpBridge,
  ProviderSession,
  ProviderSessionOptions,
} from '../../../../src/runtimes/agent/providers/types.ts';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';

const restrictedRoute: ProviderRoutePolicy = Object.freeze({
  provider: 'openai-api',
  model: 'gpt-test',
  dataPolicy: 'restricted',
  policyVersion: PROVIDER_DATA_POLICY_VERSION,
  policyState: 'classified',
});

function entropy(): (size: number) => Uint8Array {
  let call = 0;
  return (size) => {
    call += 1;
    return Uint8Array.from({ length: size }, (_, index) => (call * 17 + index) % 256);
  };
}

function broker(
  provider: 'openai-api' | 'anthropic-api',
  sessionId: string,
  boundaryEvents: ProviderBoundaryEvent[] = [],
) {
  return createProviderDataBoundary({
    binding: {
      provider,
      model: provider === 'openai-api' ? 'gpt-test' : 'claude-test',
      dataPolicy: 'restricted',
      policyVersion: PROVIDER_DATA_POLICY_VERSION,
      providerSessionId: sessionId,
    },
    mode: 'enforce',
    routeSource: 'fallback',
    entropy: entropy(),
    eventSink: (event) => boundaryEvents.push(event),
  });
}

function openAiSse(deltas: Array<Record<string, unknown>>): Response {
  const canonical = deltas.map((delta) => {
    if (!Array.isArray(delta['choices'])) return delta;
    return {
      ...delta,
      choices: delta['choices'].map((rawChoice, choiceIndex) => {
        const choice = rawChoice as Record<string, unknown>;
        const rawDelta = choice['delta'] as Record<string, unknown> | undefined;
        const toolCalls = Array.isArray(rawDelta?.['tool_calls'])
          ? rawDelta['tool_calls'].map((rawToolCall) => {
              const toolCall = rawToolCall as Record<string, unknown>;
              return { type: 'function', ...toolCall };
            })
          : undefined;
        return {
          index: choiceIndex,
          ...choice,
          ...(rawDelta ? {
            delta: {
              ...rawDelta,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          } : {}),
        };
      }),
    };
  });
  const complete = canonical.some((chunk) => (
    Array.isArray(chunk['choices'])
    && chunk['choices'].some((rawChoice) => {
      const choice = rawChoice as Record<string, unknown>;
      return typeof choice['finish_reason'] === 'string';
    })
  ))
    ? canonical
    : [...canonical, {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: canonical.some((chunk) => (
            Array.isArray(chunk['choices'])
            && chunk['choices'].some((rawChoice) => {
              const choice = rawChoice as Record<string, unknown>;
              const delta = choice['delta'] as Record<string, unknown> | undefined;
              return Array.isArray(delta?.['tool_calls']) && delta['tool_calls'].length > 0;
            })
          ))
            ? 'tool_calls'
            : 'stop',
        }],
      }];
  return new Response(complete.map((delta) => `data: ${JSON.stringify(delta)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicSse(events: Array<Record<string, unknown>>): Response {
  const canonical = events[0]?.['type'] === 'message_start'
    ? events
    : [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }, ...events];
  const hasMessageDelta = canonical.some((event) => event['type'] === 'message_delta');
  const hasToolUse = canonical.some((event) => (
    event['type'] === 'content_block_start'
    && (event['content_block'] as Record<string, unknown> | undefined)?.['type'] === 'tool_use'
  ));
  const complete = hasMessageDelta
    ? canonical
    : canonical.flatMap((event) => event['type'] === 'message_stop'
      ? [
          {
            type: 'message_delta',
            delta: { stop_reason: hasToolUse ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          event,
        ]
      : [event]);
  return new Response(complete.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function providerToolCall(
  provider: 'openai-api' | 'anthropic-api',
  rawArguments: string,
): Response {
  return provider === 'openai-api'
    ? openAiSse([{ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'empty-schema-call',
        function: { name: 'configure', arguments: rawArguments },
      }] } }] }])
    : anthropicSse([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'empty-schema-call', name: 'configure' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: rawArguments } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ]);
}

function providerText(provider: 'openai-api' | 'anthropic-api', text: string): Response {
  return provider === 'openai-api'
    ? openAiSse([{ choices: [{ delta: { content: text } }] }])
    : anthropicSse([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ]);
}

function initOptions(
  provider: 'openai-api' | 'anthropic-api',
  events: AgentEvent[],
  mcpBridge?: ProviderMcpBridge,
  boundaryEvents: ProviderBoundaryEvent[] = [],
): ProviderSessionOptions {
  const sessionId = `${provider}-boundary-session`;
  return {
    cwd: '/workspace/LAB/WhatSoup',
    systemPrompt: 'System workspace /workspace/LAB/WhatSoup; owner operator@example.com',
    model: provider === 'openai-api' ? 'gpt-test' : 'claude-test',
    routePolicy: Object.freeze({ ...restrictedRoute, provider, model: provider === 'openai-api' ? 'gpt-test' : 'claude-test' }),
    providerBoundaryMode: 'enforce',
    providerSessionId: sessionId,
    providerDataBoundary: broker(provider, sessionId, boundaryEvents),
    instanceName: 'boundary-test',
    onEvent: (event) => events.push(event),
    onCrash: vi.fn(),
    ...(mcpBridge ? { mcpBridge } : {}),
  };
}

function findAlias(body: string, type: string): string {
  const matches = [...body.matchAll(new RegExp(`⟦WSA1:${type}:[0-9a-f]{32}:[0-9a-f]{32}⟧`, 'gu'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`missing ${type} alias`);
  return match[0];
}

describe('managed provider data boundary integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('buffers split OpenAI aliases, rehydrates once, and keeps provider history brokered', async () => {
    const rawPath = '/workspace/LAB/WhatSoup/package.json';
    const events: AgentEvent[] = [];
    let firstBody = '';
    let pathAlias = '';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      if (fetchMock.mock.calls.length === 1) {
        firstBody = body;
        pathAlias = findAlias(body, 'path');
      }
      const split = Math.floor(pathAlias.length / 2);
      return openAiSse([
        { choices: [{ delta: { content: pathAlias.slice(0, split) } }] },
        { choices: [{ delta: { content: pathAlias.slice(split) } }] },
      ]);
    });

    const provider = new OpenAIApiProvider();
    await provider.initialize(initOptions('openai-api', events));
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: `Read ${rawPath}` }],
    });

    expect(firstBody).not.toContain(rawPath);
    expect(firstBody).not.toContain('/workspace/LAB/WhatSoup');
    expect(firstBody).not.toContain('operator@example.com');
    expect(events.filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: rawPath },
    ]);
    expect(JSON.stringify(events)).not.toContain('WSA1');

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'continue' }],
    });
    const secondBody = String(fetchMock.mock.calls[1]?.[1]?.body);
    expect(secondBody).not.toContain(rawPath);
    expect(secondBody).toContain(pathAlias);
  });

  it('rehydrates authorized tool arguments locally and aliases tool results before OpenAI history', async () => {
    const rawPath = '/workspace/LAB/WhatSoup/package.json';
    const rawJid = '15551234567@s.whatsapp.net';
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: `owner=${rawJid}`, isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'boundary_read_file',
        description: 'Read one file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', 'x-whatsoup-alias-type': 'path' },
          },
          required: ['path'],
        },
      }],
      executeTool,
    };
    let pathAlias = '';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      const call = fetchMock.mock.calls.length;
      if (call === 1) {
        pathAlias = findAlias(body, 'path');
        return openAiSse([{
          choices: [{ delta: { tool_calls: [{
            index: 0,
            id: 'call-1',
            function: { name: 'boundary_read_file', arguments: JSON.stringify({ path: pathAlias }) },
          }] } }],
        }]);
      }
      expect(body).not.toContain(rawPath);
      expect(body).not.toContain(rawJid);
      expect(body).toContain('WSA1');
      return openAiSse([{ choices: [{ delta: { content: pathAlias } }] }]);
    });

    const provider = new OpenAIApiProvider();
    await provider.initialize(initOptions('openai-api', events, mcpBridge));
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: `Read ${rawPath}` }],
    });

    expect(executeTool).toHaveBeenCalledWith('boundary_read_file', { path: rawPath });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', toolInput: { path: rawPath } }),
      expect.objectContaining({ type: 'tool_result', content: `owner=${rawJid}` }),
      expect.objectContaining({ type: 'assistant_text', text: rawPath }),
    ]));
    expect(JSON.stringify(events)).not.toContain('WSA1');
  });

  it('applies the same prompt, history, and split-output boundary to Anthropic', async () => {
    const rawPath = '/workspace/LAB/WhatSoup/CLAUDE.md';
    const events: AgentEvent[] = [];
    let alias = '';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      expect(body).not.toContain(rawPath);
      expect(body).not.toContain('operator@example.com');
      alias ||= findAlias(body, 'path');
      const split = Math.floor(alias.length / 2);
      return anthropicSse([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: alias.slice(0, split) } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: alias.slice(split) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
      ]);
    });

    const provider = new AnthropicApiProvider();
    await provider.initialize(initOptions('anthropic-api', events));
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: `Read ${rawPath}` }],
    });

    expect(events.filter((event) => event.type === 'assistant_text')).toEqual([
      { type: 'assistant_text', text: rawPath },
    ]);
    expect(JSON.stringify(events)).not.toContain('WSA1');
  });

  it('leaves every trusted provider byte unchanged', async () => {
    const events: AgentEvent[] = [];
    fetchMock.mockResolvedValue(openAiSse([{ choices: [{ delta: { content: 'trusted output' } }] }]));
    const provider = new OpenAIApiProvider();
    const options: ProviderSessionOptions = {
      cwd: '/workspace/LAB/WhatSoup',
      systemPrompt: 'System operator@example.com /workspace/LAB/WhatSoup',
      model: 'gpt-test',
      instanceName: 'trusted-test',
      onEvent: (event) => events.push(event),
      onCrash: vi.fn(),
    };
    await provider.initialize(options);
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'User operator@example.com /workspace/LAB/WhatSoup' }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages).toEqual([
      { role: 'system', content: 'System operator@example.com /workspace/LAB/WhatSoup' },
      { role: 'user', content: 'User operator@example.com /workspace/LAB/WhatSoup' },
    ]);
    expect(events).toContainEqual({ type: 'assistant_text', text: 'trusted output' });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('emits no partial %s text when a late secret invalidates the whole output', async (providerName, makeProvider) => {
    const events: AgentEvent[] = [];
    const lateSecret = `sk-${'z'.repeat(30)}`;
    fetchMock.mockResolvedValue(providerName === 'openai-api'
      ? openAiSse([
          { choices: [{ delta: { content: 'safe prefix ' } }] },
          { choices: [{ delta: { content: lateSecret } }] },
        ])
      : anthropicSse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'safe prefix ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: lateSecret } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ]));
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events));

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toMatchObject({ code: 'secret_detected' });

    expect(events.filter((event) => event.type === 'assistant_text')).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(lateSecret);
  });

  it('blocks duplicate OpenAI tool keys before execution', async () => {
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'boundary_read_file',
        description: 'Read one file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', 'x-whatsoup-alias-type': 'path' } },
        },
      }],
      executeTool,
    };
    let alias = '';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        alias = findAlias(String(init.body), 'path');
        return openAiSse([{
          choices: [{ delta: { tool_calls: [{
            index: 0,
            id: 'duplicate-call',
            function: {
              name: 'boundary_read_file',
              arguments: `{"path":${JSON.stringify(alias)},"path":${JSON.stringify(alias)}}`,
            },
          }] } }],
        }]);
      }
      return openAiSse([{ choices: [{ delta: { content: 'blocked' } }] }]);
    });
    const provider = new OpenAIApiProvider();
    await provider.initialize(initOptions('openai-api', events, mcpBridge));
    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Read /workspace/LAB/WhatSoup/package.json' }],
    })).rejects.toMatchObject({ code: 'invalid_tool_input' });

    expect(executeTool).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result'))
      .toEqual([]);
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('retires the %s broker when initialization rejects a secret prompt', async (providerName, makeProvider) => {
    const events: AgentEvent[] = [];
    const options = initOptions(providerName, events);
    const dataBoundary = options.providerDataBoundary!;
    options.systemPrompt = `Authorization: Bearer sk-${'x'.repeat(30)}`;

    await expect(makeProvider().initialize(options)).rejects.toMatchObject({ code: 'secret_detected' });

    expect(() => dataBoundary.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' }))
      .toThrowError(expect.objectContaining({ code: 'retired_boundary' }));
    expect(events).toEqual([]);
  });

  it('preflights all OpenAI turn parts before changing history or calling fetch', async () => {
    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();
    await provider.initialize(initOptions('openai-api', events));
    const secret = `sk-${'m'.repeat(30)}`;

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [
        { kind: 'text', text: 'Read /workspace/LAB/WhatSoup/package.json' },
        { kind: 'audio', mimeType: 'audio/ogg', transcript: `late ${secret}` },
      ],
    })).rejects.toMatchObject({ code: 'secret_detected' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('WSA1');
  });

  it('authorizes against the immutable tool schema snapshot captured at initialize', async () => {
    const events: AgentEvent[] = [];
    const schema = {
      type: 'object',
      properties: { path: { type: 'string', 'x-whatsoup-alias-type': 'path' } },
    };
    const executeTool = vi.fn(async () => ({ content: 'ok', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{ name: 'boundary_read_file', description: 'Read', inputSchema: schema }],
      executeTool,
    };
    let alias = '';
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        alias = findAlias(String(init.body), 'path');
        return openAiSse([{ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: 'snapshot-call',
          function: { name: 'boundary_read_file', arguments: JSON.stringify({ path: alias }) },
        }] } }] }]);
      }
      return openAiSse([{ choices: [{ delta: { content: alias } }] }]);
    });
    const provider = new OpenAIApiProvider();
    await provider.initialize(initOptions('openai-api', events, mcpBridge));
    (schema.properties.path as Record<string, unknown>)['x-whatsoup-alias-type'] = 'email';

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Read /workspace/LAB/WhatSoup/package.json' }],
    });

    expect(executeTool).toHaveBeenCalledWith('boundary_read_file', {
      path: '/workspace/LAB/WhatSoup/package.json',
    });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('preflights the complete %s tool-call batch before events or execution', async (
    providerName,
    makeProvider,
  ) => {
    const cases = ['late_secret', 'late_forgery', 'late_invalid', 'late_record_schema'] as const;
    for (const hostileCase of cases) {
      fetchMock.mockReset();
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      const mcpBridge: ProviderMcpBridge = {
        listTools: () => [{
          name: 'boundary_read_file',
          description: 'Read one file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', 'x-whatsoup-alias-type': 'path' },
              metadata: {
                type: 'object',
                additionalProperties: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        }],
        executeTool,
      };
      let alias = '';
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        alias ||= findAlias(String(init.body), 'path');
        const lateArguments = hostileCase === 'late_secret'
          ? JSON.stringify({ path: 'credential="quoted multiword value"' })
          : hostileCase === 'late_forgery'
            ? JSON.stringify({ path: alias.replace(/:[0-9a-f]{32}⟧$/u, `:${'0'.repeat(32)}⟧`) })
            : hostileCase === 'late_record_schema'
              ? JSON.stringify({ metadata: { nested: ['valid', 42] } })
              : '{"path":';
        if (providerName === 'openai-api') {
          return openAiSse([{ choices: [{ delta: {
            content: 'safe text that must remain provisional',
            tool_calls: [
            {
              index: 0,
              id: 'valid-first',
              function: { name: 'boundary_read_file', arguments: JSON.stringify({ path: alias }) },
            },
            {
              index: 1,
              id: 'hostile-late',
              function: { name: 'boundary_read_file', arguments: lateArguments },
            },
            ],
          } }] }]);
        }
        return anthropicSse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'safe text that must remain provisional' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'valid-first', name: 'boundary_read_file' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: alias }) } },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'hostile-late', name: 'boundary_read_file' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: lateArguments } },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_stop' },
        ]);
      });

      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, mcpBridge));
      await expect(provider.sendTurn({
        role: 'user',
        conversationKey: 'chat-key',
        parts: [{ kind: 'text', text: 'Read /workspace/LAB/WhatSoup/package.json' }],
      })).rejects.toBeInstanceOf(Error);

      expect(executeTool, hostileCase).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result'), hostileCase)
        .toEqual([]);
      expect(events.filter((event) => event.type === 'assistant_text'), hostileCase).toEqual([]);
      expect(events.filter((event) => event.type !== 'init'), hostileCase).toEqual([]);
      expect(provider.getCheckpoint().providerState?.['messageCount'], hostileCase)
        .toBe(providerName === 'openai-api' ? 2 : 1);
    }
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('passes ordinary JSON through empty-schema %s record values', async (
    providerName,
    makeProvider,
  ) => {
    const ordinary = {
      text: 'ordinary',
      number: 42.5,
      enabled: true,
      absent: null,
      nested: { label: 'value', count: 2 },
      items: ['value', 3, false, null, { nested: ['leaf'] }],
    };
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'complete', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'configure',
        description: 'Configure metadata',
        inputSchema: {
          type: 'object',
          properties: { metadata: { type: 'object', additionalProperties: {} } },
          required: ['metadata'],
        },
      }],
      executeTool,
    };
    fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
      ? providerToolCall(providerName, JSON.stringify({ metadata: ordinary }))
      : providerText(providerName, 'done'));
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events, mcpBridge));

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'configure ordinary metadata' }],
    });

    expect(executeTool).toHaveBeenCalledWith('configure', { metadata: ordinary });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('passes a maximum-node benign record through the restricted %s entry path', async (
    providerName,
    makeProvider,
  ) => {
    const entryCount = MAX_TOOL_NODES - 2;
    const metadata = Object.fromEntries(Array.from(
      { length: entryCount },
      (_, index) => [`field_${index}`, `ordinary_${index}`],
    ));
    const rawArguments = JSON.stringify({ metadata });
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async (
      _toolName: string,
      _input: Record<string, unknown>,
    ) => ({ content: 'complete', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'configure',
        description: 'Configure metadata',
        inputSchema: {
          type: 'object',
          properties: { metadata: { type: 'object', additionalProperties: {} } },
          required: ['metadata'],
        },
      }],
      executeTool,
    };
    fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
      ? providerToolCall(providerName, rawArguments)
      : providerText(providerName, 'done'));
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events, mcpBridge));

    expect(Buffer.byteLength(rawArguments, 'utf8')).toBeLessThan(1024 * 1024);
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'configure maximum benign metadata' }],
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    const input = executeTool.mock.calls[0]![1] as { metadata: Record<string, unknown> };
    expect(Object.keys(input.metadata)).toHaveLength(entryCount);
    expect(input.metadata['field_0']).toBe('ordinary_0');
    expect(input.metadata[`field_${entryCount - 1}`]).toBe(`ordinary_${entryCount - 1}`);
  });

  it.each([
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      'keyed negative then password',
      ['ordinarycredential=alpha', 'pass', 'word=beta'],
      1,
    ],
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      'direct keyed then token',
      ['credential=alpha', 'to', 'ken=beta'],
      2,
    ],
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      'embedded token negative then field-start token',
      [`ordinaryghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      1,
    ],
    [
      'openai-api',
      () => new OpenAIApiProvider(),
      'direct token then distinct field-start token',
      [`ghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      2,
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      'keyed negative then password',
      ['ordinarycredential=alpha', 'pass', 'word=beta'],
      1,
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      'direct keyed then token',
      ['credential=alpha', 'to', 'ken=beta'],
      2,
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      'embedded token negative then field-start token',
      [`ordinaryghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      1,
    ],
    [
      'anthropic-api',
      () => new AnthropicApiProvider(),
      'direct token then distinct field-start token',
      [`ghp_${'x'.repeat(16)}`, 'ghp_', 'y'.repeat(16)],
      2,
    ],
  ] as const)('rejects non-shadowing fragments through the restricted %s entry path', async (
    providerName,
    makeProvider,
    hostileCase,
    texts,
    secretCount,
  ) => {
    const events: AgentEvent[] = [];
    const boundaryEvents: ProviderBoundaryEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'configure',
        description: 'Configure metadata',
        inputSchema: {
          type: 'object',
          properties: { metadata: { type: 'object', additionalProperties: {} } },
          required: ['metadata'],
        },
      }],
      executeTool,
    };
    const metadata = {
      [texts[0]]: texts[1],
      [texts[2]]: '',
    };
    fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
      ? providerToolCall(providerName, JSON.stringify({ metadata }))
      : providerText(providerName, 'done'));
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events, mcpBridge, boundaryEvents));

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: `configure ${hostileCase}` }],
    })).rejects.toBeInstanceOf(Error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result'))
      .toEqual([]);
    expect(boundaryEvents.filter((event) => event.eventType === 'secret_block'))
      .toEqual([expect.objectContaining({ secretCount })]);
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('reports exact secret counts through the restricted %s entry path', async (
    providerName,
    makeProvider,
  ) => {
    const cases = [
      ['benign left plus one direct secret', ['ordinary', 'token=beta'], 1],
      ['two direct secrets', ['token=alpha', 'password=beta'], 2],
      ['two distinct fragments', ['pass', 'word=alpha', 'ordinary', 'to', 'ken=beta'], 2],
      [
        'one direct plus two distinct fragments',
        ['credential=gamma', 'pass', 'word=alpha', 'ordinary', 'to', 'ken=beta'],
        3,
      ],
    ] as const;
    for (const [caseName, metadata, secretCount] of cases) {
      fetchMock.mockReset();
      const events: AgentEvent[] = [];
      const boundaryEvents: ProviderBoundaryEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      const mcpBridge: ProviderMcpBridge = {
        listTools: () => [{
          name: 'configure',
          description: 'Configure metadata',
          inputSchema: {
            type: 'object',
            properties: {
              metadata: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['metadata'],
          },
        }],
        executeTool,
      };
      fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
        ? providerToolCall(providerName, JSON.stringify({ metadata }))
        : providerText(providerName, 'done'));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, mcpBridge, boundaryEvents));

      await expect(provider.sendTurn({
        role: 'user',
        conversationKey: 'chat-key',
        parts: [{ kind: 'text', text: `configure ${caseName}` }],
      })).rejects.toMatchObject({ code: 'secret_detected' });

      expect(fetchMock, caseName).toHaveBeenCalledTimes(1);
      expect(executeTool, caseName).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init'), caseName).toEqual([]);
      expect(provider.getCheckpoint().providerState?.['messageCount'], caseName)
        .toBe(providerName === 'openai-api' ? 2 : 1);
      expect(
        boundaryEvents.filter((event) => event.eventType === 'secret_block'),
        caseName,
      ).toEqual([expect.objectContaining({ secretCount })]);
    }
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('rejects every quoted-key split through the restricted %s entry path', async (
    providerName,
    makeProvider,
  ) => {
    for (const assignment of ['"password"="beta"', '"token"="beta"']) {
      for (let split = 1; split < assignment.length; split += 1) {
        fetchMock.mockReset();
        const events: AgentEvent[] = [];
        const boundaryEvents: ProviderBoundaryEvent[] = [];
        const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
        const mcpBridge: ProviderMcpBridge = {
          listTools: () => [{
            name: 'configure',
            description: 'Configure metadata',
            inputSchema: {
              type: 'object',
              properties: { metadata: { type: 'object', additionalProperties: {} } },
              required: ['metadata'],
            },
          }],
          executeTool,
        };
        const left = assignment.slice(0, split);
        const right = assignment.slice(split);
        const metadata = {
          ordinary: left,
          [right]: '',
        };
        fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
          ? providerToolCall(providerName, JSON.stringify({ metadata }))
          : providerText(providerName, 'done'));
        const provider = makeProvider();
        await provider.initialize(initOptions(providerName, events, mcpBridge, boundaryEvents));
        await expect(provider.sendTurn({
          role: 'user',
          conversationKey: 'chat-key',
          parts: [{ kind: 'text', text: 'configure ordinary metadata' }],
        })).rejects.toMatchObject({ code: 'secret_detected' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(executeTool).not.toHaveBeenCalled();
        expect(events.filter((event) => event.type !== 'init')).toEqual([]);
        expect(provider.getCheckpoint().providerState?.['messageCount'])
          .toBe(providerName === 'openai-api' ? 2 : 1);
        expect(boundaryEvents.filter((event) => event.eventType === 'secret_block'))
          .toEqual([expect.objectContaining({ secretCount: 1 })]);
      }
    }
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('passes exact maximum-node candidate-dense JSON through restricted %s', async (
    providerName,
    makeProvider,
  ) => {
    const metadata = Array.from({ length: MAX_TOOL_NODES - 2 }, () => 'xcredential=a');
    const rawArguments = JSON.stringify({ metadata });
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async (
      _toolName: string,
      _input: Record<string, unknown>,
    ) => ({ content: 'complete', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'configure',
        description: 'Configure metadata',
        inputSchema: {
          type: 'object',
          properties: {
            metadata: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['metadata'],
        },
      }],
      executeTool,
    };
    fetchMock.mockImplementation(async () => fetchMock.mock.calls.length === 1
      ? providerToolCall(providerName, rawArguments)
      : providerText(providerName, 'done'));
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events, mcpBridge));

    expect(Buffer.byteLength(rawArguments, 'utf8')).toBeLessThan(1024 * 1024);
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'configure candidate-dense metadata' }],
    });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith('configure', { metadata });
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('rejects hostile JSON inside empty-schema %s record values', async (
    providerName,
    makeProvider,
  ) => {
    for (const hostileCase of ['secret', 'alias'] as const) {
      fetchMock.mockReset();
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      const mcpBridge: ProviderMcpBridge = {
        listTools: () => [{
          name: 'configure',
          description: 'Configure metadata',
          inputSchema: {
            type: 'object',
            properties: { metadata: { type: 'object', additionalProperties: {} } },
          },
        }],
        executeTool,
      };
      fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
        const value = hostileCase === 'secret'
          ? 'credential="quoted multiword value"'
          : findAlias(String(init.body), 'path');
        return providerToolCall(providerName, JSON.stringify({ metadata: { value } }));
      });
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, mcpBridge));

      await expect(provider.sendTurn({
        role: 'user',
        conversationKey: 'chat-key',
        parts: [{ kind: 'text', text: 'use /workspace/LAB/WhatSoup metadata' }],
      }), hostileCase).rejects.toBeInstanceOf(Error);

      expect(executeTool, hostileCase).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result'), hostileCase)
        .toEqual([]);
    }
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('snapshots the restricted %s boundary admission against caller mutation', async (
    providerName,
    makeProvider,
  ) => {
    const events: AgentEvent[] = [];
    const options = initOptions(providerName, events);
    const provider = makeProvider();
    await provider.initialize(options);

    options.routePolicy = {
      ...options.routePolicy!,
      dataPolicy: 'trusted',
    };
    options.providerBoundaryMode = 'shadow';
    options.providerDataBoundary = undefined;
    options.model = 'caller-mutated-model';
    options.providerSessionId = 'caller-mutated-session';
    const secret = `sk-${'q'.repeat(30)}`;
    fetchMock.mockResolvedValue(providerName === 'openai-api'
      ? openAiSse([{ choices: [{ delta: { content: secret } }] }])
      : anthropicSse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: secret } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ]));

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    })).rejects.toMatchObject({ code: 'secret_detected' });
    expect(events.filter((event) => event.type !== 'init')).toEqual([]);
    expect(provider.getCheckpoint().providerState?.['messageCount'])
      .toBe(providerName === 'openai-api' ? 2 : 1);
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('rejects per-turn %s model drift before restricted exposure', async (
    providerName,
    makeProvider,
  ) => {
    const events: AgentEvent[] = [];
    const boundaryEvents: ProviderBoundaryEvent[] = [];
    const options = initOptions(providerName, events);
    options.providerDataBoundary = broker(providerName, options.providerSessionId!, boundaryEvents);
    const provider = makeProvider();
    await provider.initialize(options);

    await expect(provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      model: 'drifted-model',
      parts: [{ kind: 'text', text: 'Read /workspace/LAB/WhatSoup/package.json' }],
    })).rejects.toMatchObject({ code: 'route_drift' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(boundaryEvents).toContainEqual(expect.objectContaining({
      eventType: 'route_drift',
      success: 0,
    }));
  });

  it('rejects prototype-poisoned advertised tool schemas at snapshot time', async () => {
    const poisonedSchema = Object.create({
      properties: { path: { type: 'string', 'x-whatsoup-alias-type': 'path' } },
    }) as Record<string, unknown>;
    poisonedSchema['type'] = 'object';
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'boundary_read_file',
        description: 'Read one file',
        inputSchema: poisonedSchema,
      }],
      executeTool: vi.fn(),
    };
    const events: AgentEvent[] = [];

    await expect(new OpenAIApiProvider().initialize(initOptions('openai-api', events, mcpBridge)))
      .rejects.toBeInstanceOf(Error);
    expect(events).toEqual([]);
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('retires the %s broker on shutdown', async (providerName, makeProvider) => {
    const provider: ProviderSession = makeProvider();
    const events: AgentEvent[] = [];
    const options = initOptions(providerName, events);
    const dataBoundary = options.providerDataBoundary!;
    const alias = dataBoundary.exposeText('/workspace/LAB/WhatSoup', { surface: 'prompt' });
    await provider.initialize(options);

    await provider.shutdown('end');

    expect(() => dataBoundary.rehydrateProviderText(alias, { surface: 'provider_output' }))
      .toThrowError(expect.objectContaining({ code: 'retired_boundary' }));
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('rejects deterministic cross-key secret and alias fragments before %s execution', async (
    providerName,
    makeProvider,
  ) => {
    for (const [rawArguments, expectedCode] of [
      [JSON.stringify({ metadata: { cred: 'ential="quoted multiword value"' } }), 'secret_detected'],
      [JSON.stringify({
        metadata: { 'prefix ⟦W': `SA1:path:${'1'.repeat(32)}:${'2'.repeat(32)}⟧` },
      }), 'residual_alias'],
    ] as const) {
      const events: AgentEvent[] = [];
      const executeTool = vi.fn(async () => ({ content: 'must not run', isError: false }));
      const mcpBridge: ProviderMcpBridge = {
        listTools: () => [{
          name: 'configure',
          description: 'Configure metadata',
          inputSchema: {
            type: 'object',
            properties: {
              metadata: { type: 'object', additionalProperties: {} },
            },
            required: ['metadata'],
          },
        }],
        executeTool,
      };
      fetchMock
        .mockResolvedValueOnce(providerToolCall(providerName, rawArguments))
        .mockResolvedValueOnce(providerText(providerName, 'complete'));
      const provider = makeProvider();
      await provider.initialize(initOptions(providerName, events, mcpBridge));

      await expect(provider.sendTurn({
        role: 'user',
        conversationKey: 'chat-key',
        parts: [{ kind: 'text', text: 'configure' }],
      })).rejects.toMatchObject({ code: expectedCode });

      expect(executeTool).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type !== 'init')).toEqual([]);
      expect(provider.getCheckpoint().providerState?.['messageCount'])
        .toBe(providerName === 'openai-api' ? 2 : 1);
      fetchMock.mockReset();
    }
  });

  it.each([
    ['openai-api', () => new OpenAIApiProvider()],
    ['anthropic-api', () => new AnthropicApiProvider()],
  ] as const)('authorizes production request_pairing_code.phoneNumber for %s', async (
    providerName,
    makeProvider,
  ) => {
    const rawPhone = '14155551234';
    const events: AgentEvent[] = [];
    const executeTool = vi.fn(async () => ({ content: 'paired', isError: false }));
    const mcpBridge: ProviderMcpBridge = {
      listTools: () => [{
        name: 'request_pairing_code',
        description: 'Request a pairing code',
        inputSchema: {
          type: 'object',
          properties: {
            phoneNumber: { type: 'string' },
          },
          required: ['phoneNumber'],
          additionalProperties: false,
        },
      }],
      executeTool,
    };
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        const alias = findAlias(String(init.body), 'phone');
        const argumentsJson = JSON.stringify({ phoneNumber: alias });
        return providerName === 'openai-api'
          ? openAiSse([{ choices: [{ delta: { tool_calls: [{
              index: 0,
              id: 'pair-call',
              function: { name: 'request_pairing_code', arguments: argumentsJson },
            }] } }] }])
          : anthropicSse([
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'tool_use', id: 'pair-call', name: 'request_pairing_code' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: argumentsJson },
              },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_stop' },
            ]);
      }
      return providerText(providerName, 'complete');
    });
    const provider = makeProvider();
    await provider.initialize(initOptions(providerName, events, mcpBridge));

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: `pair ${rawPhone}` }],
    });

    expect(executeTool).toHaveBeenCalledWith('request_pairing_code', {
      phoneNumber: rawPhone,
    });
  });
});
