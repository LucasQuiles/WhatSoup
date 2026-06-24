import { describe, expect, it } from 'vitest';
import { deriveModelUsable } from '../../../src/runtimes/agent/runtime.ts';

const NOW = 1_000_000_000_000;
const base = { provider: 'claude-cli', model: 'claude-opus-4-8' };

describe('deriveModelUsable — modelUsable freshness gate (RCA 2026-06-24)', () => {
  it('null usability → unknown, not stale', () => {
    expect(deriveModelUsable(null, NOW)).toEqual({
      modelUsable: null, modelUsableStale: false, modelUsableCheckedAt: null,
    });
  });

  it('probe in flight → unknown', () => {
    const u = { ...base, status: 'usable' as const, probeInFlight: true, checkedAt: NOW };
    expect(deriveModelUsable(u, NOW)).toMatchObject({ modelUsable: null, modelUsableStale: false });
  });

  it('fresh usable probe → true', () => {
    const checkedAt = NOW - 60_000;
    const u = { ...base, status: 'usable' as const, probeInFlight: false, checkedAt };
    expect(deriveModelUsable(u, NOW)).toEqual({ modelUsable: true, modelUsableStale: false, modelUsableCheckedAt: checkedAt });
  });

  it('STALE usable probe → unknown + stale flag (the rb-bot stale-green gap)', () => {
    const checkedAt = NOW - Math.round(9.4 * 60 * 60_000); // 9.4h ago, like the incident
    const u = { ...base, status: 'usable' as const, probeInFlight: false, checkedAt };
    expect(deriveModelUsable(u, NOW)).toEqual({ modelUsable: null, modelUsableStale: true, modelUsableCheckedAt: checkedAt });
  });

  it('usable probe with null checkedAt → treated as stale (no fresh evidence)', () => {
    const u = { ...base, status: 'usable' as const, probeInFlight: false, checkedAt: null };
    expect(deriveModelUsable(u, NOW)).toEqual({ modelUsable: null, modelUsableStale: true, modelUsableCheckedAt: null });
  });

  it('boundary: exactly at the freshness window is still fresh (true)', () => {
    const checkedAt = NOW - 30 * 60_000;
    const u = { ...base, status: 'usable' as const, probeInFlight: false, checkedAt };
    expect(deriveModelUsable(u, NOW).modelUsable).toBe(true);
  });

  it('unusable (credential-unavailable) → false, regardless of probe age', () => {
    const u = { ...base, status: 'credential-unavailable' as const, probeInFlight: false, checkedAt: NOW };
    expect(deriveModelUsable(u, NOW)).toMatchObject({ modelUsable: false, modelUsableStale: false });
  });

  it('honors a custom freshnessMs window', () => {
    const checkedAt = NOW - 10 * 60_000;
    const u = { ...base, status: 'usable' as const, probeInFlight: false, checkedAt };
    const r = deriveModelUsable(u, NOW, 5 * 60_000);
    expect(r.modelUsable).toBeNull();
    expect(r.modelUsableStale).toBe(true);
  });
});
