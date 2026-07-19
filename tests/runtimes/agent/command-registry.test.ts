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
      expect(['none', 'admin']).toContain(c.gate);
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

  it('N17: god-priv session-control commands are venue-restricted to DM, read-only are venue:any', () => {
    for (const name of ['new', 'sessions', 'kill-session'] as const) {
      expect(getCommandSpec(name).venue).toBe('dm');
    }
    expect(getCommandSpec('status').venue).toBe('any');
  });

  it('N16: state-rendering commands declare asOf + field provenance', () => {
    expect(getCommandSpec('status').renderContract?.asOf).toBe(true);
    expect(getCommandSpec('sessions').renderContract?.asOf).toBe(true);
    expect(getCommandSpec('status').renderContract?.fields).toMatchObject({ started: 'verified-runtime' });
  });

  it('admin-gates exactly new/sessions/kill-session (the session-control trio, D2)', () => {
    expect(COMMAND_REGISTRY.filter((c) => c.gate === 'admin').map((c) => c.name).sort())
      .toEqual(['kill-session', 'new', 'sessions']);
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
