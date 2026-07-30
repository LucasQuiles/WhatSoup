/**
 * TurnCapabilityTracker — per-runtime record of recent turn outcomes that feed the
 * provider-fallback decision and the runtime health snapshot.
 *
 * First slice of the provider-fallback subsystem decomposition. Owns the telemetry
 * the fallback logic reads to answer "has the primary served a turn, and what went
 * wrong last": the last successful user-turn time, the last user-turn error
 * class/time, and the cumulative per-class error counts.
 *
 * The orchestration stays in AgentRuntime: recordTurnCapabilitySuccess/Failure keep
 * the is-user-turn guard (system turns must not count) and the
 * consecutivePrimaryEmptyTurns reset, delegating the field mutations here;
 * getTurnCapability blends these fields with the model-usability probe state. Only
 * user-turn results reach recordSuccess/recordFailure — the guard lives upstream.
 *
 * Behavior is identical to the previous inline fields — see the existing fallback /
 * turn-capability characterization coverage (provider-fallback.test.ts turnErrorCounts
 * accounting, runtime.test.ts turnCapability snapshot assertions, health-snapshot.test.ts).
 */
import type { ProviderFailureKind } from './failure-taxonomy.ts';
import { PROVIDER_FAILURE_KINDS } from './failure-taxonomy.ts';

/** Error classes attributed to a turn for fallback/health purposes. */
export type TurnCapabilityErrorClass = ProviderFailureKind | 'unknown-terminal' | 'empty-output';

/** Non-provider terminal classes this tracker records beyond ProviderFailureKind. */
const NON_PROVIDER_TURN_ERROR_CLASSES = ['unknown-terminal', 'empty-output'] as const;

// Compile-time exhaustiveness: if TurnCapabilityErrorClass gains a member not
// covered by ProviderFailureKind ∪ NON_PROVIDER_TURN_ERROR_CLASSES, _covered
// narrows to `never` and this assignment errors — forcing an update here.
type _CoveredTurnClass = ProviderFailureKind
  | (typeof NON_PROVIDER_TURN_ERROR_CLASSES)[number];
const _turnClassExhaustive: [TurnCapabilityErrorClass] extends [_CoveredTurnClass] ? true : never = true;
void _turnClassExhaustive;

/** Runtime-enumerable SSOT of TurnCapabilityErrorClass = provider kinds + the
 *  non-provider terminal classes. This is HEALTH_TURN_ERROR_CLASSES' true mirror. */
export const TURN_CAPABILITY_ERROR_CLASSES: readonly TurnCapabilityErrorClass[] =
  [...PROVIDER_FAILURE_KINDS, ...NON_PROVIDER_TURN_ERROR_CLASSES];

export class TurnCapabilityTracker {
  /** Error class → cumulative count of user-turn failures of that class. */
  readonly errorCounts = new Map<TurnCapabilityErrorClass, number>();
  /** Epoch-ms of the most recent successful user turn (null until the first success). */
  lastSuccessfulTurnAt: number | null = null;
  /** Provider that served the most recent successful user turn. */
  lastSuccessfulTurnProvider: string | null = null;
  /** Class of the most recent user-turn failure (cleared to null on a success). */
  lastTurnErrorClass: TurnCapabilityErrorClass | null = null;
  /** Epoch-ms of the most recent user-turn failure (cleared to null on a success). */
  lastTurnErrorAt: number | null = null;

  /** A user turn completed successfully — stamp the time and clear the last error. */
  recordSuccess(provider: string): void {
    this.lastSuccessfulTurnAt = Date.now();
    this.lastSuccessfulTurnProvider = provider;
    this.lastTurnErrorClass = null;
    this.lastTurnErrorAt = null;
  }

  /** A user turn failed with the given class — stamp it and bump the class counter. */
  recordFailure(errorClass: TurnCapabilityErrorClass): void {
    this.lastTurnErrorClass = errorClass;
    this.lastTurnErrorAt = Date.now();
    this.errorCounts.set(errorClass, (this.errorCounts.get(errorClass) ?? 0) + 1);
  }
}
