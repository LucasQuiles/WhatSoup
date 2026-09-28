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
 * No producer string is kept. An unrecognised schema is recorded only as
 * `unrecognised`; of the declared ids, only members of the tool's floor are
 * kept (as the tool's own constants), and every other id is only counted.
 *
 * Only `satisfied` is green, and it means "the bound process declared every
 * floor id". It does not prove the behaviour. The verdict never enters the
 * pass predicate, the outcome, or the exit code.
 *
 * Binding contract. The verdict classifies a body only when all of these
 * agree: the launchd pid sampled before the request, whose argv names the
 * release entrypoint; the same pid and argv sampled again after the response;
 * and the body's own `instance.pid`. Otherwise it is `unbound`. This is the
 * producer's self-reported identity checked inside one window, not a kernel
 * proof: a process of the same user squatting the port and echoing the pid is
 * outside it. A producer that predates `instance.pid` reads `unbound`. It
 * relies on the instance being the launchd job's own process
 * (deploy/whatsoup execs node, and src/core/health.ts reports that
 * process.pid as `instance.pid`).
 * A body that could not be read or was not diagnostic is `unobserved`, and a
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
  /** Declared ids that are members of the floor, in floor order (the known schema only). */
  floorIds: string[];
  /** How many declared ids are not floor members; never the ids themselves. */
  extraIdCount: number;
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

/** An instance observation as `observeInstance` records it (apply.ts). */
export interface BoundObservation {
  pid: number | null;
  argvMatches: boolean;
  health: HealthObservation | null;
  /** launchd pid and argv sampled again after the response; null when not re-sampled. */
  resample: { pid: number | null; argvMatches: boolean } | null;
}

function unread(reading: 'absent' | 'unknown-schema' | 'malformed'): HealthInvariantsReading {
  return { reading, floorIds: [], extraIdCount: 0 };
}

/**
 * Read the block from a parsed diagnostic payload. Structural only: text
 * elsewhere in the body is never a declaration. The ids are validated in
 * full, but only floor members survive the read.
 */
export function readHealthInvariants(
  payload: Record<string, unknown>,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): HealthInvariantsReading {
  if (!Object.prototype.hasOwnProperty.call(payload, HEALTH_INVARIANTS_KEY)) return unread('absent');
  const block = payload[HEALTH_INVARIANTS_KEY];
  if (!isRecord(block)) return unread('malformed');
  const schema = block['schema'];
  if (typeof schema !== 'string') return unread('malformed');
  if (schema !== HEALTH_INVARIANTS_SCHEMA) return unread('unknown-schema');
  const ids = block['ids'];
  if (!Array.isArray(ids) || ids.length > MAX_IDS) return unread('malformed');
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id) || seen.has(id)) {
      return unread('malformed');
    }
    seen.add(id);
  }
  const floorIds = floor.filter((id) => seen.has(id));
  return { reading: 'declared', floorIds, extraIdCount: seen.size - floorIds.length };
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
      const declared = new Set(reading.floorIds);
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
 * release, a re-sample that disagrees, or a body not served by that pid is
 * `unbound`; no diagnostic body is `unobserved`; a non-2xx diagnostic body is
 * `http-status`. All three are `unknown`.
 */
export function releaseInvariantsVerdict(
  observation: BoundObservation | null,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): ReleaseInvariantsVerdict {
  const unknown = (detail: 'unbound' | 'unobserved' | 'http-status'): ReleaseInvariantsVerdict => ({
    outcome: 'unknown', detail, schema: null, undeclared: [...floor],
  });
  if (observation === null) return unknown('unobserved');
  const { pid, resample } = observation;
  if (pid === null || !observation.argvMatches) return unknown('unbound');
  const health = observation.health;
  if (health === null || health.projection !== 'diagnostic' || health.invariants === null) return unknown('unobserved');
  if (resample === null || resample.pid !== pid || !resample.argvMatches || health.responderPid !== pid) {
    return unknown('unbound');
  }
  if (health.httpStatus === null || health.httpStatus < 200 || health.httpStatus > 299) return unknown('http-status');
  return classifyReleaseInvariants(health.invariants, floor);
}
