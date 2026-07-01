/**
 * QR-047 — restart_self lacked a hard admin gate. Its handler was `async (params) =>`,
 * ignoring the session, so a non-admin actorJid in an auto-responded chat could induce
 * the global operator-agent to call restart_self → service restart (prompt-injection DoS
 * / restart-loop). Every sibling privileged tool (substrate.ts) calls assertAdmin; this
 * one did not. The fix threads the session into the handler and calls the injected
 * `assertAdmin(session)` BEFORE any ack or trigger.
 *
 * These tests inject a realistic assertAdmin (admin = one specific actorJid). The gate's
 * phone-resolution correctness lives in lib/phone + access-list tests; here we prove the
 * self-restart handler actually INVOKES the gate, fail-closed, before triggering.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildRestartSelfTool,
  type RestartSelfToolDeps,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

const ADMIN_JID = '15550100111@s.whatsapp.net';

function harness(overrides: Partial<RestartSelfToolDeps> = {}) {
  const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/d/m' }));
  const sendAck = vi.fn(async (_chatJid: string, _text: string) => {});
  const serviceManager = { restart: vi.fn(async (_name: string) => {}) };
  // Realistic gate: only ADMIN_JID passes; anyone else is rejected fail-closed.
  const assertAdmin = vi.fn((session: SessionContext) => {
    if (session.actorJid !== ADMIN_JID) {
      throw new Error(`restart_self is admin-only: caller "${session.actorJid ?? 'unresolved'}" is not on the admin list`);
    }
  });
  const deps: RestartSelfToolDeps = {
    instanceName: 'q',
    dataRoot: '/data/q',
    resolveChatJid: () => '1111111000000000@g.us',
    sendAck,
    serviceManager,
    trigger,
    assertAdmin,
    ...overrides,
  };
  return { deps, trigger, sendAck, assertAdmin };
}

const adminSession: SessionContext = { tier: 'global', actorJid: ADMIN_JID };
const nonAdminSession: SessionContext = { tier: 'global', actorJid: '15550100199@s.whatsapp.net' };

describe('restart_self admin gate (QR-047)', () => {
  it('REJECTS a non-admin actor and does NOT trigger a restart or send an ack', async () => {
    const { deps, trigger, sendAck } = harness();
    const tool = buildRestartSelfTool(deps);

    await expect(tool.handler({ reason: 'restart now' }, nonAdminSession)).rejects.toThrow(/admin-only/);

    expect(trigger).not.toHaveBeenCalled();
    expect(sendAck).not.toHaveBeenCalled(); // gate is the FIRST action, before the ack
  });

  it('ALLOWS an admin actor: gate runs, then the restart triggers', async () => {
    const { deps, trigger, assertAdmin } = harness();
    const tool = buildRestartSelfTool(deps);

    const result = (await tool.handler({ reason: 'load merged main', code: 'redeploy' }, adminSession)) as { restarting: boolean };

    expect(assertAdmin).toHaveBeenCalledWith(adminSession);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(result.restarting).toBe(true);
  });

  it('gate fires before the trigger (ordering): a throwing gate short-circuits', async () => {
    const calls: string[] = [];
    const { deps } = harness({
      assertAdmin: () => { calls.push('gate'); throw new Error('admin-only: nope'); },
      trigger: async () => { calls.push('trigger'); return { ok: true, markerPath: '/d/m' }; },
    });
    const tool = buildRestartSelfTool(deps);

    await expect(tool.handler({ reason: 'r' }, nonAdminSession)).rejects.toThrow();
    expect(calls).toEqual(['gate']); // trigger never reached
  });
});
