import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import {
  noExecutingSession,
  type ExecutingSessionContext,
  type SessionContext,
} from '../../../../src/mcp/types.ts';
import { ToolRegistry } from '../../../../src/mcp/registry.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import {
  createProviderMcpBridge as createProductionProviderMcpBridge,
} from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';
import type { ProviderMcpBridge } from '../../../../src/runtimes/agent/providers/types.ts';

vi.mock('../../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../../helpers/logger-mock.ts');
  return loggerMock();
});

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeRawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function registerEchoTool(registry: ToolRegistry): void {
  registry.register({
    name: 'echo_tool',
    description: 'Echoes the provided value with session context',
    schema: z.object({
      value: z.string(),
    }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params, session) => ({
      echoed: `${String(params['value'])}:${session.deliveryJid ?? 'unknown'}`,
    }),
  });
}

function createProviderMcpBridge(
  registry: ToolRegistry,
  session: SessionContext,
  resolveExecutingSession: () => ExecutingSessionContext = noExecutingSession,
): ProviderMcpBridge {
  return createProductionProviderMcpBridge(registry, session, resolveExecutingSession);
}

function registerFailTool(registry: ToolRegistry): void {
  registry.register({
    name: 'fail_tool',
    description: 'Always fails',
    schema: z.object({
      reason: z.string(),
    }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => {
      throw new Error(`boom: ${String(params['reason'])}`);
    },
  });
}

describe('HTTP provider MCP bridge', () => {
  const onCrash = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('openai-api advertises MCP tools and executes them through the bridge', async () => {
    const registry = new ToolRegistry();
    registerEchoTool(registry);

    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'echo_tool',
                  arguments: '{"value":"hello"}',
                },
              }],
            },
          }],
        },
        {
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
          },
        },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              content: 'Tool complete.',
            },
          }],
        },
        {
          usage: {
            prompt_tokens: 14,
            completion_tokens: 5,
          },
        },
        '[DONE]',
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '123@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Use the MCP tool.' }],
    });

    expect(provider.descriptor.mcpMode).toBe('native_bridge');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(firstBody['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'echo_tool',
          description: 'Echoes the provided value with session context',
          parameters: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      },
    ]);

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMessage = secondBody.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
    expect(String(toolMessage?.content)).toContain('"echoed": "hello:123@s.whatsapp.net"');

    const toolUseEvent = events.find((event) => event.type === 'tool_use');
    expect(toolUseEvent).toMatchObject({
      type: 'tool_use',
      toolName: 'echo_tool',
      toolId: 'call_1',
      toolInput: { value: 'hello' },
    });

    const toolResultEvent = events.find((event) => event.type === 'tool_result');
    expect(toolResultEvent).toMatchObject({
      type: 'tool_result',
      isError: false,
      toolId: 'call_1',
    });
    expect((toolResultEvent as Extract<AgentEvent, { type: 'tool_result' }>).content)
      .toContain('"echoed": "hello:123@s.whatsapp.net"');
  });

  it('openai-api blocks malformed MCP tool arguments without executing the tool', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn<(params: Record<string, unknown>, session: SessionContext) => Promise<unknown>>(async () => ({ echoed: 'must not execute' }));

    registry.register({
      name: 'echo_tool',
      description: 'Echoes the provided value',
      schema: z.object({ value: z.string() }),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler,
    });

    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_bad_json',
                type: 'function',
                function: {
                  name: 'echo_tool',
                  arguments: '{"value":',
                },
              }],
            },
          }],
        },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: 'Recovered from bad tool input.' } }] },
        '[DONE]',
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '123@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Use the MCP tool.' }],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    const toolMessage = secondBody.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad_json',
    });
    expect(String(toolMessage?.content))
      .toBe('Tool "echo_tool" failed: malformed provider tool arguments; the tool was not executed.');

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_use',
        toolId: 'call_bad_json',
        toolInput: {},
      }),
      expect.objectContaining({
        type: 'tool_result',
        toolId: 'call_bad_json',
        isError: true,
        content: 'Tool "echo_tool" failed: malformed provider tool arguments; the tool was not executed.',
      }),
      expect.objectContaining({
        type: 'assistant_text',
        text: 'Recovered from bad tool input.',
      }),
    ]));
  });

  it('openai-api blocks non-object MCP tool arguments without executing the tool', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn<(params: Record<string, unknown>, session: SessionContext) => Promise<unknown>>(async () => ({ echoed: 'must not execute' }));

    registry.register({
      name: 'echo_tool',
      description: 'Echoes the provided value',
      schema: z.object({ value: z.string() }),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler,
    });

    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_bad_shape',
                type: 'function',
                function: {
                  name: 'echo_tool',
                  arguments: '["value"]',
                },
              }],
            },
          }],
        },
        '[DONE]',
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: 'Recovered from bad tool shape.' } }] },
        '[DONE]',
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '123@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Use the MCP tool.' }],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const toolResultEvent = events.find((event) => event.type === 'tool_result');
    expect(toolResultEvent).toMatchObject({
      type: 'tool_result',
      toolId: 'call_bad_shape',
      isError: true,
      content: 'Tool "echo_tool" failed: provider tool arguments must be a JSON object; the tool was not executed.',
    });
  });

  it('anthropic-api returns MCP execution failures as tool_result errors', async () => {
    const registry = new ToolRegistry();
    registerFailTool(registry);

    const events: AgentEvent[] = [];
    const provider = new AnthropicApiProvider();

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 9,
              output_tokens: 0,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'fail_tool',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"reason":"denied"}',
          },
        },
        {
          type: 'message_delta',
          usage: {
            output_tokens: 3,
          },
        },
        {
          type: 'message_stop',
        },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 13,
              output_tokens: 0,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'text',
            text: '',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'Handled tool failure.',
          },
        },
        {
          type: 'message_delta',
          usage: {
            output_tokens: 4,
          },
        },
        {
          type: 'message_stop',
        },
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '456@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Call the failing tool.' }],
    });

    expect(provider.descriptor.mcpMode).toBe('native_bridge');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(firstBody['tools']).toEqual([
      {
        name: 'fail_tool',
        description: 'Always fails',
        input_schema: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
          },
          required: ['reason'],
        },
      },
    ]);

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultTurn = secondBody.messages.find(
      (message) => message.role === 'user'
        && Array.isArray(message.content)
        && message.content.some((block) => (
          typeof block === 'object'
            && block !== null
            && 'type' in block
            && block.type === 'tool_result'
        )),
    );
    expect(toolResultTurn?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'Tool "fail_tool" failed: boom: denied',
        is_error: true,
      },
    ]);

    const toolUseEvent = events.find((event) => event.type === 'tool_use');
    expect(toolUseEvent).toMatchObject({
      type: 'tool_use',
      toolName: 'fail_tool',
      toolId: 'toolu_1',
      toolInput: { reason: 'denied' },
    });

    const toolResultEvent = events.find((event) => event.type === 'tool_result');
    expect(toolResultEvent).toMatchObject({
      type: 'tool_result',
      isError: true,
      toolId: 'toolu_1',
      content: 'Tool "fail_tool" failed: boom: denied',
    });
  });

  it('openai-api parses a final SSE data line without a trailing newline', async () => {
    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();

    fetchMock.mockResolvedValueOnce(makeRawSseResponse(
      'data: {"choices":[{"delta":{"content":"tail text"}}]}',
    ));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(events).toEqual(expect.arrayContaining([
      { type: 'assistant_text', text: 'tail text' },
      expect.objectContaining({ type: 'result', text: null }),
    ]));
  });

  it('anthropic-api parses a final SSE data line without a trailing newline', async () => {
    const events: AgentEvent[] = [];
    const provider = new AnthropicApiProvider();

    fetchMock.mockResolvedValueOnce(makeRawSseResponse([
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tail text"}}',
    ].join('')));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(events).toEqual(expect.arrayContaining([
      { type: 'assistant_text', text: 'tail text' },
      expect.objectContaining({ type: 'result', text: null }),
    ]));
  });

  it('openai-api emits one terminal result for fetch failures', async () => {
    const events: AgentEvent[] = [];
    const provider = new OpenAIApiProvider();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    const resultEvents = events.filter((event) => event.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({
      type: 'result',
      text: '_Connection error - please try again._',
    });
  });

  it('anthropic-api emits one terminal result for fetch failures', async () => {
    const events: AgentEvent[] = [];
    const provider = new AnthropicApiProvider();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (event) => events.push(event),
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    const resultEvents = events.filter((event) => event.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toMatchObject({
      type: 'result',
      text: '_Connection error - please try again._',
    });
  });

  it('openai-api includes base64 image parts in the request body', async () => {
    const provider = new OpenAIApiProvider();
    fetchMock.mockResolvedValueOnce(makeSseResponse(['[DONE]']));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: () => {},
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [
        { kind: 'text', text: 'inspect this' },
        { kind: 'image', mimeType: 'image/jpeg', base64: 'abc123', caption: 'front panel' },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userMessage = body.messages.find((message) => message.role === 'user');
    expect(userMessage?.content).toEqual([
      { type: 'text', text: 'inspect this' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
      { type: 'text', text: 'front panel' },
    ]);
  });

  it('anthropic-api includes base64 image parts in the request body', async () => {
    const provider = new AnthropicApiProvider();
    fetchMock.mockResolvedValueOnce(makeSseResponse([
      { type: 'message_stop' },
    ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: () => {},
      onCrash,
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [
        { kind: 'text', text: 'inspect this' },
        { kind: 'image', mimeType: 'image/png', base64: 'abc123', caption: 'front panel' },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'inspect this' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
      { type: 'text', text: 'front panel' },
    ]);
  });
});

describe('managed tool loop kill behavior', () => {
  const onCrash = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('anthropic-api stops executing queued tool calls after kill()', async () => {
    const registry = new ToolRegistry();
    const provider = new AnthropicApiProvider();
    const afterToolHandler = vi.fn(async () => ({ echoed: 'must not run' }));

    registry.register({
      name: 'kill_tool',
      description: 'Kills the session mid-turn',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler: async () => {
        provider.kill();
        return { done: true };
      },
    });
    registry.register({
      name: 'after_tool',
      description: 'Queued behind kill_tool in the same turn',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler: afterToolHandler,
    });

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_kill', name: 'kill_tool' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_after', name: 'after_tool' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
        { type: 'message_delta', usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]))
      .mockResolvedValue(makeSseResponse([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'done' },
        },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: () => {},
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '456@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Run both tools.' }],
    });

    // Once kill() lands mid-loop, queued tool calls must not execute against
    // the dead session...
    expect(afterToolHandler).not.toHaveBeenCalled();
    // ...and the outer loop must not re-enter callApi with orphaned history
    // (assistant tool_use blocks without matching tool_result entries draw a
    // hard 400 from the Anthropic API, surfacing a spurious error after kill).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('openai-api stops the managed loop after kill() without a follow-up API call', async () => {
    const registry = new ToolRegistry();
    const provider = new OpenAIApiProvider();
    const afterToolHandler = vi.fn(async () => ({ echoed: 'must not run' }));

    registry.register({
      name: 'kill_tool',
      description: 'Kills the session mid-turn',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler: async () => {
        provider.kill();
        return { done: true };
      },
    });
    registry.register({
      name: 'after_tool',
      description: 'Queued behind kill_tool in the same turn',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler: afterToolHandler,
    });

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_kill',
                  type: 'function',
                  function: { name: 'kill_tool', arguments: '{}' },
                },
                {
                  index: 1,
                  id: 'call_after',
                  type: 'function',
                  function: { name: 'after_tool', arguments: '{}' },
                },
              ],
            },
          }],
        },
        { usage: { prompt_tokens: 11, completion_tokens: 4 } },
        '[DONE]',
      ]))
      .mockResolvedValue(makeSseResponse([
        { choices: [{ delta: { content: 'done' } }] },
        { usage: { prompt_tokens: 14, completion_tokens: 5 } },
        '[DONE]',
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: () => {},
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '456@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Run both tools.' }],
    });

    expect(afterToolHandler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('anthropic malformed tool input blocking', () => {
  const onCrash = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function runTurnWithInputJson(
    provider: AnthropicApiProvider,
    handler: (params: Record<string, unknown>, session: SessionContext) => Promise<unknown>,
    inputJson: string,
  ): Promise<void> {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo_tool',
      description: 'Echoes the provided value',
      schema: z.object({ value: z.string() }),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler,
    });

    fetchMock
      .mockResolvedValueOnce(makeSseResponse([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 5, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bad', name: 'echo_tool' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        },
        { type: 'message_delta', usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        {
          type: 'message_start',
          message: { usage: { input_tokens: 7, output_tokens: 0 } },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Recovered from bad tool input.' },
        },
        { type: 'message_delta', usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]));

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: () => {},
      onCrash,
      mcpBridge: createProviderMcpBridge(registry, {
        tier: 'chat-scoped',
        conversationKey: 'chat-key',
        deliveryJid: '456@s.whatsapp.net',
      }),
    });

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Use the MCP tool.' }],
    });
  }

  it('blocks malformed tool input JSON without executing the tool (openai parity)', async () => {
    const handler = vi.fn<(params: Record<string, unknown>, session: SessionContext) => Promise<unknown>>(async () => ({ echoed: 'must not execute' }));
    const provider = new AnthropicApiProvider();

    await runTurnWithInputJson(provider, handler, '{"value":');

    expect(handler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The error feeds back to the model as a tool_result, not an execution.
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultTurn = secondBody.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && m.content.some((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_result'),
    );
    expect(toolResultTurn?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'toolu_bad',
        is_error: true,
        content: 'Tool "echo_tool" failed: malformed provider tool arguments; the tool was not executed.',
      }),
    ]);
  });

  it('blocks non-object tool input JSON without executing the tool', async () => {
    const handler = vi.fn<(params: Record<string, unknown>, session: SessionContext) => Promise<unknown>>(async () => ({ echoed: 'must not execute' }));
    const provider = new AnthropicApiProvider();

    await runTurnWithInputJson(provider, handler, '[1,2]');

    expect(handler).not.toHaveBeenCalled();
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultTurn = secondBody.messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content)
        && m.content.some((b) => typeof b === 'object' && b !== null && 'type' in b && b.type === 'tool_result'),
    );
    expect(toolResultTurn?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'toolu_bad',
        is_error: true,
        content: 'Tool "echo_tool" failed: provider tool arguments must be a JSON object; the tool was not executed.',
      }),
    ]);
  });
});

describe('rate-limit retry on 429 responses', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function make429Response(retryAfterSeconds?: number): Response {
    return new Response('', {
      status: 429,
      headers: retryAfterSeconds !== undefined
        ? { 'retry-after': String(retryAfterSeconds) }
        : {},
    });
  }

  function makeTextResponse(text: string): Response {
    return new Response(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: null }],
      })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  function makeAnthropicSseResponse(text: string): Response {
    return new Response(
      [
        `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })}`,
        `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
        `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 1 } })}`,
        `data: ${JSON.stringify({ type: 'message_stop' })}`,
        '',
      ].join('\n\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  async function initProvider(provider: OpenAIApiProvider | AnthropicApiProvider): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: (e) => events.push(e),
      onCrash: vi.fn(),
    });
    return events;
  }

  it('openai-api retries once on 429 with Retry-After and then succeeds', async () => {
    const provider = new OpenAIApiProvider();
    const events = await initProvider(provider);

    fetchMock
      .mockResolvedValueOnce(make429Response(3))
      .mockResolvedValueOnce(makeTextResponse('Hello after retry'));

    const sendPromise = provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    // Advance past the 3s Retry-After window
    await vi.advanceTimersByTimeAsync(3000);
    await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'assistant_text' && e.text === 'Hello after retry')).toBe(true);
  });

  it('openai-api falls through to terminal message on 429 without Retry-After header', async () => {
    const provider = new OpenAIApiProvider();
    const events = await initProvider(provider);

    fetchMock.mockResolvedValueOnce(make429Response());

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    // Only one fetch — no retry without Retry-After
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const terminal = events.find((e) => e.type === 'result');
    expect(terminal).toBeDefined();
    expect((terminal as { type: string; text: string | null }).text).toContain('Rate limited');
  });

  it('openai-api does not retry a second time after already retrying once', async () => {
    const provider = new OpenAIApiProvider();
    const events = await initProvider(provider);

    // First call: 429 with Retry-After — triggers retry
    // Second call: another 429 with Retry-After — must NOT retry again
    fetchMock
      .mockResolvedValueOnce(make429Response(1))
      .mockResolvedValueOnce(make429Response(1));

    const sendPromise = provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    await vi.advanceTimersByTimeAsync(1000);
    await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const terminal = events.find((e) => e.type === 'result');
    expect(terminal).toBeDefined();
    expect((terminal as { type: string; text: string | null }).text).toContain('Rate limited');
  });

  it('anthropic-api retries once on 429 with Retry-After and then succeeds', async () => {
    const provider = new AnthropicApiProvider();
    const events = await initProvider(provider);

    fetchMock
      .mockResolvedValueOnce(make429Response(2))
      .mockResolvedValueOnce(makeAnthropicSseResponse('Hello from Anthropic'));

    const sendPromise = provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    await vi.advanceTimersByTimeAsync(2000);
    await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'assistant_text' && e.text === 'Hello from Anthropic')).toBe(true);
  });

  it('anthropic-api falls through to terminal message on 429 without Retry-After header', async () => {
    const provider = new AnthropicApiProvider();
    const events = await initProvider(provider);

    fetchMock.mockResolvedValueOnce(make429Response());

    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const terminal = events.find((e) => e.type === 'result');
    expect(terminal).toBeDefined();
    expect((terminal as { type: string; text: string | null }).text).toContain('Rate limited');
  });

  it('anthropic-api does not retry a second time after already retrying once', async () => {
    const provider = new AnthropicApiProvider();
    const events = await initProvider(provider);

    fetchMock
      .mockResolvedValueOnce(make429Response(1))
      .mockResolvedValueOnce(make429Response(1));

    const sendPromise = provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'Hello' }],
    });

    await vi.advanceTimersByTimeAsync(1000);
    await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const terminal = events.find((e) => e.type === 'result');
    expect(terminal).toBeDefined();
    expect((terminal as { type: string; text: string | null }).text).toContain('Rate limited');
  });
});
