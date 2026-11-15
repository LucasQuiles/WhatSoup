/**
 * A send_message whose connection presented a session token the registry
 * recognizes but refuses on that socket (bound to another socket, or its lease
 * revoked) keeps B9's stale-manager outcome: it is suppressed, never raw-sent.
 * A connection that presented no token keeps the pre-existing raw send.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import {
  SESSION_TOKEN_CAPACITY,
  SESSION_TOKEN_NOTIFICATION,
  SessionTokenRegistry,
} from '../../../src/mcp/caller-attribution.ts';
import { registerMessagingTools } from '../../../src/mcp/tools/messaging.ts';
import { noExecutingSession } from '../../../src/mcp/types.ts';
import { PerChatMcpSocketManager } from '../../../src/runtimes/agent/per-chat-mcp-socket-manager.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createActiveTurnReplySink } from '../../../src/runtimes/agent/turn-reply-sink.ts';

const IDENTITY = 'socket-refusal@s.whatsapp.net';
const LIVE_MANAGER = 'live-manager';

interface SendResult {
  sent?: boolean;
  suppressed?: boolean;
  queued?: boolean;
  reason?: string;
}

function exchange(socketPath: string, lines: unknown[]): Promise<{ result: { content: Array<{ text: string }> } }> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      for (const line of lines) client.write(JSON.stringify(line) + '\n');
    });
    let buffer = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => {
      buffer += chunk;
      const line = buffer.split('\n').find((candidate) => candidate.trim() !== '');
      if (!line) return;
      client.end();
      resolve(JSON.parse(line) as { result: { content: Array<{ text: string }> } });
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 3000).unref();
  });
}

describe('send_message with a refused session token', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function startLine() {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const tokens = new SessionTokenRegistry();
    const rawSends: Array<{ jid: string; content: unknown }> = [];
    const db = new Database(':memory:');
    db.open();
    cleanups.push(() => db.close());
    const registry = new ToolRegistry();
    registerMessagingTools(registry, {
      connection: {
        contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
        sendRaw: async (jid: string, content: unknown) => {
          rawSends.push({ jid, content });
          return { waMessageId: 'raw-send' };
        },
      } as never,
      db: db.raw,
      dbWrapper: db,
      adminPhones: new Set<string>(),
    });
    const queue = new OutboundQueue({
      sendMessage: async () => ({ waMessageId: null }),
      sendMedia: async () => ({ waMessageId: null }),
    }, IDENTITY, { conversationKey: 'socket-refusal' });
    queue.beginTurnEvidence('live-turn');
    cleanups.push(() => queue.abortTurn());
    const sink = createActiveTurnReplySink((request) => (
      request.runtimeSessionId === LIVE_MANAGER ? { queue, logicalTurnId: 'live-turn' } : undefined
    ));
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry,
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: noExecutingSession,
      resolveTurnReplySink: () => sink,
      sessionTokens: tokens,
    });
    const lease = manager.acquire(IDENTITY, IDENTITY);
    cleanups.push(() => manager.release(IDENTITY));
    await lease.ready;

    const send = async (token: string | undefined): Promise<SendResult> => {
      const call = {
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'send_message', arguments: { text: 'socket reply' } },
      };
      const lines = token === undefined
        ? [call]
        : [{ jsonrpc: '2.0', method: SESSION_TOKEN_NOTIFICATION, params: { token } }, call];
      const response = await exchange(lease.socketPath, lines);
      return JSON.parse(response.result.content[0]!.text) as SendResult;
    };
    return { root, tokens, rawSends, queue, socketPath: lease.socketPath, send };
  }

  it('suppresses a live session token bound to another socket instead of sending raw', async () => {
    const line = await startLine();
    // Even the live manager's identity gains no reply authority off its own socket.
    const elsewhere = line.tokens.mint({
      kind: 'session', socketPath: join(line.root, 'other-actor.sock'), turnReplySessionId: LIVE_MANAGER,
    });

    const result = await line.send(elsewhere);

    expect(line.rawSends).toEqual([]);
    expect(result).toMatchObject({ sent: false, suppressed: true, reason: 'active_turn_unavailable' });
    expect(line.queue.hasCommittedAnswer()).toBe(false);
  });

  it('suppresses a revoked session lease presented on a fresh connection instead of sending raw', async () => {
    const line = await startLine();
    const retired = line.tokens.mintLease({ kind: 'session', socketPath: line.socketPath, turnReplySessionId: LIVE_MANAGER });
    retired.revoke();

    const result = await line.send(retired.token);

    expect(line.rawSends).toEqual([]);
    expect(result).toMatchObject({ sent: false, suppressed: true, reason: 'active_turn_unavailable' });
    expect(line.queue.hasCommittedAnswer()).toBe(false);
  });

  it('still suppresses a revoked session lease after a full capacity of request leases has come and gone', async () => {
    const line = await startLine();
    const retired = line.tokens.mintLease({ kind: 'session', socketPath: line.socketPath, turnReplySessionId: LIVE_MANAGER });
    retired.revoke();
    // Ordinary Microsoft 365 adapter calls each mint and revoke one request lease.
    for (let call = 0; call <= SESSION_TOKEN_CAPACITY; call += 1) {
      line.tokens.mintLease({ kind: 'request', socketPath: line.socketPath, conversationKey: 'socket-refusal', requestRef: `r-${call}` }).revoke();
    }

    const result = await line.send(retired.token);

    expect(line.rawSends).toEqual([]);
    expect(result).toMatchObject({ sent: false, suppressed: true, reason: 'active_turn_unavailable' });
  });

  it('still queues the reply of a live session token presented on its own socket', async () => {
    const line = await startLine();
    const live = line.tokens.mint({ kind: 'session', socketPath: line.socketPath, turnReplySessionId: LIVE_MANAGER });

    const result = await line.send(live);

    expect(line.rawSends).toEqual([]);
    expect(result).toMatchObject({ sent: false, queued: true });
  });

  it('keeps the raw send for a connection that presented no token', async () => {
    const line = await startLine();

    const result = await line.send(undefined);

    expect(line.rawSends).toHaveLength(1);
    expect(result).toMatchObject({ sent: true });
  });
});
