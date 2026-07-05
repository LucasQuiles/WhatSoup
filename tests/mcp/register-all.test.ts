// tests/mcp/register-all.test.ts
// TDD test for the standalone registerAllTools function.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';

// Baseline tool count for a non-Pinecone build.
// Bumped from a loose `>= 100` to an exact baseline so a missing module is detected.
// 162 always-registered + 1 conditional `knowledge_search` when Pinecone is configured.
const BASELINE_TOOL_COUNT = 162;

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

  it('R1: listing is not a gate — sensitive tools are listed to actor-less sessions (enforcement is at call)', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    registerAllTools(registry, makeConnection(), db);
    // The actor-less baseline is the full count — listing sensitive tools
    // matches base behavior; the call() gate is the authoritative enforcement.
    expect(registry.listTools({ tier: 'global' }).length).toBe(BASELINE_TOOL_COUNT);
    db.raw.close();
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

  // Issue #510: callback-path failures inside a core module must also fail closed.
  // The shared `register` helper passed to Pattern 2/3 modules previously swallowed
  // throws from `registry.register(tool)` (e.g. duplicate-name collisions), so a
  // core callback module would appear to register successfully even though tools
  // were silently dropped. The fix threads the parent module's `core` flag into
  // the helper so callback failures re-throw and surface to the runModule aggregator.
  it('fails closed when a core callback module hits a registry.register failure', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    // Pre-register a tool that chat-management (core, callback-path) will later
    // attempt to register, forcing registry.register to throw on duplicate.
    registry.register({
      name: 'list_messages',
      description: 'stale duplicate to force registry collision',
      schema: z.object({}),
      scope: 'global',
      replayPolicy: 'reject',
      handler: async () => ({ ok: true }),
    } as unknown as ToolDeclaration);

    expect(() => registerAllTools(registry, connection, db)).toThrow(
      /chat-management|core/i,
    );

    db.raw.close();
  });

  it('tolerates a callback-path registry failure from an optional module', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    // Pre-register the tool name that knowledge (optional, callback-path) will emit
    // so registry.register throws on duplicate when the optional module runs.
    registry.register({
      name: 'knowledge_search',
      description: 'stale duplicate to force optional collision',
      schema: z.object({}),
      scope: 'global',
      replayPolicy: 'reject',
      handler: async () => ({ ok: true }),
    } as unknown as ToolDeclaration);

    // Configure Pinecone so the knowledge branch runs.
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
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
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

  it('falls back to an empty profile registry when config.profiles is undefined', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.profiles;
    (cfgMod.config as { profiles?: unknown }).profiles = undefined; // line 78 `?? {}` fallback
    try {
      expect(() => registerAllTools(registry, connection, db)).not.toThrow();
      expect(registry.listTools({ tier: 'global' }).length).toBe(BASELINE_TOOL_COUNT);
    } finally {
      (cfgMod.config as { profiles?: unknown }).profiles = original;
      db.raw.close();
    }
  });

  it('registers knowledge_search when Pinecone is configured', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const knowledgeMod = await import('../../src/mcp/tools/knowledge.ts');
    vi.spyOn(knowledgeMod, 'registerKnowledgeTools').mockImplementation(
      ((_indexes: string[], register: (tool: ToolDeclaration) => void) => {
        register({
          name: 'knowledge_search',
          description: 'stub knowledge tool',
          schema: z.object({}),
          scope: 'global',
          replayPolicy: 'reject',
          handler: async () => ({ ok: true }),
        } as unknown as ToolDeclaration);
      }) as never,
    );

    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.memory;
    (cfgMod.config as { memory?: unknown }).memory = {
      ...((original as object | undefined) ?? {}),
      pinecone: {
        ...((original as { pinecone?: object } | undefined)?.pinecone ?? {}),
        allowedIndexes: ['mw-mind'],
      },
    };
    try {
      registerAllTools(registry, connection, db);
      const tools = registry.listTools({ tier: 'global' });
      expect(tools.some((t) => t.name === 'knowledge_search')).toBe(true);
      expect(tools.length).toBe(BASELINE_TOOL_COUNT + 1);
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
  });

  it('skips knowledge search when memory.pinecone.knowledgeSearch.enabled is false', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.memory;
    (cfgMod.config as { memory?: unknown }).memory = {
      ...((original as object | undefined) ?? {}),
      pinecone: { allowedIndexes: ['mw-mind'], knowledgeSearch: { enabled: false } },
    };
    try {
      registerAllTools(registry, connection, db);
      const tools = registry.listTools({ tier: 'global' });
      expect(tools.some((t) => t.name === 'knowledge_search')).toBe(false);
      expect(tools.length).toBe(BASELINE_TOOL_COUNT);
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
  });

  it('skips knowledge search when options.enableKnowledgeSearch is false', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.memory;
    (cfgMod.config as { memory?: unknown }).memory = {
      ...((original as object | undefined) ?? {}),
      pinecone: { allowedIndexes: ['mw-mind'] },
    };
    try {
      registerAllTools(registry, connection, db, { enableKnowledgeSearch: false });
      const tools = registry.listTools({ tier: 'global' });
      expect(tools.some((t) => t.name === 'knowledge_search')).toBe(false);
      expect(tools.length).toBe(BASELINE_TOOL_COUNT);
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
  });

  it('wraps a non-Error thrown by a core module into the aggregated failure', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const chatMgmt = await import('../../src/mcp/tools/chat-management.ts');
    vi.spyOn(chatMgmt, 'registerChatManagementTools').mockImplementation(() => {
      // throw a primitive (non-Error) to drive the `f.err instanceof Error ? ... : new Error(String(f.err))` false arm
      throw 'synthetic non-error core failure';
    });

    expect(() => registerAllTools(registry, connection, db)).toThrow(/chat-management/i);

    db.raw.close();
  });

  it('warns and continues on a per-tool registry failure inside an optional module', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    // Pre-register the name so the optional module's register(tool) throws a duplicate,
    // exercising makeRegister's core=false catch (warn-and-continue, line 107).
    registry.register({
      name: 'knowledge_search',
      description: 'pre-existing',
      schema: z.object({}),
      scope: 'global',
      replayPolicy: 'reject',
      handler: async () => ({ ok: true }),
    } as unknown as ToolDeclaration);

    const knowledgeMod = await import('../../src/mcp/tools/knowledge.ts');
    vi.spyOn(knowledgeMod, 'registerKnowledgeTools').mockImplementation(
      ((_indexes: string[], register: (tool: ToolDeclaration) => void) => {
        register({
          name: 'knowledge_search', // duplicate → registry.register throws → optional warn+continue
          description: 'dup',
          schema: z.object({}),
          scope: 'global',
          replayPolicy: 'reject',
          handler: async () => ({ ok: true }),
        } as unknown as ToolDeclaration);
      }) as never,
    );

    const cfgMod = await import('../../src/config.ts');
    const original = cfgMod.config.memory;
    (cfgMod.config as { memory?: unknown }).memory = {
      ...((original as object | undefined) ?? {}),
      pinecone: { allowedIndexes: ['mw-mind'] },
    };
    try {
      expect(() => registerAllTools(registry, connection, db)).not.toThrow();
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = original;
      db.raw.close();
    }
  });

  it('falls back to top-level config.pineconeAllowedIndexes when memory.pinecone is absent', async () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    const knowledgeMod = await import('../../src/mcp/tools/knowledge.ts');
    vi.spyOn(knowledgeMod, 'registerKnowledgeTools').mockImplementation(
      ((_indexes: string[], register: (tool: ToolDeclaration) => void) => {
        register({
          name: 'knowledge_search',
          description: 'stub',
          schema: z.object({}),
          scope: 'global',
          replayPolicy: 'reject',
          handler: async () => ({ ok: true }),
        } as unknown as ToolDeclaration);
      }) as never,
    );

    const cfgMod = await import('../../src/config.ts');
    const originalMem = cfgMod.config.memory;
    const originalTop = (cfgMod.config as { pineconeAllowedIndexes?: string[] }).pineconeAllowedIndexes;
    (cfgMod.config as { memory?: unknown }).memory = undefined; // outer ternary false
    (cfgMod.config as { pineconeAllowedIndexes?: string[] }).pineconeAllowedIndexes = ['legacy-index']; // inner ternary true
    try {
      registerAllTools(registry, connection, db);
      expect(registry.listTools({ tier: 'global' }).some((t) => t.name === 'knowledge_search')).toBe(true);
    } finally {
      (cfgMod.config as { memory?: unknown }).memory = originalMem;
      (cfgMod.config as { pineconeAllowedIndexes?: string[] }).pineconeAllowedIndexes = originalTop;
      db.raw.close();
    }
  });
});
