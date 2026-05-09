import { describe, expect, it } from 'vitest';
import { canonicalize, fingerprint, structuralDiff } from '../src/canonical.ts';
import type { ProbeDoc } from '../src/types.ts';

describe('canonical', () => {
  it('produces identical output regardless of key order', () => {
    expect(canonicalize({ b: 2, a: 1 })).toBe(canonicalize({ a: 1, b: 2 }));
  });

  it('strips whitespace and is byte-stable', () => {
    expect(canonicalize({ a: [1, 2, 3] })).toBe('{"a":[1,2,3]}');
  });

  it('handles nested objects deterministically', () => {
    expect(canonicalize({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('throws for root undefined', () => {
    expect(() => canonicalize(undefined)).toThrow(/\$/);
  });

  it('throws for object property undefined', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(/\$\.a/);
  });

  it('throws for function values', () => {
    expect(() => canonicalize({ fn: () => 'x' })).toThrow(/\$\.fn/);
  });

  it('throws for symbol values', () => {
    expect(() => canonicalize({ symbol: Symbol('x') })).toThrow(/\$\.symbol/);
  });

  it('throws for bigint values', () => {
    expect(() => canonicalize({ count: 1n })).toThrow(/\$\.count/);
  });

  it('throws for non-finite numbers', () => {
    expect(() => canonicalize({ n: NaN })).toThrow(/\$\.n/);
    expect(() => canonicalize({ n: Infinity })).toThrow(/\$\.n/);
  });

  it('throws for non-plain objects', () => {
    expect(() => canonicalize({ when: new Date(0) })).toThrow(/\$\.when/);
  });

  it('throws for circular references', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => canonicalize(value)).toThrow(/\$\.self/);
  });

  it('produces stable fingerprint for equivalent docs', () => {
    const obs1: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 't', fields: { a: 1, b: 2 } };
    const obs2: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 't', fields: { b: 2, a: 1 } };
    const base: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 'b', fields: {} };
    expect(fingerprint('p.id', obs1, base)).toBe(fingerprint('p.id', obs2, base));
    expect(fingerprint('p.id', obs1, base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprint rejects unsupported values inside fields', () => {
    const observed: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 't', fields: { unsupported: undefined } };
    const baseline: ProbeDoc = { probe_id: 'p.id', scope_id: 's', captured_at: 'b', fields: {} };
    expect(() => fingerprint('p.id', observed, baseline)).toThrow(/\$\.added\.unsupported/);
  });

  it('structuralDiff returns added and removed paths only', () => {
    const observed: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 't', fields: { x: 1, y: 2 } };
    const baseline: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 'b', fields: { x: 1, z: 3 } };
    const d = structuralDiff(observed, baseline);
    expect(d.added).toEqual({ y: 2 });
    expect(d.removed).toEqual({ z: 3 });
    expect(d.changed).toEqual({});
  });

  it('structuralDiff catches changed values', () => {
    const observed: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 't', fields: { x: 1 } };
    const baseline: ProbeDoc = { probe_id: 'p', scope_id: 's', captured_at: 'b', fields: { x: 2 } };
    const d = structuralDiff(observed, baseline);
    expect(d.changed).toEqual({ x: { from: 2, to: 1 } });
  });
});
