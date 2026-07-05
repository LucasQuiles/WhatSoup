import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Erasure semantics: capture_observation/forget_observation (src/mcp/tools/
// substrate.ts) model entity_observations as tombstoneable — forget_observation
// exists specifically so a captured observation's content can be made to
// disappear. #1661 activated durability recording for the global tier, and
// ToolRegistry.call() durability-records every global tool's FULL raw
// arguments (JSON.stringify(effectiveParams)) into tool_calls.tool_input with
// no redaction. Left unfixed, a forgotten observation's verbatim text/metadata
// would silently survive in that telemetry copy until 30-day retention
// pruning — the tombstone contract bypassed for up to 30 days.
//
// These tests pin a redaction gate at the recording site in registry.ts: the
// literal marker below is intentionally hardcoded (not imported from
// registry.ts) so the assertion is a genuine behavioral check against the
// recorded bytes, not a tautology against whatever constant the
// implementation happens to export.
// ---------------------------------------------------------------------------

const REDACTED_MARKER = '[redacted:erasure-sensitive]';

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

describe('ToolRegistry.call erasure-sensitive redaction', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('records a fixed marker instead of raw args for capture_observation', async () => {
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
    const toolInput = recordCall!.args[2] as string;
    expect(toolInput).toBe(REDACTED_MARKER);
    expect(toolInput).not.toContain('Secret St');
    expect(toolInput).not.toContain('+15551234567');
  });

  it('records a fixed marker instead of raw args for forget_observation', async () => {
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
    const toolInput = recordCall!.args[2] as string;
    expect(toolInput).toBe(REDACTED_MARKER);
    expect(toolInput).not.toContain('home address');
  });

  it('still records raw args verbatim for a non-sensitive tool (no over-redaction)', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    registry.setDurability(recordingDurability(calls));
    registry.register(
      makeTool({
        name: 'list_beads',
        schema: z.object({ owner_jid: z.string() }),
      }),
    );

    await registry.call('list_beads', { owner_jid: '15550000001@s.whatsapp.net' }, makeSession());

    const recordCall = calls.find((c) => c.method === 'recordToolCall');
    expect(recordCall).toBeDefined();
    const toolInput = recordCall!.args[2] as string;
    expect(toolInput).toBe(JSON.stringify({ owner_jid: '15550000001@s.whatsapp.net' }));
  });
});
