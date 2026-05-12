// tests/mcp/register-all.test.ts
// TDD test for the standalone registerAllTools function.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';

// Baseline tool count for a non-Pinecone build.
// Bumped from a loose `>= 100` to an exact baseline so a missing module is detected.
// 160 always-registered + 1 conditional `knowledge_search` when Pinecone is configured.
const BASELINE_TOOL_COUNT = 160;

// ---------------------------------------------------------------------------
// Minimal ConnectionManager mock — mirrors what tool-registration.test.ts uses
// ---------------------------------------------------------------------------

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

describe('registerAllTools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the exact baseline tool count on a non-Pinecone build', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    registerAllTools(registry, connection, db);

    const tools = registry.listTools({ tier: 'global' });
    // Exact count, not a loose lower-bound — a silently-dropped module must surface here.
    expect(tools.length).toBe(BASELINE_TOOL_COUNT);

    db.raw.close();
  });

  it('always registers the critical inventory by name', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    registerAllTools(registry, connection, db);

    const tools = registry.listTools({ tier: 'global' });
    const names = new Set(tools.map((t) => t.name));

    // Critical tools — if any of these are missing the harness is unusable.
    const criticalInventory = [
      'send_message',
      'send_media',
      'list_messages',
      'list_chats',
      'cleanup_media',
      'post_status',
      'list_statuses',
      'schedule_message',
      'list_scheduled',
      'cancel_scheduled',
      'read_outbound_sends',
    ];
    for (const name of criticalInventory) {
      expect(names.has(name), `critical tool "${name}" missing from registry`).toBe(true);
    }

    db.raw.close();
  });

  it('re-throws when a core tool module fails to register (fail-closed)', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    // Force a core module — chat-management — to throw during registration.
    const chatMgmt = await import('../../src/mcp/tools/chat-management.ts');
    vi.spyOn(chatMgmt, 'registerChatManagementTools').mockImplementation(() => {
      throw new Error('synthetic core failure: chat-management broke');
    });

    expect(() => registerAllTools(registry, connection, db)).toThrow(
      /chat-management|core/i,
    );

    db.raw.close();
  });

  it('logs and continues when an optional tool module fails to register', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    // Force the optional knowledge module to throw, with Pinecone enabled so the path executes.
    const knowledgeMod = await import('../../src/mcp/tools/knowledge.ts');
    vi.spyOn(knowledgeMod, 'registerKnowledgeTools').mockImplementation(() => {
      throw new Error('synthetic optional failure: pinecone unreachable');
    });

    // Configure Pinecone so the knowledge branch is reached.
    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.memory;
    (cfgMod.config as { memory?: unknown }).memory = {
      ...(original ?? {}),
      pinecone: {
        ...((original as { pinecone?: object } | undefined)?.pinecone ?? {}),
        allowedIndexes: ['mw-mind'],
      },
    };

    try {
      expect(() => registerAllTools(registry, connection, db)).not.toThrow();
      // Core tools still registered.
      const tools = registry.listTools({ tier: 'global' });
      expect(tools.some((t) => t.name === 'send_message')).toBe(true);
      // Knowledge tool absent because optional module threw.
      expect(tools.some((t) => t.name === 'knowledge_search')).toBe(false);
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
  });

  it('registers tools with no duplicate names', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    registerAllTools(registry, connection, db);

    const tools = registry.listTools({ tier: 'global' });
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);

    db.raw.close();
  });

  // Gap #4: every tool has an explicit scope and replayPolicy (no relying on defaults)
  it('every registered tool has an explicit scope and replayPolicy', () => {
    const db = new Database(':memory:');
    db.open();

    // Capture all ToolDeclarations as they are registered
    const captured: ToolDeclaration[] = [];
    const registry = new ToolRegistry();
    const origRegister = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      captured.push(tool);
      origRegister(tool);
    };

    const connection = makeConnection();
    registerAllTools(registry, connection, db);

    expect(captured.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const tool of captured) {
      const hasScope = 'scope' in tool && tool.scope !== undefined;
      const hasReplayPolicy = 'replayPolicy' in tool && tool.replayPolicy !== undefined;
      if (!hasScope || !hasReplayPolicy) {
        missing.push(
          `${tool.name}: scope=${hasScope ? tool.scope : 'MISSING'}, replayPolicy=${hasReplayPolicy ? tool.replayPolicy : 'MISSING'}`,
        );
      }
    }

    expect(missing).toEqual([]);

    db.raw.close();
  });
});
