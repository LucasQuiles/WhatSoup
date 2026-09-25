// src/core/observability/lifecycle-clock.ts
// Fleet Lifecycle Observability Standard — Contract E clock model (O4/O5).
//
// Progress age derives from monotonic deltas WITHIN a boot_id — never from
// wall-clock subtraction — so a stepped or regressing system clock cannot fake
// or hide progress. Across a boot change, age is reconstructed from the
// durable `at_utc` witness and carries `age_basis: utc_reconstructed`.
//
// Anomalies never manufacture green (O5): within the configured skew
// allowance a future `at_utc` clamps to now and is counted; beyond it the age
// is `unknown` — and an unknown age MUST NOT satisfy any settlement predicate,
// bound check, or SLO (fail-closed; the V6 condition raise lands with the
// Stage 2 condition machinery). A regressing derived age never regresses the
// published value (max-hold) — a regression beyond the allowance is `unknown`.
//
// Dark by default: nothing imports this until emission is gated behind the
// `observability.fleetLifecycle` phase (see ./fleet-lifecycle-flag.ts).

export const DEFAULT_CLOCK_ALLOWANCE_SECONDS = 30;

export type AgeBasis = 'monotonic' | 'utc_reconstructed' | 'unknown';

export interface DerivedAge {
  /** Whole seconds; null exactly when age_basis is 'unknown'. */
  age_seconds: number | null;
  age_basis: AgeBasis;
  /** True when a clock anomaly was observed (clamped, held, or unknown). */
  clock_anomaly: boolean;
}

export interface DeriveProgressAgeInput {
  /** The last observed event's clock fields. */
  last: { boot_id: string; mono_ms: number; at_utc: string };
  /** The observer's current clock readings. */
  now: { boot_id: string; mono_ms: number; at_utc_epoch_ms: number };
  /** Tolerable clock disagreement in seconds (default 30). */
  allowance_seconds?: number;
}

const UNKNOWN: DerivedAge = { age_seconds: null, age_basis: 'unknown', clock_anomaly: true };

function parseUtcEpochMs(at_utc: string): number | null {
  if (typeof at_utc !== 'string') return null;
  const epoch = Date.parse(at_utc);
  return Number.isFinite(epoch) && at_utc.endsWith('Z') ? epoch : null;
}

/** Derive a progress age per the O4 clock model. Never throws. */
export function deriveProgressAge(input: DeriveProgressAgeInput): DerivedAge {
  const allowanceMs = (input.allowance_seconds ?? DEFAULT_CLOCK_ALLOWANCE_SECONDS) * 1000;
  if (input.last.boot_id === input.now.boot_id) {
    const deltaMs = input.now.mono_ms - input.last.mono_ms;
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      // A monotonic clock cannot regress within a boot; the reading is wrong.
      return UNKNOWN;
    }
    return { age_seconds: Math.floor(deltaMs / 1000), age_basis: 'monotonic', clock_anomaly: false };
  }
  const lastEpochMs = parseUtcEpochMs(input.last.at_utc);
  if (lastEpochMs === null) return UNKNOWN;
  const deltaMs = input.now.at_utc_epoch_ms - lastEpochMs;
  if (!Number.isFinite(deltaMs)) return UNKNOWN;
  if (deltaMs < 0) {
    // Future witness. Within the allowance: clamp to now and count (O5).
    if (-deltaMs <= allowanceMs) {
      return { age_seconds: 0, age_basis: 'utc_reconstructed', clock_anomaly: true };
    }
    return UNKNOWN;
  }
  return { age_seconds: Math.floor(deltaMs / 1000), age_basis: 'utc_reconstructed', clock_anomaly: false };
}

/**
 * Max-hold: a regressing wall clock never regresses a derived progress age.
 * Within the allowance the prior value holds (counted as an anomaly); a
 * regression beyond the allowance is `unknown` — the same fail-closed V6 path.
 */
export function maxHoldAge(
  priorAgeSeconds: number,
  derivedAgeSeconds: number,
  allowanceSeconds: number = DEFAULT_CLOCK_ALLOWANCE_SECONDS,
): DerivedAge {
  if (derivedAgeSeconds >= priorAgeSeconds) {
    return { age_seconds: derivedAgeSeconds, age_basis: 'utc_reconstructed', clock_anomaly: false };
  }
  if (priorAgeSeconds - derivedAgeSeconds <= allowanceSeconds) {
    return { age_seconds: priorAgeSeconds, age_basis: 'utc_reconstructed', clock_anomaly: true };
  }
  return { ...UNKNOWN };
}
