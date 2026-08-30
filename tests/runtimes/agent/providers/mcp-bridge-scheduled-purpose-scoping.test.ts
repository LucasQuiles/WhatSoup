// #3427 — the in-process provider MCP bridge (managed-loop providers) is one of
// the two surfaces where a scheduled agent job's `purpose` was lost, leaving the
// registry's scheduled-agent-job forbidden-tools gate inert. The bridge is the
// sibling of the global socket; #3426 gave it a read-time ACTOR resolver, and
// #3427 adds the read-time PURPOSE resolver beside it.
//
// These tests exercise the AUTHORIZATION consequence through a REAL ToolRegistry
// with the REAL scheduled-agent-job gate (registry.ts) and a REAL forbidden tool
// (`delete_message`, a member of SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS). The
// executing-turn purpose register is modeled by a mutable variable the resolver
// closes over; in production it reads AgentRuntime's perChatExecActorQueue slot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../../../../src/logger.ts', async () => {
  const { loggerMock } = await import('../../../helpers/logger-mock.ts');
  return loggerMock();
});

import { ToolRegistry } from '../../../../src/mcp/registry.ts';
import { SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS } from '../../../../src/mcp/registry.ts';
import { createProviderMcpBridge } from '../../../../src/runtimes/agent/providers/mcp-bridge.ts';
import type { SessionContext } from '../../../../src/mcp/types.ts';

const ADMIN_JID = '15550001@s.whatsapp.net';
const FORBIDDEN_TOOL = 'delete_message';
const SCHEDULED = 'scheduled-agent-job' as const;

/** Register a forbidden chat tool under a real member name of
 *  SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS. The scheduled-agent-job gate
 *  (scheduledAgentJobMaySee) keys ONLY on tool.name + session.purpose, so a
 *  name-matching probe is a faithful test of that gate; `caller-supplied`
 *  targetMode keeps the reachable path free of target-injection validation so
 *  "reached the handler" (gate inert) is cleanly distinct from the gate's
 *  "Unknown tool" denial. The POSITIVE CONTROL proves the name is really in the
 *  forbidden set. */
function registerForbiddenProbe(registry: ToolRegistry): void {
  registry.register({
    name: FORBIDDEN_TOOL,
    description: 'Delete a message (forbidden to scheduled jobs).',
    scope: 'chat',
    targetMode: 'caller-supplied',
    schema: z.object({}),
    handler: async () => ({ reached: true }),
  });
}

describe('provider MCP bridge — read-time scheduled-agent-job purpose scoping (#3427)', () => {
  let registry: ToolRegistry;
  /** Models the long-lived stored MCP session context: for single/shared it
   *  carries NO static purpose, so the gate depends entirely on the resolver. */
  let storedSession: SessionContext;
  /** Models the executing-turn purpose register (undefined ⇒ normal turn). */
  let executingPurpose: SessionContext['purpose'];

  beforeEach(() => {
    registry = new ToolRegistry();
    registerForbiddenProbe(registry);
    storedSession = { tier: 'global', actorJid: ADMIN_JID, conversationKey: 'c' };
    executingPurpose = undefined;
  });

  // ── Positive control: the gate is live and imported, and delete_message is a
  //    real member of the forbidden set. Proves a red elsewhere is a WIRING red,
  //    not a missing import or a mis-named tool. ────────────────────────────────
  it('POSITIVE CONTROL: the real gate denies delete_message iff purpose is scheduled-agent-job', async () => {
    expect(SCHEDULED_AGENT_JOB_FORBIDDEN_TOOLS.has(FORBIDDEN_TOOL)).toBe(true);
    const denied = await registry.call(FORBIDDEN_TOOL, {}, { tier: 'global', actorJid: ADMIN_JID, conversationKey: 'c', purpose: SCHEDULED });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toBe(`Unknown tool: ${FORBIDDEN_TOOL}`);
    const reachable = await registry.call(FORBIDDEN_TOOL, {}, { tier: 'global', actorJid: ADMIN_JID, conversationKey: 'c', purpose: undefined });
    expect(reachable.isError).toBeFalsy();
    expect(reachable.content[0]?.text).toContain('"reached": true');
  });

  it('AUTH RED→GREEN: a scheduled job (admin JID) is DENIED the forbidden tool when the resolver injects purpose', async () => {
    const bridge = createProviderMcpBridge(
      registry,
      storedSession,
      () => ADMIN_JID,
      () => executingPurpose,
    );
    // Executing turn IS a scheduled job. On unmodified base (resolvePurpose
    // ignored) storedSession.purpose is undefined → gate inert → the forbidden
    // tool is REACHABLE; this assertion fails, proving the fail-open. With the
    // fix the read-time purpose engages the gate → denied.
    executingPurpose = SCHEDULED;
    const result = await bridge.executeTool(FORBIDDEN_TOOL, {});
    expect(result.isError).toBe(true);
    expect(result.content).toBe(`Unknown tool: ${FORBIDDEN_TOOL}`);
  });

  it('a NORMAL turn (no scheduled purpose) still reaches the tool — the gate does not over-restrict', async () => {
    const bridge = createProviderMcpBridge(
      registry,
      storedSession,
      () => ADMIN_JID,
      () => executingPurpose,
    );
    executingPurpose = undefined;
    const result = await bridge.executeTool(FORBIDDEN_TOOL, {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"reached": true');
  });

  it('the purpose resolver ADDS the restriction but never CLEARS a statically-set one (per_chat safety, ?? merge)', async () => {
    // A per_chat dedicated scheduled-job session carries a static purpose; its
    // bridge resolver returns undefined (per_chat reads no global register). The
    // `?? session.purpose` merge must keep the static restriction.
    const staticJobSession: SessionContext = { tier: 'chat-scoped', actorJid: ADMIN_JID, conversationKey: 'c', purpose: SCHEDULED };
    const bridge = createProviderMcpBridge(
      registry,
      staticJobSession,
      () => ADMIN_JID,
      () => undefined,
    );
    const result = await bridge.executeTool(FORBIDDEN_TOOL, {});
    expect(result.isError).toBe(true);
    expect(result.content).toBe(`Unknown tool: ${FORBIDDEN_TOOL}`);
  });

  it('without a purpose resolver the stored session is used verbatim (unchanged legacy contract)', async () => {
    const bridge = createProviderMcpBridge(registry, storedSession, () => ADMIN_JID);
    const result = await bridge.executeTool(FORBIDDEN_TOOL, {});
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"reached": true');
  });
});
