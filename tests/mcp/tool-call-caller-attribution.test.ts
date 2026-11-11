/**
 * #3421 step 1: every tool call records which caller made it, on its
 * tool_calls row, with no change to what any caller may do.
 *
 * These tests drive the real socket server, the real registry and a real
 * migrated database, and read the row back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { z } from 'zod';

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { SessionTokenRegistry } from '../../src/mcp/caller-attribution.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import { beginPollWait, type PollWaitOwner } from '../../src/mcp/poll-wait-owner.ts';
import {
  resolveSessionContext,
  type ExecutingSessionContext,
  type SessionContext,
} from '../../src/mcp/types.ts';
import { createProviderMcpBridge } from '../../src/runtimes/agent/providers/mcp-bridge.ts';
import { waitForSocket } from '../helpers/wait-for.ts';
import { makeSocketPath } from '../helpers/socket-rpc.ts';

const ADMIN_JID = '15550001@s.whatsapp.net';

interface CallerRow {
  tool_name: string;
  caller_transport: string | null;
  caller_connection_id: string | null;
  caller_client_name: string | null;
  caller_client_version: string | null;
  caller_token_result: string | null;
  caller_turn_owned: number | null;
  caller_actor_source: string | null;
  tool_sensitive: number | null;
}

function callerRows(db: Database): CallerRow[] {
  return db.raw.prepare(
    `SELECT tool_name, caller_transport, caller_connection_id, caller_client_name,
            caller_client_version, caller_token_result, caller_turn_owned,
            caller_actor_source, tool_sensitive
       FROM tool_calls ORDER BY id`,
  ).all() as unknown as CallerRow[];
}

/**
 * Open one connection, write every line in order, and collect one response per
 * request id. Notifications (no id) get no response.
 */
function exchange(socketPath: string, lines: unknown[]): Promise<Map<number, unknown>> {
  const expected = lines.filter((line) => (line as { id?: unknown }).id !== undefined).length;
  return new Promise((resolve, reject) => {
    const responses = new Map<number, unknown>();
    const client = createConnection(socketPath, () => {
      for (const line of lines) client.write(JSON.stringify(line) + '\n');
    });
    let buf = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const parsed = JSON.parse(part) as { id: number };
        responses.set(parsed.id, parsed);
      }
      if (responses.size === expected) {
        client.end();
        resolve(responses);
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000).unref();
  });
}

const initialize = (id: number, clientInfo?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, ...(clientInfo === undefined ? {} : { clientInfo }) },
});

const callTool = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('tool-call caller attribution (#3421 step 1)', () => {
  let db: Database;
  let registry: ToolRegistry;
  let server: WhatSoupSocketServer | undefined;
  let socketPath: string;
  let executing: ExecutingSessionContext;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    registry.setDurability(new DurabilityEngine(db));
    registry.setSensitiveToolAuthorizer((session) => session.actorJid === ADMIN_JID);
    registry.register({
      name: 'plain_probe',
      description: 'Ordinary tool',
      scope: 'global',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });
    registry.register({
      name: 'admin_probe',
      sensitive: true,
      description: 'Admin-gated tool',
      scope: 'global',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });
    socketPath = makeSocketPath();
    executing = { actorJid: undefined, purpose: undefined, conversationKey: undefined };
  });

  afterEach(() => {
    server?.stop();
    server = undefined;
    db.close();
  });

  async function startServer(): Promise<void> {
    server = new WhatSoupSocketServer(socketPath, registry, { tier: 'global' }, () => executing);
    server.start();
    await waitForSocket(socketPath);
  }

  it('records the socket connection and the client it declared on initialize', async () => {
    await startServer();

    await exchange(socketPath, [
      initialize(1, { name: 'probe-client', version: '1.2.3' }),
      callTool(2, 'plain_probe'),
    ]);

    const [row] = callerRows(db);
    expect(row).toMatchObject({
      tool_name: 'plain_probe',
      caller_transport: 'socket',
      caller_client_name: 'probe-client',
      caller_client_version: '1.2.3',
      caller_token_result: 'absent',
      caller_turn_owned: 0,
      caller_actor_source: 'none',
      tool_sensitive: 0,
    });
    expect(row?.caller_connection_id).toMatch(/^[0-9a-f]{12}:\d+$/);
  });

  it('gives each connection its own id', async () => {
    await startServer();

    await exchange(socketPath, [callTool(1, 'plain_probe')]);
    await exchange(socketPath, [callTool(1, 'plain_probe')]);

    const ids = callerRows(db).map((row) => row.caller_connection_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('records an outside caller that inherits the running turn actor, and still admits it exactly as before', async () => {
    executing = { actorJid: ADMIN_JID, purpose: undefined, conversationKey: undefined };
    await startServer();

    const responses = await exchange(socketPath, [
      initialize(1, { name: 'fleet-client', version: '1.0.0' }),
      callTool(2, 'admin_probe'),
    ]);

    expect(responses.get(2)).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }] },
    });
    expect(callerRows(db)).toEqual([expect.objectContaining({
      tool_name: 'admin_probe',
      caller_client_name: 'fleet-client',
      caller_token_result: 'absent',
      caller_turn_owned: 0,
      caller_actor_source: 'executing_turn',
      tool_sensitive: 1,
    })]);
  });

  it('bounds the client-declared name: control characters dropped, length capped, non-strings null', async () => {
    await startServer();

    await exchange(socketPath, [
      initialize(1, { name: `\u0007evil\nclient${'x'.repeat(100)}`, version: 42 }),
      callTool(2, 'plain_probe'),
    ]);

    const [row] = callerRows(db);
    expect(row).toMatchObject({
      caller_client_name: `evilclient${'x'.repeat(54)}`,
      caller_client_version: null,
    });
  });

  it('returns the same initialize reply whatever the client declares', async () => {
    await startServer();

    const declared = await exchange(socketPath, [initialize(1, { name: 'a', version: 'b' })]);
    const silent = await exchange(socketPath, [initialize(1)]);

    expect(declared.get(1)).toEqual(silent.get(1));
    expect(declared.get(1)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'whatsoup', version: '0.1.0' },
      },
    });
  });

  it('records an in-process bridge call as the turn\'s own', async () => {
    executing = { actorJid: ADMIN_JID, purpose: undefined, conversationKey: undefined };
    const bridge = createProviderMcpBridge(registry, { tier: 'global' }, () => executing);

    await bridge.executeTool('plain_probe', {});

    expect(callerRows(db)).toEqual([{
      tool_name: 'plain_probe',
      caller_transport: 'in_process',
      caller_connection_id: null,
      caller_client_name: null,
      caller_client_version: null,
      caller_token_result: 'not_applicable',
      caller_turn_owned: 1,
      caller_actor_source: 'executing_turn',
      tool_sensitive: 0,
    }]);
  });

  it('leaves the columns NULL for a caller that carries no attribution', async () => {
    const session: SessionContext = { tier: 'global' };

    await registry.call('plain_probe', {}, resolveSessionContext(session, executing));

    expect(callerRows(db)).toEqual([{
      tool_name: 'plain_probe',
      caller_transport: null,
      caller_connection_id: null,
      caller_client_name: null,
      caller_client_version: null,
      caller_token_result: null,
      caller_turn_owned: null,
      caller_actor_source: null,
      tool_sensitive: null,
    }]);
  });

  it('attaches a matched token owner only to its fresh request, then clears it on mismatch', async () => {
    let begins = 0;
    let disposals = 0;
    const observedOwnership: boolean[] = [];
    const serializedContexts: string[] = [];
    const owner: PollWaitOwner = {
      begin: (timeoutMs) => {
        expect(timeoutMs).toBe(60_000);
        begins += 1;
        return () => {
          disposals += 1;
        };
      },
    };
    const sessionTokens = new SessionTokenRegistry();
    const token = sessionTokens.mint(owner);

    registry.register({
      name: 'poll_wait_owner_probe',
      description: 'Observes an in-process poll-wait capability',
      scope: 'global',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async (_params, session) => {
        const dispose = beginPollWait(session, 60_000);
        observedOwnership.push(dispose !== undefined);
        serializedContexts.push(JSON.stringify(session));
        dispose?.();
        return { ownerAttached: dispose !== undefined };
      },
    });

    server = new WhatSoupSocketServer(
      socketPath,
      registry,
      { tier: 'global' },
      () => executing,
      undefined,
      { sessionTokens },
    );
    server.start();
    await waitForSocket(socketPath);

    const matchedThenMismatched = await exchange(socketPath, [
      {
        jsonrpc: '2.0',
        method: 'notifications/whatsoup/session',
        params: { token },
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'poll_wait_owner_probe', arguments: {} },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/whatsoup/session',
        params: { token: 'f'.repeat(64) },
      },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'poll_wait_owner_probe', arguments: {} },
      },
    ]);
    const tokenless = await exchange(socketPath, [{
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'poll_wait_owner_probe', arguments: {} },
    }]);

    expect(matchedThenMismatched.has(1)).toBe(true);
    expect(matchedThenMismatched.has(2)).toBe(true);
    expect(tokenless.has(1)).toBe(true);
    expect(observedOwnership).toEqual([true, false, false]);
    expect(begins).toBe(1);
    expect(disposals).toBe(1);
    expect(callerRows(db).map((row) => row.caller_token_result)).toEqual([
      'match',
      'mismatch',
      'absent',
    ]);
    expect(serializedContexts).toHaveLength(3);
    for (const serialized of serializedContexts) {
      expect(serialized).not.toContain(token);
    }
    const persistedCalls = db.raw.prepare('SELECT * FROM tool_calls ORDER BY id').all();
    expect(JSON.stringify(persistedCalls)).not.toContain(token);
  });
});

describe('session token poll-wait ownership', () => {
  function owner(): PollWaitOwner {
    return { begin: vi.fn(() => undefined) };
  }

  it('resolves each current token only to the owner supplied at mint time', () => {
    const registry = new SessionTokenRegistry();
    const first = owner();
    const second = owner();
    const firstToken = registry.mint(first);
    const secondToken = registry.mint(second);

    expect(registry.resolvePollWaitOwner(firstToken)).toBe(first);
    expect(registry.resolvePollWaitOwner(secondToken)).toBe(second);
    expect(registry.verify(firstToken)).toBe(true);
    expect(registry.verify(secondToken)).toBe(true);
  });

  it('does not turn missing, invalid, or ownerless tokens into poll-wait capability', () => {
    const registry = new SessionTokenRegistry();
    const ownerlessToken = registry.mint();
    const staticToken = '0'.repeat(64);

    expect(registry.resolvePollWaitOwner(undefined)).toBeUndefined();
    expect(registry.resolvePollWaitOwner(staticToken)).toBeUndefined();
    expect(registry.resolvePollWaitOwner(ownerlessToken)).toBeUndefined();
    expect(registry.verify(staticToken)).toBe(false);
    expect(registry.verify(ownerlessToken)).toBe(true);
  });

  it('forgets both the evidence match and poll-wait owner together on FIFO eviction', () => {
    const registry = new SessionTokenRegistry(2);
    const first = owner();
    const second = owner();
    const third = owner();
    const firstToken = registry.mint(first);
    const secondToken = registry.mint(second);
    const thirdToken = registry.mint(third);

    expect(registry.verify(firstToken)).toBe(false);
    expect(registry.resolvePollWaitOwner(firstToken)).toBeUndefined();
    expect(registry.resolvePollWaitOwner(secondToken)).toBe(second);
    expect(registry.resolvePollWaitOwner(thirdToken)).toBe(third);
  });
});
