import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { acquireProcessLock, releaseProcessLock } from '../../src/lib/process-lock.ts';

const DRAIN_SCRIPT = join(process.cwd(), 'deploy/hooks/drain-stuck-replies.mjs');
const WRAPPER_PATH = join(process.cwd(), 'deploy/scripts/reply-guarantee-drain.sh');
const PLIST_PATH = join(process.cwd(), 'deploy/com.whatsoup.reply-guarantee.plist');
const SERVICE_PATH = join(process.cwd(), 'deploy/whatsoup-reply-guarantee.service');

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface MockServer {
  dir: string;
  socketPath: string;
  received: JsonRpcRequest[];
  close: () => Promise<void>;
}

const tmp = trackTmpDirs('rgp-drain-', { base: '/tmp' });
const servers: MockServer[] = [];

function makeHome(): string {
  return tmp.make('home');
}

function queuePath(home: string, instance: string): string {
  return join(home, '.claude', 'rgp', instance, 'stuck-replies.jsonl');
}

function expiredQueuePath(home: string, instance: string): string {
  return join(home, '.claude', 'rgp', instance, 'expired-replies.jsonl');
}

function lockPath(home: string, instance: string): string {
  return join(home, '.claude', 'rgp', instance, 'stuck-replies.lock');
}

function writeQueue(home: string, instance: string, entries: unknown[], options: { stampMissingCreatedAt?: boolean } = {}): string {
  const path = queuePath(home, instance);
  mkdirSync(join(home, '.claude', 'rgp', instance), { recursive: true });
  const stampMissingCreatedAt = options.stampMissingCreatedAt ?? true;
  const normalized = stampMissingCreatedAt
    ? entries.map((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry) && !Object.prototype.hasOwnProperty.call(entry, 'createdAt')
        ? { createdAt: new Date().toISOString(), ...entry }
        : entry
    ))
    : entries;
  writeFileSync(path, `${normalized.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return path;
}

function readQueue(home: string, instance: string): unknown[] {
  const path = queuePath(home, instance);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function runDrain(home: string, args: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRAIN_SCRIPT, '--once', ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function startMockServer(toolResult: unknown, delayMs = 0): Promise<MockServer> {
  const dir = tmp.make('socket');
  const socketPath = join(dir, 'whatsoup.sock');
  const received: JsonRpcRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as JsonRpcRequest;
        received.push(request);
        if (request.method === 'initialize') {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
        } else if (request.method === 'tools/call') {
          setTimeout(() => {
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: toolResult })}\n`);
          }, delayMs);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    dir,
    socketPath,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('drain-stuck-replies daemon', () => {
  it('drains successful stuck replies from multiple instance queues', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-a', [{ id: 'a', kind: 'stuck-reply', status: 'queued', chatJid: 'a@g.us', text: 'one', socketPath: server.socketPath }]);
    writeQueue(home, 'bot-b', [{ id: 'b', kind: 'stuck-reply', status: 'queued', chatJid: 'b@g.us', text: 'two', socketPath: server.socketPath }]);

    const result = await runDrain(home);

    expect(result.status).toBe(0);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(2);
    expect(readQueue(home, 'bot-a')).toEqual([]);
    expect(readQueue(home, 'bot-b')).toEqual([]);
  });

  it('keeps failed sends queued and only acknowledges successful entries', async () => {
    const home = makeHome();
    const server = await startMockServer({ isError: true, content: [{ type: 'text', text: 'provider rejected' }] });
    servers.push(server);
    writeQueue(home, 'bot-c', [{ id: 'fail', kind: 'stuck-reply', status: 'queued', chatJid: 'c@g.us', text: 'retry', socketPath: server.socketPath }]);

    const result = await runDrain(home, ['--instance', 'bot-c']);

    expect(result.status).toBe(0);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(1);
    expect(readQueue(home, 'bot-c')).toMatchObject([{ id: 'fail', status: 'queued' }]);
  });

  it('fails closed on an invalid lock and does not drain while it exists', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-d', [{ id: 'locked', kind: 'stuck-reply', status: 'queued', chatJid: 'd@g.us', text: 'locked', socketPath: server.socketPath }]);
    mkdirSync(join(home, '.claude', 'rgp', 'bot-d'), { recursive: true });
    writeFileSync(lockPath(home, 'bot-d'), 'active');

    const active = await runDrain(home, ['--instance', 'bot-d']);

    expect(active.status).toBe(1);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(0);
    expect(readQueue(home, 'bot-d')).toHaveLength(1);

    const invalid = await runDrain(home, ['--instance', 'bot-d', '--lock-stale-ms', '1']);

    expect(invalid.status).toBe(1);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(0);
    expect(readQueue(home, 'bot-d')).toHaveLength(1);
  });

  it('retains an unknown-age entry and never sends it', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-unknown-age', [{
      id: 'missing-created-at',
      kind: 'stuck-reply',
      status: 'queued',
      chatJid: 'unknown@g.us',
      text: 'must stay queued',
      socketPath: server.socketPath,
    }], { stampMissingCreatedAt: false });

    const result = await runDrain(home, ['--instance', 'bot-unknown-age']);

    expect(result.status).toBe(1);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(0);
    expect(readQueue(home, 'bot-unknown-age')).toMatchObject([{ id: 'missing-created-at' }]);
  });

  it('returns an explicit failure and preserves an oversized queue', async () => {
    const home = makeHome();
    const path = queuePath(home, 'bot-oversized');
    mkdirSync(join(home, '.claude', 'rgp', 'bot-oversized'), { recursive: true });
    const oversized = 'x'.repeat(16 * 1024 * 1024 + 1);
    writeFileSync(path, oversized);

    const result = await runDrain(home, ['--instance', 'bot-oversized']);

    expect(result.status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(oversized);
  });

  it('reports an oversized queue as failed even when another drainer owns the lock', async () => {
    const home = makeHome();
    const path = writeQueue(home, 'bot-locked-oversized', []);
    const oversized = 'x'.repeat(16 * 1024 * 1024 + 1);
    writeFileSync(path, oversized);
    const lock = acquireProcessLock(lockPath(home, 'bot-locked-oversized'));
    try {
      const result = await runDrain(home, ['--instance', 'bot-locked-oversized']);
      expect(result.status).toBe(1);
      expect(readFileSync(path, 'utf8')).toBe(oversized);
    } finally {
      expect(releaseProcessLock(lock)).toBe(true);
    }
  });

  it('retains malformed entries without starving a valid reply behind them', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-starvation', [
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `unknown-age-${index}`, kind: 'stuck-reply', status: 'queued',
        chatJid: 'fixture@g.us', text: 'retain', socketPath: server.socketPath,
      })),
      { id: 'sendable', kind: 'stuck-reply', status: 'queued', createdAt: new Date().toISOString(),
        chatJid: 'fixture@g.us', text: 'deliver', socketPath: server.socketPath },
    ], { stampMissingCreatedAt: false });
    const result = await runDrain(home, ['--instance', 'bot-starvation', '--max-entries', '1']);
    expect(result.status).toBe(1);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(1);
    expect(readQueue(home, 'bot-starvation')).toHaveLength(25);
    expect(readQueue(home, 'bot-starvation')).not.toContainEqual(expect.objectContaining({ id: 'sendable' }));
  });

  it.each([false, true])('preserves a concurrent producer append (runtime shape: %s)', async (runtimeShape) => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] }, 500);
    servers.push(server);
    const original = {
      ...(runtimeShape ? { sessionId: 'session-a' } : { id: 'drained' }),
      kind: 'stuck-reply',
      status: 'queued',
      createdAt: new Date().toISOString(),
      chatJid: 'drained@g.us',
      text: 'drained',
      socketPath: server.socketPath,
    };
    const produced = runtimeShape ? { ...original, sessionId: 'session-b' } : { id: 'producer', kind: 'stuck-reply', status: 'queued' };
    writeQueue(home, 'bot-race', [original]);

    const drain = runDrain(home, ['--instance', 'bot-race']);
    while (server.received.filter((request) => request.method === 'tools/call').length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const append = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', [
        "import('./deploy/hooks/lib/rgp-state.mjs').then(({ appendQueueEntry, stuckRepliesQueuePath }) => {",
        `  process.exit(appendQueueEntry(stuckRepliesQueuePath('bot-race'), ${JSON.stringify(produced)}) ? 0 : 1);`,
        '}).catch(() => process.exit(1));',
      ].join('')], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: 'ignore',
      });
      child.on('close', (status) => resolve(status ?? 1));
    });

    expect(append).toBe(0);
    expect((await drain).status).toBe(0);
    expect(readQueue(home, 'bot-race')).toEqual([produced]);
  });

  it('records expired entries durably before removing them and never sends stale or malformed entries', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-e', [
      { id: 'old', kind: 'stuck-reply', status: 'queued', createdAt: '2026-05-13T00:00:00Z', chatJid: 'e@g.us', text: 'old', socketPath: server.socketPath },
      { id: 'missing-socket', kind: 'stuck-reply', status: 'queued', createdAt: '2026-05-14T00:00:00Z', chatJid: 'e@g.us', text: 'no socket' },
      { id: 'missing-chat', kind: 'stuck-reply', status: 'queued', createdAt: '2026-05-14T00:00:00Z', text: 'no chat', socketPath: server.socketPath },
      { id: 'missing-text', kind: 'stuck-reply', status: 'queued', createdAt: '2026-05-14T00:00:00Z', chatJid: 'e@g.us', socketPath: server.socketPath },
    ]);

    const result = await runDrain(home, ['--instance', 'bot-e', '--ttl-ms', '1', '--now-ms', String(Date.parse('2026-05-14T00:00:00Z'))]);

    expect(result.status).toBe(0);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(0);
    expect(readQueue(home, 'bot-e')).toMatchObject([
      { id: 'missing-socket' },
      { id: 'missing-chat' },
      { id: 'missing-text' },
    ]);
    const expired = readFileSync(expiredQueuePath(home, 'bot-e'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(expired).toEqual([
      expect.objectContaining({
        status: 'failed',
        failureCode: 'reply-expired',
        sourceId: 'old',
      }),
    ]);
    expect(JSON.stringify(expired)).not.toContain('"text"');
  });

  it('bounds one drain cycle while retaining excess retry obligations', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    writeQueue(home, 'bot-f', Array.from({ length: 4 }, (_, index) => ({
      id: `retry-${index}`,
      kind: 'stuck-reply',
      status: 'queued',
      chatJid: `f-${index}@g.us`,
      text: `reply-${index}`,
      socketPath: server.socketPath,
    })));

    const result = await runDrain(home, ['--instance', 'bot-f', '--max-entries', '2']);

    expect(result.status).toBe(0);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(2);
    expect(readQueue(home, 'bot-f')).toMatchObject([{ id: 'retry-2' }, { id: 'retry-3' }]);
  });

  it('returns a failure for malformed queue lines while preserving the line', async () => {
    const home = makeHome();
    const server = await startMockServer({ content: [{ type: 'text', text: 'sent' }] });
    servers.push(server);
    const path = writeQueue(home, 'bot-g', [{
      id: 'valid', kind: 'stuck-reply', status: 'queued', chatJid: 'g@g.us', text: 'reply', socketPath: server.socketPath,
    }, {
      id: 'invalid-time', kind: 'stuck-reply', status: 'queued', createdAt: 'not-a-time',
      chatJid: 'g@g.us', text: 'invalid', socketPath: server.socketPath,
    }]);
    writeFileSync(path, `not-json\n${readFileSync(path, 'utf8')}`);

    const result = await runDrain(home, ['--instance', 'bot-g']);

    expect(result.status).toBe(1);
    expect(server.received.filter((request) => request.method === 'tools/call')).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toContain('not-json');
    expect(readFileSync(path, 'utf8')).toContain('invalid-time');
  });
});

describe('reply guarantee daemon deployment artifacts', () => {
  it('ships macOS launchd and Linux systemd schedulers without host-specific paths', () => {
    const plist = readFileSync(PLIST_PATH, 'utf8');
    const service = readFileSync(SERVICE_PATH, 'utf8');
    const wrapper = readFileSync(WRAPPER_PATH, 'utf8');

    expect(plist).toContain('com.whatsoup.reply-guarantee');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>60</integer>');
    // The plist execs the drain wrapper script (which resolves Node itself and
    // chains to drain-stuck-replies.mjs), matching the systemd unit's entrypoint.
    expect(plist).toContain('deploy/scripts/reply-guarantee-drain.sh');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(service).toContain('Description=WhatSoup Reply Guarantee queue drain and durability observer');
    expect(service).toContain('ExecStart=%h/.local/bin/whatsoup-reply-guarantee-drain');
    expect(service).not.toContain('WHATSOUP_REPO_ROOT');
    expect(wrapper).toContain('drain-stuck-replies.mjs');
    expect(wrapper).toContain('reply-guarantee-observer.py');
    expect(`${plist}\n${service}\n${wrapper}`).not.toMatch(/\/Users\/[^<\s]+|mwlab|anabot|nucles/i);
  });
});
