import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  makeSockTool,
  registerSockTools,
} from '../../../src/mcp/tools/sock-tool-factory.ts';
import type {
  ToolDeclaration,
  ExtendedBaileysSocket,
  SessionContext,
} from '../../../src/mcp/types.ts';

function makeFakeSock(): ExtendedBaileysSocket {
  return { mock: true } as unknown as ExtendedBaileysSocket;
}

function makeSession(): SessionContext {
  return { tier: 'global' };
}

describe('makeSockTool', () => {
  it('returns a ToolDeclaration carrying the configured name, description, schema', () => {
    const schema = z.object({ jid: z.string() });
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'do_thing',
      description: 'Does the thing',
      schema,
      call: async () => 'ok',
    });

    expect(tool.name).toBe('do_thing');
    expect(tool.description).toBe('Does the thing');
    expect(tool.schema).toBe(schema);
  });

  it('defaults scope to "global" when omitted', () => {
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({}),
      call: async () => null,
    });
    expect(tool.scope).toBe('global');
  });

  it('defaults targetMode to "caller-supplied" when omitted', () => {
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({}),
      call: async () => null,
    });
    expect(tool.targetMode).toBe('caller-supplied');
  });

  it('honors explicit scope, targetMode, and replayPolicy', () => {
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'injected',
      replayPolicy: 'safe',
      call: async () => null,
    });
    expect(tool.scope).toBe('chat');
    expect(tool.targetMode).toBe('injected');
    expect(tool.replayPolicy).toBe('safe');
  });

  it('handler parses params via schema before dispatching to call', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({ count: z.number(), label: z.string() }),
      call,
    });

    const result = await tool.handler({ count: 5, label: 'hi', extra: 'dropped' }, makeSession());

    expect(result).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(1);
    const parsed = call.mock.calls[0]?.[0];
    expect(parsed).toEqual({ count: 5, label: 'hi' });
    expect(parsed).not.toHaveProperty('extra');
  });

  it('handler throws when schema validation fails', async () => {
    const call = vi.fn();
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({ count: z.number() }),
      call,
    });

    await expect(tool.handler({ count: 'not a number' }, makeSession())).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it('handler throws "WhatsApp is not connected" when getSock returns null', async () => {
    const call = vi.fn();
    const tool = makeSockTool(() => null, {
      name: 'a',
      description: '',
      schema: z.object({}),
      call,
    });

    await expect(tool.handler({}, makeSession())).rejects.toThrow('WhatsApp is not connected');
    expect(call).not.toHaveBeenCalled();
  });

  it('handler passes the live socket from getSock into call', async () => {
    const fakeSock = makeFakeSock();
    const call = vi.fn().mockResolvedValue(null);
    const tool = makeSockTool(() => fakeSock, {
      name: 'a',
      description: '',
      schema: z.object({}),
      call,
    });

    await tool.handler({}, makeSession());

    expect(call).toHaveBeenCalledWith({}, fakeSock);
  });

  it('handler resolves to whatever call returns (string)', async () => {
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({}),
      call: async () => 'plain string',
    });
    await expect(tool.handler({}, makeSession())).resolves.toBe('plain string');
  });

  it('handler propagates errors thrown by call', async () => {
    const tool = makeSockTool(() => makeFakeSock(), {
      name: 'a',
      description: '',
      schema: z.object({}),
      call: async () => {
        throw new Error('downstream failure');
      },
    });
    await expect(tool.handler({}, makeSession())).rejects.toThrow('downstream failure');
  });
});

describe('registerSockTools', () => {
  it('registers every config in the input array', () => {
    const registered: ToolDeclaration[] = [];
    const configs = [
      {
        name: 'tool_a',
        description: '',
        schema: z.object({}),
        call: async () => null,
      },
      {
        name: 'tool_b',
        description: '',
        schema: z.object({ jid: z.string() }),
        call: async () => 'b',
      },
      {
        name: 'tool_c',
        description: '',
        schema: z.object({}),
        call: async () => 'c',
      },
    ];

    registerSockTools(() => makeFakeSock(), configs, (t) => registered.push(t));

    expect(registered.map((t) => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('uses the same getSock for every registered tool', async () => {
    const sock = makeFakeSock();
    const getSock = vi.fn().mockReturnValue(sock);
    const registered: ToolDeclaration[] = [];

    registerSockTools(
      getSock,
      [
        { name: 'x', description: '', schema: z.object({}), call: async (_, s) => s },
        { name: 'y', description: '', schema: z.object({}), call: async (_, s) => s },
      ],
      (t) => registered.push(t),
    );

    await registered[0]!.handler({}, makeSession());
    await registered[1]!.handler({}, makeSession());

    expect(getSock).toHaveBeenCalledTimes(2);
  });

  it('registers zero configs without throwing', () => {
    const registered: ToolDeclaration[] = [];
    expect(() =>
      registerSockTools(() => makeFakeSock(), [], (t) => registered.push(t)),
    ).not.toThrow();
    expect(registered).toEqual([]);
  });
});
