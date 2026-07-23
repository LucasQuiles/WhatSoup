import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { toolError, type ToolDeclaration, type SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', ...overrides };
}

function chatSession(
  conversationKey: string,
  deliveryJid: string,
): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({ message: z.string() }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async (params) => ({ echo: params['message'] }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // --- Registration ---

  it('registers a tool and lists it', () => {
    registry.register(makeTool());
    const session = makeSession();
    const tools = registry.listTools(session);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test_tool');
    expect(tools[0].description).toBe('A test tool');
  });

  it('throws on duplicate registration', () => {
    registry.register(makeTool());
    expect(() => registry.register(makeTool())).toThrow('Tool already registered: test_tool');
  });

  // --- listTools filtering by scope ---

  it('listTools shows chat-scope tools for global sessions', () => {
    registry.register(makeTool({ name: 'chat_tool', scope: 'chat' }));
    registry.register(makeTool({ name: 'global_tool', scope: 'global' }));
    const tools = registry.listTools(makeSession({ tier: 'global' }));
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['chat_tool', 'global_tool']));
    expect(tools).toHaveLength(2);
  });

  it('listTools filters out global tools for chat-scoped sessions', () => {
    registry.register(makeTool({ name: 'chat_tool', scope: 'chat' }));
    registry.register(makeTool({ name: 'global_tool', scope: 'global' }));
    const tools = registry.listTools(chatSession('18001234567', '18001234567@s.whatsapp.net'));
    expect(tools.map((t) => t.name)).toEqual(['chat_tool']);
    expect(tools).toHaveLength(1);
  });

  // --- listTools schema adaptation for injected tools ---

  it('listTools omits chatJid from injected tool schema in chat-scoped session', () => {
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ text: z.string() }),
      }),
    );
    const tools = registry.listTools(chatSession('18001234567', '18001234567@s.whatsapp.net'));
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).not.toHaveProperty('chatJid');
  });

  it('listTools omits caller target fields from alias-target injected tool schema in chat-scoped session', () => {
    registry.register(
      makeTool({
        name: 'alias_target_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({
          chatJid: z.string().optional(),
          to: z.string().optional(),
          message: z.string(),
        }),
      }),
    );
    const tools = registry.listTools(chatSession('18001234567', '18001234567@s.whatsapp.net'));
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).not.toHaveProperty('chatJid');
    expect(schema.properties).not.toHaveProperty('to');
    expect(schema.required).toEqual(['message']);
  });

  it('listTools adds chatJid as required in injected tool schema for global session', () => {
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ text: z.string() }),
      }),
    );
    const tools = registry.listTools(makeSession({ tier: 'global' }));
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('chatJid');
    expect(schema.required).toContain('chatJid');
  });

  it('listTools exposes chatJid or to for alias-target injected tool schema in global session', () => {
    registry.register(
      makeTool({
        name: 'alias_target_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({
          chatJid: z.string().optional(),
          to: z.string().optional(),
          message: z.string(),
        }),
      }),
    );
    const tools = registry.listTools(makeSession({ tier: 'global' }));
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).toHaveProperty('chatJid');
    expect(schema.properties).toHaveProperty('to');
    expect(schema.required).toEqual(['message']);
  });

  it('listTools does not add chatJid for caller-supplied tools in global session', () => {
    registry.register(
      makeTool({
        name: 'caller_tool',
        scope: 'chat',
        targetMode: 'caller-supplied',
        schema: z.object({ text: z.string() }),
      }),
    );
    const tools = registry.listTools(makeSession({ tier: 'global' }));
    const schema = tools[0].inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(schema.properties).not.toHaveProperty('chatJid');
  });

  // --- call: scope enforcement ---

  it('rejects global-scope tool when called in chat-scoped session', async () => {
    registry.register(makeTool({ name: 'global_tool', scope: 'global' }));
    const result = await registry.call(
      'global_tool',
      { message: 'hi' },
      chatSession('18001234567', '18001234567@s.whatsapp.net'),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available in a chat-scoped session/);
  });

  it('returns error for unknown tool name', async () => {
    const result = await registry.call('nonexistent', {}, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown tool/);
  });

  // --- call: injected tools in chat-scoped sessions ---

  it('auto-fills deliveryJid as chatJid for injected tool in chat-scoped session', async () => {
    let capturedParams: Record<string, unknown> = {};
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => {
          capturedParams = params;
          return 'ok';
        },
      }),
    );

    const session = chatSession('18001234567', '18001234567@s.whatsapp.net');
    const result = await registry.call('injected_tool', { message: 'hello' }, session);

    expect(result.isError).toBeUndefined();
    expect(capturedParams['chatJid']).toBe('18001234567@s.whatsapp.net');
    expect(capturedParams['message']).toBe('hello');
  });

  it('auto-fills deliveryJid and ignores caller alias target for injected tool in chat-scoped session', async () => {
    let capturedParams: Record<string, unknown> = {};
    registry.register(
      makeTool({
        name: 'alias_target_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({
          chatJid: z.string().optional(),
          to: z.string().optional(),
          message: z.string(),
        }),
        handler: async (params) => {
          capturedParams = params;
          return 'ok';
        },
      }),
    );

    const session = chatSession('18001234567', '18001234567@s.whatsapp.net');
    const result = await registry.call('alias_target_tool', { to: 'bob', message: 'hello' }, session);

    expect(result.isError).toBeUndefined();
    expect(capturedParams['chatJid']).toBe('18001234567@s.whatsapp.net');
    expect(capturedParams).not.toHaveProperty('to');
    expect(capturedParams['message']).toBe('hello');
  });

  it('returns error when chat-scoped session has no deliveryJid for injected tool', async () => {
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      }),
    );

    const session: SessionContext = { tier: 'chat-scoped', conversationKey: '18001234567' };
    const result = await registry.call('injected_tool', { message: 'hello' }, session);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no deliveryJid/);
  });

  // --- call: injected tools in global sessions ---

  it('requires chatJid for injected tool in global session (error without it)', async () => {
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      }),
    );
    const result = await registry.call('injected_tool', { message: 'hello' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires chatJid/);
  });

  it('accepts to-only params for alias-target injected tool in global session', async () => {
    let capturedParams: Record<string, unknown> = {};
    registry.register(
      makeTool({
        name: 'alias_target_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({
          chatJid: z.string().optional(),
          to: z.string().optional(),
          message: z.string(),
        }),
        handler: async (params) => {
          capturedParams = params;
          return 'ok';
        },
      }),
    );

    const result = await registry.call(
      'alias_target_tool',
      { to: 'ops', message: 'hello' },
      makeSession({ tier: 'global' }),
    );

    expect(result.isError).toBeUndefined();
    expect(capturedParams['to']).toBe('ops');
    expect(capturedParams).not.toHaveProperty('chatJid');
  });

  it('requires chatJid or to for alias-target injected tool in global session', async () => {
    registry.register(
      makeTool({
        name: 'alias_target_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({
          chatJid: z.string().optional(),
          to: z.string().optional(),
          message: z.string(),
        }),
      }),
    );

    const result = await registry.call(
      'alias_target_tool',
      { message: 'hello' },
      makeSession({ tier: 'global' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires chatJid or to/);
  });

  it('accepts chatJid for injected tool in global session and invokes handler', async () => {
    let capturedParams: Record<string, unknown> = {};
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => {
          capturedParams = params;
          return 'ok';
        },
      }),
    );

    const result = await registry.call(
      'injected_tool',
      { chatJid: '18001234567@s.whatsapp.net', message: 'hello' },
      makeSession({ tier: 'global' }),
    );

    expect(result.isError).toBeUndefined();
    expect(capturedParams['chatJid']).toBe('18001234567@s.whatsapp.net');
  });

  // --- call: cross-conversation rejection ---

  it('rejects injected tool when chatJid resolves to different conversationKey', async () => {
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      }),
    );

    // Session is bound to conversation '18001234567' but caller supplies a different JID
    const session: SessionContext = {
      tier: 'global',
      conversationKey: '18001234567',
    };
    const result = await registry.call(
      'injected_tool',
      { chatJid: '19995551234@s.whatsapp.net', message: 'hello' },
      session,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not match session conversation/);
  });

  it('accepts injected tool when chatJid resolves to the matching conversationKey', async () => {
    let capturedChatJid: unknown;
    registry.register(
      makeTool({
        name: 'injected_tool',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => {
          capturedChatJid = params['chatJid'];
          return 'ok';
        },
      }),
    );

    const session: SessionContext = {
      tier: 'global',
      conversationKey: '18001234567',
    };
    const result = await registry.call(
      'injected_tool',
      { chatJid: '18001234567@s.whatsapp.net', message: 'hello' },
      session,
    );

    expect(result.isError).toBeUndefined();
    expect(capturedChatJid).toBe('18001234567@s.whatsapp.net');
  });

  // --- call: caller-supplied tools ---

  it('calls a caller-supplied chat tool successfully', async () => {
    registry.register(
      makeTool({
        name: 'chat_tool',
        scope: 'chat',
        targetMode: 'caller-supplied',
        schema: z.object({ message: z.string() }),
      }),
    );
    const result = await registry.call(
      'chat_tool',
      { message: 'world' },
      chatSession('18001234567', '18001234567@s.whatsapp.net'),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('world');
  });

  it('returns error when schema validation fails', async () => {
    registry.register(makeTool({ schema: z.object({ count: z.number() }) }));
    const result = await registry.call('test_tool', { count: 'not-a-number' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid parameters/);
  });

  it('returns error when handler throws', async () => {
    registry.register(
      makeTool({
        schema: z.object({}),
        handler: async () => {
          throw new Error('handler exploded');
        },
      }),
    );
    const result = await registry.call('test_tool', {}, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/handler exploded/);
  });

  it('marks explicitly returned tool errors with isError', async () => {
    registry.register(
      makeTool({
        schema: z.object({}),
        handler: async () => toolError({ error: 'denied' }),
      }),
    );

    const result = await registry.call('test_tool', {}, makeSession());

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'denied' });
  });

  it('does not treat ordinary domain error fields as tool failures', async () => {
    registry.register(
      makeTool({
        schema: z.object({}),
        handler: async () => ({ id: 123, status: 'failed', error: 'delivery failed' }),
      }),
    );

    const result = await registry.call('test_tool', {}, makeSession());

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      id: 123,
      status: 'failed',
      error: 'delivery failed',
    });
  });

  it('does not infer tool failure from a tool name or top-level error field', async () => {
    registry.register(
      makeTool({
        name: 'send_message',
        schema: z.object({}),
        handler: async () => ({ sent: true, error: 'provider annotated delivery' }),
      }),
    );

    const result = await registry.call('send_message', {}, makeSession());

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({
      sent: true,
      error: 'provider annotated delivery',
    });
  });

  // --- Zod-to-JSON-Schema conversion spot checks ---

  it('converts ZodObject schema to JSON Schema with required fields', () => {
    registry.register(
      makeTool({
        schema: z.object({
          required_field: z.string(),
          optional_field: z.string().optional(),
        }),
      }),
    );
    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties['required_field']).toEqual({ type: 'string' });
    expect(schema.properties['optional_field']).toEqual({ type: 'string' });
    expect(schema.required).toContain('required_field');
    expect(schema.required).not.toContain('optional_field');
  });

  it('converts ZodEnum to JSON Schema enum', () => {
    registry.register(
      makeTool({
        schema: z.object({ color: z.enum(['red', 'green', 'blue']) }),
      }),
    );
    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      properties: Record<string, { type: string; enum: string[] }>;
    };
    expect(schema.properties['color'].type).toBe('string');
    expect(schema.properties['color'].enum).toEqual(['red', 'green', 'blue']);
  });

  it('converts ZodArray to JSON Schema array with items', () => {
    registry.register(
      makeTool({
        schema: z.object({ tags: z.array(z.string()) }),
      }),
    );
    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      properties: Record<string, { type: string; items: { type: string } }>;
    };
    expect(schema.properties['tags'].type).toBe('array');
    expect(schema.properties['tags'].items).toEqual({ type: 'string' });
  });

  it('preserves Zod descriptions in JSON Schema for portable MCP tool planners', () => {
    registry.register(
      makeTool({
        schema: z.object({
          question: z.string().describe('Question shown to the user'),
          options: z.array(
            z.string().describe('Short option label'),
          ).describe('Available choices'),
          selectableCount: z.number().optional().describe('Maximum number of choices'),
        }).describe('Poll request'),
      }),
    );

    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      description?: string;
      properties: Record<string, { description?: string; items?: { description?: string } }>;
    };

    expect(schema.description).toBe('Poll request');
    expect(schema.properties['question'].description).toBe('Question shown to the user');
    expect(schema.properties['options'].description).toBe('Available choices');
    expect(schema.properties['options'].items?.description).toBe('Short option label');
    expect(schema.properties['selectableCount'].description).toBe('Maximum number of choices');
  });

  it('keeps default ZodRecord schemas byte-compatible while rich opt-in preserves value schemas', () => {
    registry.register(
      makeTool({
        schema: z.object({
          metadata: z.record(z.unknown()),
          labels: z.record(z.array(z.string())),
        }),
      }),
    );
    const defaultTools = registry.listTools(makeSession());
    const defaultSchema = defaultTools[0].inputSchema as {
      properties: Record<string, { type: string; additionalProperties?: unknown }>;
    };
    expect(JSON.stringify(defaultSchema.properties['metadata'])).toBe('{"type":"object"}');
    expect(JSON.stringify(defaultSchema.properties['labels'])).toBe('{"type":"object"}');

    const richTools = registry.listTools(makeSession(), { richRecordSchemas: true });
    const richSchema = richTools[0].inputSchema as {
      properties: Record<string, { type: string; additionalProperties?: unknown }>;
    };
    expect(richSchema.properties['metadata']).toEqual({ type: 'object', additionalProperties: {} });
    expect(richSchema.properties['labels']).toEqual({
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    });
  });

  it('converts ZodBoolean to JSON Schema boolean', () => {
    registry.register(
      makeTool({
        schema: z.object({ enabled: z.boolean() }),
      }),
    );
    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      properties: Record<string, { type: string }>;
    };
    expect(schema.properties['enabled']).toEqual({ type: 'boolean' });
  });

  it('omits required array for an empty ZodObject schema', () => {
    registry.register(
      makeTool({
        schema: z.object({}),
      }),
    );
    const tools = registry.listTools(makeSession());
    const schema = tools[0].inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toBeUndefined();
    expect(schema.properties).toEqual({});
  });
});

describe('registry.ts uncovered-branch coverage', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('getChatScopedToolNames lists only chat-scoped tools', () => {
    registry.register(makeTool({ name: 'chat_one', scope: 'chat' }));
    registry.register(makeTool({ name: 'chat_two', scope: 'chat' }));
    registry.register(makeTool({ name: 'global_one', scope: 'global' }));

    const names = registry.getChatScopedToolNames();
    expect(names).toEqual(['chat_one', 'chat_two']);
  });

  it('injected tool with no properties/required gets chatJid appended (covers ?? {} and ?? [])', () => {
    // An empty schema has no `properties`/`required` keys in its JSON form, so the
    // injected-tool builder falls back to `{}` and `[]`.
    registry.register(
      makeTool({
        name: 'injected_empty',
        targetMode: 'injected',
        schema: z.object({}),
      }),
    );

    const tools = registry.listTools(makeSession({ tier: 'global' }));
    const schema = tools[0].inputSchema as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties['chatJid']).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['chatJid']);
  });

  it('records durability lifecycle (record → executing → complete) on a successful call', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fakeDurability = {
      recordToolCall: (conversationKey: string, toolName: string, input: string, replayPolicy: string) => {
        const id = 4242;
        calls.push({ method: 'recordToolCall', args: [conversationKey, toolName, input, replayPolicy] });
        return id;
      },
      markToolExecuting: (id: number) => {
        calls.push({ method: 'markToolExecuting', args: [id] });
      },
      markToolComplete: (id: number, result: string) => {
        calls.push({ method: 'markToolComplete', args: [id, result] });
      },
    };
    registry.setDurability(fakeDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine);
    registry.register(makeTool({ name: 'durable_tool', scope: 'global' }));

    const result = await registry.call(
      'durable_tool',
      { message: 'hi' },
      makeSession({ tier: 'global', conversationKey: '15550000001@s.whatsapp.net' }),
    );

    expect(calls.map((c) => c.method)).toEqual([
      'recordToolCall',
      'markToolExecuting',
      'markToolComplete',
    ]);
    expect(calls[1].args[0]).toBe(4242);
    expect(calls[2].args[0]).toBe(4242);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('hi');
  });

  // --- W6: tool_calls telemetry for global-tier sessions ---
  //
  // Global-tier sessions (operator-agent / primary-line) carry no
  // conversationKey, so before W6 the durability recording gate was falsy and
  // recordToolCall was never invoked — only chat-scoped hosts emitted tool
  // telemetry. These lock in the reserved '__global__' sentinel key.

  function recordingDurability(calls: Array<{ method: string; args: unknown[] }>) {
    return {
      recordToolCall: (conversationKey: string, toolName: string, input: string, replayPolicy: string) => {
        calls.push({ method: 'recordToolCall', args: [conversationKey, toolName, input, replayPolicy] });
        return 99;
      },
      markToolExecuting: (id: number) => {
        calls.push({ method: 'markToolExecuting', args: [id] });
      },
      markToolComplete: (id: number, result: string) => {
        calls.push({ method: 'markToolComplete', args: [id, result] });
      },
    } as unknown as import('../../src/core/durability.ts').DurabilityEngine;
  }

  it('records tool_calls under the __global__ sentinel for a global-tier session with no conversationKey', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(makeTool({ name: 'global_durable', scope: 'global' }));

    const result = await registry.call(
      'global_durable',
      { message: 'hi' },
      makeSession({ tier: 'global' }), // no conversationKey
    );

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    expect(recordCall!.args[0]).toBe('__global__');
    expect(recordCall!.args[1]).toBe('global_durable');
    expect(calls.map((c) => c.method)).toEqual([
      'recordToolCall',
      'markToolExecuting',
      'markToolComplete',
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"echo": "hi"');
  });

  it('records tool_calls under the real conversationKey for a chat-scoped session (unchanged by W6)', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(makeTool({ name: 'chat_durable', scope: 'chat' }));

    const result = await registry.call(
      'chat_durable',
      { message: 'hi' },
      chatSession('15550000002', '15550000002@s.whatsapp.net'),
    );

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    expect(recordCall!.args[0]).toBe('15550000002');
    expect(recordCall!.args[1]).toBe('chat_durable');
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"echo": "hi"');
  });

  it('skips durability recording entirely when no durability engine is attached (both tiers)', async () => {
    // No setDurability(): the recording gate must short-circuit before touching
    // markToolExecuting/markToolComplete (which would throw on the absent engine).
    registry.register(makeTool({ name: 'global_no_dur', scope: 'global' }));
    registry.register(makeTool({ name: 'chat_no_dur', scope: 'chat' }));

    const globalResult = await registry.call(
      'global_no_dur',
      { message: 'hi' },
      makeSession({ tier: 'global' }), // no conversationKey — sentinel path, still no engine
    );
    const chatResult = await registry.call(
      'chat_no_dur',
      { message: 'hi' },
      chatSession('15550000002', '15550000002@s.whatsapp.net'),
    );

    expect(globalResult.isError).toBeUndefined();
    expect(chatResult.isError).toBeUndefined();
    // Both tools still executed and returned their payloads — recording was the
    // only thing skipped.
    expect(globalResult.content[0].text).toContain('"echo": "hi"');
    expect(chatResult.content[0].text).toContain('"echo": "hi"');
  });

  it('marks tool complete with the error message when the handler throws an Error', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fakeDurability = {
      recordToolCall: () => {
        calls.push({ method: 'recordToolCall', args: [] });
        return 777;
      },
      markToolExecuting: (id: number) => calls.push({ method: 'markToolExecuting', args: [id] }),
      markToolComplete: (id: number, result: string) => calls.push({ method: 'markToolComplete', args: [id, result] }),
    };
    registry.setDurability(fakeDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine);
    registry.register(
      makeTool({
        name: 'durable_fail',
        scope: 'global',
        schema: z.object({}),
        handler: async () => {
          throw new Error('boom');
        },
      }),
    );

    const result = await registry.call(
      'durable_fail',
      {},
      makeSession({ tier: 'global', conversationKey: '15550000001@s.whatsapp.net' }),
    );

    expect(calls[2].args[1]).toBe('error: boom');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool "durable_fail" failed: boom');
  });

  it('stringifies non-Error thrown values (err instanceof Error false branch)', async () => {
    registry.register(
      makeTool({
        name: 'non_error_throw',
        scope: 'global',
        schema: z.object({}),
        handler: async () => {
          // Intentionally throw a non-Error to exercise the String(err) branch.
          // eslint-disable-next-line no-throw-literal -- deliberate non-Error throw for branch coverage (expires 2027-06-17)
          throw 'plain string failure';
        },
      }),
    );

    const result = await registry.call('non_error_throw', {}, makeSession());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool "non_error_throw" failed: plain string failure');
  });

  it('sanitizes connection-level transport errors before exposing them', async () => {
    registry.register(
      makeTool({
        name: 'transport_fail',
        scope: 'global',
        schema: z.object({}),
        handler: async () => {
          const err = new Error('write ECONNRESET at TCPOnSession');
          throw err;
        },
      }),
    );

    const result = await registry.call('transport_fail', {}, makeSession());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool "transport_fail" failed: connection error — try again');
  });

  it('rejects a malformed caller chatJid in a global session bound to a conversationKey', async () => {
    registry.register(
      makeTool({
        name: 'injected_global',
        targetMode: 'injected',
        scope: 'global',
        schema: z.object({ message: z.string() }),
        handler: async (params) => ({ echoed: params['message'] }),
      }),
    );

    const result = await registry.call(
      'injected_global',
      { chatJid: 'not-a-jid', message: 'hi' },
      makeSession({ tier: 'global', conversationKey: '15550000001' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Invalid chatJid "not-a-jid": must be a valid JID');
  });
});

// #1753 rem-2: MCP/send-path liveness. A wedged tool.handler() (async-hung send
// path) never pins the event loop, so loop-lag sampling structurally cannot see
// it — getInFlightCallStats is the only signal for that failure mode.
describe('ToolRegistry.getInFlightCallStats', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('reports zero pending calls with no in-flight tool handlers', () => {
    expect(registry.getInFlightCallStats()).toEqual({
      pendingCount: 0,
      oldestCallAgeMs: null,
      oldestCallTool: null,
    });
  });

  it('reports a pending call while its handler is still awaiting', async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    registry.register(
      makeTool({
        name: 'slow_tool',
        scope: 'global',
        schema: z.object({}),
        handler: async () => {
          await handlerGate;
          return { ok: true };
        },
      }),
    );

    const callPromise = registry.call('slow_tool', {}, makeSession());
    // Yield so the async handler actually starts and registers itself before
    // we inspect in-flight state — call() awaits synchronously up to the
    // handler invocation.
    await Promise.resolve();
    await Promise.resolve();

    const midFlight = registry.getInFlightCallStats(Date.now());
    expect(midFlight.pendingCount).toBe(1);
    expect(midFlight.oldestCallTool).toBe('slow_tool');
    expect(midFlight.oldestCallAgeMs).not.toBeNull();
    expect(midFlight.oldestCallAgeMs!).toBeGreaterThanOrEqual(0);

    releaseHandler();
    await callPromise;

    expect(registry.getInFlightCallStats()).toEqual({
      pendingCount: 0,
      oldestCallAgeMs: null,
      oldestCallTool: null,
    });
  });

  it('deregisters the in-flight call even when the handler throws', async () => {
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((_resolve, reject) => { releaseHandler = () => reject(new Error('boom')); });
    registry.register(
      makeTool({
        name: 'throwing_tool',
        scope: 'global',
        schema: z.object({}),
        handler: async () => { await handlerGate; },
      }),
    );

    const callPromise = registry.call('throwing_tool', {}, makeSession());
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.getInFlightCallStats().pendingCount).toBe(1);

    releaseHandler();
    const result = await callPromise;

    expect(result.isError).toBe(true);
    expect(registry.getInFlightCallStats()).toEqual({
      pendingCount: 0,
      oldestCallAgeMs: null,
      oldestCallTool: null,
    });
  });

  it('reports the OLDEST call and the total pending count with multiple concurrent calls', async () => {
    const gates: Array<() => void> = [];
    registry.register(
      makeTool({
        name: 'concurrent_tool',
        scope: 'global',
        schema: z.object({}),
        handler: async () => {
          await new Promise<void>((resolve) => { gates.push(resolve); });
          return { ok: true };
        },
      }),
    );

    const first = registry.call('concurrent_tool', {}, makeSession());
    await Promise.resolve();
    await Promise.resolve();
    const second = registry.call('concurrent_tool', {}, makeSession());
    await Promise.resolve();
    await Promise.resolve();

    const stats = registry.getInFlightCallStats();
    expect(stats.pendingCount).toBe(2);
    expect(stats.oldestCallTool).toBe('concurrent_tool');

    gates.forEach((release) => release());
    await Promise.all([first, second]);
    expect(registry.getInFlightCallStats().pendingCount).toBe(0);
  });
});
