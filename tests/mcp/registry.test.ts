import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

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
});
