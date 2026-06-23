// tests/lib/fleet-health-gate.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateQuarantineClear, type GateDeps } from '../../src/lib/fleet-health-gate.ts';

let dir: string;
function makeDeps(over: Partial<GateDeps> & { confirmed: boolean }): GateDeps {
  const calls = { clears: 0, escalations: [] as string[] };
  const deps: GateDeps = {
    now: () => '2026-06-21 05:12:00',
    stateDir: dir,
    recentWindowSeconds: 900,
    attemptWindowSeconds: 1800,
    tripThreshold: 5,
    confirmedOutboundWithinSeconds: () => over.confirmed,
    emitClear: () => { calls.clears += 1; },
    emitEscalation: (evidence: string) => { calls.escalations.push(evidence); },
    ...over,
  };
  (deps as unknown as { _calls: typeof calls })._calls = calls;
  return deps;
}
function calls(deps: GateDeps) { return (deps as unknown as { _calls: { clears: number; escalations: string[] } })._calls; }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['FLEET_HEALTH_VERIFY_GATE']; });

describe('gateQuarantineClear', () => {
  it('mode=off emits the clear unconditionally (current behavior preserved)', () => {
    process.env['FLEET_HEALTH_VERIFY_GATE'] = 'off';
    const deps = makeDeps({ confirmed: false });
    const d = gateQuarantineClear('ml-bot', deps);
    expect(d.action).toBe('clear');
    expect(calls(deps).clears).toBe(1);
    expect(calls(deps).escalations).toEqual([]);
  });

  it('mode=enforce + proof passes emits the clear and raises no escalation', () => {
    process.env['FLEET_HEALTH_VERIFY_GATE'] = 'enforce';
    const deps = makeDeps({ confirmed: true });
    const d = gateQuarantineClear('ml-bot', deps);
    expect(d.action).toBe('clear');
    expect(calls(deps).clears).toBe(1);
    expect(calls(deps).escalations).toEqual([]);
  });

  it('mode=shadow + proof fails still emits the clear but reports the would-suppress decision', () => {
    process.env['FLEET_HEALTH_VERIFY_GATE'] = 'shadow';
    const deps = makeDeps({ confirmed: false });
    const d = gateQuarantineClear('ml-bot', deps);
    expect(d.action).toBe('clear_shadow');
    expect(calls(deps).clears).toBe(1); // behavior unchanged in shadow
    expect(calls(deps).escalations).toEqual([]);
  });

  it('mode=enforce + proof fails suppresses the clear and raises exactly one escalation across repeated calls', () => {
    process.env['FLEET_HEALTH_VERIFY_GATE'] = 'enforce';
    const deps = makeDeps({ confirmed: false });
    const d1 = gateQuarantineClear('ml-bot', deps);
    const d2 = gateQuarantineClear('ml-bot', deps);
    const d3 = gateQuarantineClear('ml-bot', deps);
    expect([d1.action, d2.action, d3.action]).toEqual([
      'suppress_and_escalate', 'suppress_and_escalate', 'suppress_and_escalate',
    ]);
    expect(calls(deps).clears).toBe(0);
    expect(calls(deps).escalations).toHaveLength(1); // deduped
  });

  it('mode=warn + proof fails suppresses + escalates but never trips the breaker', () => {
    process.env['FLEET_HEALTH_VERIFY_GATE'] = 'warn';
    const deps = makeDeps({ confirmed: false, tripThreshold: 1 });
    const d = gateQuarantineClear('ml-bot', deps);
    expect(d.action).toBe('suppress_and_escalate');
    expect(d.tripped).toBe(false);
    expect(calls(deps).clears).toBe(0);
    expect(calls(deps).escalations).toHaveLength(1);
  });
});
