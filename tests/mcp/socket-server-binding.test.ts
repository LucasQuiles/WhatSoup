import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';
import { waitForSocket } from '../helpers/wait-for.ts';
import { makeSocketPath, sendJsonRpc } from '../helpers/socket-rpc.ts';

// Conversation-binding lifecycle on the socket server. The invariant under
// test: binding objects are IMMUTABLE — a rekey REPLACES the frozen object on
// the base session and every live connection in one call, so top-level
// deliveryJid and the binding can never diverge (split-brain), while an
// in-flight request keeps the binding object it was admitted under.

const BOUND_KEY = '12345';
const BOUND_JID = '12345@s.whatsapp.net';
const NEW_JID = '12345@lid';

function boundSession(): SessionContext {
  return {
    tier: 'global',
    conversationKey: BOUND_KEY,
    deliveryJid: BOUND_JID,
    binding: { kind: 'conversation-bound', conversationKey: BOUND_KEY, deliveryJid: BOUND_JID },
  };
}

function makeInjectedTool(onCall: (chatJid: unknown) => void | Promise<void>): ToolDeclaration {
  return {
    name: 'send_message',
    description: 'test send',
    schema: z.object({ chatJid: z.string(), text: z.string() }),
    scope: 'chat',
    targetMode: 'injected',
    handler: async (params) => {
      await onCall(params['chatJid']);
      return { sentTo: params['chatJid'] };
    },
  };
}

describe('WhatSoupSocketServer — conversation binding lifecycle', () => {
  let server: WhatSoupSocketServer | null = null;
  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('freezes the binding at construction', () => {
    const session = boundSession();
    server = new WhatSoupSocketServer(makeSocketPath(), new ToolRegistry(), session);
    expect(Object.isFrozen(session.binding)).toBe(true);
  });

  it('updateDeliveryJid rebuilds the binding coherently (no split-brain)', () => {
    const session = boundSession();
    server = new WhatSoupSocketServer(makeSocketPath(), new ToolRegistry(), session);
    server.updateDeliveryJid(NEW_JID);
    expect(session.deliveryJid).toBe(NEW_JID);
    expect(session.binding?.deliveryJid).toBe(NEW_JID);
    expect(session.binding?.conversationKey).toBe(BOUND_KEY);
    expect(Object.isFrozen(session.binding)).toBe(true);
  });

  it('updateConversationKey is refused on a bound socket (lifetime binding cannot be re-pinned)', () => {
    const session = boundSession();
    server = new WhatSoupSocketServer(makeSocketPath(), new ToolRegistry(), session);
    server.updateConversationKey('99999');
    expect(session.conversationKey).toBe(BOUND_KEY);
    expect(session.binding?.conversationKey).toBe(BOUND_KEY);
  });

  it('updateConversationBinding replaces the binding atomically for live connections', async () => {
    const socketPath = makeSocketPath();
    const registry = new ToolRegistry();
    const seen: unknown[] = [];
    registry.register(makeInjectedTool((chatJid) => { seen.push(chatJid); }));
    server = new WhatSoupSocketServer(socketPath, registry, boundSession());
    server.start();
    await waitForSocket(socketPath);

    const call = (id: number) => sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'send_message', arguments: { text: 'hi' } },
    });

    await call(1);
    server.updateConversationBinding(NEW_JID);
    await call(2);

    expect(seen).toEqual([BOUND_JID, NEW_JID]);
  });

  it('an in-flight request keeps the binding it was admitted under (rekey does not retarget it)', async () => {
    const socketPath = makeSocketPath();
    const registry = new ToolRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    let signalEntered: () => void = () => {};
    const entered = new Promise<void>((r) => { signalEntered = r; });
    const observed: unknown[] = [];
    registry.register({
      name: 'slow_probe',
      description: 'blocks until released, then reads its session binding',
      schema: z.object({}),
      scope: 'chat',
      targetMode: 'caller-supplied',
      handler: async (_params, toolSession) => {
        signalEntered();
        await gate; // rekey happens while we are in flight
        observed.push(toolSession.binding?.deliveryJid);
        return { ok: true };
      },
    });
    server = new WhatSoupSocketServer(socketPath, registry, boundSession());
    server.start();
    await waitForSocket(socketPath);

    const inFlight = sendJsonRpc(socketPath, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'slow_probe', arguments: {} },
    });
    await entered; // request is inside the handler — now rekey mid-flight
    server.updateConversationBinding(NEW_JID);
    release();
    await inFlight;

    expect(observed).toEqual([BOUND_JID]); // admitted-under pair, not the rekeyed one
  });
});
