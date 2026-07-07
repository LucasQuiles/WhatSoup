import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// ---------------------------------------------------------------------------
// Containment: durability/telemetry writes must never gate the tool call.
//
// ToolRegistry.call() records tool_calls telemetry (recordToolCall /
// markToolExecuting / markToolComplete) around every tool invocation. None of
// those DurabilityEngine methods have internal error handling — raw
// synchronous node:sqlite .run() calls. A throw from any of them (SQLITE_BUSY
// under lock contention, SQLITE_FULL on disk pressure) must degrade to "no
// telemetry recorded", never "tool call failed". This is newly load-bearing
// for the global/operator tier (#1661 activated recording for sessions with
// no conversationKey under the __global__ sentinel), which is exactly the
// tier holding recovery tools like self_restart/resync_app_state — a
// DB-unhealthy instance is exactly when an operator reaches for one of those
// and exactly when these writes are likely to throw.
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return { tier: 'global', ...overrides };
}

function makeTool(overrides: Partial<ToolDeclaration> = {}): ToolDeclaration {
  return {
    name: 'test_tool',
    description: 'A test tool',
    schema: z.object({ message: z.string() }),
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async (params) => ({ echo: params['message'] }),
    ...overrides,
  };
}

describe('ToolRegistry.call durability containment', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    mockWarn.mockClear();
  });

  it('still invokes the tool handler and returns its result when recordToolCall throws', async () => {
    let handlerInvoked = false;
    const throwingDurability = {
      recordToolCall: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      markToolExecuting: vi.fn(),
      markToolComplete: vi.fn(),
    };
    registry.setDurability(
      throwingDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine,
    );
    registry.register(
      makeTool({
        handler: async (params) => {
          handlerInvoked = true;
          return { echo: params['message'] };
        },
      }),
    );

    const result = await registry.call('test_tool', { message: 'hi' }, makeSession());

    expect(handlerInvoked).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: 'hi' });
    // durabilityId never resolved, so the downstream lifecycle call must not fire.
    expect(throwingDurability.markToolExecuting).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatchObject({ tool: 'test_tool' });
    expect(mockWarn.mock.calls[0][0].err).toBeInstanceOf(Error);
  });

  it('still invokes the tool handler and returns its result when markToolExecuting throws', async () => {
    let handlerInvoked = false;
    const throwingDurability = {
      recordToolCall: () => 55,
      markToolExecuting: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      markToolComplete: vi.fn(),
    };
    registry.setDurability(
      throwingDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine,
    );
    registry.register(
      makeTool({
        handler: async (params) => {
          handlerInvoked = true;
          return { echo: params['message'] };
        },
      }),
    );

    const result = await registry.call('test_tool', { message: 'hi' }, makeSession());

    expect(handlerInvoked).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: 'hi' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('still returns the successful tool result when markToolComplete throws on the success path', async () => {
    const throwingDurability = {
      recordToolCall: () => 77,
      markToolExecuting: vi.fn(),
      markToolComplete: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
    };
    registry.setDurability(
      throwingDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine,
    );
    registry.register(makeTool());

    const result = await registry.call('test_tool', { message: 'hi' }, makeSession());

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ echo: 'hi' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('still surfaces the original handler error when markToolComplete throws on the error path', async () => {
    const throwingDurability = {
      recordToolCall: () => 88,
      markToolExecuting: vi.fn(),
      markToolComplete: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
    };
    registry.setDurability(
      throwingDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine,
    );
    registry.register(
      makeTool({
        schema: z.object({}),
        handler: async () => {
          throw new Error('handler exploded');
        },
      }),
    );

    const result = await registry.call('test_tool', {}, makeSession());

    // The tool's own error must win — a durability failure on the way out
    // must not replace or mask the real handler error.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool "test_tool" failed: handler exploded');
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('still returns the uniform deny reply when the deny-path recordToolCall throws (QR-239)', async () => {
    const throwingDurability = {
      recordToolCall: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
      markToolExecuting: vi.fn(),
      markToolComplete: vi.fn(),
    };
    registry.setDurability(
      throwingDurability as unknown as import('../../src/core/durability.ts').DurabilityEngine,
    );
    registry.register(makeTool({ name: 'sensitive_tool', sensitive: true }));

    const result = await registry.call(
      'sensitive_tool',
      { message: 'hi' },
      makeSession({ actorJid: '15550000001@s.whatsapp.net', conversationKey: '15550000009' }),
    );

    // Uniform non-disclosing deny reply, unaffected by the durability throw
    // (no authorizer is installed, so this is a denial regardless).
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Unknown tool: sensitive_tool');
    // recordToolCall threw, so nothing downstream in the deny-path's
    // denyId-chained writes can fire.
    expect(throwingDurability.markToolExecuting).not.toHaveBeenCalled();
    expect(throwingDurability.markToolComplete).not.toHaveBeenCalled();
    // Two distinct warns: the R1 denial itself always logs (unrelated to
    // durability), and the caught durability throw logs a second, separate
    // warning — unlike the main-path tests above, this deny path does not
    // start from a clean warn slate.
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn.mock.calls[0][0]).toMatchObject({ tool: 'sensitive_tool' });
    expect(mockWarn.mock.calls[1][0]).toMatchObject({ tool: 'sensitive_tool' });
    expect(mockWarn.mock.calls[1][0].err).toBeInstanceOf(Error);
  });
});
