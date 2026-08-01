import net, { type Server, type Socket } from 'node:net';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startImsgRpcRelay, type ImsgRpcRelay } from '../../../src/transport/imessage/imsg-rpc-relay.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');
const relays: ImsgRpcRelay[] = [];

function fixture(version = '0.13.2'): {
  readonly root: string;
  readonly binary: string;
  readonly socketPath: string;
  readonly launchesPath: string;
} {
  const root = tmp.make('whatsoup-imsg-relay');
  const binary = join(root, 'fake-imsg.mjs');
  const socketPath = join(root, 'relay.sock');
  const launchesPath = join(root, 'launches.txt');
  writeFileSync(binary, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const command = process.argv[2];
if (command === '--version') {
  process.stdout.write('imsg ${version}\\n');
  process.exit(0);
}
if (command !== 'rpc') process.exit(64);
appendFileSync(${JSON.stringify(launchesPath)}, 'launch\\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'oversized') {
    process.stdout.write('x'.repeat(65) + '\\n');
    return;
  }
  if (request.method === 'stderr') process.stderr.write('provider-secret-sentinel\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { guid: 'notice' } }) + '\\n');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      ok: true,
      secret: process.env.WHATSOUP_RELAY_TEST_SECRET ?? null,
    },
  }) + '\\n');
});
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { root, binary, socketPath, launchesPath };
}

async function start(fx: ReturnType<typeof fixture>, maxLineBytes?: number): Promise<ImsgRpcRelay> {
  const relay = startImsgRpcRelay({
    socketPath: fx.socketPath,
    imsgBinary: fx.binary,
    supportedVersions: ['0.13.2'],
    maxLineBytes,
  });
  relays.push(relay);
  await relay.ready;
  return relay;
}

async function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function readLines(socket: Socket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines: string[] = [];
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (lines.length === count) {
          socket.off('data', onData);
          resolve(lines);
          return;
        }
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => {
      if (lines.length < count) reject(new Error(`socket closed after ${lines.length} lines`));
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(relays.splice(0).map((relay) => relay.close()));
});

describe('imsg rpc relay', () => {
  it('pins the provider version, creates a 0600 socket, and relays bidirectional NDJSON', async () => {
    const fx = fixture();
    await start(fx);

    expect(lstatSync(fx.socketPath).isSocket()).toBe(true);
    expect(lstatSync(fx.socketPath).mode & 0o777).toBe(0o600);

    const client = await connect(fx.socketPath);
    const response = readLines(client, 2);
    client.write('{"jsonrpc":"2.0","id":7,"method":"chats.list","params":{}}\n');

    expect((await response).map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', method: 'message', params: { guid: 'notice' } },
      { jsonrpc: '2.0', id: 7, result: { ok: true, secret: null } },
    ]);
    client.end();
  });

  it('reaps the child on disconnect and creates a fresh rpc process for a reconnect', async () => {
    const fx = fixture();
    await start(fx);

    const first = await connect(fx.socketPath);
    first.end();
    await new Promise<void>((resolve) => first.once('close', resolve));

    const second = await connect(fx.socketPath);
    const response = readLines(second, 2);
    second.write('{"jsonrpc":"2.0","id":8,"method":"chats.list","params":{}}\n');
    await response;
    second.end();

    expect(readFileSync(fx.launchesPath, 'utf8').trim().split('\n')).toEqual(['launch', 'launch']);
  });

  it('rejects an additional client while a session is active', async () => {
    const fx = fixture();
    await start(fx);
    const first = await connect(fx.socketPath);
    const second = await connect(fx.socketPath);

    await expect(new Promise<void>((resolve, reject) => {
      second.once('close', () => resolve());
      second.once('error', (error) => reject(error));
    })).resolves.toBeUndefined();
    first.end();
  });

  it('closes an oversized client line before forwarding it to imsg', async () => {
    const fx = fixture();
    await start(fx, 64);
    const client = await connect(fx.socketPath);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));

    client.write(`${'x'.repeat(65)}\n`);

    await expect(closed).resolves.toBeUndefined();
  });

  it('closes an oversized provider line instead of forwarding it to the client', async () => {
    const fx = fixture();
    await start(fx, 64);
    const client = await connect(fx.socketPath);
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));

    client.write('{"jsonrpc":"2.0","id":9,"method":"oversized","params":{}}\n');

    await expect(closed).resolves.toBeUndefined();
  });

  it('does not inherit unrelated environment values or forward provider stderr', async () => {
    const fx = fixture();
    const previous = process.env.WHATSOUP_RELAY_TEST_SECRET;
    process.env.WHATSOUP_RELAY_TEST_SECRET = 'environment-secret-sentinel';
    try {
      await start(fx);
      const client = await connect(fx.socketPath);
      const response = readLines(client, 2);
      client.write('{"jsonrpc":"2.0","id":10,"method":"stderr","params":{}}\n');
      const lines = await response;

      expect(lines.join('\n')).not.toContain('provider-secret-sentinel');
      expect(lines.join('\n')).not.toContain('environment-secret-sentinel');
      expect(JSON.parse(lines[1] ?? '').result.secret).toBeNull();
      client.end();
    } finally {
      if (previous === undefined) delete process.env.WHATSOUP_RELAY_TEST_SECRET;
      else process.env.WHATSOUP_RELAY_TEST_SECRET = previous;
    }
  });

  it('fails before listening when the provider version is unsupported', async () => {
    const fx = fixture('0.13.1');
    const relay = startImsgRpcRelay({
      socketPath: fx.socketPath,
      imsgBinary: fx.binary,
      supportedVersions: ['0.13.2'],
    });
    relays.push(relay);

    await expect(relay.ready).rejects.toThrow(/unsupported imsg version/i);
    expect(() => lstatSync(fx.socketPath)).toThrow();
  });

  it('does not remove regular files or symlinks at the configured socket path', async () => {
    const regular = fixture();
    writeFileSync(regular.socketPath, 'owner data');
    const regularRelay = startImsgRpcRelay({
      socketPath: regular.socketPath,
      imsgBinary: regular.binary,
      supportedVersions: ['0.13.2'],
    });
    relays.push(regularRelay);
    await expect(regularRelay.ready).rejects.toThrow(/not a socket/i);
    expect(readFileSync(regular.socketPath, 'utf8')).toBe('owner data');

    const linked = fixture();
    const target = join(linked.root, 'target');
    writeFileSync(target, 'target data');
    symlinkSync(target, linked.socketPath);
    const linkedRelay = startImsgRpcRelay({
      socketPath: linked.socketPath,
      imsgBinary: linked.binary,
      supportedVersions: ['0.13.2'],
    });
    relays.push(linkedRelay);
    await expect(linkedRelay.ready).rejects.toThrow(/symbolic link/i);
    expect(readFileSync(target, 'utf8')).toBe('target data');
  });

  it('does not unlink a replacement path during shutdown', async () => {
    const fx = fixture();
    const relay = await start(fx);
    unlinkSync(fx.socketPath);
    writeFileSync(fx.socketPath, 'replacement');
    let stoppedOutcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    void relay.stopped.then(
      () => { stoppedOutcome = 'resolved'; },
      () => { stoppedOutcome = 'rejected'; },
    );
    await Promise.resolve();

    expect(stoppedOutcome).toBe('pending');

    await relay.close();
    await expect(relay.stopped).resolves.toBeUndefined();

    expect(stoppedOutcome).toBe('resolved');
    expect(readFileSync(fx.socketPath, 'utf8')).toBe('replacement');
  });

  it('surfaces a post-listen server error and cleans up the relay socket', async () => {
    const fx = fixture();
    const createServer = net.createServer;
    let observedServer: Server | undefined;
    const createServerSpy = vi.spyOn(net, 'createServer').mockImplementation(((options, listener) => {
      observedServer = createServer(options, listener);
      return observedServer;
    }) as typeof net.createServer);
    try {
      const relay = await start(fx);
      let stoppedOutcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void relay.stopped.then(
        () => { stoppedOutcome = 'resolved'; },
        () => { stoppedOutcome = 'rejected'; },
      );
      await Promise.resolve();

      expect(observedServer).toBeDefined();
      expect(stoppedOutcome).toBe('pending');
      observedServer!.emit('error', new Error('injected post-listen failure'));

      await expect(relay.stopped).rejects.toThrow(/server failed after startup/i);
      expect(stoppedOutcome).toBe('rejected');
      expect(() => lstatSync(fx.socketPath)).toThrow();
    } finally {
      createServerSpy.mockRestore();
    }
  });
});
