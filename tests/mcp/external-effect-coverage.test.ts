/**
 * D2 exhaustiveness — every tool the registry exposes MUST carry an explicit
 * `externalEffect` declaration at the current contract version. No grandfather
 * list: an unclassified tool folds to `unknown` at runtime (which blocks
 * automatic obligation creation), and fails CI here so the gap is closed at
 * authoring time, not discovered in production folds.
 *
 * Pattern follows tests/mcp/sensitive-taxonomy-coverage.test.ts (register
 * interceptor + full registerAllTools against real in-memory SQLite).
 */
import { describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import { EXTERNAL_EFFECT_CONTRACT_VERSION } from '../../src/mcp/external-effect.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import type { ToolDeclaration } from '../../src/mcp/types.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

describe('external-effect taxonomy coverage (D2)', () => {
  it('every registered tool declares externalEffect at the current version', () => {
    const db = new Database(':memory:');
    db.open();
    const registry = new ToolRegistry();

    const captured: ToolDeclaration[] = [];
    const origRegister = registry.register.bind(registry);
    registry.register = (tool: ToolDeclaration) => {
      captured.push(tool);
      origRegister(tool);
    };

    registerAllTools(registry, makeConnection(), db);
    db.raw.close();

    // Non-vacuity floor.
    expect(captured.length).toBeGreaterThan(100);

    const missing = captured
      .filter((t) => t.externalEffect === undefined)
      .map((t) => t.name)
      .sort();
    expect(
      missing,
      `tools missing an explicit externalEffect declaration:\n${missing.join('\n')}`,
    ).toEqual([]);

    const wrongVersion = captured
      .filter((t) => t.externalEffect !== undefined && t.externalEffect.version !== EXTERNAL_EFFECT_CONTRACT_VERSION)
      .map((t) => t.name)
      .sort();
    expect(wrongVersion, `tools at a stale externalEffect version:\n${wrongVersion.join('\n')}`).toEqual([]);
  });
});
