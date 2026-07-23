import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderDataBoundary } from '../../../../src/core/provider-data-boundary.ts';
import type { ProviderBoundaryEvent } from '../../../../src/core/provider-data-boundary.ts';
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
  return new Response(canonical.map((delta) => `data: ${JSON.stringify(delta)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicSse(events: Array<Record<string, unknown>>): Response {
  const canonical = events[0]?.['type'] === 'message_start'
    ? events
    : [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }, ...events];
  return new Response(canonical.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
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
): ProviderSessionOptions {
  const sessionId = `${provider}-boundary-session`;
  return {
    cwd: '/workspace/LAB/WhatSoup',
    systemPrompt: 'System workspace /workspace/LAB/WhatSoup; owner operator@example.com',
    model: provider === 'openai-api' ? 'gpt-test' : 'claude-test',
    routePolicy: Object.freeze({ ...restrictedRoute, provider, model: provider === 'openai-api' ? 'gpt-test' : 'claude-test' }),
    providerBoundaryMode: 'enforce',
    providerSessionId: sessionId,
    providerDataBoundary: broker(provider, sessionId),
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
});
