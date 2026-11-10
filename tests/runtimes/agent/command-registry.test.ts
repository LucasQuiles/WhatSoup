import { describe, it, expect, vi } from 'vitest';
import {
  COMMAND_REGISTRY,
  commandGateDenies,
  getCommandSpec,
  type CommandGate,
  type CommandSpec,
} from '../../../src/runtimes/agent/command-registry.ts';
import type { SessionScope } from '../../../src/runtimes/agent/runtime-options.ts';

describe('COMMAND_REGISTRY', () => {
  it('has a unique name per entry', () => {
    const names = COMMAND_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seeds exactly the eight commands the classifier knows today (D11/D12: /why removed; #2949 N1 added /stop)', () => {
    expect(COMMAND_REGISTRY.map((c) => c.name).sort()).toEqual(
      ['help', 'kill-session', 'model', 'new', 'reset', 'sessions', 'status', 'stop'],
    );
  });

  it('declares every axis validly for every entry (gate/venue/tier/visibility/renderContract/errorClasses)', () => {
    for (const c of COMMAND_REGISTRY as readonly CommandSpec[]) {
      expect(['none', 'admin', 'admin-shared-scope']).toContain(c.gate); // W1-T3 RULING: admin-shared-scope added for /new
      expect([undefined, 'dm', 'admin-group', 'any']).toContain(c.venue);    // N17 venue axis (optional)
      expect(['transport-local', 'agent-forwarded']).toContain(c.tier);      // schema-forward tier axis
      expect(['end-user', 'operator']).toContain(c.visibility);
      if (c.renderContract) expect(typeof c.renderContract.asOf).toBe('boolean'); // N16 contract, where declared
      expect(c.errorClasses.length).toBeGreaterThan(0);
      expect(typeof c.summary).toBe('string');
      expect(c.syntax.startsWith('/')).toBe(true);
    }
  });

  it('uses only WhatsApp-safe placeholders in syntax/summary — no `<...>` (E1)', () => {
    for (const c of COMMAND_REGISTRY as readonly CommandSpec[]) {
      expect(c.syntax).not.toMatch(/[<>]/);   // `<N>` etc. are eaten by WhatsApp markup
      expect(c.summary).not.toMatch(/[<>]/);
    }
  });

  it('every Phase-1 command is transport-local (LLM-free tier)', () => {
    expect(COMMAND_REGISTRY.every((c) => c.tier === 'transport-local')).toBe(true);
  });

  it('N17: cross-session admin surfaces are admin-gated and group-permitting (B21-A F3 base parity); /new is group-permitting by design (W1-T3 RULING)', () => {
    // /sessions and /kill-session are cross-session admin surfaces (U6),
    // identity-gated (gate:'admin'). Venue is 'any' since B21-A F3: the
    // pre-registry phone-only gates let admins run these from groups, and the
    // former venue:'dm' declaration leaned on isAdminMessage's DM-only clause,
    // which the runtime gate deliberately dropped. The W3 god-priv
    // 'admin-group' floor lands with its venue-aware gate.
    for (const name of ['sessions', 'kill-session'] as const) {
      expect(getCommandSpec(name).gate).toBe('admin');
      expect(getCommandSpec(name).venue).toBe('any');
    }
    // /new is group-permitting by design (W1-PACKET.md W1-T3 RULING: an admin
    // may /new in a group). Its gate is scope-based ('admin-shared-scope',
    // enforced by commandGateDenies via sessionScope/isGroup — NOT the venue
    // axis), so venue is 'any', not 'dm'.
    expect(getCommandSpec('new').gate).toBe('admin-shared-scope');
    expect(getCommandSpec('new').venue).toBe('any');
    expect(getCommandSpec('status').venue).toBe('any');
  });

  it('N16: state-rendering commands declare asOf + field provenance', () => {
    expect(getCommandSpec('status').renderContract?.asOf).toBe(true);
    expect(getCommandSpec('sessions').renderContract?.asOf).toBe(true);
    expect(getCommandSpec('status').renderContract?.fields).toMatchObject({ started: 'verified-runtime' });
  });

  it('admin-gates (admin or admin-shared-scope) exactly new/stop/sessions/kill-session (the session-control set, D2)', () => {
    // W1-T3 RULING: /new moved from gate:'admin' to gate:'admin-shared-scope'
    // (scope-based — see the N17 test above); its total admin coverage is
    // unchanged, just split across the two gate values.
    // #2949 N1: /stop joins the set on the same gate as /new and for the same
    // reason (WG-5) — tearing down the active turn hits SHARED session state in
    // single/shared scope and in a per_chat group.
    expect(
      COMMAND_REGISTRY.filter((c) => c.gate === 'admin' || c.gate === 'admin-shared-scope')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['kill-session', 'new', 'sessions', 'stop']);
  });

  it('marks /status operator-only sensitive fields (D3: pid + sessionId) while staying ungated', () => {
    const status = getCommandSpec('status');
    expect(status.gate).toBe('none');
    expect(status.sensitiveFields).toEqual(['pid', 'sessionId']);
  });

  it('flags model/reset as routing aliases and only those (D11/D12: /why removed)', () => {
    // Deviation (labeled, T1-REPORT.md): the packet's verbatim `COMMAND_REGISTRY
    // .filter((c) => c.routingAlias)` does not typecheck — `as const satisfies
    // readonly CommandSpec[]` keeps COMMAND_REGISTRY's narrow per-entry literal
    // type, and `routingAlias` is absent (not merely undefined) on the 5 entries
    // that don't declare it, so TS2339 fires on the union access. Cast to the
    // widened `readonly CommandSpec[]`, matching the pattern the packet already
    // uses at the two `for (const c of COMMAND_REGISTRY as readonly CommandSpec[])`
    // sites above. Semantics-preserving; runtime behavior is unchanged.
    expect((COMMAND_REGISTRY as readonly CommandSpec[]).filter((c) => c.routingAlias).map((c) => c.name).sort())
      .toEqual(['model', 'reset']);
  });

  it('carries the /model sub-verbs as membership data (D5), matching today’s classifier set', () => {
    // B26: 'list' (the config-derived model catalogue) joined the verb set.
    // D12: 'default' is dropped from the standalone verb set.
    expect(getCommandSpec('model').subVerbs).toEqual(['status', 'list', 'strongest', 'fastest']);
  });

  it('model subVerbs no longer include standalone default (D12)', () => {
    const model = COMMAND_REGISTRY.find((c) => c.name === 'model')!;
    expect(model.subVerbs).toEqual(['status', 'list', 'strongest', 'fastest']);
  });

  it('why is removed from the registry (D11)', () => {
    expect(COMMAND_REGISTRY.find((c) => (c.name as string) === 'why')).toBeUndefined();
  });

  it('getCommandSpec throws on an unknown command (fail-closed lookup)', () => {
    expect(() => getCommandSpec('nope' as never)).toThrow();
  });
});

// The one authority rule. The runtime command gate enforces it, and the queued
// receipt asks it before offering /stop, so the two cannot disagree. The
// runtime-level pins are command-gate-contract.test.ts group 1 (the gate) and
// queued-turn-receipt-runtime.test.ts (the receipt against the gate). Here:
// the rule itself, and that the admin lookup (a DB read) runs only when the
// answer depends on it.
describe('commandGateDenies: the one authority rule for the command gate and the queued receipt', () => {
  type Row = {
    title: string;
    gate: CommandGate;
    scope: SessionScope;
    isGroup: boolean;
    adminCount: number;
    isAdmin: boolean;
    denies: boolean;
    looksUpAdmin: boolean;
  };

  const rows: Row[] = [
    { title: 'none: single DM, admins configured, non-admin → allow, no lookup', gate: 'none', scope: 'single', isGroup: false, adminCount: 1, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'none: per_chat group, admins configured, non-admin → allow, no lookup', gate: 'none', scope: 'per_chat', isGroup: true, adminCount: 1, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'admin: per_chat DM, admins configured, admin → allow', gate: 'admin', scope: 'per_chat', isGroup: false, adminCount: 1, isAdmin: true, denies: false, looksUpAdmin: true },
    { title: 'admin: per_chat DM, admins configured, non-admin → deny', gate: 'admin', scope: 'per_chat', isGroup: false, adminCount: 1, isAdmin: false, denies: true, looksUpAdmin: true },
    { title: 'admin: single DM, no admin configured → deny (no empty-set exemption for admin)', gate: 'admin', scope: 'single', isGroup: false, adminCount: 0, isAdmin: false, denies: true, looksUpAdmin: true },
    { title: 'admin-shared-scope: per_chat DM, admins configured, non-admin → allow, no lookup', gate: 'admin-shared-scope', scope: 'per_chat', isGroup: false, adminCount: 1, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'admin-shared-scope: per_chat DM, no admin configured → allow, no lookup', gate: 'admin-shared-scope', scope: 'per_chat', isGroup: false, adminCount: 0, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'admin-shared-scope: per_chat group, admins configured, non-admin → deny', gate: 'admin-shared-scope', scope: 'per_chat', isGroup: true, adminCount: 1, isAdmin: false, denies: true, looksUpAdmin: true },
    { title: 'admin-shared-scope: per_chat group, admins configured, admin → allow', gate: 'admin-shared-scope', scope: 'per_chat', isGroup: true, adminCount: 2, isAdmin: true, denies: false, looksUpAdmin: true },
    { title: 'admin-shared-scope: per_chat group, no admin configured → allow, no lookup', gate: 'admin-shared-scope', scope: 'per_chat', isGroup: true, adminCount: 0, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'admin-shared-scope: single DM, admins configured, non-admin → deny', gate: 'admin-shared-scope', scope: 'single', isGroup: false, adminCount: 1, isAdmin: false, denies: true, looksUpAdmin: true },
    { title: 'admin-shared-scope: single DM, admins configured, admin → allow', gate: 'admin-shared-scope', scope: 'single', isGroup: false, adminCount: 1, isAdmin: true, denies: false, looksUpAdmin: true },
    { title: 'admin-shared-scope: shared DM, admins configured, non-admin → deny', gate: 'admin-shared-scope', scope: 'shared', isGroup: false, adminCount: 1, isAdmin: false, denies: true, looksUpAdmin: true },
    { title: 'admin-shared-scope: shared group, no admin configured → allow, no lookup', gate: 'admin-shared-scope', scope: 'shared', isGroup: true, adminCount: 0, isAdmin: false, denies: false, looksUpAdmin: false },
    { title: 'admin-shared-scope: single DM, no admin configured → allow, no lookup', gate: 'admin-shared-scope', scope: 'single', isGroup: false, adminCount: 0, isAdmin: false, denies: false, looksUpAdmin: false },
  ];

  it.each(rows.map((row) => [row.title, row] as const))('%s', (_title, row) => {
    const isAdmin = vi.fn(() => row.isAdmin);

    const denies = commandGateDenies(row.gate, {
      sessionScope: row.scope,
      isGroup: row.isGroup,
      adminCount: row.adminCount,
      isAdmin,
    });

    expect(denies).toBe(row.denies);
    expect(isAdmin).toHaveBeenCalledTimes(row.looksUpAdmin ? 1 : 0);
  });
});
