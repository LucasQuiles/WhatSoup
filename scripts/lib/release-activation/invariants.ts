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
 * Binding contract (`resolveBinding`). The verdict classifies a body only
 * when the binding is `bound`: the launchd pid sampled before the request,
 * with its argv naming the release entrypoint and its process start time
 * (`ps -o lstart=`); the same pid, argv and start time sampled again once
 * after the verification decision; and the body's own `instance.pid`, all
 * agree. Another pid or another start time is `restarted` (the start time
 * catches pid reuse); a re-sample that timed out or a start time that could
 * not be read is `unobserved`; any other mismatch is `unbound`. The raw pids
 * and start times are transient: only the binding result is recorded.
 *
 * This checks the producer's self-reported identity inside one window, not a
 * kernel proof: a process of the same user that holds the health port and
 * reports the right pid is outside it, nothing is known about restarts after
 * the re-sample, and `lstart` resolves to the second, so a pid reused within
 * the same second reads `bound`. A producer that predates `instance.pid` reads
 * `unbound`. It relies on the instance being the launchd job's own process:
 * deploy/whatsoup execs node, src/bootstrap-common.ts:23 imports the main
 * module in that process, and src/core/health.ts reports its process.pid as
 * `instance.pid`.
 *
 * A body that could not be read or was not diagnostic is `unobserved`, and a
 * non-2xx diagnostic body is `http-status`: never `missing`, because a failed
 * or erroring read is not evidence of a legacy producer.
 */
import { createHash } from 'node:crypto';

import {
  HEALTH_INVARIANTS_SCHEMA,
  RELEASE_INVARIANT_FLOOR,
} from '../../../src/core/health-invariants.ts';
import { isRecord } from '../../../src/lib/type-guards.ts';
import type { HealthObservation } from './host.ts';

const ALERT_SOURCE_PREFIX = 'release-invariants';

/**
 * The BOT ERRORS source for this tool's floor: `release-invariants:` plus the
 * first 8 hex of sha256 over the schema and the sorted floor ids, joined by
 * newlines. A tool with another floor raises and clears another incident, so
 * a clear never closes a requirement it did not check. Built only from our own
 * constants; it fits the dispatcher's source segment unchanged.
 */
export function releaseInvariantsAlertSource(
  schema: string = HEALTH_INVARIANTS_SCHEMA,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): string {
  const digest = createHash('sha256').update([schema, ...[...floor].sort()].join('\n')).digest('hex');
  return `${ALERT_SOURCE_PREFIX}:${digest.slice(0, 8)}`;
}

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

/** One launchd sample of the instance; transient, never recorded. */
export interface ProcessSample {
  pid: number | null;
  argvMatches: boolean;
  /** `ps -o lstart=` for that pid; null when it could not be read in time. */
  startTime: string | null;
}

export type Binding = 'bound' | 'unbound' | 'restarted' | 'unobserved';

/** An instance observation as recorded (apply.ts): the binding result, not the pids behind it. */
export interface BoundObservation {
  pid: number | null;
  argvMatches: boolean;
  health: Pick<HealthObservation, 'projection' | 'httpStatus' | 'invariants'> | null;
  binding: Binding;
}

/**
 * Is the body bound to one process generation? `first` was sampled before
 * the request; `resample` once after the verification decision, or null when
 * it timed out or failed. See the binding contract above.
 */
export function resolveBinding(
  first: ProcessSample,
  resample: ProcessSample | null,
  health: Pick<HealthObservation, 'projection' | 'responderPid'> | null,
): Binding {
  if (first.pid === null || !first.argvMatches) return 'unbound';
  if (health === null || health.projection !== 'diagnostic') return 'unobserved';
  if (resample === null) return 'unobserved';
  if (resample.pid !== first.pid) return 'restarted';
  if (first.startTime === null || resample.startTime === null) return 'unobserved';
  if (resample.startTime !== first.startTime) return 'restarted';
  if (!resample.argvMatches || health.responderPid !== first.pid) return 'unbound';
  return 'bound';
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
 * release, or a binding that is `unbound` or `restarted` is `unbound`; no
 * diagnostic body, or a binding that could not be observed, is `unobserved`;
 * a non-2xx diagnostic body is `http-status`. All three are `unknown`.
 */
export function releaseInvariantsVerdict(
  observation: BoundObservation | null,
  floor: readonly string[] = RELEASE_INVARIANT_FLOOR,
): ReleaseInvariantsVerdict {
  const unknown = (detail: 'unbound' | 'unobserved' | 'http-status'): ReleaseInvariantsVerdict => ({
    outcome: 'unknown', detail, schema: null, undeclared: [...floor],
  });
  if (observation === null) return unknown('unobserved');
  if (observation.pid === null || !observation.argvMatches) return unknown('unbound');
  const health = observation.health;
  if (health === null || health.projection !== 'diagnostic' || health.invariants === null) return unknown('unobserved');
  if (observation.binding === 'unbound' || observation.binding === 'restarted') return unknown('unbound');
  if (observation.binding === 'unobserved') return unknown('unobserved');
  if (health.httpStatus === null || health.httpStatus < 200 || health.httpStatus > 299) return unknown('http-status');
  return classifyReleaseInvariants(health.invariants, floor);
}
