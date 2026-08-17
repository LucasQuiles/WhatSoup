/**
 * S5 — the `logout` tool must be gated (bond-revocation programme, 2026-08-17).
 *
 * `logout` calls `sock.logout()`, which sends an outbound
 * `remove-companion-device reason=user_initiated` iq and then ends the socket
 * with a local `loggedOut` Boom (Baileys `lib/Socket/socket.js:569`). It is the
 * ONLY WhatSoup path that intentionally requests removal of its own companion
 * device — the same class of outcome the fleet has hit seven times, though NOT
 * the same event path: those were inbound `CB:stream:error` with
 * `conflict type=device_removed`, which this call does not produce.
 *
 * It shipped globally registered with no `sensitive` flag, grandfathered
 * "pending per-tool review" since 2026-08-04 alongside read-only tools such as
 * `list_chats` and `mute_chat`. These tests pin the gate so that classification
 * cannot silently return.
 *
 * The R1 gate is fail-closed by construction (`registry.ts` — no authorizer, no
 * actorJid, or a throwing authorizer all deny), so `sensitive: true` alone
 * delivers the default-disable this requires; no bespoke gate is introduced.
 */
import { describe, it, expect } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ADMIN_REQUIRED_DENIAL, ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type { SessionContext, ToolDeclaration } from '../../src/mcp/types.ts';

const ADMIN: SessionContext = { tier: 'global', actorJid: '15550000001@s.whatsapp.net' };

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => null,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

/** Build the real registry and capture every declaration as it registers. */
function buildRealRegistry(): { registry: ToolRegistry; captured: ToolDeclaration[] } {
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
  return { registry, captured };
}

describe('S5 — logout is a gated, device-removing tool', () => {
  it('is declared sensitive', () => {
    const { captured } = buildRealRegistry();
    // Non-vacuity: the interceptor must have seen registrations, and `logout`
    // must actually exist. An absent tool would otherwise pass silently.
    expect(captured.length).toBeGreaterThan(0);
    const logout = captured.find((t) => t.name === 'logout');
    expect(logout, 'the logout tool must still be registered').toBeDefined();
    expect(logout!.sensitive).toBe(true);
  });

  // The gate-state tests below re-register the REAL captured declaration into a
  // fresh registry. registerAllTools() installs the instance admin predicate and
  // setSensitiveToolAuthorizer() throws on a second install by design, so the
  // authorizer states cannot be varied on the production registry. Re-hosting the
  // genuine declaration keeps these tests bound to the shipped tool rather than a
  // hand-written stand-in.
  function hostRealLogout(): ToolRegistry {
    const { captured } = buildRealRegistry();
    const logout = captured.find((t) => t.name === 'logout');
    expect(logout, 'the logout tool must still be registered').toBeDefined();
    const registry = new ToolRegistry();
    registry.register(logout!);
    return registry;
  }

  it('denies the call fail-closed when no authorizer is installed', async () => {
    // The production default before an instance installs its admin predicate.
    // Device removal must not be reachable in that state, even for an
    // actor-bearing global session.
    const res = await hostRealLogout().call('logout', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('logout'));
  });

  it('denies when the authorizer refuses, and never reaches the socket', async () => {
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => false);
    const res = await registry.call('logout', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('logout'));
    // The denial must come from the gate, not from an incidental socket failure
    // downstream — otherwise this test would still pass with the gate removed.
    expect(res.content[0].text).not.toContain('not connected');
  });

  it('denies when the authorizer throws (fail-closed, never grants)', async () => {
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => {
      throw new Error('predicate exploded');
    });
    const res = await registry.call('logout', {}, ADMIN);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('logout'));
  });

  it('denies a session with no actorJid even when the authorizer would grant', async () => {
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => true);
    const res = await registry.call('logout', {}, { tier: 'global' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(ADMIN_REQUIRED_DENIAL('logout'));
  });
});

describe('S5 — the sock-tool factory propagates the sensitive flag', () => {
  // Regression guard for the root cause found while landing S5: SockToolConfig
  // had no `sensitive` field and makeSockTool never copied it, so no tool built
  // through this factory could be gated at all. Setting the flag was silently
  // discarded — the config array is typed SockToolConfig<any>[], which disables
  // excess-property checking, so TypeScript did not reject it either.
  it('copies sensitive: true onto the built declaration', () => {
    const { captured } = buildRealRegistry();
    const sockBuilt = captured.filter((t) => t.sensitive === true);
    // Non-vacuity: at least one sensitive tool must exist, else this asserts nothing.
    expect(sockBuilt.length).toBeGreaterThan(0);
    expect(sockBuilt.map((t) => t.name)).toContain('logout');
  });
});
