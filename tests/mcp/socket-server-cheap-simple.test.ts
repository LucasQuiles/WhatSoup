/**
 * Simple extended coverage for socket-server.ts focusing on session updates
 * and actor binding without deep timing dependencies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { z } from 'zod';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';
import { waitForSocket } from '../helpers/wait-for.ts';
import { makeSocketPath, sendJsonRpc } from '../helpers/socket-rpc.ts';

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

describe('WhatSoupSocketServer - Session Updates', () => {
  let server: WhatSoupSocketServer;
  let registry: ToolRegistry;
  let session: SessionContext;
  let socketPath: string;

  beforeEach(() => {
    socketPath = makeSocketPath();
    registry = new ToolRegistry();
    session = makeSession();
  });

  afterEach(() => {
    server?.stop();
    try { unlinkSync(socketPath); } catch { /* already gone */ }
  });

  describe('updateDeliveryJid', () => {
    it('updates base session deliveryJid and affects handler session', async () => {
      const baseSession = makeSession({ deliveryJid: 'initial@jid' });
      server = new WhatSoupSocketServer(socketPath, registry, baseSession);
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesJid: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesJid = sess.deliveryJid;
          return 'ok';
        },
      }));

      server.updateDeliveryJid('updated@jid');

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesJid).toBe('updated@jid');
    });

    it('handles conversation-bound socket binding update', async () => {
      const boundSession = makeSession({
        binding: { kind: 'conversation-bound', conversationKey: 'key@g.us', deliveryJid: 'old@binding' },
      });
      server = new WhatSoupSocketServer(socketPath, registry, boundSession);
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesJid: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesJid = sess.deliveryJid;
          return 'ok';
        },
      }));

      server.updateDeliveryJid('new@binding');

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesJid).toBe('new@binding');
    });
  });

  describe('updateActorJid', () => {
    it('updates actor on base session', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesActor: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesActor = sess.actorJid;
          return 'ok';
        },
      }));

      server.updateActorJid('sender@actor');

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesActor).toBe('sender@actor');
    });

    it('allows setting actor to undefined', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, makeSession({ actorJid: 'initial@actor' }));
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesActor: string | undefined = 'not-checked';
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesActor = sess.actorJid;
          return 'ok';
        },
      }));

      server.updateActorJid(undefined);

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesActor).toBeUndefined();
    });
  });

  describe('updateConversationKey', () => {
    it('updates conversation key on base session', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesKey: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesKey = sess.conversationKey;
          return 'ok';
        },
      }));

      server.updateConversationKey('conv@key');

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesKey).toBe('conv@key');
    });

    it('refuses to update key on conversation-bound socket', async () => {
      const boundSession = makeSession({
        conversationKey: 'bound@key',
        binding: { kind: 'conversation-bound', conversationKey: 'bound@key', deliveryJid: 'jid@x' },
      });
      server = new WhatSoupSocketServer(socketPath, registry, boundSession);
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesKey: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesKey = sess.conversationKey;
          return 'ok';
        },
      }));

      server.updateConversationKey('different@key');

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesKey).toBe('bound@key');
    });
  });

  describe('F-STICKY-ACTOR: actorResolver per-request binding', () => {
    it('uses actorResolver to override connSession actor', async () => {
      const actorResolver = () => 'resolver@actor';

      server = new WhatSoupSocketServer(
        socketPath,
        registry,
        makeSession({ actorJid: 'base@actor' }),
        actorResolver,
      );
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesActor: string | undefined;
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesActor = sess.actorJid;
          return 'ok';
        },
      }));

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesActor).toBe('resolver@actor');
    });

    it('supports actorResolver returning undefined for fail-closed', async () => {
      const actorResolver = () => undefined;

      server = new WhatSoupSocketServer(
        socketPath,
        registry,
        makeSession({ actorJid: 'base@actor' }),
        actorResolver,
      );
      server.start();
      await waitForSocket(socketPath);

      let handlerSeesActor: string | undefined = 'not-set';
      registry.register(makeTool({
        handler: async (params, sess) => {
          handlerSeesActor = sess.actorJid;
          return 'ok';
        },
      }));

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(handlerSeesActor).toBeUndefined();
    });
  });

  describe('properties', () => {
    it('returns 0 for maxConnections before start', () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      expect(server.maxConnections).toBe(0);
    });

    it('returns bounded cap after start', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      server.start();
      await waitForSocket(socketPath);

      expect(server.maxConnections).toBeGreaterThan(0);
      expect(server.maxConnections).toBeLessThanOrEqual(128);
    });

    it('returns 0 for connectionCount initially', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      server.start();
      await waitForSocket(socketPath);

      expect(server.connectionCount).toBe(0);
    });
  });

  describe('abortSignal in session', () => {
    it('handler receives abortSignal in cloned session', async () => {
      server = new WhatSoupSocketServer(socketPath, registry, session);
      server.start();
      await waitForSocket(socketPath);

      let hasAbortSignal = false;
      registry.register(makeTool({
        handler: async (params, sess) => {
          hasAbortSignal = sess.abortSignal !== undefined;
          return 'ok';
        },
      }));

      await sendJsonRpc(socketPath, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool', arguments: { message: 'x' } },
      });

      expect(hasAbortSignal).toBe(true);
    });
  });
});
