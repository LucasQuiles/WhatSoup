/**
 * #2481: the release-invariant classifier used by `release:activate`
 * and the leaf constant it shares with the health producer. The verdict is
 * report-only; these tests pin the outcomes and the rule that only
 * `satisfied` is green.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  HEALTH_INVARIANTS,
  HEALTH_INVARIANTS_SCHEMA,
  RELEASE_INVARIANT_FLOOR,
} from '../../src/core/health-invariants.ts';
import type { HealthObservation } from '../../scripts/lib/release-activation/host.ts';
import {
  type Binding,
  type BindingEvidence,
  classifyReleaseInvariants,
  type HealthInvariantsReading,
  type ProcessSample,
  readHealthInvariants,
  releaseInvariantsAlertSource,
  releaseInvariantsVerdict,
  resolveBinding,
} from '../../scripts/lib/release-activation/invariants.ts';

const FLOOR = ['a.required'] as const;
const PID = 7001;
/** When the health request was sent (a whole second plus 400 ms). */
const REQUESTED = Date.UTC(2026, 0, 1, 12, 0, 10) + 400;

function declared(floorIds: string[], extraIdCount = 0): HealthInvariantsReading {
  return { reading: 'declared', floorIds, extraIdCount };
}

function reading(kind: HealthInvariantsReading['reading']): HealthInvariantsReading {
  return { reading: kind, floorIds: [], extraIdCount: 0 };
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

/** An instance observation as recorded, with the binding result the re-sample produced. */
function bound(health: HealthObservation | null, pid: number | null = PID, binding: Binding = 'bound') {
  return { pid, argvMatches: true, health, binding };
}

/** The observation from the poll that decided: it passed, with a diagnostic body to a request sent at REQUESTED. */
function evidence(overrides: Partial<BindingEvidence> = {}): BindingEvidence {
  return {
    pid: PID, argvMatches: true, passed: true, health: observation(declared(['a.required'])), requestedAtMs: REQUESTED,
    ...overrides,
  };
}

/** The one sample taken after the outcome: the same process, started a minute before the request. */
function sample(overrides: Partial<ProcessSample> = {}): ProcessSample {
  return { pid: PID, argvMatches: true, startedAtMs: REQUESTED - 60_400, ...overrides };
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
    expect(readHealthInvariants({ whatsapp: {} }, FLOOR)).toEqual(reading('absent'));
    expect(readHealthInvariants({ health_invariants: null }, FLOOR)).toEqual(reading('malformed'));
    expect(readHealthInvariants({ health_invariants: undefined }, FLOOR)).toEqual(reading('malformed'));
    // Only an own key counts; an inherited one is still absent.
    expect(readHealthInvariants(Object.create({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: [] } }) as Record<string, unknown>, FLOOR))
      .toEqual(reading('absent'));
  });

  it('keeps only floor ids by name and counts every other declared id, never storing it', () => {
    const read = readHealthInvariants(
      { health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: ['b.extra', 'a.required', 'tenant.alice.prod.example'] } },
      FLOOR,
    );
    expect(read).toEqual(declared(['a.required'], 2));
    expect(JSON.stringify(read)).not.toContain('b.extra');
    expect(JSON.stringify(read)).not.toContain('alice');
  });

  it('defaults to the tool floor it imports when reading', () => {
    expect(readHealthInvariants({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids: [...HEALTH_INVARIANTS] } }))
      .toEqual(declared([...RELEASE_INVARIANT_FLOOR], HEALTH_INVARIANTS.length - RELEASE_INVARIANT_FLOOR.length));
  });

  it('declares only the known schema with an array of unique, bounded, well-formed ids', () => {
    const block = (ids: unknown) => ({ health_invariants: { schema: HEALTH_INVARIANTS_SCHEMA, ids } });
    expect(readHealthInvariants(block('a.required'), FLOOR).reading).toBe('malformed');
    expect(readHealthInvariants(block({ 0: 'a.required' }), FLOOR).reading).toBe('malformed');
    expect(readHealthInvariants(block(['A.Upper']), FLOOR).reading).toBe('malformed');
    expect(readHealthInvariants(block(['x'.repeat(97)]), FLOOR).reading).toBe('malformed');
    expect(readHealthInvariants(block(['a.required', 'a.required']), FLOOR).reading).toBe('malformed');
  });

  it('reads any other schema string as unknown-schema and keeps none of it', () => {
    for (const schema of ['whatsoup.health-invariants.v9', 'tenant-alice.prod.example', '/var/lib/whatsoup/state', 'has space']) {
      const read = readHealthInvariants({ health_invariants: { schema, ids: ['a.required'] } }, FLOOR);
      expect(read).toEqual(reading('unknown-schema'));
      expect(JSON.stringify(read)).not.toContain(schema);
    }
    expect(readHealthInvariants({ health_invariants: { schema: 42, ids: [] } }, FLOOR).reading).toBe('malformed');
  });
});

describe('classifyReleaseInvariants', () => {
  it('satisfied: the declared ids cover the floor', () => {
    expect(classifyReleaseInvariants(declared(['a.required']), FLOOR))
      .toEqual({ outcome: 'satisfied', detail: null, schema: 'known', undeclared: [] });
  });

  it('extra ids beyond the floor are still satisfied', () => {
    expect(classifyReleaseInvariants(declared(['a.required'], 2), FLOOR).outcome).toBe('satisfied');
  });

  it('missing: a producer with no block at all, every floor id undeclared', () => {
    expect(classifyReleaseInvariants(reading('absent'), FLOOR))
      .toEqual({ outcome: 'missing', detail: null, schema: null, undeclared: ['a.required'] });
  });

  it('below_floor: the known schema omitting a floor id', () => {
    expect(classifyReleaseInvariants(declared([], 1), FLOOR))
      .toEqual({ outcome: 'below_floor', detail: null, schema: 'known', undeclared: ['a.required'] });
    expect(classifyReleaseInvariants(declared([]), FLOOR).outcome).toBe('below_floor');
  });

  it('unknown: an unrecognised schema, recorded only as unrecognised', () => {
    expect(classifyReleaseInvariants(reading('unknown-schema'), FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'unknown-schema', schema: 'unrecognised', undeclared: ['a.required'] });
  });

  it('unknown: a malformed block', () => {
    expect(classifyReleaseInvariants(reading('malformed'), FLOOR))
      .toEqual({ outcome: 'unknown', detail: 'malformed', schema: null, undeclared: ['a.required'] });
  });

  it('defaults to the tool floor it imports, never one the producer supplies', () => {
    expect(classifyReleaseInvariants(declared([...RELEASE_INVARIANT_FLOOR])).outcome).toBe('satisfied');
    expect(classifyReleaseInvariants(declared([])).undeclared).toEqual([...RELEASE_INVARIANT_FLOOR]);
  });
});

describe('releaseInvariantsVerdict: bound to the responding process', () => {
  const unknown = (detail: string) => ({ outcome: 'unknown', detail, schema: null, undeclared: ['a.required'] });

  it('classifies the body only when the binding is bound', () => {
    expect(releaseInvariantsVerdict(bound(observation(declared(['a.required']))), FLOOR).outcome).toBe('satisfied');
  });

  it('unbound: no pid, argv naming another release, or a binding that is unbound or restarted', () => {
    const body = observation(declared(['a.required']));
    expect(releaseInvariantsVerdict({ pid: null, argvMatches: false, health: null, binding: 'unbound' }, FLOOR))
      .toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict({ ...bound(body), argvMatches: false }, FLOOR)).toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict(bound(body, PID, 'unbound'), FLOOR)).toEqual(unknown('unbound'));
    expect(releaseInvariantsVerdict(bound(body, PID, 'restarted'), FLOOR)).toEqual(unknown('unbound'));
  });

  it('unobserved: a binding that could not be observed (the re-sample timed out or failed)', () => {
    expect(releaseInvariantsVerdict(bound(observation(declared(['a.required'])), PID, 'unobserved'), FLOOR))
      .toEqual(unknown('unobserved'));
  });

  it('unobserved: no body, or a body that is not diagnostic, is unknown and never missing', () => {
    for (const health of [null, observation(null, { projection: 'unobserved' }), observation(null, { projection: 'public' })]) {
      expect(releaseInvariantsVerdict(bound(health), FLOOR)).toEqual(unknown('unobserved'));
    }
  });

  it('http-status: a non-2xx diagnostic body is unknown whatever it declares', () => {
    for (const httpStatus of [503, 500, 404, 304]) {
      expect(releaseInvariantsVerdict(bound(observation(declared(['a.required']), { httpStatus })), FLOOR))
        .toEqual(unknown('http-status'));
    }
    expect(releaseInvariantsVerdict(bound(observation(reading('absent'), { httpStatus: 503 })), FLOOR))
      .toEqual(unknown('http-status'));
  });

  it('null observation (the step never ran) is unknown/unobserved', () => {
    expect(releaseInvariantsVerdict(null, FLOOR).detail).toBe('unobserved');
  });
});

describe('resolveBinding: one sample after the outcome, against the request second', () => {
  const second = (ms: number) => Math.floor(ms / 1_000) * 1_000;

  it('bound: same pid and argv, a start second strictly before the request second, and the responder names that pid', () => {
    expect(resolveBinding(evidence(), sample())).toBe('bound');
    // The latest start that still binds: the whole second before the request.
    expect(resolveBinding(evidence(), sample({ startedAtMs: second(REQUESTED) - 1_000 }))).toBe('bound');
  });

  it('unobserved: a start in the SAME second as the request (a same-second pid reuse would compare equal)', () => {
    expect(resolveBinding(evidence(), sample({ startedAtMs: second(REQUESTED) }))).toBe('unobserved');
  });

  it('a delayed response never binds a replacement: request 9.9 s, answer 10.1 s, pid reused 10.8 s, read at 12 s', () => {
    // The responder started at 8 s. Its replacement starts after it exits, so after the request was sent;
    // a boundary taken when the response was read (12 s) would put 10.8 s before it and bind.
    const at = (seconds: number) => Date.UTC(2026, 0, 1, 12, 0, 0) + seconds * 1_000;
    const delayed = evidence({ requestedAtMs: at(9.9) });
    expect(resolveBinding(delayed, sample({ startedAtMs: at(10) }))).toBe('restarted');
    expect(resolveBinding(delayed, sample({ startedAtMs: at(8) }))).toBe('bound');
  });

  it('restarted: a start in a later second than the request, another pid, or no process at all', () => {
    expect(resolveBinding(evidence(), sample({ startedAtMs: second(REQUESTED) + 1_000 }))).toBe('restarted');
    expect(resolveBinding(evidence(), sample({ pid: PID + 1 }))).toBe('restarted');
    expect(resolveBinding(evidence(), sample({ pid: null, argvMatches: false, startedAtMs: null }))).toBe('restarted');
  });

  it('unbound: no pid or argv on another release when observed, argv changed, or another responder pid', () => {
    expect(resolveBinding(evidence({ pid: null, argvMatches: false }), null)).toBe('unbound');
    expect(resolveBinding(evidence({ argvMatches: false }), sample())).toBe('unbound');
    expect(resolveBinding(evidence(), sample({ argvMatches: false }))).toBe('unbound');
    expect(resolveBinding(evidence({ health: observation(declared(['a.required']), { responderPid: 424_242 }) }), sample()))
      .toBe('unbound');
    expect(resolveBinding(evidence({ health: observation(declared(['a.required']), { responderPid: null }) }), sample()))
      .toBe('unbound');
  });

  it('unobserved: the observation did not pass, no diagnostic body, no request time, no sample (timed out), or no start time', () => {
    expect(resolveBinding(evidence({ passed: false }), sample())).toBe('unobserved');
    expect(resolveBinding(evidence({ health: null }), sample())).toBe('unobserved');
    expect(resolveBinding(evidence({ health: observation(null, { projection: 'public' }) }), sample())).toBe('unobserved');
    expect(resolveBinding(evidence({ requestedAtMs: null }), sample())).toBe('unobserved');
    expect(resolveBinding(evidence(), null)).toBe('unobserved');
    expect(resolveBinding(evidence(), sample({ startedAtMs: null }))).toBe('unobserved');
  });
});

describe('releaseInvariantsAlertSource: the incident names its floor', () => {
  it('is release-invariants: plus 8 hex, and the same for the same floor in any order', () => {
    const alertSource = releaseInvariantsAlertSource(HEALTH_INVARIANTS_SCHEMA, ['b.second', 'a.first']);
    expect(alertSource).toMatch(/^release-invariants:[0-9a-f]{8}$/);
    expect(releaseInvariantsAlertSource(HEALTH_INVARIANTS_SCHEMA, ['a.first', 'b.second'])).toBe(alertSource);
  });

  it('two floors (or two schemas) give two sources, so a clear under one never closes the other', () => {
    const floorA = releaseInvariantsAlertSource(HEALTH_INVARIANTS_SCHEMA, ['a.first']);
    const floorB = releaseInvariantsAlertSource(HEALTH_INVARIANTS_SCHEMA, ['a.first', 'b.second']);
    expect(floorA).not.toBe(floorB);
    expect(releaseInvariantsAlertSource('whatsoup.health-invariants.v2', ['a.first'])).not.toBe(floorA);
  });

  it('defaults to the tool schema and floor it imports, as a literal digest (lockstep with the release-activate tests)', () => {
    const digest = createHash('sha256')
      .update([HEALTH_INVARIANTS_SCHEMA, ...[...RELEASE_INVARIANT_FLOOR].sort()].join('\n'))
      .digest('hex')
      .slice(0, 8);
    expect(releaseInvariantsAlertSource()).toBe(`release-invariants:${digest}`);
  });
});
