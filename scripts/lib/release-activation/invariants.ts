/**
 * #2481 — release-invariant verdict for `release:activate`, report-only.
 *
 * The producer emits `health_invariants: {schema, ids}` on the authenticated
 * diagnostic body (src/core/health-invariants.ts). This module reads that
 * block and classifies it against the floor THIS tool imports, never one the
 * producer supplies. The reading follows the versioned-reader rules of
 * `deploy/scripts/lib/health_reader.py::disconnect_decision_reading`:
 *
 * - `absent`: a diagnostic body without the key, i.e. a producer that predates
 *   the block. Verdict `missing`. Silence is a finding, never a pass.
 * - `declared`: the known schema with an array of unique, bounded ids.
 *   Verdict `satisfied` when the ids cover the floor, else `below_floor`.
 * - `unknown-schema` or `malformed`: verdict `unknown`.
 *
 * No producer string is kept: an unrecognised schema is recorded only as
 * `unrecognised`, and only ids that match the id pattern are ever read.
 *
 * Only `satisfied` is green, and it means "the bound process declared every
 * floor id". It does not prove the behaviour. The verdict never enters the
 * pass predicate, the outcome, or the exit code.
 *
 * The verdict is bound to the responding process. It classifies a body only
 * when `observeInstance` matched the launchd pid's argv to the release AND the
 * body's own `instance.pid` is that same pid; otherwise it is `unbound`. A
 * body that could not be read or was not diagnostic is `unobserved`, and a
 * non-2xx diagnostic body is `http-status`: never `missing`, because a failed
 * or erroring read is not evidence of a legacy producer.
 */
import {
  HEALTH_INVARIANTS_SCHEMA,
  RELEASE_INVARIANT_FLOOR,
} from '../../../src/core/health-invariants.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';
import type { HealthObservation } from './host.ts';

export const RELEASE_INVARIANTS_ALERT_SOURCE = 'release-invariants';

const HEALTH_INVARIANTS_KEY = 'health_invariants';
const MAX_IDS = 64;
const MAX_ID_LENGTH = 96;
const ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export interface HealthInvariantsReading {
  reading: 'absent' | 'declared' | 'unknown-schema' | 'malformed';
  /** Declared ids (the known schema only); empty for every other reading. */
  ids: string[];
}

export type ReleaseInvariantsOutcome = 'satisfied' | 'missing' | 'below_floor' | 'unknown';

export interface ReleaseInvariantsVerdict {
  outcome: ReleaseInvariantsOutcome;
  detail: 'unbound' | 'unobserved' | 'http-status' | 'unknown-schema' | 'malformed' | null;
  /** Whether the block used this tool's schema; never the producer's string. */
  schema: 'known' | 'unrecognised' | null;
  /** Floor ids the bound process did not declare; every floor id unless the block was read. */
  undeclared: string[];
}

function malformed(): HealthInvariantsReading {
  return { reading: 'malformed', ids: [] };
}

/** Read the block from a parsed diagnostic payload. Structural only: text elsewhere in the body is never a declaration. */
export function readHealthInvariants(payload: Record<string, unknown>): HealthInvariantsReading {
  if (!Object.prototype.hasOwnProperty.call(payload, HEALTH_INVARIANTS_KEY)) return { reading: 'absent', ids: [] };
  const block = payload[HEALTH_INVARIANTS_KEY];
  if (!isRecord(block)) return malformed();
  const schema = block['schema'];
  if (typeof schema !== 'string') return malformed();
  if (schema !== HEALTH_INVARIANTS_SCHEMA) return { reading: 'unknown-schema', ids: [] };
  const ids = block['ids'];
  if (!Array.isArray(ids) || ids.length > MAX_IDS) return malformed();
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id) || seen.has(id)) {
      return malformed();
    }
    seen.add(id);
  }
  return { reading: 'declared', ids: [...seen] };
}

/** Classify a reading against the tool's floor. */
export function classifyReleaseInvariants(
  reading: HealthInvariantsReading,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): ReleaseInvariantsVerdict {
  switch (reading.reading) {
    case 'absent':
      return { outcome: 'missing', detail: null, schema: null, undeclared: [...floor] };
    case 'unknown-schema':
      return { outcome: 'unknown', detail: 'unknown-schema', schema: 'unrecognised', undeclared: [...floor] };
    case 'malformed':
      return { outcome: 'unknown', detail: 'malformed', schema: null, undeclared: [...floor] };
    case 'declared': {
      const declared = new Set(reading.ids);
      const undeclared = floor.filter((id) => !declared.has(id));
      return {
        outcome: undeclared.length === 0 ? 'satisfied' : 'below_floor',
        detail: null,
        schema: 'known',
        undeclared,
      };
    }
  }
}

/**
 * The verdict for one instance observation. No pid, argv naming another
 * release, or a body not served by that pid is `unbound`; no diagnostic body
 * is `unobserved`; a non-2xx diagnostic body is `http-status`. All three are
 * `unknown`.
 */
export function releaseInvariantsVerdict(
  observation: { pid: number | null; argvMatches: boolean; health: HealthObservation | null } | null,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): ReleaseInvariantsVerdict {
  const unknown = (detail: 'unbound' | 'unobserved' | 'http-status'): ReleaseInvariantsVerdict => ({
    outcome: 'unknown', detail, schema: null, undeclared: [...floor],
  });
  if (observation === null) return unknown('unobserved');
  if (observation.pid === null || !observation.argvMatches) return unknown('unbound');
  const health = observation.health;
  if (health === null || health.projection !== 'diagnostic' || health.invariants === null) return unknown('unobserved');
  if (health.responderPid !== observation.pid) return unknown('unbound');
  if (health.httpStatus === null || health.httpStatus < 200 || health.httpStatus > 299) return unknown('http-status');
  return classifyReleaseInvariants(health.invariants, floor);
}
