import { describe, expect, it } from 'vitest';
import { resolveExtends } from '../../src/policy/extends.ts';

describe('resolveExtends', () => {
  it('shallow-merges parent into child with child winning', () => {
    const parent = { actions: { 'a.b': 'observe' as const, 'c.d': 'alert' as const } };
    const child = { actions: { 'a.b': 'alert' as const } };

    const merged = resolveExtends(parent, child) as typeof parent;

    expect(merged.actions['a.b']).toBe('alert');
    expect(merged.actions['c.d']).toBe('alert');
  });

  it('replaces arrays at the field level', () => {
    const parent = { mute_constraints: { forbidden_domains: ['alerting', 'transport'] } };
    const child = { mute_constraints: { forbidden_domains: ['alerting'] } };

    const merged = resolveExtends(parent, child) as typeof parent;

    expect(merged.mute_constraints.forbidden_domains).toEqual(['alerting']);
  });

  it('preserves child fields not present in parent', () => {
    const parent = { foo: 1 };
    const child = { foo: 2, bar: 3 };

    const merged = resolveExtends(parent, child) as Record<string, number>;

    expect(merged).toEqual({ foo: 2, bar: 3 });
  });

  it('replaces nested objects below the one-level merge boundary', () => {
    const parent = {
      transport: {
        alert_sink: { kind: 'whatsoup', timeout_s: 10 },
        meta_alert: { enabled: false },
      },
    };
    const child = {
      transport: {
        alert_sink: { timeout_s: 20 },
      },
    };

    const merged = resolveExtends(parent, child) as typeof parent;

    expect(merged.transport).toEqual({
      alert_sink: { timeout_s: 20 },
      meta_alert: { enabled: false },
    });
  });

  it('does not mutate parent or child inputs', () => {
    const parent = { actions: { a: 'observe' }, list: ['parent'] };
    const child = { actions: { b: 'alert' }, list: ['child'] };

    const merged = resolveExtends(parent, child);

    expect(merged).toEqual({ actions: { a: 'observe', b: 'alert' }, list: ['child'] });
    expect(parent).toEqual({ actions: { a: 'observe' }, list: ['parent'] });
    expect(child).toEqual({ actions: { b: 'alert' }, list: ['child'] });
  });
});
