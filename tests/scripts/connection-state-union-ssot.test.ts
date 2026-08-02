import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_ADAPTER_STATES, isAdapterState } from '../../src/transport/contract/adapter.ts';
import {
  CONNECTION_LIFECYCLE_STATES,
  isConnectionLifecycleState,
} from '../../src/transport/connection.ts';

/**
 * Arch ratchet for #2201 — the three parallel connection-state unions drifted
 * independently because nothing asserted their declared relationships. This
 * suite pins:
 *
 *  1. Each named union's declared membership equals its runtime const array
 *     (the type derives from the array, so a hand-edit to either side that
 *     skips the other is caught here at the value level and by the compiler
 *     at the type level).
 *  2. The two unions' overlap stays exactly the declared {connected,
 *     disconnected} — the axes are deliberately distinct (adapter operational
 *     health vs socket lifecycle phase), so a silent member addition on
 *     either side trips this assertion.
 *  3. feed.ts never re-introduces an inline connection-state literal union
 *     (the original drift class): its subset must be derived from
 *     ConnectionLifecycleState via `satisfies`.
 */

const ADAPTER_SOURCE = readFileSync('src/transport/contract/adapter.ts', 'utf8');
const CONNECTION_SOURCE = readFileSync('src/transport/connection.ts', 'utf8');
const FEED_SOURCE = readFileSync('src/fleet/routes/feed.ts', 'utf8');

const DECLARED_OVERLAP = ['connected', 'disconnected'] as const;

describe('connection-state union SSOT ratchet (#2201)', () => {
  it('AdapterState runtime array holds exactly the eight canonical states', () => {
    expect([...ALL_ADAPTER_STATES]).toEqual([
      'starting',
      'connected',
      'degraded',
      'disconnected',
      'auth_required',
      'rate_limited',
      'exhausted',
      'stopping',
    ]);
  });

  it('ConnectionLifecycleState runtime array holds exactly the six canonical states', () => {
    expect([...CONNECTION_LIFECYCLE_STATES]).toEqual([
      'disconnected',
      'connecting',
      'connected',
      'reconnecting',
      'cooldown',
      'shutting_down',
    ]);
  });

  it('the two axes overlap only in the declared {connected, disconnected} set', () => {
    const overlap = ALL_ADAPTER_STATES.filter((state) =>
      (CONNECTION_LIFECYCLE_STATES as readonly string[]).includes(state),
    );
    expect([...overlap].sort()).toEqual([...DECLARED_OVERLAP].sort());
  });

  it('feed.ts derives its connection-state subset from the canonical union, never inline', () => {
    // The drift class this issue killed: an open-coded literal union
    // re-declared next to the FeedDetail connection variant.
    expect(FEED_SOURCE).not.toMatch(/state\?:\s*'connecting'\s*\|/);
    expect(FEED_SOURCE).not.toMatch(/state\?:\s*'connected'\s*\|/);
    expect(FEED_SOURCE).toContain("from '../../transport/connection.ts'");
    expect(FEED_SOURCE).toContain('satisfies readonly ConnectionLifecycleState[]');
  });

  it('union declarations live in exactly one source file each', () => {
    expect(ADAPTER_SOURCE.match(/ALL_ADAPTER_STATES = \[/g)).toHaveLength(1);
    expect(CONNECTION_SOURCE.match(/CONNECTION_LIFECYCLE_STATES = \[/g)).toHaveLength(1);
  });

  it('guards accept every member of their own union and reject foreign values', () => {
    for (const state of ALL_ADAPTER_STATES) {
      expect(isAdapterState(state)).toBe(true);
    }
    for (const state of CONNECTION_LIFECYCLE_STATES) {
      expect(isConnectionLifecycleState(state)).toBe(true);
    }
    // Lifecycle-only states are not adapter states (the axes are distinct).
    expect(isAdapterState('reconnecting')).toBe(false);
    expect(isAdapterState('cooldown')).toBe(false);
    expect(isAdapterState('shutting_down')).toBe(false);
    // Adapter-only states are not lifecycle states.
    expect(isConnectionLifecycleState('degraded')).toBe(false);
    expect(isConnectionLifecycleState('auth_required')).toBe(false);
    expect(isConnectionLifecycleState('rate_limited')).toBe(false);
    expect(isConnectionLifecycleState('exhausted')).toBe(false);
    expect(isConnectionLifecycleState('stopping')).toBe(false);
    // Shared states are members of both.
    expect(isAdapterState('connected')).toBe(true);
    expect(isConnectionLifecycleState('connected')).toBe(true);
    // Garbage is neither.
    for (const rejected of ['', 'Connected', 'connnected', undefined, null, 7, {}]) {
      expect(isAdapterState(rejected)).toBe(false);
      expect(isConnectionLifecycleState(rejected)).toBe(false);
    }
  });
});
