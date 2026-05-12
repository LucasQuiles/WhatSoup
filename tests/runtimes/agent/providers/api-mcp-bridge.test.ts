import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../../../../src/runtimes/agent/stream-parser.ts';
import { ToolRegistry } from '../../../../src/mcp/registry.ts';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { createProviderMcpBridge } from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(() => 'test-api-key'),
}));

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
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
      (message) => message.role === 'user' && Array.isArray(message.content),
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
});
