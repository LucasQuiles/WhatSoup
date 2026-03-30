// tests/mcp/tool-registration.test.ts
// Integration test: verify all 13 registration functions wire up without conflicts.

import { describe, it, expect } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerMessagingTools } from '../../src/mcp/tools/messaging.ts';
import { registerMediaTools } from '../../src/mcp/tools/media.ts';
import { registerChatManagementTools } from '../../src/mcp/tools/chat-management.ts';
import { registerChatOperationTools } from '../../src/mcp/tools/chat-operations.ts';
import { registerSearchTools } from '../../src/mcp/tools/search.ts';
import { registerGroupTools } from '../../src/mcp/tools/groups.ts';
import { registerCommunityTools } from '../../src/mcp/tools/community.ts';
import { registerNewsletterTools } from '../../src/mcp/tools/newsletter.ts';
import { registerBusinessTools } from '../../src/mcp/tools/business.ts';
import { registerAdvancedTools } from '../../src/mcp/tools/advanced.ts';
import { registerCallTools } from '../../src/mcp/tools/calls.ts';
import { registerPresenceTools } from '../../src/mcp/tools/presence.ts';
import { registerProfileTools } from '../../src/mcp/tools/profile.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Minimal ConnectionManager mock — only the properties the registration
// functions call at registration time (none) or via getSock (returns null).
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

describe('tool registration', () => {
  it('registers all tools without duplicate names', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();
    const connection = makeConnection();
    const getSock = () => connection.getSocket();
    const register = (tool: ToolDeclaration) => registry.register(tool);

    // Messaging & media
    registerMessagingTools(registry, { connection, db: db.raw });
    registerMediaTools(registry, { connection });

    // DB-dependent tools
    registerChatManagementTools(db, getSock, register);
    registerChatOperationTools(db, getSock, register);
    registerSearchTools(db, register);

    // Socket-only tools
    registerGroupTools(getSock, register);
    registerCommunityTools(getSock, register);
    registerNewsletterTools(getSock, register);
    registerBusinessTools(getSock, register);
    registerAdvancedTools(getSock, register);
    registerCallTools(getSock, register);
    registerProfileTools(getSock, register);

    // Presence
    registerPresenceTools(getSock, connection.presenceCache, register);

    const tools = registry.listTools({ tier: 'global' });

    // At least 100 tools should be registered across all modules
    expect(tools.length).toBeGreaterThan(100);

    // No duplicate tool names
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);

    db.raw.close();
  });
});
