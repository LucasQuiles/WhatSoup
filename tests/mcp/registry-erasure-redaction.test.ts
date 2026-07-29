import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Metadata-only durability routing: ToolRegistry passes only a bounded group
// to DurabilityEngine. The engine owns the fixed storage marker, so raw caller
// parameters never cross this boundary for sensitive or ordinary tools.
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', ...overrides };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({}),
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

function recordingDurability(calls: Array<{ method: string; args: unknown[] }>) {
  return {
    recordToolCall: (conversationKey: string, toolName: string, input: string, replayPolicy: string) => {
      calls.push({ method: 'recordToolCall', args: [conversationKey, toolName, input, replayPolicy] });
      return 1;
    },
    markToolExecuting: () => {},
    markToolComplete: () => {},
  } as unknown as import('../../src/core/durability.ts').DurabilityEngine;
}

describe('ToolRegistry.call metadata-only durability routing', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('passes a bounded group instead of raw args for capture_observation', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(
      makeTool({
        name: 'capture_observation',
        schema: z.object({
          entity_ref: z.string(),
          text: z.string(),
          metadata: z.record(z.unknown()).optional(),
        }),
      }),
    );

    await registry.call(
      'capture_observation',
      {
        entity_ref: 'person:jane',
        text: 'lives at 123 Secret St, phone +15551234567',
        metadata: { phone: '+15551234567' },
      },
      makeSession(),
    );

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    const toolGroup = recordCall!.args[2] as string;
    expect(toolGroup).toBe('other');
    expect(JSON.stringify(recordCall)).not.toContain('Secret St');
    expect(JSON.stringify(recordCall)).not.toContain('+15551234567');
  });

  it('passes a bounded group instead of raw args for forget_observation', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(
      makeTool({
        name: 'forget_observation',
        schema: z.object({ id: z.number(), reason: z.string() }),
      }),
    );

    await registry.call(
      'forget_observation',
      { id: 42, reason: 'user requested erasure of home address' },
      makeSession(),
    );

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    const toolGroup = recordCall!.args[2] as string;
    expect(toolGroup).toBe('other');
    expect(JSON.stringify(recordCall)).not.toContain('home address');
  });

  it('passes a declared bounded group for an ordinary tool', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(
      makeTool({
        name: 'list_beads',
        group: 'audit',
        schema: z.object({ owner_jid: z.string() }),
      }),
    );

    await registry.call('list_beads', { owner_jid: '15550000001@s.whatsapp.net' }, makeSession());

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    const toolGroup = recordCall!.args[2] as string;
    expect(toolGroup).toBe('audit');
    expect(JSON.stringify(recordCall)).not.toContain('15550000001@s.whatsapp.net');
  });
});
