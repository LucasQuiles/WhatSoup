/**
 * B1 / QR-143 — restart_self admin gate must gate on AUTHENTICATED TRANSPORT
 * before the phone match, and the tool must carry `sensitive:true` for the
 * central R1 backstop.
 *
 * The hole: `resolvePhoneFromJid('<admin-digits>@sms', db)` collapses a spoofable
 * SMS JID to the SAME bare phone as a real WhatsApp admin. The prior gate was
 * phone-keyed only (no `isWhatsAppAuthenticatedJid`), and the tool had NO
 * `sensitive:true`, so the broken in-handler check was the ONLY thing standing
 * between a spoofed SMS admin-impersonation and a forced service restart.
 *
 * Both directions are proven: authenticated admin ALLOW preserved, @sms
 * admin-digits DENY new — at the helper, at the declaration, and end-to-end
 * through a real ToolRegistry central gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertRestartSelfAdmin,
  buildRestartSelfTool,
  type RestartSelfToolDeps,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

const ADMIN_DIGITS = '15550100111';
const ADMIN_PN_JID = `${ADMIN_DIGITS}@s.whatsapp.net`;
const ADMIN_SMS_JID = `+${ADMIN_DIGITS}@sms`; // spoofable: same bare digits as the admin
const adminPhones = new Set<string>([ADMIN_DIGITS]);

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

describe('assertRestartSelfAdmin — QR-143 transport gate (both directions)', () => {
  let db: Database;
  afterEach(() => { db?.close(); });

  it('ALLOWS an authenticated WhatsApp admin (@s.whatsapp.net)', () => {
    db = makeDb();
    expect(() =>
      assertRestartSelfAdmin({ tier: 'global', actorJid: ADMIN_PN_JID }, { db, adminPhones }),
    ).not.toThrow();
  });

  it('DENIES a spoofed <admin-digits>@sms even though it collapses to the admin phone', () => {
    db = makeDb();
    expect(() =>
      assertRestartSelfAdmin({ tier: 'global', actorJid: ADMIN_SMS_JID }, { db, adminPhones }),
    ).toThrow(/configured transport/);
  });

  it('DENIES a missing actorJid (fail-closed)', () => {
    db = makeDb();
    expect(() =>
      assertRestartSelfAdmin({ tier: 'global' }, { db, adminPhones }),
    ).toThrow(/configured transport/);
  });

  it('DENIES an authenticated non-admin phone', () => {
    db = makeDb();
    expect(() =>
      assertRestartSelfAdmin({ tier: 'global', actorJid: '15550100999@s.whatsapp.net' }, { db, adminPhones }),
    ).toThrow(/not on the instance admin list/);
  });

  it('DENIES an admin identity from a different configured transport namespace', () => {
    db = makeDb();
    expect(() =>
      assertRestartSelfAdmin(
        { tier: 'global', actorJid: ADMIN_PN_JID },
        { db, adminPhones, transport: 'signal' },
      ),
    ).toThrow(/configured transport/);
  });
});

describe('restart_self declaration — sensitive:true backstop', () => {
  it('carries sensitive:true so the central R1 gate applies', () => {
    const tool = buildRestartSelfTool(minimalDeps());
    expect(tool.sensitive).toBe(true);
  });
});

describe('restart_self central R1 gate (registry integration)', () => {
  let db: Database;
  afterEach(() => { db?.close(); });

  function registerWithCentralGate(): { registry: ToolRegistry; trigger: ReturnType<typeof vi.fn> } {
    const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/d/m' }));
    const registry = new ToolRegistry();
    // Mirror the production wiring: the central authorizer rides the same
    // authenticated-admin predicate the in-handler gate uses.
    registry.setSensitiveToolAuthorizer((session) => {
      try {
        assertRestartSelfAdmin(session, { db, adminPhones });
        return true;
      } catch {
        return false;
      }
    });
    registry.register(buildRestartSelfTool({
      ...minimalDeps(),
      trigger,
      assertAdmin: (session) => assertRestartSelfAdmin(session, { db, adminPhones }),
    }));
    return { registry, trigger };
  }

  it('DENIES a spoofed @sms actor at the central gate (uniform non-disclosing reply, handler never reached)', async () => {
    db = makeDb();
    const { registry, trigger } = registerWithCentralGate();
    const res = await registry.call('restart_self', { reason: 'r' }, { tier: 'global', actorJid: ADMIN_SMS_JID });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe('Unknown tool: restart_self');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('ALLOWS an authenticated admin through the central gate to the handler', async () => {
    db = makeDb();
    const { registry, trigger } = registerWithCentralGate();
    const res = await registry.call('restart_self', { reason: 'load merged main', code: 'redeploy' }, { tier: 'global', actorJid: ADMIN_PN_JID });
    expect(res.isError).toBeFalsy();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

function minimalDeps(): RestartSelfToolDeps {
  return {
    instanceName: 'q',
    dataRoot: '/data/q',
    resolveChatJid: () => undefined,
    sendAck: async () => {},
    serviceManager: { restart: async () => {} },
    trigger: async () => ({ ok: true, markerPath: '/d/m' }),
    assertAdmin: () => {},
  };
}
