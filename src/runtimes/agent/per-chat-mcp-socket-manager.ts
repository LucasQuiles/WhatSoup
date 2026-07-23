import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { toConversationKey } from '../../core/conversation-key.ts';
import type { ToolRegistry } from '../../mcp/registry.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import { perChatActorSession } from './per-chat-actor-session.ts';

interface PerChatMcpSocketManagerOptions {
  stateRoot: string;
  registry: ToolRegistry;
  allowedRoot: string;
  conversationBound: boolean;
  resolveActor: (conversationIdentity: string) => string | undefined;
}

interface PerChatSocketResource {
  socketPath: string;
  server: WhatSoupSocketServer;
  ready: Promise<void>;
  identity: { value: string };
}

interface TeardownBarrier {
  identity: { value: string };
  ready: Promise<void>;
}

function processUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function assertSafeOwnedSocket(stat: Stats, expectedUid = processUid()): void {
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error('actor MCP socket path collision');
  }
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    throw new Error('actor MCP socket ownership collision');
  }
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.destroy();
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') resolve(false);
      else reject(new Error('actor MCP socket collision probe failed'));
    });
  });
}

export class PerChatMcpSocketManager {
  private readonly options: PerChatMcpSocketManagerOptions;
  private readonly resources = new Map<string, PerChatSocketResource>();
  private readonly teardownBarriers = new Map<string, TeardownBarrier>();

  constructor(options: PerChatMcpSocketManagerOptions) {
    this.options = options;
  }

  acquire(conversationIdentity: string, deliveryJid: string): {
    socketPath: string;
    ready: Promise<void>;
  } {
    const barrier = this.teardownBarriers.get(conversationIdentity);
    if (barrier) {
      const socketPath = this.socketPathFor(conversationIdentity);
      return {
        socketPath,
        ready: barrier.ready.then(async () => {
          const replacement = this.acquire(conversationIdentity, deliveryJid);
          if (replacement.socketPath !== socketPath) {
            throw new Error('actor MCP socket path changed across teardown');
          }
          await replacement.ready;
        }),
      };
    }
    const existing = this.resources.get(conversationIdentity);
    if (existing) return { socketPath: existing.socketPath, ready: existing.ready };

    const directory = join(this.options.stateRoot, 'mcp');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new Error('actor MCP socket directory collision');
    }
    if (processUid() !== undefined && directoryStat.uid !== processUid()) {
      throw new Error('actor MCP socket directory ownership collision');
    }
    chmodSync(directory, 0o700);
    const socketPath = this.socketPathFor(conversationIdentity);
    const identity = { value: conversationIdentity };
    const server = new WhatSoupSocketServer(
      socketPath,
      this.options.registry,
      perChatActorSession(
        deliveryJid,
        this.options.allowedRoot,
        this.options.conversationBound,
      ),
      () => this.options.resolveActor(identity.value),
    );
    let ownedSocket: { dev: number; ino: number } | undefined;
    let resource!: PerChatSocketResource;
    const ready = this.startSafely(socketPath, server)
      .then(() => {
        const socketStat = lstatSync(socketPath);
        assertSafeOwnedSocket(socketStat);
        ownedSocket = { dev: socketStat.dev, ino: socketStat.ino };
        chmodSync(socketPath, 0o600);
        const finalStat = statSync(socketPath);
        assertSafeOwnedSocket(finalStat);
        if (finalStat.dev !== ownedSocket.dev || finalStat.ino !== ownedSocket.ino) {
          throw new Error('actor MCP transport changed during readiness proof');
        }
      })
      .catch((err: unknown) => {
        server.stop({ unlinkSocket: false });
        if (ownedSocket) {
          try {
            const current = lstatSync(socketPath);
            assertSafeOwnedSocket(current);
            if (current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
              unlinkSync(socketPath);
            }
          } catch (cleanupErr) {
            if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
              // Preserve the readiness failure; an exact-path mismatch is left untouched.
            }
          }
        }
        if (this.resources.get(identity.value) === resource) {
          this.resources.delete(identity.value);
        }
        throw err;
      });
    resource = { socketPath, server, ready, identity };
    this.resources.set(conversationIdentity, resource);
    void ready.catch(() => {});
    return { socketPath, ready };
  }

  private socketPathFor(conversationIdentity: string): string {
    const digest = createHash('sha256').update(conversationIdentity).digest('hex').slice(0, 16);
    return join(this.options.stateRoot, 'mcp', `${digest}.sock`);
  }

  private async startSafely(
    socketPath: string,
    server: WhatSoupSocketServer,
  ): Promise<void> {
    let existing: Stats | null = null;
    try {
      existing = lstatSync(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existing) {
      assertSafeOwnedSocket(existing);
      if (await socketIsLive(socketPath)) {
        throw new Error('live actor MCP socket collision');
      }
      const current = lstatSync(socketPath);
      assertSafeOwnedSocket(current);
      if (current.dev !== existing.dev || current.ino !== existing.ino) {
        throw new Error('actor MCP socket collision changed during probe');
      }
      unlinkSync(socketPath);
    }
    await server.startAndWait({ unlinkExisting: false });
  }

  release(conversationIdentity: string): void {
    if (this.teardownBarriers.has(conversationIdentity)) {
      throw new Error('actor MCP socket release requires terminal child proof');
    }
    this.releaseOwned(conversationIdentity);
  }

  private releaseOwned(conversationIdentity: string): void {
    const resource = this.resources.get(conversationIdentity);
    if (!resource) return;
    resource.server.stop();
    this.resources.delete(conversationIdentity);
  }

  releaseAfter(conversationIdentity: string, childStopped: Promise<void>): void {
    if (this.teardownBarriers.has(conversationIdentity)) return;
    const identity = { value: conversationIdentity };
    let barrier!: TeardownBarrier;
    const ready = childStopped.then(() => {
      this.releaseOwned(identity.value);
      if (this.teardownBarriers.get(identity.value) === barrier) {
        this.teardownBarriers.delete(identity.value);
      }
    });
    barrier = { identity, ready };
    this.teardownBarriers.set(conversationIdentity, barrier);
    void ready.catch(() => {});
  }

  rekey(
    oldIdentity: string,
    newIdentity: string,
    deliveryJid: string,
  ): void {
    if (oldIdentity === newIdentity) return;
    const resource = this.resources.get(oldIdentity);
    const target = this.resources.get(newIdentity);
    if (resource && target && target !== resource) {
      throw new Error('actor MCP socket rekey collision');
    }
    if (resource) {
      this.resources.delete(oldIdentity);
      resource.identity.value = newIdentity;
      if (this.options.conversationBound) {
        resource.server.updateConversationBinding(deliveryJid);
      } else {
        resource.server.updateConversationKey(toConversationKey(deliveryJid));
      }
      this.resources.set(newIdentity, resource);
    }
    const barrier = this.teardownBarriers.get(oldIdentity);
    if (barrier) {
      this.teardownBarriers.delete(oldIdentity);
      barrier.identity.value = newIdentity;
      this.teardownBarriers.set(newIdentity, barrier);
    }
  }
}
