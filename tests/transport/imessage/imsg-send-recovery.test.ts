import net, { type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine, drainPendingOutbound, sendTracked } from '../../../src/core/durability.ts';
import { SqliteIdentityStore } from '../../../src/core/outbound-identity/store.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { ImessageAdapter } from '../../../src/transport/imessage/adapter.ts';
import { ImessageConnection } from '../../../src/transport/imessage/connection-bridge.ts';
import { ImsgPort, createSocketConnection } from '../../../src/transport/imessage/imsg-port.ts';
import { DEFAULT_IMESSAGE } from '../../../src/transport/imessage/types.ts';

vi.mock('../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../helpers/logger-mock.ts');
  return loggerMock();
});
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: () => true,
  emitAlertChecked: () => true,
  emitObservationChecked: () => true,
  clearAlertSource: () => true,
  clearAlertSourceChecked: () => true,
}));

const PEER = '+15550000001';
const CHAT = `${PEER}@imessage`;
interface RpcFrame { id: number; method: string; params: Record<string, unknown> }
type OpRow = { status: string; failure_disposition: string; retry_count: number };

describe('imsg send failure recovery', () => {
  let directory: string;
  let db: Database;
  let connection: ImessageConnection | undefined;
  const sockets = new Set<Socket>();
  const servers = new Set<Server>();

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'imsg-recovery-'));
    db = new Database(join(directory, 'bot.db'));
    db.open();
  });

  afterEach(async () => {
    await connection?.shutdown();
    connection = undefined;
    for (const socket of sockets) socket.destroy();
    await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
    servers.clear();
    sockets.clear();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function listen(onFrame: (frame: RpcFrame, socket: Socket) => void): Promise<string> {
    const path = join(directory, 'rpc.sock');
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          onFrame(JSON.parse(line) as RpcFrame, socket);
        }
      });
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    return path;
  }

  it.each([
    { name: 'internal error', code: -32603, ambiguous: true },
    { name: 'string internal error', code: '-32603', ambiguous: true },
    { name: 'post-write disconnect', code: 'disconnect', ambiguous: true },
    { name: 'acknowledgement without ID', code: 'no-id', ambiguous: true },
    { name: 'invalid request', code: -32600, ambiguous: false },
    { name: 'method missing', code: -32601, ambiguous: false },
    { name: 'invalid params', code: -32602, ambiguous: false },
  ])('preserves $name evidence across reopening without another send', async ({ code, ambiguous }) => {
    const requests: RpcFrame[] = [];
    const effects: string[] = [];
    const socketPath = await listen((frame, socket) => {
      if (frame.method !== 'send') {
        socket.write(`${JSON.stringify({ id: frame.id, result: { chats: [] } })}\n`);
        return;
      }
      requests.push(frame);
      if (ambiguous) effects.push(String(frame.params.text));
      if (code === 'disconnect') return socket.end();
      const response = code === 'no-id'
        ? { id: frame.id, result: { ok: true } }
        : { id: frame.id, error: { code, message: 'RPC failure', data: 'provider diagnostic' } };
      socket.write(`${JSON.stringify(response)}\n`);
    });
    const config = { ...DEFAULT_IMESSAGE, account: 'test', backend: 'imsg' as const,
      imsgSocketPath: socketPath, sender: '+15550000099', pollIntervalMs: 0 };
    const port = new ImsgPort(config);
    connection = new ImessageConnection(new ImessageAdapter(config, port), port);
    db.raw.prepare('INSERT INTO contacts (jid, canonical_phone) VALUES (?, ?)').run(CHAT, PEER);
    connection.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    await connection.connect();
    const engine = new DurabilityEngine(db);
    const queue = new OutboundQueue(connection, CHAT);
    queue.setDurability(engine);
    queue.enqueueText('recovery witness', 'answer');
    await queue.flush();

    const readOp = (): OpRow => db.raw.prepare(
      'SELECT status, error AS failure_disposition, retry_count FROM outbound_ops',
    ).get() as OpRow;
    expect(requests).toHaveLength(1);
    expect(effects).toEqual(ambiguous ? ['recovery witness'] : []);
    expect(readOp().status).toBe(ambiguous ? 'maybe_sent' : 'failed_permanent');
    expect(readOp().retry_count).toBe(1);
    expect(JSON.parse(readOp().failure_disposition)).toMatchObject({
      mutation_state: ambiguous ? 'ambiguous' : 'rejected',
      retry_decision: 'stop', provider_submission_count: 1,
    });

    await connection.shutdown();
    db.close();
    db = new Database(join(directory, 'bot.db'));
    db.open();
    connection.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    await connection.connect();
    const recovered = new DurabilityEngine(db);
    recovered.preConnectRecovery();
    recovered.postConnectRecovery();
    const drain = await drainPendingOutbound(connection, recovered);
    expect(drain).toEqual({ resent: 0, expired: 0 });
    expect(requests).toHaveLength(1);
    expect(readOp().status).toBe(ambiguous ? 'quarantined' : 'failed_permanent');
    expect(JSON.parse(readOp().failure_disposition).mutation_state).toBe(ambiguous ? 'ambiguous' : 'rejected');
  });

  it('keeps internal errors on read operations outside send ambiguity', async () => {
    const socketPath = await listen((frame, socket) => {
      socket.write(`${JSON.stringify({ id: frame.id, error: { code: -32603, message: 'read failed' } })}\n`);
    });
    const rpc = createSocketConnection({ ...DEFAULT_IMESSAGE, account: 'test',
      sender: '+15550000099', imsgSocketPath: socketPath });
    try {
      await expect(rpc.request('chats.list')).rejects.toMatchObject({ code: '-32603', message: 'read failed' });
    } finally { rpc.close(); }
  });

  it.each(['safe', 'read_only'] as const)('quarantines ambiguous sends despite caller replay policy %s', async (replayPolicy) => {
    const effects: string[] = [];
    const socketPath = await listen((frame, socket) => {
      if (frame.method !== 'send') {
        socket.write(`${JSON.stringify({ id: frame.id, result: { chats: [] } })}\n`);
        return;
      }
      effects.push(String(frame.params.text));
      const response = effects.length === 1
        ? { id: frame.id, error: { code: -32603, message: 'internal error after effect' } }
        : { id: frame.id, result: { guid: 'provider-second-effect' } };
      socket.write(`${JSON.stringify(response)}\n`);
    });
    const config = { ...DEFAULT_IMESSAGE, account: 'test', backend: 'imsg' as const,
      imsgSocketPath: socketPath, sender: '+15550000099', pollIntervalMs: 0 };
    const port = new ImsgPort(config);
    connection = new ImessageConnection(new ImessageAdapter(config, port), port);
    db.raw.prepare('INSERT INTO contacts (jid, canonical_phone) VALUES (?, ?)').run(CHAT, PEER);
    connection.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    await connection.connect();
    const engine = new DurabilityEngine(db);
    await expect(sendTracked(connection, CHAT, 'safe-policy witness', engine, { replayPolicy }))
      .rejects.toMatchObject({ payload: { code: 'transport.send_ambiguous' } });
    expect(engine.getOutboundByStatus('maybe_sent')).toHaveLength(1);
    expect(engine.getOutboundByStatus('maybe_sent')[0].replay_policy).toBe('unsafe');
    expect(effects).toEqual(['safe-policy witness']);

    await connection.shutdown();
    db.close();
    db = new Database(join(directory, 'bot.db'));
    db.open();
    connection.setIdentityStore(new SqliteIdentityStore(db.raw), 'enforce');
    await connection.connect();
    const recovered = new DurabilityEngine(db);
    expect(recovered.getOutboundByStatus('maybe_sent')[0].replay_policy).toBe('unsafe');
    recovered.preConnectRecovery();
    recovered.postConnectRecovery();
    expect(recovered.getOutboundByStatus('pending')).toHaveLength(0);
    expect(await drainPendingOutbound(connection, recovered)).toEqual({ resent: 0, expired: 0 });
    expect(effects).toEqual(['safe-policy witness']);
    expect(recovered.getOutboundByStatus('quarantined')).toHaveLength(1);
  });
});
