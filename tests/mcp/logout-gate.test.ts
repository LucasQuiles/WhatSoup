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
import { beforeAll, describe, it, expect } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { ADMIN_REQUIRED_DENIAL, ToolRegistry } from '../../src/mcp/registry.ts';
import { PresenceCache } from '../../src/transport/presence-cache.ts';
import { registerAllTools } from '../../src/mcp/register-all.ts';
import {
  bondActorLedger,
  resolveBondOwnerEvidence,
} from '../../src/transport/bond-actor-receipt.ts';
import type { ConnectionManager } from '../../src/transport/connection.ts';
import type {
  ExtendedBaileysSocket,
  SessionContext,
  ToolDeclaration,
} from '../../src/mcp/types.ts';

const ADMIN: SessionContext = { tier: 'global', actorJid: '15550000001@s.whatsapp.net' };

const socketState: { current: ExtendedBaileysSocket | null } = { current: null };

function makeConnection(): ConnectionManager {
  return {
    contactsDir: { contacts: new Map(), getLidMappings: () => undefined },
    presenceCache: new PresenceCache(),
    getSocket: () => socketState.current,
    sendRaw: async () => ({ waMessageId: null }),
    sendMedia: async () => ({ waMessageId: null }),
  } as unknown as ConnectionManager;
}

/**
 * Build the real registry once and capture every declaration as it registers.
 *
 * MEMOIZED deliberately. registerAllTools() installs 165 tools and applies the
 * full migration chain; doing that per test pushed several cases past the 10s
 * per-test timeout, and a timed-out run is inconclusive rather than red — it
 * would have destroyed the mutation evidence these tests exist to produce.
 * Registration is deterministic and the declarations are only read, so one build
 * serves every case. Tests that need to vary authorizer state build a fresh
 * ToolRegistry around the cached declaration instead (see hostRealLogout).
 *
 * The database is intentionally left open: the memoized registry outlives any one
 * test, and closing it under a live registry would make handler-reaching calls
 * fail for a reason unrelated to what is under test.
 */
let realRegistryCache: { registry: ToolRegistry; captured: ToolDeclaration[] } | null = null;

function buildRealRegistry(): { registry: ToolRegistry; captured: ToolDeclaration[] } {
  if (realRegistryCache) return realRegistryCache;
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
  realRegistryCache = { registry, captured };
  return realRegistryCache;
}

/**
 * Re-register the REAL captured declaration into a fresh registry.
 *
 * registerAllTools() installs the instance admin predicate, and
 * setSensitiveToolAuthorizer() throws on a second install by design, so the
 * authorizer states cannot be varied on the production registry. Re-hosting the
 * genuine declaration keeps these tests bound to the shipped tool rather than a
 * hand-written stand-in.
 */
function hostRealLogout(): ToolRegistry {
  const { captured } = buildRealRegistry();
  const logout = captured.find((t) => t.name === 'logout');
  expect(logout, 'the logout tool must still be registered').toBeDefined();
  const registry = new ToolRegistry();
  registry.register(logout!);
  return registry;
}

// Pay the one-time registration cost outside any test's budget. Charged to the
// first test it would exceed the 10s per-test timeout on its own, and a timeout
// is inconclusive — it cannot be distinguished from a real failure, which would
// silently void the mutation evidence.
beforeAll(() => {
  buildRealRegistry();
}, 120_000);

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

describe('S1 — logout records an actor receipt at the socket dispatch seam', () => {
  it('declares itself a device-removal path', () => {
    const { captured } = buildRealRegistry();
    const logout = captured.find((t) => t.name === 'logout');
    expect(logout, 'the logout tool must still be registered').toBeDefined();
    expect(logout!.bondEffect).toBe('requests_device_removal');
    // Exactly one tool may claim this: it is a factual marker, not a severity
    // label, and a second claimant would mean the taxonomy has drifted.
    expect(captured.filter((t) => t.bondEffect === 'requests_device_removal').map((t) => t.name))
      .toEqual(['logout']);
  });

  it('does not record a removal request when socket acquisition fails', async () => {
    bondActorLedger.reset();
    socketState.current = null;
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => true);
    const res = await registry.call('logout', {}, ADMIN);

    expect(res.isError).toBe(true);
    const evidence = resolveBondOwnerEvidence(bondActorLedger);
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    expect(evidence.bondRemovalRequest).toBeNull();
    expect(evidence.actorClass).toBe('unattributed');
  });

  it('does not record a removal request when schema validation rejects the call', async () => {
    bondActorLedger.reset();
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => true);

    const res = await registry.call('logout', { msg: 42 }, ADMIN);

    expect(res.isError).toBe(true);
    const evidence = resolveBondOwnerEvidence(bondActorLedger);
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    expect(evidence.bondRemovalRequest).toBeNull();
  });

  it('records at the live socket seam immediately before sock.logout', async () => {
    bondActorLedger.reset();
    socketState.current = {
      logout: async () => {
        const atDispatch = resolveBondOwnerEvidence(bondActorLedger);
        expect(atDispatch.status).toBe('consulted');
        if (atDispatch.status !== 'consulted') return;
        expect(atDispatch.bondRemovalRequest?.action).toBe('mcp_tool:logout');
        expect(atDispatch.bondRemovalRequest?.route).toBe('mcp');
        throw new Error('socket disconnected after dispatch');
      },
    } as unknown as ExtendedBaileysSocket;
    const registry = hostRealLogout();
    registry.setSensitiveToolAuthorizer(() => true);

    const res = await registry.call('logout', {}, ADMIN);

    socketState.current = null;
    expect(res.isError).toBe(true);
    const evidence = resolveBondOwnerEvidence(bondActorLedger);
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    expect(evidence.bondRemovalRequest?.action).toBe('mcp_tool:logout');
    expect(evidence.actorClass).toBe('operator');
  });

  it('does not let an ordinary tool call forge a removal request', async () => {
    bondActorLedger.reset();
    const { registry } = buildRealRegistry();
    // list_chats is read-only and reaches the same seam. It must land in the
    // temporal-context slot and leave the discriminator untouched.
    await registry.call('list_chats', {}, ADMIN);
    const evidence = resolveBondOwnerEvidence(bondActorLedger);
    expect(evidence.status).toBe('consulted');
    if (evidence.status !== 'consulted') return;
    expect(evidence.bondRemovalRequest).toBeNull();
    expect(evidence.actorClass).toBe('unattributed');
    expect(evidence.lastControlPlaneAction?.action).toBe('mcp_tool:list_chats');
    expect(evidence.causalRelation).toBe('temporal_only');
  });
});

describe('S5 — the sock-tool factory propagates the sensitive flag', () => {
  // Regression guard for the root cause found while landing S5: SockToolConfig
  // had no `sensitive` field and makeSockTool never copied it, so no tool built
  // through this factory could be gated at all. Setting the flag was silently
  // discarded — the config array is typed SockToolConfig<any>[], which disables
  // excess-property checking, so TypeScript did not reject it either.
  it('forwards no field that is not part of ToolDeclaration', () => {
    // The counterpart risk to the sensitive bug. makeSockTool now forwards config
    // fields by rest-spread instead of a whitelist, which makes silently DROPPING
    // a field impossible — at the cost of making silently FORWARDING one possible.
    // TypeScript cannot catch that: the config arrays are typed
    // `SockToolConfig<any>[]`, so excess-property checking is off and a stray key
    // in any config literal would ride onto the declaration unnoticed.
    //
    // This closes the trade permanently: a config-only member must be
    // destructured out in makeSockTool, and if someone forgets, this turns red.
    const ALLOWED = new Set([
      'name', 'description', 'schema', 'scope', 'targetMode', 'replayPolicy',
      'core', 'sensitive', 'bondEffect', 'group', 'externalEffect', 'handler',
    ]);
    const { captured } = buildRealRegistry();
    // Non-vacuity: a trivially small or empty capture would assert nothing.
    expect(captured.length).toBeGreaterThan(100);
    const leaked = captured.flatMap((tool) =>
      Object.keys(tool)
        .filter((key) => !ALLOWED.has(key))
        .map((key) => `${tool.name}.${key}`),
    );
    expect(leaked).toEqual([]);
    // And the spread must not have swallowed `call`, the one config-only member.
    expect(captured.some((t) => 'call' in t)).toBe(false);
  });

  it('copies sensitive: true onto the built declaration', () => {
    const { captured } = buildRealRegistry();
    const sockBuilt = captured.filter((t) => t.sensitive === true);
    // Non-vacuity: at least one sensitive tool must exist, else this asserts nothing.
    expect(sockBuilt.length).toBeGreaterThan(0);
    expect(sockBuilt.map((t) => t.name)).toContain('logout');
  });
});
