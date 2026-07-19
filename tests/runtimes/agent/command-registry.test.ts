import { describe, it, expect } from 'vitest';
import {
  COMMAND_REGISTRY,
  getCommandSpec,
  type CommandSpec,
} from '../../../src/runtimes/agent/command-registry.ts';

describe('COMMAND_REGISTRY', () => {
  it('has a unique name per entry', () => {
    const names = COMMAND_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('seeds exactly the eight commands the classifier knows today', () => {
    expect(COMMAND_REGISTRY.map((c) => c.name).sort()).toEqual(
      ['help', 'kill-session', 'model', 'new', 'reset', 'sessions', 'status', 'why'],
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

  it('N17: cross-session admin surfaces are venue-restricted to DM; /new is group-permitting by design (W1-T3 RULING)', () => {
    // /sessions and /kill-session are cross-session admin surfaces (U6) —
    // DM-only, enforced via the venue axis (gate:'admin', venue:'dm').
    for (const name of ['sessions', 'kill-session'] as const) {
      expect(getCommandSpec(name).gate).toBe('admin');
      expect(getCommandSpec(name).venue).toBe('dm');
    }
    // /new is group-permitting by design (W1-PACKET.md W1-T3 RULING: an admin
    // may /new in a group). Its gate is scope-based ('admin-shared-scope',
    // enforced inline via sessionScope/isGroup in runtime.ts — NOT the venue
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

  it('admin-gates (admin or admin-shared-scope) exactly new/sessions/kill-session (the session-control trio, D2)', () => {
    // W1-T3 RULING: /new moved from gate:'admin' to gate:'admin-shared-scope'
    // (scope-based — see the N17 test above); the trio's total admin coverage
    // is unchanged, just split across the two gate values.
    expect(
      COMMAND_REGISTRY.filter((c) => c.gate === 'admin' || c.gate === 'admin-shared-scope')
        .map((c) => c.name)
        .sort(),
    ).toEqual(['kill-session', 'new', 'sessions']);
  });

  it('marks /status operator-only sensitive fields (D3: pid + sessionId) while staying ungated', () => {
    const status = getCommandSpec('status');
    expect(status.gate).toBe('none');
    expect(status.sensitiveFields).toEqual(['pid', 'sessionId']);
  });

  it('flags model/why/reset as routing aliases and only those', () => {
    // Deviation (labeled, T1-REPORT.md): the packet's verbatim `COMMAND_REGISTRY
    // .filter((c) => c.routingAlias)` does not typecheck — `as const satisfies
    // readonly CommandSpec[]` keeps COMMAND_REGISTRY's narrow per-entry literal
    // type, and `routingAlias` is absent (not merely undefined) on the 5 entries
    // that don't declare it, so TS2339 fires on the union access. Cast to the
    // widened `readonly CommandSpec[]`, matching the pattern the packet already
    // uses at the two `for (const c of COMMAND_REGISTRY as readonly CommandSpec[])`
    // sites above. Semantics-preserving; runtime behavior is unchanged.
    expect((COMMAND_REGISTRY as readonly CommandSpec[]).filter((c) => c.routingAlias).map((c) => c.name).sort())
      .toEqual(['model', 'reset', 'why']);
  });

  it('carries the /model sub-verbs as membership data (D5), matching today’s classifier set', () => {
    expect(getCommandSpec('model').subVerbs).toEqual(['status', 'default', 'strongest', 'fastest']);
  });

  it('getCommandSpec throws on an unknown command (fail-closed lookup)', () => {
    expect(() => getCommandSpec('nope' as never)).toThrow();
  });
});
