// tests/runtimes/agent/proof-of-death.test.ts
//
// The ProofOfDeathRegistry centralizes the "is this process tree provably
// empty?" retry that the per-chat quarantine, the system-turn dispatch
// quarantine, and the blocking system-result lease each used to run on their
// own timer. These tests pin the invariant that made those loops safe and the
// convergence property that having one loop is supposed to buy.

import { describe, it, expect, vi } from 'vitest';
import { ProofOfDeathRegistry, type ProvableSession } from '../../../src/runtimes/agent/proof-of-death.ts';

function makeSession(shutdown: ProvableSession['shutdown']): ProvableSession {
  return { shutdown };
}

describe('ProofOfDeathRegistry', () => {
  it('holds a registered session and fires no callback until proof', async () => {
    const registry = new ProofOfDeathRegistry();
    const onProven = vi.fn();
    const session = makeSession(vi.fn(async () => {
      throw new Error('pre-signal recensus unavailable');
    }));

    registry.register(session, 'wedge', onProven, 0);
    expect(registry.has(session)).toBe(true);

    await registry.sweep(1_000);
    await registry.sweep(2_000);

    expect(onProven, 'a callback must not fire while the tree is unprovable').not.toHaveBeenCalled();
    expect(registry.has(session), 'an unprovable session stays registered').toBe(true);
  });

  it('retires the session and fires the callback once the tree is provably empty', async () => {
    const registry = new ProofOfDeathRegistry();
    const onProven = vi.fn();
    let provable = false;
    const session = makeSession(vi.fn(async () => {
      if (!provable) throw new Error('pre-signal recensus unavailable');
    }));

    registry.register(session, 'wedge', onProven, 0);
    await registry.sweep(1_000);
    expect(onProven).not.toHaveBeenCalled();

    provable = true;
    await registry.sweep(2_000);

    expect(onProven, 'proof of death must fire the release callback').toHaveBeenCalledTimes(1);
    expect(registry.has(session), 'a proven session must be retired').toBe(false);
  });

  it('fires EVERY subscriber of one tree on a single proof (structural convergence)', async () => {
    // The whole point of centralizing: a session that is blocking two different
    // subsystems (e.g. a quarantined per-chat mapKey AND a system-turn lease)
    // releases both together on one proof, instead of two loops racing with
    // separate bookkeeping.
    const registry = new ProofOfDeathRegistry();
    const releaseQuarantine = vi.fn();
    const cancelLease = vi.fn();
    let provable = false;
    const session = makeSession(vi.fn(async () => {
      if (!provable) throw new Error('unprovable');
    }));

    registry.register(session, 'per-chat quarantine', releaseQuarantine, 0);
    registry.register(session, 'system-turn lease', cancelLease, 10);
    expect(registry.size, 'two subscribers share one record').toBe(1);

    provable = true;
    await registry.sweep(1_000);

    expect(releaseQuarantine).toHaveBeenCalledTimes(1);
    expect(cancelLease).toHaveBeenCalledTimes(1);
    expect(registry.has(session)).toBe(false);
  });

  it('isolates a throwing release callback from the others', async () => {
    const registry = new ProofOfDeathRegistry();
    const bad = vi.fn(() => { throw new Error('subscriber blew up'); });
    const good = vi.fn();
    const session = makeSession(vi.fn(async () => {}));

    registry.register(session, 'a', bad, 0);
    registry.register(session, 'b', good, 0);

    await registry.sweep(1_000);

    expect(good, 'one throwing subscriber must not starve the others').toHaveBeenCalledTimes(1);
    expect(registry.has(session)).toBe(false);
  });

  it('reports a session as stalled only after the threshold', async () => {
    const registry = new ProofOfDeathRegistry();
    const session = makeSession(vi.fn(async () => { throw new Error('unprovable'); }));
    registry.register(session, 'wedge reason', vi.fn(), 0, 'chat-1');

    await registry.sweep(60_000);

    expect(registry.stalled(60_000, 5 * 60_000), 'not stalled before the threshold').toHaveLength(0);
    const rows = registry.stalled(6 * 60_000, 5 * 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'wedge reason', attempts: 1, label: 'chat-1' });
    expect(rows[0]!.ageMs).toBe(6 * 60_000);
  });

  it('counts attempts across sweeps for bounded escalation', async () => {
    const registry = new ProofOfDeathRegistry();
    const session = makeSession(vi.fn(async () => { throw new Error('unprovable'); }));
    registry.register(session, 'wedge', vi.fn(), 0);

    await registry.sweep(1_000);
    await registry.sweep(2_000);
    await registry.sweep(3_000);

    expect(registry.stalled(10 * 60_000, 0)[0]?.attempts).toBe(3);
  });
});
