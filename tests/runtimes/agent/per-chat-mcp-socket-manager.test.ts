import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Database } from '../../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../../src/core/outbound-sends.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { SESSION_TOKEN_NOTIFICATION, SessionTokenRegistry } from '../../../src/mcp/caller-attribution.ts';
import { WhatSoupSocketServer } from '../../../src/mcp/socket-server.ts';
import { registerMessagingTools } from '../../../src/mcp/tools/messaging.ts';
import { noExecutingSession } from '../../../src/mcp/types.ts';
import { isPathWithinAllowedRoot } from '../../../src/lib/path-boundary.ts';
import { admitHomeConfinedPath } from '../../../src/lib/home-confinement.ts';
import {
  assertSafeOwnedSocket,
  PerChatMcpSocketManager,
} from '../../../src/runtimes/agent/per-chat-mcp-socket-manager.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { createActiveTurnReplySink } from '../../../src/runtimes/agent/turn-reply-sink.ts';
import { waitForSocket } from '../../helpers/wait-for.ts';
import { sendJsonRpc } from '../../helpers/socket-rpc.ts';
import { outsideRuntimeHome } from '../../helpers/runtime-home-fixture.ts';

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

  function makeShortStateRoot(): string {
    return mkdtempSync(join(tmpdir(), 'ws-'));
  }

  function makeManager(
    root: string,
    options: { registry?: ToolRegistry; conversationBound?: boolean } = {},
  ): PerChatMcpSocketManager {
    return new PerChatMcpSocketManager({
      stateRoot: root,
      registry: options.registry ?? new ToolRegistry(),
      allowedRoot: root,
      conversationBound: options.conversationBound ?? true,
      resolveExecutingSession: () => ({
        actorJid: undefined,
        purpose: undefined,
        conversationKey: undefined,
      }),
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

  async function exchange(socketPath: string, lines: unknown[]): Promise<unknown> {
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
        resolve(JSON.parse(line));
      });
      client.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000).unref();
    });
  }

  it('F6 carries an admitted runtime root into the first actor socket after alias retarget', async () => {
    const root = mkdtempSync(join(homedir(), 'f6-actor-root-'));
    const outside = await outsideRuntimeHome(homedir(), 'f6-actor-outside-');
    roots.push(root, outside);
    const physical = join(root, 'physical');
    const alias = join(root, 'alias');
    mkdirSync(physical);
    symlinkSync(physical, alias);
    const insideFile = join(physical, 'inside.txt');
    const outsideFile = join(outside, 'outside.txt');
    writeFileSync(insideFile, 'inside');
    writeFileSync(outsideFile, 'outside');
    const admittedRoot = admitHomeConfinedPath(alias, homedir());
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry: new ToolRegistry(),
      allowedRoot: admittedRoot,
      conversationBound: true,
      resolveExecutingSession: noExecutingSession,
    });
    const later = 'later@s.whatsapp.net';
    try {
      const resources = (manager as unknown as {
        resources: Map<string, { server: { baseSession: { allowedRoot?: string } } }>;
      }).resources;
      expect(resources.size).toBe(0);
      unlinkSync(alias);
      symlinkSync(outside, alias);
      await manager.acquire(later, later).ready;
      const context = resources.get(later)!.server.baseSession;
      expect(isPathWithinAllowedRoot(realpathSync.native(outsideFile), context.allowedRoot)).toBe(false);
      expect(isPathWithinAllowedRoot(realpathSync.native(insideFile), context.allowedRoot)).toBe(true);
      expect(context.allowedRoot).toBe(admittedRoot);
    } finally {
      manager.release(later);
    }
  });

  it('binds an awaitable mode-0600 socket below a mode-0700 state-root directory using only a digest', async () => {
    const root = makeShortStateRoot();
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

  it('retains the runtime-provided active-turn reply sink on the socket session', async () => {
    const root = makeShortStateRoot();
    roots.push(root);
    const identities: string[] = [];
    const sink = () => ({ disposition: 'inactive' as const });
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry: new ToolRegistry(),
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: noExecutingSession,
      resolveTurnReplySink: (identity) => {
        identities.push(identity);
        return sink;
      },
    });
    const identity = 'active-turn@s.whatsapp.net';
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    try {
      const resources = (manager as unknown as {
        resources: Map<string, { server: { baseSession: { turnReplySink?: unknown } } }>;
      }).resources;
      expect(identities).toEqual([identity]);
      expect(resources.get(identity)!.server.baseSession.turnReplySink).toBe(sink);
    } finally {
      manager.release(identity);
    }
  });

  it('rejects a stale session token and a delayed raw acknowledgement at the real socket boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    roots.push(root);
    const identity = 'socket-turn@s.whatsapp.net';
    const conversationKey = 'socket-turn';
    const tokens = new SessionTokenRegistry();
    const queue = new OutboundQueue({
      sendMessage: async () => ({ waMessageId: null }),
      sendMedia: async () => ({ waMessageId: null }),
    }, identity, { conversationKey });
    let active = { managerId: 'live-manager', logicalTurnId: 'socket-old-turn' };
    queue.beginTurnEvidence(active.logicalTurnId);
    const sink = createActiveTurnReplySink((request) => (
      request.runtimeSessionId === active.managerId
        ? { queue, logicalTurnId: active.logicalTurnId }
        : undefined
    ));
    const dispositions: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: 'capture_active_turn',
      description: 'test-only active turn reply capture',
      scope: 'chat',
      targetMode: 'injected',
      schema: z.object({ delayedAck: z.boolean().optional() }),
      handler: async (params, session) => {
        const request = {
          chatJid: identity,
          conversationKey,
          text: 'socket reply',
          runtimeSessionId: session.turnReplySessionId ?? '',
        };
        const reserved = session.turnReplySink?.({ ...request, action: 'reserve' });
        if (params['delayedAck'] === true && reserved?.disposition === 'reserved') {
          queue.abortTurn();
          active = { managerId: 'live-manager', logicalTurnId: 'socket-new-turn' };
          queue.beginTurnEvidence(active.logicalTurnId);
          dispositions.push(reserved, session.turnReplySink?.({
            ...request,
            action: 'commit',
            reservationId: reserved.reservationId,
          }));
        } else {
          dispositions.push(reserved);
        }
        return { ok: true };
      },
    });
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry,
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: noExecutingSession,
      resolveTurnReplySink: () => sink,
      sessionTokens: tokens,
    });
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    // Both tokens are bound to this socket, so the stale case is refused by the
    // turn-reply arbitration, not by the socket binding.
    const staleToken = tokens.mint({ kind: 'session', socketPath: lease.socketPath, turnReplySessionId: 'stale-manager' });
    const liveToken = tokens.mint({ kind: 'session', socketPath: lease.socketPath, turnReplySessionId: 'live-manager' });
    try {
      await exchange(lease.socketPath, [
        { jsonrpc: '2.0', method: SESSION_TOKEN_NOTIFICATION, params: { token: staleToken } },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capture_active_turn', arguments: {} } },
      ]);
      expect(dispositions).toEqual([{ disposition: 'inactive' }]);

      await exchange(lease.socketPath, [
        { jsonrpc: '2.0', method: SESSION_TOKEN_NOTIFICATION, params: { token: liveToken } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'capture_active_turn', arguments: { delayedAck: true } } },
      ]);
      expect(dispositions.slice(1)).toMatchObject([
        { disposition: 'reserved' },
        { disposition: 'inactive' },
      ]);
      expect(queue.hasCommittedAnswer()).toBe(false);
    } finally {
      manager.release(identity);
      queue.abortTurn();
    }
  });

  it('does not let a stale socket session bypass active-turn reply arbitration through send_message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    roots.push(root);
    const identity = 'socket-turn@s.whatsapp.net';
    const tokens = new SessionTokenRegistry();
    const rawSends: Array<{ jid: string; content: unknown }> = [];
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    registerMessagingTools(registry, {
      connection: {
        contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
        sendRaw: async (jid: string, content: unknown) => {
          rawSends.push({ jid, content });
          return { waMessageId: 'unexpected-raw-send' };
        },
      } as never,
      db: db.raw,
      dbWrapper: db,
      adminPhones: new Set<string>(),
    });
    const queue = new OutboundQueue({
      sendMessage: async () => ({ waMessageId: null }),
      sendMedia: async () => ({ waMessageId: null }),
    }, identity, { conversationKey: 'socket-turn' });
    queue.beginTurnEvidence('live-turn');
    const sink = createActiveTurnReplySink((request) => (
      request.runtimeSessionId === 'live-manager'
        ? { queue, logicalTurnId: 'live-turn' }
        : undefined
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
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    // Bound to this socket, so only the turn-reply arbitration refuses it.
    const staleToken = tokens.mint({ kind: 'session', socketPath: lease.socketPath, turnReplySessionId: 'stale-manager' });
    try {
      const response = await exchange(lease.socketPath, [
        { jsonrpc: '2.0', method: SESSION_TOKEN_NOTIFICATION, params: { token: staleToken } },
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'send_message', arguments: { text: 'stale socket reply' } },
        },
      ]) as { result: { content: Array<{ text: string }> } };

      expect(rawSends).toEqual([]);
      expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({
        sent: false,
        suppressed: true,
        reason: 'active_turn_unavailable',
      });
    } finally {
      manager.release(identity);
      queue.abortTurn();
      db.close();
    }
  });

  it('keeps a delayed raw acknowledgement submitted without committing the newer socket turn', async () => {
    const root = makeShortStateRoot();
    roots.push(root);
    const identity = 'socket-delayed-ack@s.whatsapp.net';
    const tokens = new SessionTokenRegistry();
    const db = new Database(':memory:');
    db.open();
    const queue = new OutboundQueue({
      sendMessage: async () => ({ waMessageId: null }),
      sendMedia: async () => ({ waMessageId: null }),
    }, identity, { conversationKey: 'socket-delayed-ack' });
    let activeTurnId = 'socket-old-turn';
    queue.beginTurnEvidence(activeTurnId);
    const sink = createActiveTurnReplySink((request) => (
      request.runtimeSessionId === 'live-manager'
        ? { queue, logicalTurnId: activeTurnId }
        : undefined
    ));
    const rawSends: Array<{ jid: string; content: unknown }> = [];
    const registry = new ToolRegistry();
    registerMessagingTools(registry, {
      connection: {
        contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
        sendRaw: async (jid: string, content: unknown) => {
          rawSends.push({ jid, content });
          queue.abortTurn();
          activeTurnId = 'socket-new-turn';
          queue.beginTurnEvidence(activeTurnId);
          return { waMessageId: 'delayed-provider-ack' };
        },
      } as never,
      db: db.raw,
      dbWrapper: db,
      adminPhones: new Set<string>(),
      auditWriter: createOutboundSendsWriter({ db: db.raw, line: 'test-line' }),
    });
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry,
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: noExecutingSession,
      resolveTurnReplySink: () => sink,
      sessionTokens: tokens,
    });
    const lease = manager.acquire(identity, identity);
    await lease.ready;
    const liveToken = tokens.mint({ kind: 'session', socketPath: lease.socketPath, turnReplySessionId: 'live-manager' });
    try {
      const response = await exchange(lease.socketPath, [
        { jsonrpc: '2.0', method: SESSION_TOKEN_NOTIFICATION, params: { token: liveToken } },
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            name: 'send_message',
            arguments: { text: 'https://example.com', link_preview: 'off' },
          },
        },
      ]) as { result: { content: Array<{ text: string }> } };

      expect(rawSends).toHaveLength(1);
      expect(JSON.parse(response.result.content[0]!.text)).toMatchObject({ sent: true });
      expect(queue.hasCommittedAnswer()).toBe(false);
      expect(db.raw.prepare(`
        SELECT outcome_code, failure_stage, mutation_state, provider_submission_count
        FROM outbound_sends
      `).get()).toEqual({
        outcome_code: 'submitted',
        failure_stage: 'ack_received',
        mutation_state: 'acknowledged',
        provider_submission_count: 1,
      });
    } finally {
      manager.release(identity);
      queue.abortTurn();
      db.close();
    }
  });

  it.each([
    ['symlink', (path: string) => symlinkSync('/private/actor-target', path)],
    ['non-socket', (path: string) => writeFileSync(path, 'owned data', { mode: 0o600 })],
  ])('rejects an exact-path %s collision without unlinking it', async (_kind, createCollision) => {
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
    roots.push(root);
    const socketPath = join(root, 'occupied.sock');
    writeFileSync(socketPath, 'collision', { mode: 0o600 });
    const before = lstatSync(socketPath);
    const server = new WhatSoupSocketServer(
      socketPath,
      new ToolRegistry(),
      { tier: 'global', allowedRoot: root },
      noExecutingSession,
    );

    await expect(server.startAndWait({ unlinkExisting: false })).rejects.toBeDefined();
    const after = lstatSync(socketPath);
    expect({ dev: after.dev, ino: after.ino })
      .toEqual({ dev: before.dev, ino: before.ino });
  });

  it('replaces an unreachable same-uid stale socket at only the exact known path', async () => {
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
    roots.push(root);
    const observedIdentities: string[] = [];
    const manager = new PerChatMcpSocketManager({
      stateRoot: root,
      registry: new ToolRegistry(),
      allowedRoot: root,
      conversationBound: true,
      resolveExecutingSession: (identity) => {
        observedIdentities.push(identity);
        return {
          actorJid: identity,
          purpose: undefined,
          conversationKey: identity,
        };
      },
    });
    const oldIdentity = '15550001111@lid';
    const newIdentity = '15550001111@s.whatsapp.net';
    const lease = manager.acquire(oldIdentity, oldIdentity);
    await lease.ready;
    const resources = (manager as unknown as {
      resources: Map<string, {
        server: {
          executingSessionResolver: () => {
            actorJid?: string;
            purpose?: string;
            conversationKey?: string;
          };
          baseSession: {
            binding?: { conversationKey: string; deliveryJid: string };
          };
        };
      }>;
    }).resources;
    const resource = resources.get(oldIdentity)!;

    const oldContext = resource.server.executingSessionResolver();
    expect(oldContext.actorJid).toBe(oldIdentity);
    expect(oldContext.conversationKey).toBe(oldIdentity);
    manager.rekey(oldIdentity, newIdentity, newIdentity);
    const newContext = resource.server.executingSessionResolver();
    expect(newContext.conversationKey).toBe(newIdentity);
    expect(newContext.actorJid).toBe(newIdentity);
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
      const root = makeShortStateRoot();
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
    const root = makeShortStateRoot();
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
