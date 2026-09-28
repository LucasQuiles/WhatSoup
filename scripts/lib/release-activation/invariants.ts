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
 * when the binding is `bound`. The evidence is the poll that decided the
 * verification: the launchd pid, its argv naming the release entrypoint, the
 * body's own `instance.pid`, and the tool clock when the response arrived.
 * Once the activation outcome is final, one sample reads the launchd pid, its
 * argv and its process start time (`ps -o lstart=` in UTC). `bound` needs the
 * same pid and argv, a responder that names that pid, and a start second
 * strictly earlier than the response second. A process that reused the pid
 * after the responder exited started no earlier than the response second, so
 * it can never bind; a start in the response second itself is `unobserved`,
 * because a same-second reuse would read the same `lstart` text. A later start
 * or another pid is `restarted`; an observation that did not pass, a sample
 * that timed out, or a start time that could not be read is `unobserved`; any
 * other mismatch is `unbound`. The raw pids and times are transient: only the
 * binding result is recorded.
 *
 * This checks the producer's self-reported identity inside one window, not a
 * kernel proof: a process of the same user that holds the health port and
 * reports the right pid is outside it, and nothing is known about restarts
 * after the sample. Both seconds come from the same wall clock (the tool's
 * `host.now()` and the kernel's start time), so a wall-clock step backwards
 * after the response can give a process that reused the pid a start second
 * earlier than the response second; the rule assumes no such step. A producer that
 * predates `instance.pid` reads `unbound`. It relies on the instance being the
 * launchd job's own process: deploy/whatsoup execs node,
 * src/bootstrap-common.ts:23 imports the main module in that process, and
 * src/core/health.ts reports its process.pid as `instance.pid`.
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

/** The one launchd sample taken after the outcome; transient, never recorded. */
export interface ProcessSample {
  pid: number | null;
  argvMatches: boolean;
  /** Process start (`ps -o lstart=`, UTC) in epoch ms at second resolution; null when it could not be read. */
  startedAtMs: number | null;
}

/** The deciding poll's observation, as the binding needs it; transient, never recorded. */
export interface BindingEvidence {
  pid: number | null;
  argvMatches: boolean;
  /** Whether this observation passed verification; one that did not is never re-sampled. */
  passed: boolean;
  health: Pick<HealthObservation, 'projection' | 'responderPid'> | null;
  /** The tool clock (`host.now()`) when the health response arrived; null when none did. */
  respondedAtMs: number | null;
}

export type Binding = 'bound' | 'unbound' | 'restarted' | 'unobserved';

/** An instance observation as recorded (apply.ts): the binding result, not the pids behind it. */
export interface BoundObservation {
  pid: number | null;
  argvMatches: boolean;
  health: Pick<HealthObservation, 'projection' | 'httpStatus' | 'invariants'> | null;
  binding: Binding;
}

const secondOf = (ms: number): number => Math.floor(ms / 1_000);

/**
 * Is the body bound to one process generation? `evidence` is the deciding
 * poll; `sample` was taken once after the activation outcome was final, or is
 * null when it was not taken or timed out. See the binding contract above.
 */
export function resolveBinding(evidence: BindingEvidence, sample: ProcessSample | null): Binding {
  if (evidence.pid === null || !evidence.argvMatches) return 'unbound';
  if (!evidence.passed) return 'unobserved';
  const health = evidence.health;
  if (health === null || health.projection !== 'diagnostic' || evidence.respondedAtMs === null) return 'unobserved';
  if (sample === null) return 'unobserved';
  if (sample.pid !== evidence.pid) return 'restarted';
  if (sample.startedAtMs === null) return 'unobserved';
  const started = secondOf(sample.startedAtMs);
  const responded = secondOf(evidence.respondedAtMs);
  if (started > responded) return 'restarted';
  if (started === responded) return 'unobserved';
  if (!sample.argvMatches || health.responderPid !== evidence.pid) return 'unbound';
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
