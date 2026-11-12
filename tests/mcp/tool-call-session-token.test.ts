/**
 * #3421 step 1: a session's own helper processes present a per-session token
 * as their first line, so each tool call is recorded as the turn's own or as
 * an outside caller. The token is evidence only, and it is never stored.
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
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../src/mcp/socket-server.ts';
import type { ExecutingSessionContext } from '../../src/mcp/types.ts';
import { waitForSocket } from '../helpers/wait-for.ts';
import { makeSocketPath } from '../helpers/socket-rpc.ts';

const ADMIN_JID = '15550001@s.whatsapp.net';
const LIVE_TOKEN = 'a'.repeat(64);

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

const presentToken = (token: unknown) => ({
  jsonrpc: '2.0',
  method: 'notifications/whatsoup/session',
  params: { token },
});

const callTool = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
});

describe('per-session token on the socket (#3421 step 1)', () => {
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
      name: 'admin_probe',
      sensitive: true,
      description: 'Admin-gated tool',
      scope: 'global',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async () => ({ ok: true }),
    });
    socketPath = makeSocketPath();
    executing = { actorJid: ADMIN_JID, purpose: undefined, conversationKey: undefined };
  });

  afterEach(() => {
    server?.stop();
    server = undefined;
    db.close();
  });

  async function startServer(verify: (presented: unknown) => boolean): Promise<void> {
    server = new WhatSoupSocketServer(
      socketPath,
      registry,
      { tier: 'global' },
      () => executing,
      undefined,
      { sessionTokens: { verify: (presented, path) => (verify(presented) ? { kind: 'session', socketPath: path } : undefined) } },
    );
    server.start();
    await waitForSocket(socketPath);
  }

  function lastRow(): Record<string, unknown> {
    return db.raw.prepare('SELECT * FROM tool_calls ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  }

  it('records a caller presenting a live session token as the turn\'s own', async () => {
    await startServer((presented) => presented === LIVE_TOKEN);

    await exchange(socketPath, [presentToken(LIVE_TOKEN), callTool(1, 'admin_probe')]);

    expect(lastRow()).toMatchObject({
      caller_token_result: 'match',
      caller_turn_owned: 1,
      caller_actor_source: 'executing_turn',
    });
  });

  it('records a caller presenting any other token as an outside caller', async () => {
    await startServer((presented) => presented === LIVE_TOKEN);

    await exchange(socketPath, [presentToken('b'.repeat(64)), callTool(1, 'admin_probe')]);

    expect(lastRow()).toMatchObject({ caller_token_result: 'mismatch', caller_turn_owned: 0 });
  });

  it('never replies to the token line and admits the call exactly as without it', async () => {
    await startServer((presented) => presented === LIVE_TOKEN);

    const withToken = await exchange(socketPath, [presentToken(LIVE_TOKEN), callTool(7, 'admin_probe')]);
    const withoutToken = await exchange(socketPath, [callTool(7, 'admin_probe')]);

    expect([...withToken.keys()]).toEqual([7]);
    expect(withToken.get(7)).toEqual(withoutToken.get(7));
    expect(db.raw.prepare('SELECT caller_token_result FROM tool_calls ORDER BY id').all())
      .toEqual([{ caller_token_result: 'match' }, { caller_token_result: 'absent' }]);
  });

  it('never stores the token itself', async () => {
    await startServer((presented) => presented === LIVE_TOKEN);

    await exchange(socketPath, [presentToken(LIVE_TOKEN), callTool(1, 'admin_probe')]);

    expect(JSON.stringify(lastRow())).not.toContain(LIVE_TOKEN);
  });
});

describe('SessionTokenRegistry', () => {
  async function loadRegistry() {
    const module = await import('../../src/mcp/caller-attribution.ts') as Record<string, unknown>;
    const SessionTokenRegistry = module['SessionTokenRegistry'] as new (capacity?: number) => {
      mint(binding: { kind: 'session'; socketPath: string }): string;
      verify(presented: unknown, socketPath: string): unknown;
    };
    return SessionTokenRegistry;
  }
  const SOCKET = '/tmp/whatsoup-test-session.sock';
  const binding = { kind: 'session' as const, socketPath: SOCKET };

  it('verifies a minted token and rejects anything else', async () => {
    const SessionTokenRegistry = await loadRegistry();
    const tokens = new SessionTokenRegistry();

    const minted = tokens.mint(binding);

    expect(minted).toMatch(/^[0-9a-f]{64}$/);
    expect([minted, '0'.repeat(64), undefined, 42].map((presented) => tokens.verify(presented, SOCKET) !== undefined))
      .toEqual([true, false, false, false]);
  });

  it('keeps at most its capacity of live tokens, oldest first out', async () => {
    const SessionTokenRegistry = await loadRegistry();
    const tokens = new SessionTokenRegistry(2);

    const first = tokens.mint(binding);
    const second = tokens.mint(binding);
    const third = tokens.mint(binding);

    expect([first, second, third].map((token) => tokens.verify(token, SOCKET) !== undefined)).toEqual([false, true, true]);
  });
});

describe('SessionTokenRegistry bindings (M365 r4, W4)', () => {
  const SOCKET_A = '/tmp/whatsoup-test-a.sock';
  const SOCKET_B = '/tmp/whatsoup-test-b.sock';

  async function loadBindingRegistry() {
    const module = await import('../../src/mcp/caller-attribution.ts') as Record<string, unknown>;
    return module['SessionTokenRegistry'] as new (capacity?: number) => {
      mint(binding: Record<string, unknown>): string;
      mintLease(binding: Record<string, unknown>): { token: string; revoke(): void };
      revoke(token: string): void;
      verify(presented: unknown, socketPath: string): unknown;
      readonly liveCount: number;
    };
  }

  it('verifies a token only on the socket it was minted for and returns its binding', async () => {
    const SessionTokenRegistry = await loadBindingRegistry();
    const tokens = new SessionTokenRegistry();

    const token = tokens.mint({ kind: 'session', socketPath: SOCKET_A });

    expect(tokens.verify(token, SOCKET_A)).toEqual({ kind: 'session', socketPath: SOCKET_A });
    expect(tokens.verify(token, SOCKET_B)).toBeUndefined();
    expect(tokens.verify('0'.repeat(64), SOCKET_A)).toBeUndefined();
  });

  it('never verifies a revoked token', async () => {
    const SessionTokenRegistry = await loadBindingRegistry();
    const tokens = new SessionTokenRegistry();
    const kept = tokens.mint({ kind: 'session', socketPath: SOCKET_A });
    const revoked = tokens.mint({ kind: 'session', socketPath: SOCKET_A });

    tokens.revoke(revoked);

    expect(tokens.verify(revoked, SOCKET_A)).toBeUndefined();
    expect(tokens.verify(kept, SOCKET_A)).toEqual({ kind: 'session', socketPath: SOCKET_A });
  });

  it('hands out a request lease whose revoke retires exactly its own token', async () => {
    const SessionTokenRegistry = await loadBindingRegistry();
    const tokens = new SessionTokenRegistry();
    const baseline = tokens.liveCount;
    const binding = { kind: 'request', socketPath: SOCKET_A, conversationKey: 'chat-a', requestRef: 'request-1' };

    const lease = tokens.mintLease(binding);
    expect(tokens.verify(lease.token, SOCKET_A)).toEqual(binding);
    expect(tokens.liveCount).toBe(baseline + 1);

    lease.revoke();
    lease.revoke();
    expect(tokens.verify(lease.token, SOCKET_A)).toBeUndefined();
    expect(tokens.liveCount).toBe(baseline);
  });
});
