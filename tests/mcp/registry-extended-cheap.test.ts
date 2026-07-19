/**
 * Extended cheap-tier test coverage for registry.ts edge cases and error paths.
 * Focuses on branch coverage for error conditions, schema validation, and durability paths
 * that are difficult to trigger in integration tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
// Typecheck fix during the 2026-07-17 wave-8 land: DurabilityEngine was never
// exported from mcp/types.ts (checked against the wave-8 branch point
// a36b52e3f — not source drift) and is unused elsewhere in this file; it
// lives in core/durability.ts. Dropped the dead import.
import type { SessionContext, ToolDeclaration, ToolCallResult } from '../../src/mcp/types.ts';

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', ...overrides };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'Test tool',
    schema: z.object({ message: z.string() }),
    scope: 'chat',
    targetMode: 'caller-supplied',
    handler: async () => 'ok',
    ...overrides,
  };
}

describe('ToolRegistry Extended Coverage', () => {
  describe('zodToJsonSchema edge cases', () => {
    it('converts ZodString with description', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          name: z.string().describe('A person name'),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x', name: 'Alice' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodNumber with description', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          count: z.number().describe('Item count'),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { count: 5, message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodBoolean with description', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          enabled: z.boolean().describe('Enable flag'),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { enabled: true, message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodArray element types', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          tags: z.array(z.string()),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { tags: ['a', 'b'], message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodEnum to string enum', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          status: z.enum(['active', 'inactive']),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { status: 'active', message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodRecord to object schema', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          metadata: z.record(z.string()),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { metadata: { key: 'value' }, message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('converts ZodOptional to schema without required marker', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          optional_field: z.string().optional(),
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });

    it('handles unrecognized Zod types with fallback empty schema', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          message: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBeFalsy();
    });
  });

  describe('sensitive-tool authorization (R1)', () => {
    it('denies sensitive tool when no authorizer installed (fail-closed)', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);

      const session = makeSession({ tier: 'global', actorJid: '123@s.whatsapp.net' });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('denies sensitive tool when actorJid is missing (fail-closed)', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);
      registry.setSensitiveToolAuthorizer(() => true);

      const session = makeSession({ tier: 'global', actorJid: undefined });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('denies sensitive tool when authorizer returns false', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);
      registry.setSensitiveToolAuthorizer(() => false);

      const session = makeSession({ tier: 'global', actorJid: '123@s.whatsapp.net' });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('denies sensitive tool when authorizer returns non-boolean truthy', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);
      registry.setSensitiveToolAuthorizer(() => 'yes' as unknown as boolean);

      const session = makeSession({ tier: 'global', actorJid: '123@s.whatsapp.net' });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
    });

    it('denies sensitive tool when authorizer throws', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);
      registry.setSensitiveToolAuthorizer(() => {
        throw new Error('auth exploded');
      });

      const session = makeSession({ tier: 'global', actorJid: '123@s.whatsapp.net' });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('allows sensitive tool when authorizer returns exactly true', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'sensitive_tool', sensitive: true });
      registry.register(tool);
      registry.setSensitiveToolAuthorizer(() => true);

      const session = makeSession({ tier: 'global', actorJid: '123@s.whatsapp.net' });
      const result = await registry.call('sensitive_tool', { message: 'x' }, session);

      expect(result.isError).toBeFalsy();
    });

    it('throws on second setSensitiveToolAuthorizer install', () => {
      const registry = new ToolRegistry();
      registry.setSensitiveToolAuthorizer(() => true);

      expect(() => {
        registry.setSensitiveToolAuthorizer(() => false);
      }).toThrow('sensitive-tool authorizer already installed');
    });
  });

  describe('in-flight call tracking (#1753)', () => {
    it('tracks pending calls with startedAt timestamp', async () => {
      const registry = new ToolRegistry();
      let callStarted = false;

      const tool = makeTool({
        handler: async () => {
          const stats = registry.getInFlightCallStats();
          callStarted = stats.pendingCount > 0;
          return 'ok';
        },
      });
      registry.register(tool);

      await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(callStarted).toBe(true);
    });

    it('returns pending count and oldest call age', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool();
      registry.register(tool);

      // No calls yet
      const initial = registry.getInFlightCallStats();
      expect(initial.pendingCount).toBe(0);
      expect(initial.oldestCallAgeMs).toBeNull();
      expect(initial.oldestCallTool).toBeNull();
    });

    it('clears in-flight call on handler completion', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool();
      registry.register(tool);

      await registry.call('test_tool', { message: 'x' }, makeSession());

      const stats = registry.getInFlightCallStats();
      expect(stats.pendingCount).toBe(0);
      expect(stats.oldestCallAgeMs).toBeNull();
    });

    it('clears in-flight call on handler error', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          throw new Error('handler failed');
        },
      });
      registry.register(tool);

      await registry.call('test_tool', { message: 'x' }, makeSession());

      const stats = registry.getInFlightCallStats();
      expect(stats.pendingCount).toBe(0);
    });
  });

  describe('scope enforcement', () => {
    it('rejects global tool in chat-scoped session', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'global_tool', scope: 'global' });
      registry.register(tool);

      const session = makeSession({ tier: 'chat-scoped', deliveryJid: '123@s.whatsapp.net' });
      const result = await registry.call('global_tool', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available in a chat-scoped session');
    });

    it('allows chat tool in chat-scoped session', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({ name: 'chat_tool', scope: 'chat' });
      registry.register(tool);

      const session = makeSession({ tier: 'chat-scoped', deliveryJid: '123@s.whatsapp.net' });
      const result = await registry.call('chat_tool', { message: 'x' }, session);

      expect(result.isError).toBeFalsy();
    });

    it('allows any tool in global session', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'chat_tool', scope: 'chat' }));
      registry.register(makeTool({ name: 'global_tool', scope: 'global' }));

      const session = makeSession({ tier: 'global' });
      const result1 = await registry.call('chat_tool', { message: 'x' }, session);
      const result2 = await registry.call('global_tool', { message: 'x' }, session);

      expect(result1.isError).toBeFalsy();
      expect(result2.isError).toBeFalsy();
    });
  });

  describe('injected tool target validation', () => {
    it('auto-fills chatJid from binding in conversation-bound socket', async () => {
      const registry = new ToolRegistry();
      let capturedJid: string | undefined;

      const tool = makeTool({
        name: 'send_msg',
        scope: 'chat',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => {
          capturedJid = params.chatJid as string;
          return 'ok';
        },
      });
      registry.register(tool);

      const session = makeSession({
        conversationKey: 'key@g.us',
        binding: {
          kind: 'conversation-bound',
          conversationKey: 'key@g.us',
          deliveryJid: '555@g.us',
        },
      });

      await registry.call('send_msg', { message: 'x' }, session);
      expect(capturedJid).toBe('555@g.us');
    });

    it('auto-fills deliveryJid in chat-scoped session', async () => {
      const registry = new ToolRegistry();
      let capturedJid: string | undefined;

      const tool = makeTool({
        name: 'send_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
        handler: async (params) => {
          capturedJid = params.chatJid as string;
          return 'ok';
        },
      });
      registry.register(tool);

      const session = makeSession({
        tier: 'chat-scoped',
        deliveryJid: '777@s.whatsapp.net',
      });

      await registry.call('send_msg', { message: 'test' }, session);
      expect(capturedJid).toBe('777@s.whatsapp.net');
    });

    it('rejects injected tool call with no deliveryJid in chat-scoped session', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        name: 'send_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      });
      registry.register(tool);

      const session = makeSession({
        tier: 'chat-scoped',
        deliveryJid: undefined,
      });

      const result = await registry.call('send_msg', { message: 'x' }, session);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('deliveryJid');
    });

    it('requires chatJid in global session for injected tool without alias support', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        name: 'send_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      });
      registry.register(tool);

      const session = makeSession({ tier: 'global' });
      const result = await registry.call('send_msg', { message: 'x' }, session);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('requires chatJid parameter');
    });

    it('allows alias target in global session when tool supports it', async () => {
      const registry = new ToolRegistry();
      let capturedTo: string | undefined;

      const tool = makeTool({
        name: 'forward_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string().optional(), to: z.string().optional(), message: z.string() }),
        handler: async (params) => {
          capturedTo = params.to as string;
          return 'ok';
        },
      });
      registry.register(tool);

      const session = makeSession({ tier: 'global' });
      await registry.call('forward_msg', { to: 'alias@s.whatsapp.net', message: 'x' }, session);

      expect(capturedTo).toBe('alias@s.whatsapp.net');
    });

    it('enforces cross-conversation guard when conversationKey is bound', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        name: 'send_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      });
      registry.register(tool);

      const session = makeSession({
        tier: 'global',
        conversationKey: 'key1@g.us',
      });

      // Try to send to a different conversation
      const result = await registry.call('send_msg', { chatJid: 'key2@g.us', message: 'x' }, session);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('does not match session conversation');
    });

    it('rejects invalid chatJid in cross-conversation guard', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        name: 'send_msg',
        targetMode: 'injected',
        schema: z.object({ chatJid: z.string(), message: z.string() }),
      });
      registry.register(tool);

      const session = makeSession({
        tier: 'global',
        conversationKey: 'valid@g.us',
      });

      const result = await registry.call('send_msg', { chatJid: 'INVALID-JID', message: 'x' }, session);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatJid');
    });
  });

  describe('schema validation error handling', () => {
    it('returns validation error for missing required field', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          message: z.string(),
          required_field: z.string(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid parameters');
    });

    it('returns validation error for wrong type', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        schema: z.object({
          message: z.number(),
        }),
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'not-a-number' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid parameters');
    });
  });

  describe('tool handler error sanitization', () => {
    it('sanitizes ECONNRESET transport errors', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          const err = new Error('write ECONNRESET at TCPConnection');
          throw err;
        },
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('connection error');
      expect(result.content[0].text).not.toContain('TCP');
    });

    it('sanitizes EPIPE transport errors', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          throw new Error('EPIPE write failed');
        },
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('connection error');
    });

    it('sanitizes certificate errors', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          throw new Error('certificate verification failed');
        },
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('connection error');
      expect(result.content[0].text).not.toContain('certificate');
    });

    it('keeps application-level error messages readable', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          throw new Error('user not found');
        },
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('user not found');
      expect(result.content[0].text).not.toContain('connection error');
    });

    it('handles non-Error throws gracefully', async () => {
      const registry = new ToolRegistry();
      const tool = makeTool({
        handler: async () => {
          throw 'plain string error';
        },
      });
      registry.register(tool);

      const result = await registry.call('test_tool', { message: 'x' }, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('failed');
    });
  });

  describe('getChatScopedToolNames', () => {
    it('returns empty array when no tools registered', () => {
      const registry = new ToolRegistry();
      expect(registry.getChatScopedToolNames()).toEqual([]);
    });

    it('returns only chat-scoped tool names', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'chat1', scope: 'chat' }));
      registry.register(makeTool({ name: 'global1', scope: 'global' }));
      registry.register(makeTool({ name: 'chat2', scope: 'chat' }));

      const names = registry.getChatScopedToolNames();
      expect(names).toContain('chat1');
      expect(names).toContain('chat2');
      expect(names).not.toContain('global1');
    });
  });

  describe('register method', () => {
    it('throws on duplicate tool name', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'dup' }));

      expect(() => {
        registry.register(makeTool({ name: 'dup' }));
      }).toThrow('Tool already registered: dup');
    });
  });

  describe('conversation-bound session access', () => {
    it('allows chat-scoped tools in conversation-bound session', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({
        name: 'chat_tool',
        scope: 'chat',
      }));

      const session = makeSession({
        binding: {
          kind: 'conversation-bound',
          conversationKey: 'key@g.us',
          deliveryJid: 'jid@g.us',
        },
      });

      const tools = registry.listTools(session);
      const hasChatTool = tools.some(t => t.name === 'chat_tool');
      expect(hasChatTool).toBe(true);
    });

    it('allows conversation-safe global tools in conversation-bound session', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({
        name: 'transcribe_audio',
        scope: 'global',
      }));

      const session = makeSession({
        binding: {
          kind: 'conversation-bound',
          conversationKey: 'key@g.us',
          deliveryJid: 'jid@g.us',
        },
      });

      const tools = registry.listTools(session);
      const hasTranscribe = tools.some(t => t.name === 'transcribe_audio');
      expect(hasTranscribe).toBe(true);
    });

    it('denies call to non-safe global tool in conversation-bound session', async () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({
        name: 'unsafe_global',
        scope: 'global',
      }));

      const session = makeSession({
        binding: {
          kind: 'conversation-bound',
          conversationKey: 'key@g.us',
          deliveryJid: 'jid@g.us',
        },
      });

      const result = await registry.call('unsafe_global', { message: 'x' }, session);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not available in a conversation-bound session');
    });
  });

  describe('listTools filtering', () => {
    it('sorts tools alphabetically', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'zebra' }));
      registry.register(makeTool({ name: 'apple' }));
      registry.register(makeTool({ name: 'monkey' }));

      const tools = registry.listTools(makeSession());
      expect(tools[0].name).toBe('apple');
      expect(tools[1].name).toBe('monkey');
      expect(tools[2].name).toBe('zebra');
    });

    it('hides global tools from chat-scoped sessions', () => {
      const registry = new ToolRegistry();
      registry.register(makeTool({ name: 'chat_only', scope: 'chat' }));
      registry.register(makeTool({ name: 'global_only', scope: 'global' }));

      const chatTools = registry.listTools(makeSession({ tier: 'chat-scoped', deliveryJid: '123@s.whatsapp.net' }));
      expect(chatTools.map(t => t.name)).not.toContain('global_only');
      expect(chatTools.map(t => t.name)).toContain('chat_only');
    });
  });
});
