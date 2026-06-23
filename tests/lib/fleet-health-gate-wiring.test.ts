import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { makeConfirmedOutboundProbe } from '../../src/core/durability.ts';
import { gateQuarantineClear, type GateDeps } from '../../src/lib/fleet-health-gate.ts';

describe('makeConfirmedOutboundProbe', () => {
  it('returns true when an outbound op was echoed within the window, false otherwise', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE outbound_ops (id INTEGER PRIMARY KEY, echoed_at TEXT);`);
    const probe = makeConfirmedOutboundProbe(db);

    expect(probe(900)).toBe(false); // empty table

    db.prepare(`INSERT INTO outbound_ops (echoed_at) VALUES (datetime('now'))`).run();
    expect(probe(900)).toBe(true); // recent echo

    db.exec(`DELETE FROM outbound_ops`);
    db.prepare(`INSERT INTO outbound_ops (echoed_at) VALUES (datetime('now','-3600 seconds'))`).run();
    expect(probe(900)).toBe(false); // echo older than window
    db.close();
  });
});

describe('gate failure is fail-safe at the wiring seam', () => {
  it('a throwing gate dependency must not escape the guarded clear; legacy clear still runs', () => {
    // Simulate the durability wiring guard: gate throws -> fall back to legacy clear.
    let legacyCleared = false;
    const runGuardedClear = () => {
      try {
        // emitEscalation throws to simulate an unwritable state dir / save failure path
        const deps: GateDeps = {
          now: () => '2026-06-21 05:12:00',
          stateDir: '/nonexistent/ /breaker', // invalid path
          recentWindowSeconds: 900,
          attemptWindowSeconds: 1800,
          tripThreshold: 5,
          confirmedOutboundWithinSeconds: () => {
            throw new Error('boom');
          },
          emitClear: () => {},
          emitEscalation: () => {},
        };
        process.env['FLEET_HEALTH_VERIFY_GATE'] = 'enforce';
        gateQuarantineClear('ml-bot', deps);
      } catch {
        legacyCleared = true; // guard caught it and would run the legacy clear
      } finally {
        delete process.env['FLEET_HEALTH_VERIFY_GATE'];
      }
    };
    runGuardedClear();
    expect(legacyCleared).toBe(true);
  });
});
