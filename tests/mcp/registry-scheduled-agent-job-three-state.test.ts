// #3435 (L1) — the registry scheduled-agent-job gate is a THREE-STATE decision,
// not a default flip. This suite exercises the AUTHORITATIVE gate directly: every
// surface (global socket, chat-scoped socket, provider bridge, passive socket)
// converges on ToolRegistry.listTools/call with a ResolvedSessionContext, so the
// gate is where the fail-open lived and where the fix must hold.
//
// The three states (field × turn-kind), each asserted through BOTH discovery
// (listTools) and execution (call):
//
//   (a) UNRESOLVED     — an empty (all-undefined) executing context reached the
//                        gate: no real resolution happened. The forbidden
//                        history-mutation set is DENIED (fail-closed). This row is
//                        RED on the pre-fix gate (undefined purpose fell open) and
//                        GREEN with the fix.
//   (b) RESOLVED-NORMAL — a REAL resolution, ordinary (non-scheduled) turn
//                        (purpose undefined). The forbidden set MUST stay
//                        REACHABLE — the no-over-restriction control, GREEN both
//                        before and after the fix.
//   (c) RESOLVED-SCHEDULED — purpose === 'scheduled-agent-job'. DENIED (unchanged).
//
// The contexts are built with resolveSessionContext() directly — NOT via the
// direct-registry test adapter, which asserts resolution unconditionally and would
// rescue the unresolved row into a vacuous pass.

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../../src/mcp/registry.ts';
import {
  noExecutingSession,
  resolveSessionContext,
  type ExecutingSessionContext,
  type ResolvedSessionContext,
  type SessionContext,
} from '../../src/mcp/types.ts';

const FORBIDDEN = 'delete_message'; // a scheduled-agent-job forbidden (history-mutation) tool
const CONTROL = 'send_message'; // NOT forbidden — must be reachable in every state
const ADMIN_JID = '15550001@s.whatsapp.net';

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Register both under production names, scope 'global', caller-supplied target,
  // NOT sensitive — so `purpose` is the SOLE gate (matches production: the 6
  // forbidden tools are not sensitive:true).
  for (const name of [FORBIDDEN, CONTROL]) {
    registry.register({
      name,
      description: `three-state gate probe (${name})`,
      scope: 'global',
      targetMode: 'caller-supplied',
      schema: z.object({}),
      handler: async () => ({ ok: true, tool: name }),
    });
  }
  return registry;
}

/** Build a resolved snapshot from an explicit executing context (never the adapter). */
function resolved(
  session: SessionContext,
  executing: ExecutingSessionContext,
): ResolvedSessionContext {
  return resolveSessionContext(session, executing);
}

function listNames(registry: ToolRegistry, session: ResolvedSessionContext): string[] {
  return registry.listTools(session).map((t) => t.name);
}

function textOf(result: Awaited<ReturnType<ToolRegistry['call']>>): string {
  return result.content.map((part) => part.text).join('\n');
}

/** The scheduled-gate denial for a global session returns the non-disclosing
 *  "Unknown tool: <name>" reply — assert that shape so a pass is the GATE denial,
 *  not some unrelated error (scope/schema/durability). No durability engine is
 *  attached here, so the durable-evidence early-return path is not in play. */
async function expectGateDenied(
  registry: ToolRegistry,
  session: ResolvedSessionContext,
  name: string,
): Promise<void> {
  expect(listNames(registry, session)).not.toContain(name);
  const call = await registry.call(name, {}, session);
  expect(call.isError).toBe(true);
  expect(textOf(call)).toMatch(new RegExp(`Unknown tool: ${name}`));
}

/** Reachable = listed AND the handler actually RAN (its payload came back, so the
 *  call passed the gate — not merely isError falsy from a short-circuit). */
async function expectReachable(
  registry: ToolRegistry,
  session: ResolvedSessionContext,
  name: string,
): Promise<void> {
  expect(listNames(registry, session)).toContain(name);
  const call = await registry.call(name, {}, session);
  expect(call.isError).toBeFalsy();
  expect(textOf(call)).toContain(`"tool": "${name}"`);
}

describe('#3435 registry scheduled-agent-job gate — three-state', () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = makeRegistry();
  });

  it('(a) UNRESOLVED empty context DENIES the forbidden set (fail-closed hardening)', async () => {
    // noExecutingSession() is the canonical empty context; resolveSessionContext
    // classifies it 'unresolved'. On the pre-fix gate an undefined purpose fell
    // OPEN here — this is the row the fix flips.
    const session = resolved({ tier: 'global' }, noExecutingSession());
    expect(session.executingResolution).toBe('unresolved');

    await expectGateDenied(registry, session, FORBIDDEN);
    // Control: a non-forbidden tool is UNAFFECTED by the scheduled gate even when unresolved.
    await expectReachable(registry, session, CONTROL);
  });

  it('(b) RESOLVED-NORMAL turn keeps the forbidden set REACHABLE (no over-restriction)', async () => {
    // A real resolution recognized by a defined field (a live register entry
    // always pins a canonical conversationKey), ordinary turn (purpose undefined).
    const viaField = resolved(
      { tier: 'global' },
      { actorJid: ADMIN_JID, purpose: undefined, conversationKey: '15550002' },
    );
    expect(viaField.executingResolution).toBe('resolved');
    await expectReachable(registry, viaField, FORBIDDEN);

    // A legitimately all-undefined resolved-normal turn, asserted explicitly
    // (the shape the direct-registry adapter uses). purpose undefined must NOT deny.
    const viaAssertion = resolved(
      { tier: 'global' },
      { actorJid: undefined, purpose: undefined, conversationKey: undefined, resolved: true },
    );
    expect(viaAssertion.executingResolution).toBe('resolved');
    await expectReachable(registry, viaAssertion, FORBIDDEN);
  });

  it('(c) RESOLVED-SCHEDULED turn DENIES the forbidden set (unchanged)', async () => {
    const session = resolved(
      { tier: 'global' },
      { actorJid: ADMIN_JID, purpose: 'scheduled-agent-job', conversationKey: '15550002' },
    );
    expect(session.executingResolution).toBe('resolved');

    await expectGateDenied(registry, session, FORBIDDEN);
    // Control: a scheduled turn may still publish a fresh update (non-forbidden).
    await expectReachable(registry, session, CONTROL);
  });
});
