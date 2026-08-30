// #2976 residual — the in-process provider MCP bridge (managed-loop providers)
// is the sibling of the global socket that #3389 fixed with a read-time actor
// resolver. The bridge held the long-lived per-session MCP context whose
// actorJid was written per turn (updateMcpActorJid) and never cleared, so a
// subsequent actor-less turn authorized/attributed as the PREVIOUS sender.
//
// These tests exercise the AUTHORIZATION consequence through a REAL ToolRegistry
// with the REAL substrate admin authorizer (isAdminActor) and the REAL bridge.
// The executing-turn register is modeled by a mutable variable the resolver
// closes over (in production the resolver reads AgentRuntime's
// perChatExecActorQueue; that wiring is covered in bridge-actor-scoping.test.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../../helpers/logger-mock.ts');
  return loggerMock();
});

import { Database } from '../../../../src/core/database.ts';
import { ToolRegistry } from '../../../../src/mcp/registry.ts';
import { isAdminActor, type SubstrateDeps } from '../../../../src/mcp/tools/substrate.ts';
import { createProviderMcpBridge } from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';
import type { SessionContext } from '../../../../src/mcp/types.ts';

const ADMIN_JID = '15550001@s.whatsapp.net';
const NON_ADMIN_JID = '15559999@s.whatsapp.net';

function makeAdminDeps(db: Database): SubstrateDeps {
  return {
    db: db.raw,
    instanceName: 'test-instance',
    dbWrapper: db,
    adminPhones: new Set<string>(['15550001']),
    memory: {
      adminJid: 'admin@s.whatsapp.net',
      vaultPath: '/tmp/whatsoup-test-vault-bridge-actor',
      observationConfidenceMin: 0.5,
      sweep: { beadProposeMin: 0.5, beadUpdateMin: 0.5, lookbackHours: 24, reviewByDays: 7 },
      watchTtl: { defaultHours: 24, maxHours: 168 },
    },
  };
}

/** Register a real sensitive (admin-gated) tool through the R1 central gate. */
function registerSensitiveProbe(registry: ToolRegistry, deps: SubstrateDeps): void {
  registry.setSensitiveToolAuthorizer((session) => isAdminActor(deps, session));
  registry.register({
    name: 'admin_probe',
    sensitive: true,
    description: 'Admin-gated probe',
    scope: 'global',
    targetMode: 'caller-supplied',
    schema: z.object({}),
    handler: async () => ({ ok: true }),
  });
}

describe('provider MCP bridge — read-time actor scoping (#2976 residual)', () => {
  let db: Database;
  let registry: ToolRegistry;
  /** Models the long-lived stored MCP session context. updateMcpActorJid sets
   *  actorJid here; on base it is NEVER cleared, so it lingers across turns. */
  let storedSession: SessionContext;
  /** Models the executing-turn actor register (undefined ⇒ no turn executing). */
  let executingActor: string | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    registerSensitiveProbe(registry, makeAdminDeps(db));
    // Turn N ran for the admin and left the stored conduit populated — the
    // lingering value that the base code never clears.
    storedSession = { tier: 'global', actorJid: ADMIN_JID };
    executingActor = undefined;
  });

  it('AUTH RED: an admin sensitive tool is DENIED on the actor-less follow-up turn (base: fail-open)', async () => {
    const bridge = createProviderMcpBridge(registry, storedSession, () => executingActor);

    // Between turns: no turn executes, so the read-time resolver yields
    // undefined and the R1 gate must deny fail-closed. On unmodified base the
    // resolver is ignored and the lingering admin actorJid on storedSession
    // authorizes the call — this assertion fails (proves the fail-open).
    executingActor = undefined;
    const between = await bridge.executeTool('admin_probe', {});
    expect(between.isError).toBe(true);
    expect(between.content).toMatch(/admin/i);
  });

  it('AUTH GREEN pin: the real admin mid-turn is still ALLOWED (no regression)', async () => {
    const bridge = createProviderMcpBridge(registry, storedSession, () => executingActor);

    // Mid-turn: the executing turn's sender is the admin → allowed.
    executingActor = ADMIN_JID;
    const mid = await bridge.executeTool('admin_probe', {});
    expect(mid.isError).toBe(false);
    expect(mid.content).toContain('"ok": true');
  });

  it('a non-admin executing turn is DENIED even when the stored conduit holds a stale admin', async () => {
    const bridge = createProviderMcpBridge(registry, storedSession, () => executingActor);

    // storedSession.actorJid is still the stale admin, but the executing turn
    // belongs to a non-admin — the resolver override must win.
    executingActor = NON_ADMIN_JID;
    const result = await bridge.executeTool('admin_probe', {});
    expect(result.isError).toBe(true);
  });

  it('without a resolver the stored session is used verbatim (unchanged legacy contract)', async () => {
    // Callers that manage identity themselves (e.g. direct-construction tests)
    // keep the pre-#2976 behavior: the stored session reaches the registry.
    const bridge = createProviderMcpBridge(registry, storedSession);
    const result = await bridge.executeTool('admin_probe', {});
    expect(result.isError).toBe(false);
  });
});
