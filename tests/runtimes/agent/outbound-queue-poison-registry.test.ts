import { describe, expect, it } from 'vitest';

import { OutboundQueuePoisonRegistry } from '../../../src/runtimes/agent/outbound-queue-poison-registry.ts';

describe('OutboundQueuePoisonRegistry', () => {
  it('retains the first exact process-local cause and counts a scope once', () => {
    const registry = new OutboundQueuePoisonRegistry();
    const first = new Error('first delivery failure');
    const later = new Error('later delivery failure');

    expect(registry.record('scope-a', first)).toBe(true);
    expect(registry.record('scope-a', later)).toBe(false);
    expect(registry.has('scope-a')).toBe(true);
    expect((registry as unknown as { causes: Map<string, unknown> }).causes.get('scope-a')).toBe(first);
    expect(registry.snapshot()).toEqual({
      outboundQueuePoisoned: true,
      outboundQueuePoisonedScopes: 1,
      activeAdmissionLaneBlocked: true,
    });
  });

  it('migrates poison through aliases and keeps old aliases blocked', () => {
    const registry = new OutboundQueuePoisonRegistry();
    registry.record('provisional', new Error('delivery failed'));

    registry.rekey('provisional', 'canonical');

    expect(registry.has('provisional')).toBe(true);
    expect(registry.has('canonical')).toBe(true);
    expect(registry.snapshot().outboundQueuePoisonedScopes).toBe(1);
  });

  it('retains the destination first cause when poisoned aliases collide', () => {
    const registry = new OutboundQueuePoisonRegistry();
    const sourceCause = new Error('source failed first');
    const destinationCause = new Error('destination failed first');
    registry.record('source', sourceCause);
    registry.record('destination', destinationCause);

    registry.rekey('source', 'destination');

    expect(registry.has('source')).toBe(true);
    expect(registry.has('destination')).toBe(true);
    expect(registry.snapshot().outboundQueuePoisonedScopes).toBe(1);
    expect(
      (registry as unknown as { causes: Map<string, unknown> }).causes.get('destination'),
    ).toBe(destinationCause);
  });

  it('resolves alias cycles without hanging or widening the aggregate', () => {
    const registry = new OutboundQueuePoisonRegistry();
    registry.rekey('a', 'b');
    registry.rekey('b', 'a');

    expect(registry.record('a', new Error('delivery failed'))).toBe(true);
    expect(registry.has('b')).toBe(true);
    expect(registry.snapshot().outboundQueuePoisonedScopes).toBe(1);
  });

  it('has no clear/delete surface and snapshots contain no identities or errors', () => {
    const registry = new OutboundQueuePoisonRegistry();
    registry.record('sensitive-scope', new Error('sensitive failure detail'));

    expect('clear' in registry).toBe(false);
    expect('delete' in registry).toBe(false);
    const serialized = JSON.stringify(registry.snapshot());
    expect(serialized).not.toContain('sensitive-scope');
    expect(serialized).not.toContain('sensitive failure detail');
  });
});
