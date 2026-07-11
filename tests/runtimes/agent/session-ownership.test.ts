import { describe, expect, it } from 'vitest';

import {
  SessionOwnershipRegistry,
  type OwnedGenerationState,
} from '../../../src/runtimes/agent/session-ownership.ts';

describe('SessionOwnershipRegistry', () => {
  it('claims the sole starting generation and exposes its initialized shape', () => {
    const registry = new SessionOwnershipRegistry();

    expect(registry.get('chat-1')).toBeUndefined();

    const owned = registry.claim('chat-1', 'manager-a');

    expect(owned).toEqual({
      mapKey: 'chat-1',
      managerId: 'manager-a',
      generation: 1,
      state: 'starting',
      respawnTimer: null,
    });
    expect(registry.get('chat-1')).toEqual(owned);
    expect(registry.isCurrent('chat-1', 'manager-a', 1)).toBe(true);
  });

  it('blocks duplicate claims from the same or a different manager', () => {
    const registry = new SessionOwnershipRegistry();
    const owned = registry.claim('chat-1', 'manager-a');

    expect(() => registry.claim('chat-1', 'manager-a')).toThrowError(
      'Session "chat-1" already has an owner',
    );
    expect(() => registry.claim('chat-1', 'manager-b')).toThrowError(
      'Session "chat-1" already has an owner',
    );
    expect(registry.get('chat-1')).toEqual(owned);
  });

  it('requires a non-empty owner identity for every mutator', () => {
    const registry = new SessionOwnershipRegistry();

    expect(() => registry.claim('chat-1', '')).toThrowError(
      'managerId must be a non-empty string',
    );
    expect(registry.get('chat-1')).toBeUndefined();

    const owned = registry.claim('chat-1', 'manager-a');
    const original = { ...owned };

    expect(() => registry.advanceGeneration('chat-1', '')).toThrowError(
      'managerId must be a non-empty string',
    );
    expect(() => registry.transition('chat-1', '', 'active')).toThrowError(
      'managerId must be a non-empty string',
    );
    expect(() => registry.release('chat-1', '')).toThrowError(
      'managerId must be a non-empty string',
    );
    expect(registry.get('chat-1')).toEqual(original);
  });

  it('returns snapshots that cannot rewrite the current owner record', () => {
    const registry = new SessionOwnershipRegistry();
    const claimed = registry.claim('chat-1', 'manager-a');

    claimed.generation = 99;
    claimed.state = 'closing';
    const viewed = registry.get('chat-1');
    if (!viewed) throw new Error('claimed owner record is missing');
    viewed.generation = 42;
    viewed.state = 'exhausted';

    expect(registry.get('chat-1')).toEqual({
      mapKey: 'chat-1',
      managerId: 'manager-a',
      generation: 1,
      state: 'starting',
      respawnTimer: null,
    });
    expect(registry.isCurrent('chat-1', 'manager-a', 1)).toBe(true);
    expect(registry.isCurrent('chat-1', 'manager-a', 99)).toBe(false);
  });

  it('rejects every wrong-owner mutation without changing the record', () => {
    const registry = new SessionOwnershipRegistry();
    const owned = registry.claim('chat-1', 'manager-a');
    const original = { ...owned };

    expect(() => registry.advanceGeneration('chat-1', 'manager-b')).toThrowError(
      'Session "chat-1" is not owned by manager "manager-b"',
    );
    expect(() => registry.transition('chat-1', 'manager-b', 'active')).toThrowError(
      'Session "chat-1" is not owned by manager "manager-b"',
    );
    expect(() => registry.release('chat-1', 'manager-b')).toThrowError(
      'Session "chat-1" is not owned by manager "manager-b"',
    );
    expect(registry.get('chat-1')).toEqual(original);
  });

  it('rejects mutations when no ownership record exists', () => {
    const registry = new SessionOwnershipRegistry();

    expect(() => registry.advanceGeneration('missing', 'manager-a')).toThrowError(
      'Session "missing" has no owner',
    );
    expect(() => registry.transition('missing', 'manager-a', 'active')).toThrowError(
      'Session "missing" has no owner',
    );
    expect(() => registry.release('missing', 'manager-a')).toThrowError(
      'Session "missing" has no owner',
    );
    expect(registry.get('missing')).toBeUndefined();
  });

  it('advances every replacement generation and fences old callbacks', () => {
    const registry = new SessionOwnershipRegistry();
    const firstGeneration = registry.claim('chat-1', 'manager-a').generation;

    expect(registry.advanceGeneration('chat-1', 'manager-a')).toBe(2);
    expect(registry.isCurrent('chat-1', 'manager-a', firstGeneration)).toBe(false);
    expect(registry.isCurrent('chat-1', 'manager-a', 2)).toBe(true);

    expect(registry.advanceGeneration('chat-1', 'manager-a')).toBe(3);
    expect(registry.isCurrent('chat-1', 'manager-a', 2)).toBe(false);
    expect(registry.isCurrent('chat-1', 'manager-a', 3)).toBe(true);
    expect(registry.isCurrent('chat-1', 'manager-b', 3)).toBe(false);
  });

  it('rekeys the current owner without changing its manager, generation, or state', () => {
    const registry = new SessionOwnershipRegistry();
    registry.claim('chat-lid', 'manager-a');
    registry.advanceGeneration('chat-lid', 'manager-a');
    registry.transition('chat-lid', 'manager-a', 'active');

    registry.rekey('chat-lid', 'chat-phone', 'manager-a');

    expect(registry.get('chat-lid')).toBeUndefined();
    expect(registry.get('chat-phone')).toEqual({
      mapKey: 'chat-phone',
      managerId: 'manager-a',
      generation: 2,
      state: 'active',
      respawnTimer: null,
    });
    expect(registry.isCurrent('chat-phone', 'manager-a', 2)).toBe(true);
  });

  it('allows the current owner to make arbitrary specified state transitions', () => {
    const registry = new SessionOwnershipRegistry();
    const owned = registry.claim('chat-1', 'manager-a');
    const states: OwnedGenerationState[] = [
      'active',
      'resetting',
      'recoverable_dead',
      'respawning',
      'exhausted',
      'closing',
      'starting',
    ];

    for (const state of states) {
      registry.transition('chat-1', 'manager-a', state);
      expect(registry.get('chat-1')).toEqual({ ...owned, state });
    }
    expect(owned.state).toBe('starting');
    expect(owned.generation).toBe(1);
  });

  it('rejects release from every nonterminal state and preserves ownership', () => {
    const registry = new SessionOwnershipRegistry();
    const owned = registry.claim('chat-1', 'manager-a');
    const nonterminalStates: OwnedGenerationState[] = [
      'starting',
      'active',
      'resetting',
      'recoverable_dead',
      'respawning',
    ];

    for (const state of nonterminalStates) {
      registry.transition('chat-1', 'manager-a', state);
      expect(() => registry.release('chat-1', 'manager-a')).toThrowError(
        `Cannot release session "chat-1" from state "${state}"`,
      );
      expect(registry.get('chat-1')).toEqual({ ...owned, state });
    }
  });

  it('releases an exhausted owner and fences its generation', () => {
    const registry = new SessionOwnershipRegistry();
    registry.claim('chat-1', 'manager-a');
    registry.transition('chat-1', 'manager-a', 'exhausted');

    registry.release('chat-1', 'manager-a');

    expect(registry.get('chat-1')).toBeUndefined();
    expect(registry.isCurrent('chat-1', 'manager-a', 1)).toBe(false);
  });

  it('releases a closing owner', () => {
    const registry = new SessionOwnershipRegistry();
    registry.claim('chat-1', 'manager-a');
    registry.transition('chat-1', 'manager-a', 'closing');

    registry.release('chat-1', 'manager-a');

    expect(registry.get('chat-1')).toBeUndefined();
  });

  it('allows a released key to be reclaimed by a new manager at generation one', () => {
    const registry = new SessionOwnershipRegistry();
    registry.claim('chat-1', 'manager-a');
    registry.advanceGeneration('chat-1', 'manager-a');
    registry.transition('chat-1', 'manager-a', 'closing');
    registry.release('chat-1', 'manager-a');

    const reclaimed = registry.claim('chat-1', 'manager-b');

    expect(reclaimed).toEqual({
      mapKey: 'chat-1',
      managerId: 'manager-b',
      generation: 1,
      state: 'starting',
      respawnTimer: null,
    });
    expect(registry.isCurrent('chat-1', 'manager-a', 2)).toBe(false);
    expect(registry.isCurrent('chat-1', 'manager-b', 1)).toBe(true);
  });

  it('reports missing keys as not current', () => {
    const registry = new SessionOwnershipRegistry();

    expect(registry.isCurrent('missing', 'manager-a', 1)).toBe(false);
  });

  it('owns at most one respawn timer for the current manager generation', () => {
    const registry = new SessionOwnershipRegistry();
    const firstTimer = { id: 'first' } as unknown as ReturnType<typeof setTimeout>;
    const duplicateTimer = { id: 'duplicate' } as unknown as ReturnType<typeof setTimeout>;

    registry.claim('chat-1', 'manager-a');

    expect(registry.setRespawnTimer('chat-1', 'manager-a', 1, firstTimer)).toBe(true);
    expect(registry.get('chat-1')?.respawnTimer).toBe(firstTimer);
    expect(registry.setRespawnTimer('chat-1', 'manager-a', 1, duplicateTimer)).toBe(false);
    expect(registry.get('chat-1')?.respawnTimer).toBe(firstTimer);
  });

  it('clears only the exact respawn timer owned by the current generation', () => {
    const registry = new SessionOwnershipRegistry();
    const ownedTimer = { id: 'owned' } as unknown as ReturnType<typeof setTimeout>;
    const staleTimer = { id: 'stale' } as unknown as ReturnType<typeof setTimeout>;

    registry.claim('chat-1', 'manager-a');
    expect(registry.setRespawnTimer('chat-1', 'manager-a', 1, ownedTimer)).toBe(true);

    expect(registry.clearRespawnTimer('chat-1', 'manager-a', 2, ownedTimer)).toBe(false);
    expect(registry.clearRespawnTimer('chat-1', 'manager-a', 1, staleTimer)).toBe(false);
    expect(registry.clearRespawnTimer('chat-1', 'manager-b', 1, ownedTimer)).toBe(false);
    expect(registry.get('chat-1')?.respawnTimer).toBe(ownedTimer);

    expect(registry.clearRespawnTimer('chat-1', 'manager-a', 1, ownedTimer)).toBe(true);
    expect(registry.get('chat-1')?.respawnTimer).toBeNull();
  });
});
