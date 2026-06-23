// tests/lib/fleet-health-gate-replay.test.ts
// Replays the ml-bot 2026-06-21 flap storm: repeated postConnectRecovery drains
// while auth stays dead (no confirmed outbound). Asserts the storm collapses to
// ONE escalation and ZERO false 'recovered' clears under enforce.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateQuarantineClear, type GateDeps } from '../../src/lib/fleet-health-gate.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'replay-')); process.env['FLEET_HEALTH_VERIFY_GATE'] = 'enforce'; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['FLEET_HEALTH_VERIFY_GATE']; });

function depsAt(minute: number, confirmed: boolean, sink: { clears: number; escalations: string[] }): GateDeps {
  const mm = String(minute).padStart(2, '0');
  return {
    now: () => `2026-06-21 05:${mm}:00`,
    stateDir: dir,
    recentWindowSeconds: 900,
    attemptWindowSeconds: 1800,
    tripThreshold: 5,
    confirmedOutboundWithinSeconds: () => confirmed,
    emitClear: () => { sink.clears += 1; },
    emitEscalation: (e: string) => { sink.escalations.push(e); },
  };
}

describe('ml-bot flap storm replay', () => {
  it('collapses ~10 cosmetic clears (auth dead) into one escalation, zero false clears', () => {
    const sink = { clears: 0, escalations: [] as string[] };
    // PIDs cycled ~every 6 min while auth stayed dead.
    for (let i = 0; i < 10; i++) {
      gateQuarantineClear('ml-bot', depsAt((i * 6) % 60, /* confirmed */ false, sink));
    }
    expect(sink.clears).toBe(0);
    expect(sink.escalations).toHaveLength(1);
    // The single escalation carries the proof signature (gate-level evidence, no HUMAN_REQUIRED prefix).
    expect(sink.escalations[0]).toContain('no_confirmed_outbound_within_900s');
  });

  it('emits a real clear and closes the incident once a confirmed outbound appears (auth restored)', () => {
    const sink = { clears: 0, escalations: [] as string[] };
    gateQuarantineClear('ml-bot', depsAt(0, false, sink));  // dead -> suppress + escalate
    gateQuarantineClear('ml-bot', depsAt(6, false, sink));  // still dead -> no new escalation (deduped)
    gateQuarantineClear('ml-bot', depsAt(12, true, sink));  // auth restored -> real clear
    expect(sink.escalations).toHaveLength(1);
    expect(sink.clears).toBe(1);
  });
});
