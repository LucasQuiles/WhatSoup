// tests/mcp/register-all.test.ts
// TDD test for the standalone registerAllTools function.

import { describe, it, expect } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Minimal ConnectionManager mock — mirrors what tool-registration.test.ts uses
// ---------------------------------------------------------------------------

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map() },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

describe('registerAllTools', () => {
  it('registers >= 100 tools on a ToolRegistry', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();

    registerAllTools(registry, connection, db);

    const tools = registry.listTools({ tier: 'global' });
    expect(tools.length).toBeGreaterThanOrEqual(100);

    db.raw.close();
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
});
