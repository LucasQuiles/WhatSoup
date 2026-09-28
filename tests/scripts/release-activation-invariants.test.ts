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
const PID = 7001;

function declared(ids: string[]): HealthInvariantsReading {
  return { reading: 'declared', ids };
}

function observation(
  invariants: HealthInvariantsReading | null,
  overrides: Partial<HealthObservation> = {},
): HealthObservation {
  return {
    projection: 'diagnostic', httpStatus: 200, commit: 'c'.repeat(40), connected: true, responderPid: PID, invariants,
    ...overrides,
  };
}

describe('the leaf constant', () => {
  it('is a leaf: no imports or re-exports, so the producer and the deploy tool load nothing else through it', () => {
    const source = readFileSync(new URL('../../src/core/health-invariants.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
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
    expect(readHealthInvariants({ whatsapp: {} })).toEqual({ reading: 'absent', ids: [] });
    expect(readHealthInvariants({ health_invariants: null })).toEqual({ reading: 'malformed', ids: [] });
    expect(readHealthInvariants({ health_invariants: undefined })).toEqual({ reading: 'malformed', ids: [] });
    // Only an own key counts; an inherited one is still absent.
    expect(readHealthInvariants(Object.create({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: [] } }) as Record<string, unknown>))
      .toEqual({ reading: 'absent', ids: [] });
  });

  it('declares only the known schema with an array of unique, bounded, well-formed ids', () => {
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['a.required', 'b.extra'] } }))
      .toEqual(declared(['a.required', 'b.extra']));
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: 'a.required' } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: { 0: 'a.required' } } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['A.Upper'] } }).reading).toBe('malformed');
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['x'.repeat(97)] } }).reading).toBe('malformed');
  });

  it('reads any other schema string as unknown-schema and keeps none of it', () => {
    for (const schema of ['whatsoup.health-invariants.v9', 'tenant-alice.prod.example', '/var/lib/whatsoup/state', 'has space']) {
      const reading = readHealthInvariants({ health_invariants: { schema, ids: ['a.required'] } });
      expect(reading).toEqual({ reading: 'unknown-schema', ids: [] });
      expect(JSON.stringify(reading)).not.toContain(schema);
    }
    expect(readHealthInvariants({ health_invariants: { schema: 42, ids: [] } }).reading).toBe('malformed');
  });
});

describe('classifyReleaseInvariants', () => {
  it('satisfied: the declared ids cover the floor', () => {
    expect(classifyReleaseInvariants(declared(['a.required']), FLOOR))
      .toEqual({ outcome: 'satisfied', detail: null, schema: 'known', undeclared: [] });
  });

  it('extra ids beyond the floor are still satisfied', () => {
    expect(classifyReleaseInvariants(declared(['z.newer', 'a.required', 'b.extra']), FLOOR).outcome).toBe('satisfied');
  });

  it('missing: a producer with no block at all, every floor id undeclared', () => {
    expect(classifyReleaseInvariants({ reading: 'absent', ids: [] }, FLOOR))
      .toEqual({ outcome: 'missing', detail: null, schema: null, undeclared: ['a.required'] });
  });

  it('below_floor: the known schema omitting a floor id', () => {
    expect(classifyReleaseInvariants(declared(['b.extra']), FLOOR))
      .toEqual({ outcome: 'below_floor', detail: null, schema: 'known', undeclared: ['a.required'] });
    expect(classifyReleaseInvariants(declared([]), FLOOR).outcome).toBe('below_floor');
  });

  it('unknown: an unrecognised schema, recorded only as unrecognised', () => {
    expect(classifyReleaseInvariants({ reading: 'unknown-schema', ids: [] }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'unknown-schema', schema: 'unrecognised', undeclared: ['a.required'] });
  });

  it('unknown: a malformed block', () => {
    expect(classifyReleaseInvariants({ reading: 'malformed', ids: [] }, FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'malformed', schema: null, undeclared: ['a.required'] });
  });

  it('defaults to the tool floor it imports, never one the producer supplies', () => {
    expect(classifyReleaseInvariants(declared([...RELEASE_INVARIANT_FLOOR])).outcome).toBe('satisfied');
    expect(classifyReleaseInvariants(declared([])).undeclared).toEqual([...RELEASE_INVARIANT_FLOOR]);
  });
});

describe('releaseInvariantsVerdict: bound to the responding process', () => {
  const unknown = (detail: string) => ({ outcome: 'unknown', detail, schema: null, undeclared: ['a.required'] });

  it('classifies the body when the observed pid, argv, and the responder pid all agree', () => {
    expect(releaseInvariantsVerdict({ pid: PID, argvMatches: true, health: observation(declared(['a.required'])) }, FLOOR).outcome)
      .toBe('satisfied');
  });

  it('unbound: no pid, argv naming another release, a responder with another pid, or no responder pid', () => {
    const body = observation(declared(['a.required']));
    expect(releaseInvariantsVerdict({ pid: null, argvMatches: false, health: null }, FLOOR)).toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict({ pid: PID, argvMatches: false, health: body }, FLOOR)).toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict({ pid: PID + 1, argvMatches: true, health: body }, FLOOR)).toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict({ pid: PID, argvMatches: true, health: observation(declared(['a.required']), { responderPid: null }) }, FLOOR))
      .toEqual(unknown('unbound'));
  });

  it('unobserved: no body, or a body that is not diagnostic, is unknown and never missing', () => {
    for (const health of [null, observation(null, { projection: 'unobserved' }), observation(null, { projection: 'public' })]) {
      expect(releaseInvariantsVerdict({ pid: PID, argvMatches: true, health }, FLOOR)).toEqual(unknown('unobserved'));
    }
  });

  it('http-status: a non-2xx diagnostic body is unknown whatever it declares', () => {
    for (const httpStatus of [503, 500, 404, 304]) {
      expect(releaseInvariantsVerdict({ pid: PID, argvMatches: true, health: observation(declared(['a.required']), { httpStatus }) }, FLOOR))
        .toEqual(unknown('http-status'));
    }
    expect(releaseInvariantsVerdict({ pid: PID, argvMatches: true, health: observation({ reading: 'absent', ids: [] }, { httpStatus: 503 }) }, FLOOR))
      .toEqual(unknown('http-status'));
  });

  it('null observation (the step never ran) is unknown/unobserved', () => {
    expect(releaseInvariantsVerdict(null, FLOOR).detail).toBe('unobserved');
  });
});
