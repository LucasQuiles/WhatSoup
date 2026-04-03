// src/runtimes/passive/runtime.ts
// PassiveRuntime — connects to WhatsApp, exposes all MCP tools via Unix socket,
// but never auto-responds. For personal phone / journalling instances.

import type { Runtime } from '../types.ts';
import type { IncomingMessage, RuntimeHealth } from '../../core/types.ts';
import type { DurabilityEngine } from '../../core/durability.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import type { Database } from '../../core/database.ts';
import { ToolRegistry } from '../../mcp/registry.ts';
import { registerAllTools } from '../../mcp/register-all.ts';
import { WhatSoupSocketServer } from '../../mcp/socket-server.ts';
import type { SessionContext } from '../../mcp/types.ts';
import { join } from 'node:path';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('passive-runtime');

export class PassiveRuntime implements Runtime {
  private db: Database;
  private connection: ConnectionManager;
  private config: { name: string; paths: { stateRoot: string }; socketPath?: string };
  private socketServer: WhatSoupSocketServer | null = null;
  private registry: ToolRegistry;
  private durability: DurabilityEngine | null = null;

  constructor(
    db: Database,
    connection: ConnectionManager,
    config: { name: string; paths: { stateRoot: string }; socketPath?: string },
  ) {
    this.db = db;
    this.connection = connection;
    this.config = config;
    this.registry = new ToolRegistry();
    // NOTE: registerAllTools is called in start(), not here.
    // This mirrors AgentRuntime's pattern where connection-dependent
    // work is deferred until start().
  }

  async start(): Promise<void> {
    registerAllTools(this.registry, this.connection, this.db);
    if (this.durability) this.registry.setDurability(this.durability);

    const socketPath = this.config.socketPath
      ?? join(this.config.paths.stateRoot, 'whatsoup.sock');
    const session: SessionContext = { tier: 'global' };
    this.socketServer = new WhatSoupSocketServer(socketPath, this.registry, session);
    this.socketServer.start();
    log.info(
      { socketPath, toolCount: this.registry.listTools({ tier: 'global' }).length },
      'passive runtime started',
    );
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    // Passive runtime does not process messages.
    // Ingest pipeline short-circuits before calling this (see ingest.ts).
    // Defensive: if called directly, complete the inbound lifecycle.
    if (this.durability && msg.inboundSeq) {
      this.durability.completeInbound(msg.inboundSeq, 'passive_instance');
    }
  }

  setDurability(engine: DurabilityEngine): void {
    this.durability = engine;
    this.registry.setDurability(engine);
  }

  getHealthSnapshot(): RuntimeHealth {
    let unreadCount = 0;
    let lastActivityAt: string | null = null;
    try {
      const row = this.db.raw
        .prepare('SELECT COALESCE(SUM(unread_count), 0) as total, MAX(updated_at) as last_at FROM chats')
        .get() as { total: number; last_at: string | null } | undefined;
      if (row) {
        unreadCount = row.total;
        lastActivityAt = row.last_at;
      }
    } catch {
      // DB error — fall back to safe defaults
    }
    return { status: 'healthy', details: { unreadCount, lastActivityAt } };
  }

  async shutdown(): Promise<void> {
    this.socketServer?.stop();
    log.info('passive runtime shut down');
  }
}
