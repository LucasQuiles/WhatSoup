/**
 * #2481: the release-invariant classifier used by `release:activate`
 * and the leaf constant it shares with the health producer. The verdict is
 * report-only; these tests pin the outcomes and the rule that only
 * `satisfied` is green.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  HEALTH_INVARIANTS,
  HEALTH_INVARIANTS_SCHEMA,
  RELEASE_INVARIANT_FLOOR,
} from '../../src/core/health-invariants.ts';
import type { HealthObservation } from '../../scripts/lib/release-activation/host.ts';
import {
  classifyReleaseInvariants,
  type HealthInvariantsReading,
  readHealthInvariants,
  releaseInvariantsVerdict,
} from '../../scripts/lib/release-activation/invariants.ts';

const FLOOR = ['a.required'] as const;

function declared(ids: string[], schema = HEALTH_INVARIANTS_SCHEMA): HealthInvariantsReading {
  return { reading: 'declared', schema, ids };
}

function observation(invariants: HealthInvariantsReading | null, projection: HealthObservation['projection'] = 'diagnostic'): HealthObservation {
  return { projection, httpStatus: 200, commit: 'c'.repeat(40), connected: true, invariants };
}

describe('the leaf constant', () => {
  it('is a leaf: no imports, so the producer and the deploy tool load nothing else through it', () => {
    const source = readFileSync(new URL('../../src/core/health-invariants.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it('declares a versioned schema, unique well-formed ids, and a floor inside the declared set', () => {
    expect(HEALTH_INVARIANTS_SCHEMA).toBe('whatsoup.health-invariants.v1');
    expect(new Set(HEALTH_INVARIANTS).size).toBe(HEALTH_INVARIANTS.length);
    for (const id of HEALTH_INVARIANTS) expect(id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
    expect(RELEASE_INVARIANT_FLOOR.length).toBeGreaterThan(0);
    expect(RELEASE_INVARIANT_FLOOR.length).toBeLessThanOrEqual(HEALTH_INVARIANTS.length);
    for (const id of RELEASE_INVARIANT_FLOOR) expect(HEALTH_INVARIANTS).toContain(id);
    expect(Object.isFrozen(HEALTH_INVARIANTS)).toBe(true);
    expect(Object.isFrozen(RELEASE_INVARIANT_FLOOR)).toBe(true);
  });

  it('lockstep: the id list and floor change only as a reviewed diff', () => {
    expect([...HEALTH_INVARIANTS]).toEqual([
      'turn_capability.stale_evidence_degrades',
      'turn_capability.probe_expected_stale_degrades',
      'health.diagnostic_requires_token',
    ]);
    expect([...RELEASE_INVARIANT_FLOOR]).toEqual(['turn_capability.stale_evidence_degrades']);
  });
});

describe('readHealthInvariants', () => {
  it('separates absent (a legacy producer) from a present but unusable block', () => {
    expect(readHealthInvariants({ whatsapp: {} })).toEqual({ reading: 'absent', schema: null, ids: [] });
    expect(readHealthInvariants({ health_invariants: null })).toEqual({ reading: 'malformed', schema: null, ids: [] });
    expect(readHealthInvariants({ health_invariants: undefined })).toEqual({ reading: 'malformed', schema: null, ids: [] });
  });

  it('declares only a known schema with an array of unique, bounded, well-formed ids', () => {
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['a.required', 'b.extra'] } }))
      .toEqual(declared(['a.required', 'b.extra']));
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: 'a.required' } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: { 0: 'a.required' } } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['A.Upper'] } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['x'.repeat(97)] } }).reading).toBe('malformed');
  });

  it('keeps an unrecognised schema string, bounded, and drops its ids', () => {
    expect(readHealthInvariants({ health_invariants: { schema: 'whatsoup.health-invariants.v9', ids: ['a.required'] } }))
      .toEqual({ reading: 'unknown-schema', schema: 'whatsoup.health-invariants.v9', ids: [] });
    expect(readHealthInvariants({ health_invariants: { schema: 'has space', ids: [] } }).reading).toBe('malformed');
    // The schema string is relayed into the receipt and alert, so only an id-like value is kept.
    expect(readHealthInvariants({ health_invariants: { schema: '/var/lib/whatsoup/state', ids: [] } }))
      .toEqual({ reading: 'malformed', schema: null, ids: [] });
    expect(readHealthInvariants({ health_invariants: { schema: 'Whatsoup.Health', ids: [] } }).reading).toBe('malformed');
  });
});

describe('classifyReleaseInvariants', () => {
  it('satisfied: the declared ids cover the floor', () => {
    expect(classifyReleaseInvariants(declared(['a.required']), FLOOR))
      .toEqual({ outcome: 'satisfied', detail: null, observedSchema: HEALTH_INVARIANTS_SCHEMA, undeclared: [] });
  });

  it('extra ids beyond the floor are still satisfied', () => {
    expect(classifyReleaseInvariants(declared(['z.newer', 'a.required', 'b.extra']), FLOOR).outcome).toBe('satisfied');
  });

  it('missing: a producer with no block at all, every floor id undeclared', () => {
    expect(classifyReleaseInvariants({ reading: 'absent', schema: null, ids: [] }, FLOOR))
      .toEqual({ outcome: 'missing', detail: null, observedSchema: null, undeclared: ['a.required'] });
  });

  it('below_floor: a known schema that omits a floor id', () => {
    expect(classifyReleaseInvariants(declared(['b.extra']), FLOOR))
      .toEqual({ outcome: 'below_floor', detail: null, observedSchema: HEALTH_INVARIANTS_SCHEMA, undeclared: ['a.required'] });
    expect(classifyReleaseInvariants(declared([]), FLOOR).outcome).toBe('below_floor');
  });

  it('unknown: an unrecognised schema, even one listing every floor id', () => {
    expect(classifyReleaseInvariants({ reading: 'unknown-schema', schema: 'whatsoup.health-invariants.v9', ids: [] }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'unknown-schema', observedSchema: 'whatsoup.health-invariants.v9', undeclared: ['a.required'] });
  });

  it('unknown: a malformed block', () => {
    expect(classifyReleaseInvariants({ reading: 'malformed', schema: null, ids: [] }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'malformed', observedSchema: null, undeclared: ['a.required'] });
  });

  it('defaults to the tool floor it imports, never one the producer supplies', () => {
    const verdict = classifyReleaseInvariants(declared([...RELEASE_INVARIANT_FLOOR]));
    expect(verdict.outcome).toBe('satisfied');
    expect(classifyReleaseInvariants(declared([])).undeclared).toEqual([...RELEASE_INVARIANT_FLOOR]);
  });
});

describe('releaseInvariantsVerdict: bound to the executing process', () => {
  it('classifies the body of a process whose pid and argv were bound', () => {
    expect(releaseInvariantsVerdict({ pid: 7001, argvMatches: true, health: observation(declared(['a.required'])) }, FLOOR).outcome)
      .toBe('satisfied');
  });

  it('unbound: no pid, or argv naming another release, is never attributed the body it served', () => {
    const body = observation(declared(['a.required']));
    expect(releaseInvariantsVerdict({ pid: null, argvMatches: false, health: null }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'unbound', observedSchema: null, undeclared: ['a.required'] });
    expect(releaseInvariantsVerdict({ pid: 7001, argvMatches: false, health: body }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'unbound', observedSchema: null, undeclared: ['a.required'] });
  });

  it('unobserved: no body, or a body that is not diagnostic, is unknown and never missing', () => {
    for (const health of [null, observation(null, 'unobserved'), observation(null, 'public')]) {
      expect(releaseInvariantsVerdict({ pid: 7001, argvMatches: true, health }, FLOOR))
        .toEqual({ outcome: 'unknown', detail: 'unobserved', observedSchema: null, undeclared: ['a.required'] });
    }
  });

  it('null observation (the step never ran) is unknown/unobserved', () => {
    expect(releaseInvariantsVerdict(null, FLOOR).detail).toBe('unobserved');
  });
});
