// #3497: a scheduled per-chat actor socket is keyed '<chat map key>::scheduled-agent-job'.
// With no executing turn, its read-time resolver must fall back to the chat's
// conversation and to the socket's scheduled purpose, never to a key folded from
// the isolation suffix and never to an unrestricted (normal-turn) purpose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { ExecutingSessionContext } from '../../../src/mcp/types.ts';
import { PerChatMcpSocketManager } from '../../../src/runtimes/agent/per-chat-mcp-socket-manager.ts';
import { resolveAgentTurnMapKey } from '../../../src/runtimes/agent/scheduled-agent-job-isolation.ts';
import { sendJsonRpc } from '../../helpers/socket-rpc.ts';

const PHONE_CHAT = '15550003497@s.whatsapp.net';
const LID_CHAT = '11111113497@lid';
const OTHER_CHAT = '15550009999@s.whatsapp.net';

type ResolverOf = () => ExecutingSessionContext;

function noTurn(): ExecutingSessionContext {
  return { actorJid: undefined, purpose: undefined, conversationKey: undefined };
}

describe('scheduled actor socket identity (#3497)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeManager(
    options: {
      registry?: ToolRegistry;
      conversationBound?: boolean;
      resolveExecutingSession?: (identity: string) => ExecutingSessionContext;
    } = {},
  ): PerChatMcpSocketManager {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-scheduled-socket-'));
    roots.push(root);
    return new PerChatMcpSocketManager({
      stateRoot: root,
      registry: options.registry ?? new ToolRegistry(),
      allowedRoot: root,
      conversationBound: options.conversationBound ?? true,
      resolveExecutingSession: options.resolveExecutingSession ?? noTurn,
    });
  }

  function resolverFor(manager: PerChatMcpSocketManager, identity: string): ResolverOf {
    const resources = (manager as unknown as {
      resources: Map<string, { server: { executingSessionResolver: ResolverOf } }>;
    }).resources;
    return resources.get(identity)!.server.executingSessionResolver;
  }

  function registryWithSendAndEdit(calls: string[]): ToolRegistry {
    const registry = new ToolRegistry();
    for (const name of ['send_message', 'edit_message']) {
      registry.register({
        name,
        description: 'test',
        schema: z.object({ chatJid: z.string().optional() }),
        scope: 'chat',
        targetMode: 'injected',
        handler: async (params) => {
          calls.push(`${name}:${params['chatJid'] as string}`);
          return { ok: true };
        },
      });
    }
    return registry;
  }

  async function call(
    socketPath: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean }> {
    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }) as { result: { isError?: boolean } };
    return response.result;
  }

  it.each([
    ['phone', PHONE_CHAT, '15550003497'],
    ['lid', LID_CHAT, '11111113497'],
  ])('falls back to the %s-origin chat conversation and the scheduled purpose with no executing turn', async (_origin, chatJid, conversationKey) => {
    const manager = makeManager();
    const identity = resolveAgentTurnMapKey(chatJid, true);
    await manager.acquire(identity, chatJid, 'scheduled-agent-job').ready;

    const context = resolverFor(manager, identity)();

    expect(context.conversationKey).toBe(conversationKey);
    expect(context.conversationKey).not.toContain('scheduled-agent-job');
    expect(context.purpose).toBe('scheduled-agent-job');
    expect(context.actorJid).toBeUndefined();
    manager.release(identity);
  });

  it('leaves the interactive socket fallback unchanged', async () => {
    const manager = makeManager();
    await manager.acquire(PHONE_CHAT, PHONE_CHAT).ready;

    expect(resolverFor(manager, PHONE_CHAT)()).toEqual({
      actorJid: undefined,
      purpose: undefined,
      conversationKey: '15550003497',
    });
    manager.release(PHONE_CHAT);
  });

  it('prefers the executing turn fields over the socket fallback', async () => {
    const executing: ExecutingSessionContext = {
      actorJid: '15550001111@s.whatsapp.net',
      purpose: 'scheduled-agent-job',
      conversationKey: '15550003497',
    };
    const manager = makeManager({ resolveExecutingSession: () => executing });
    const identity = resolveAgentTurnMapKey(PHONE_CHAT, true);
    await manager.acquire(identity, PHONE_CHAT, 'scheduled-agent-job').ready;

    expect(resolverFor(manager, identity)()).toEqual(executing);
    manager.release(identity);
  });

  it.each([false, true])(
    'admits a send to its own chat and denies another chat (conversation-bound: %s)',
    async (conversationBound) => {
      const calls: string[] = [];
      const manager = makeManager({ registry: registryWithSendAndEdit(calls), conversationBound });
      const identity = resolveAgentTurnMapKey(PHONE_CHAT, true);
      const lease = manager.acquire(identity, PHONE_CHAT, 'scheduled-agent-job');
      await lease.ready;

      const own = await call(lease.socketPath, 'send_message', conversationBound ? {} : { chatJid: PHONE_CHAT });
      const foreign = await call(lease.socketPath, 'send_message', { chatJid: OTHER_CHAT });

      expect(own.isError).not.toBe(true);
      expect(foreign.isError).toBe(true);
      expect(calls).toEqual([`send_message:${PHONE_CHAT}`]);
      manager.release(identity);
    },
  );

  it.each([false, true])(
    'keeps history-mutation tools denied with no executing turn (conversation-bound: %s)',
    async (conversationBound) => {
      const calls: string[] = [];
      const manager = makeManager({ registry: registryWithSendAndEdit(calls), conversationBound });
      const identity = resolveAgentTurnMapKey(PHONE_CHAT, true);
      const lease = manager.acquire(identity, PHONE_CHAT, 'scheduled-agent-job');
      await lease.ready;

      const edit = await call(lease.socketPath, 'edit_message', conversationBound ? {} : { chatJid: PHONE_CHAT });

      expect(edit.isError).toBe(true);
      expect(calls).toEqual([]);
      manager.release(identity);
    },
  );
});
