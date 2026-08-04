import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import {
  assertSafeOwnedSocket,
  PerChatMcpSocketManager,
} from '../../../src/runtimes/agent/per-chat-mcp-socket-manager.ts';
import { waitForSocket } from '../../helpers/wait-for.ts';
import { sendJsonRpc } from '../../helpers/socket-rpc.ts';

describe('PerChatMcpSocketManager', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))));
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeManager(
    root: string,
    options: { registry?: ToolRegistry; conversationBound?: boolean } = {},
  ): PerChatMcpSocketManager {
    return new PerChatMcpSocketManager({
      stateRoot: root,
      registry: options.registry ?? new ToolRegistry(),
      allowedRoot: root,
      conversationBound: options.conversationBound ?? true,
      resolveActor: () => undefined,
    });
  }

  async function unusedSocketPath(root: string, identity: string): Promise<string> {
    const primer = makeManager(root);
    const lease = primer.acquire(identity, identity);
    await lease.ready;
    primer.release(identity);
    return lease.socketPath;
  }

  async function expectSocketServing(socketPath: string): Promise<void> {
    const response = await sendJsonRpc(socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }) as { id?: number; result?: { tools?: unknown[] } };
    expect(response.id).toBe(1);
    expect(response.result?.tools).toEqual(expect.any(Array));
  }

  it('binds an awaitable mode-0600 socket below a mode-0700 state-root directory using only a digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const manager = makeManager(root);
    const identity = '15551234567@s.whatsapp.net';

    const lease = manager.acquire(identity, identity);
    await lease.ready;

    expect(dirname(lease.socketPath)).toBe(join(root, 'mcp'));
    expect(lease.socketPath).not.toContain('15551234567');
    expect(lstatSync(dirname(lease.socketPath)).mode & 0o777).toBe(0o700);
    const socketStat = lstatSync(lease.socketPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    if (typeof process.getuid === 'function') {
      expect(socketStat.uid).toBe(process.getuid());
    }

    manager.release(identity);
  });

  it.each([
    ['symlink', (path: string) => symlinkSync('/private/actor-target', path)],
    ['non-socket', (path: string) => writeFileSync(path, 'owned data', { mode: 0o600 })],
  ])('rejects an exact-path %s collision without unlinking it', async (_kind, createCollision) => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'collision@s.whatsapp.net';
    const socketPath = await unusedSocketPath(root, identity);
    createCollision(socketPath);
    const before = lstatSync(socketPath);
    const manager = makeManager(root);

    try {
      const lease = manager.acquire(identity, identity);
      await expect(lease.ready).rejects.toThrow(/collision/i);
      const after = lstatSync(socketPath);
      expect({ dev: after.dev, ino: after.ino, mode: after.mode })
        .toEqual({ dev: before.dev, ino: before.ino, mode: before.mode });
    } finally {
      manager.release(identity);
    }
  });

  it('rejects a live same-uid socket collision without unlinking it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'live-collision@s.whatsapp.net';
    const socketPath = await unusedSocketPath(root, identity);
    const liveServer = createServer();
    servers.push(liveServer);
    await new Promise<void>((resolve, reject) => {
      liveServer.once('error', reject);
      liveServer.listen(socketPath, resolve);
    });
    const before = lstatSync(socketPath);
    const manager = makeManager(root);

    try {
      const lease = manager.acquire(identity, identity);
      await expect(lease.ready).rejects.toThrow(/live|collision/i);
      const after = lstatSync(socketPath);
      expect({ dev: after.dev, ino: after.ino })
        .toEqual({ dev: before.dev, ino: before.ino });
    } finally {
      manager.release(identity);
    }
  });

  it('the awaitable server boundary can refuse to unlink an existing exact path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const socketPath = join(root, 'occupied.sock');
    writeFileSync(socketPath, 'collision', { mode: 0o600 });
    const before = lstatSync(socketPath);
    const server = new WhatSoupSocketServer(
      socketPath,
      new ToolRegistry(),
      { tier: 'global', allowedRoot: root },
    );

    await expect(server.startAndWait({ unlinkExisting: false })).rejects.toBeDefined();
    const after = lstatSync(socketPath);
    expect({ dev: after.dev, ino: after.ino })
      .toEqual({ dev: before.dev, ino: before.ino });
  });

  it('replaces an unreachable same-uid stale socket at only the exact known path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'stale-collision@s.whatsapp.net';
    const socketPath = await unusedSocketPath(root, identity);
    const child = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      "import { createServer } from 'node:net'; createServer().listen(process.env.ACTOR_STALE_SOCKET);",
    ], {
      env: { ...process.env, ACTOR_STALE_SOCKET: socketPath },
      stdio: 'ignore',
    });
    await waitForSocket(socketPath);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const stale = lstatSync(socketPath);
    expect(stale.isSocket()).toBe(true);

    const manager = makeManager(root);
    const lease = manager.acquire(identity, identity);
    await lease.ready;

    const live = lstatSync(socketPath);
    expect(live.isSocket()).toBe(true);
    expect(live.mode & 0o777).toBe(0o600);
    await expectSocketServing(socketPath);
    manager.release(identity);
  });

  it('rejects a foreign-owned socket before any unlink decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'foreign-collision@s.whatsapp.net';
    const manager = makeManager(root);
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    const actual = lstatSync(lease.socketPath);
    const foreign = new Proxy(actual, {
      get(target, property, receiver) {
        if (property === 'uid') return target.uid + 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => assertSafeOwnedSocket(foreign)).toThrow(/ownership collision/i);
    expect(lstatSync(lease.socketPath).ino).toBe(actual.ino);
    manager.release(identity);
  });

  it('rekeys the live actor resolver and conversation binding without replacing the socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const observedIdentities: string[] = [];
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry: new ToolRegistry(),
      allowedRoot: root,
      conversationBound: true,
      resolveActor: (identity) => {
        observedIdentities.push(identity);
        return identity;
      },
    });
    const oldIdentity = '15550001111@lid';
    const newIdentity = '15550001111@s.whatsapp.net';
    const lease = manager.acquire(oldIdentity, oldIdentity);
    await lease.ready;
    const resources = (manager as unknown as {
      resources: Map<string, {
        server: {
          actorResolver: () => string | undefined;
          baseSession: {
            binding?: { conversationKey: string; deliveryJid: string };
          };
        };
      }>;
    }).resources;
    const resource = resources.get(oldIdentity)!;

    expect(resource.server.actorResolver()).toBe(oldIdentity);
    manager.rekey(oldIdentity, newIdentity, newIdentity);
    expect(resource.server.actorResolver()).toBe(newIdentity);
    expect(observedIdentities).toEqual([oldIdentity, newIdentity]);
    expect(resource.server.baseSession.binding).toEqual({
      kind: 'conversation-bound',
      conversationKey: '15550001111',
      deliveryJid: newIdentity,
    });
    expect(resources.get(oldIdentity)).toBeUndefined();
    expect(resources.get(newIdentity)).toBe(resource);
    expect(manager.acquire(newIdentity, newIdentity).socketPath).toBe(lease.socketPath);

    manager.release(newIdentity);
  });

  it('drops a failed readiness lease so the same identity can retry cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'retry-after-collision@s.whatsapp.net';
    const socketPath = await unusedSocketPath(root, identity);
    symlinkSync('/private/actor-target', socketPath);
    const manager = makeManager(root);
    const failed = manager.acquire(identity, identity);

    await expect(failed.ready).rejects.toThrow(/collision/i);
    expect((manager as unknown as { resources: Map<string, unknown> }).resources.size).toBe(0);
    unlinkSync(socketPath);

    const retry = manager.acquire(identity, identity);
    expect(retry.ready).not.toBe(failed.ready);
    await retry.ready;
    manager.release(identity);
  });

  it('does not make a replacement socket ready until the previous child has stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'teardown-order@s.whatsapp.net';
    const manager = makeManager(root);
    const first = manager.acquire(identity, identity);
    await first.ready;
    const firstStat = lstatSync(first.socketPath);
    let proveStopped!: () => void;
    const childStopped = new Promise<void>((resolve) => { proveStopped = resolve; });

    manager.releaseAfter(identity, childStopped);
    const replacement = manager.acquire(identity, identity);
    let replacementReady = false;
    void replacement.ready.then(() => { replacementReady = true; });
    await Promise.resolve();

    expect(replacementReady).toBe(false);
    expect(lstatSync(first.socketPath).ino).toBe(firstStat.ino);
    proveStopped();
    await replacement.ready;
    await expectSocketServing(replacement.socketPath);
    manager.release(identity);
  });

  it('does not make a no-socket provider transition ready until retirement completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'cli-to-api@s.whatsapp.net';
    const manager = makeManager(root);
    const first = manager.acquire(identity, identity);
    await first.ready;
    const firstStat = lstatSync(first.socketPath);
    let proveRetired!: () => void;
    const retired = new Promise<void>((resolve) => { proveRetired = resolve; });

    manager.releaseAfter(identity, retired);
    const transitionReady = manager.providerTransitionReady(identity);
    let ready = false;
    void transitionReady.then(() => { ready = true; });
    await Promise.resolve();

    expect(ready).toBe(false);
    expect(lstatSync(first.socketPath).ino).toBe(firstStat.ino);
    proveRetired();
    await transitionReady;
    expect(ready).toBe(true);
    expect(existsSync(first.socketPath)).toBe(false);
  });

  it('keeps a no-socket provider transition fail-closed after rejected retirement proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'cli-to-api-rejected@s.whatsapp.net';
    const manager = makeManager(root);
    const first = manager.acquire(identity, identity);
    await first.ready;

    manager.releaseAfter(identity, Promise.reject(new Error('turn retirement failed')));

    await expect(manager.providerTransitionReady(identity))
      .rejects.toThrow(/turn retirement failed/i);
    expect(existsSync(first.socketPath)).toBe(true);
  });

  it('accepts a later successful child-stop proof after the first proof rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'retry-teardown@s.whatsapp.net';
    const manager = makeManager(root);
    const first = manager.acquire(identity, identity);
    await first.ready;
    const firstStat = lstatSync(first.socketPath);

    manager.releaseAfter(identity, Promise.reject(new Error('child still running')));
    const blocked = manager.acquire(identity, identity);
    await expect(blocked.ready).rejects.toThrow(/child still running/i);
    expect(lstatSync(first.socketPath).ino).toBe(firstStat.ino);

    manager.releaseAfter(identity, Promise.resolve());
    const replacement = manager.acquire(identity, identity);
    await replacement.ready;
    await expectSocketServing(replacement.socketPath);
    manager.release(identity);
  });

  it('preflights resource and teardown-barrier collisions before changing either identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const sourceIdentity = 'source@lid';
    const targetIdentity = 'target@s.whatsapp.net';
    const manager = makeManager(root);
    const source = manager.acquire(sourceIdentity, sourceIdentity);
    const target = manager.acquire(targetIdentity, targetIdentity);
    await Promise.all([source.ready, target.ready]);
    let releaseSource!: () => void;
    let releaseTarget!: () => void;
    manager.releaseAfter(
      sourceIdentity,
      new Promise<void>((resolve) => { releaseSource = resolve; }),
    );
    manager.releaseAfter(
      targetIdentity,
      new Promise<void>((resolve) => { releaseTarget = resolve; }),
    );
    const state = manager as unknown as {
      resources: Map<string, { identity: { value: string } }>;
      teardownBarriers: Map<string, {
        identity: { value: string };
        ready: Promise<void>;
      }>;
    };

    expect(() => manager.rekey(sourceIdentity, targetIdentity, targetIdentity))
      .toThrow(/rekey collision/i);
    expect(state.resources.get(sourceIdentity)?.identity.value).toBe(sourceIdentity);
    expect(state.resources.get(targetIdentity)?.identity.value).toBe(targetIdentity);
    expect(state.teardownBarriers.get(sourceIdentity)?.identity.value).toBe(sourceIdentity);
    expect(state.teardownBarriers.get(targetIdentity)?.identity.value).toBe(targetIdentity);

    releaseSource();
    releaseTarget();
    await Promise.all([
      state.teardownBarriers.get(sourceIdentity)!.ready,
      state.teardownBarriers.get(targetIdentity)!.ready,
    ]);
  });

  it('retains socket ownership when unlink is denied and releases it on a later retry', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const identity = 'unlink-retry@s.whatsapp.net';
    const manager = makeManager(root);
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    const before = lstatSync(lease.socketPath);
    const socketDirectory = dirname(lease.socketPath);

    chmodSync(socketDirectory, 0o500);
    try {
      expect(() => manager.release(identity)).toThrow(/socket cleanup failed/i);
      const after = lstatSync(lease.socketPath);
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
      expect((manager as unknown as { resources: Map<string, unknown> }).resources.has(identity))
        .toBe(true);
    } finally {
      chmodSync(socketDirectory, 0o700);
    }

    manager.release(identity);
    expect((manager as unknown as { resources: Map<string, unknown> }).resources.has(identity))
      .toBe(false);
  });

  it('moves an active teardown barrier across rekey and refuses an early direct release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const oldIdentity = '15559990000@lid';
    const newIdentity = '15559990000@s.whatsapp.net';
    const manager = makeManager(root);
    await manager.acquire(oldIdentity, oldIdentity).ready;
    let proveStopped!: () => void;
    const childStopped = new Promise<void>((resolve) => { proveStopped = resolve; });

    manager.releaseAfter(oldIdentity, childStopped);
    manager.rekey(oldIdentity, newIdentity, newIdentity);
    expect(() => manager.release(newIdentity)).toThrow(/child|teardown|terminal/i);
    const replacement = manager.acquire(newIdentity, newIdentity);
    let replacementReady = false;
    void replacement.ready.then(() => { replacementReady = true; });
    await Promise.resolve();
    expect(replacementReady).toBe(false);

    proveStopped();
    await replacement.ready;
    expect(replacementReady).toBe(true);
    manager.release(newIdentity);
  });

  it.each([false, true])(
    'rekeys the pinned conversation identity in %s conversation-bound mode',
    async (conversationBound) => {
      const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
      roots.push(root);
      const oldIdentity = 'legacy-lid@lid';
      const newIdentity = 'canonical-user@s.whatsapp.net';
      const manager = makeManager(root, { conversationBound });
      await manager.acquire(oldIdentity, oldIdentity).ready;
      const resources = (manager as unknown as {
        resources: Map<string, {
          server: {
            baseSession: {
              conversationKey?: string;
              deliveryJid?: string;
              binding?: { conversationKey: string; deliveryJid: string };
            };
          };
        }>;
      }).resources;

      manager.rekey(oldIdentity, newIdentity, newIdentity);
      const session = resources.get(newIdentity)!.server.baseSession;
      expect(session.conversationKey).toBe('canonical-user');
      if (conversationBound) {
        expect(session.binding).toEqual({
          kind: 'conversation-bound',
          conversationKey: 'canonical-user',
          deliveryJid: newIdentity,
        });
        expect(session.deliveryJid).toBe(newIdentity);
      } else {
        expect(session.binding).toBeUndefined();
        expect(session.deliveryJid).toBeUndefined();
      }
      manager.release(newIdentity);
    },
  );

  it('uses the rekeyed default conversation pin for request-level confinement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsoup-actor-manager-'));
    roots.push(root);
    const registry = new ToolRegistry();
    const calls: string[] = [];
    registry.register({
      name: 'rekeyed_send',
      description: 'test',
      schema: z.object({ chatJid: z.string() }),
      scope: 'chat',
      targetMode: 'injected',
      handler: async (params) => {
        calls.push(params['chatJid'] as string);
        return { ok: true };
      },
    });
    const manager = makeManager(root, { registry, conversationBound: false });
    const oldIdentity = 'legacy-lid@lid';
    const newIdentity = 'canonical-user@s.whatsapp.net';
    const lease = manager.acquire(oldIdentity, oldIdentity);
    await lease.ready;
    manager.rekey(oldIdentity, newIdentity, newIdentity);

    const accepted = await sendJsonRpc(lease.socketPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'rekeyed_send', arguments: { chatJid: newIdentity } },
    }) as { result: { isError?: boolean } };
    const rejected = await sendJsonRpc(lease.socketPath, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'rekeyed_send', arguments: { chatJid: oldIdentity } },
    }) as { result: { isError?: boolean } };

    expect(accepted.result.isError).not.toBe(true);
    expect(rejected.result.isError).toBe(true);
    expect(calls).toEqual([newIdentity]);
    manager.release(newIdentity);
  });
});
