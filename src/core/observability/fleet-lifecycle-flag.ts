// src/core/observability/fleet-lifecycle-flag.ts
// Fleet Lifecycle Observability Standard — the dark flag (design §11).
//
// `agentOptions.observability.fleetLifecycle` is the promotion axis
// `off | shadow | alerting | default` (default `off`). Every lifecycle-
// observability code path from Stage 1 onward gates through
// resolveFleetLifecyclePhase() — ONE reader, ONE default, ONE ordering — so
// later stages cannot fork the gating with per-call-site casts and defaults.
// The validator rejects malformed values at config load; this resolver is the
// runtime backstop and resolves anything malformed to `off`: emission can never
// be enabled by accident.

import { isRecord } from '../../lib/type-guards.ts';

export const FLEET_LIFECYCLE_PHASES = ['off', 'shadow', 'alerting', 'default'] as const;

export type FleetLifecyclePhase = (typeof FLEET_LIFECYCLE_PHASES)[number];

export const DEFAULT_FLEET_LIFECYCLE_PHASE: FleetLifecyclePhase = 'off';

export function isFleetLifecyclePhase(value: unknown): value is FleetLifecyclePhase {
  return (FLEET_LIFECYCLE_PHASES as readonly unknown[]).includes(value);
}

/**
 * Resolve the phase from a raw `agentOptions` record. Absent block, absent
 * key, or any malformed value ⇒ `off` (fail-closed).
 */
export function resolveFleetLifecyclePhase(agentOptions: unknown): FleetLifecyclePhase {
  if (!isRecord(agentOptions)) return DEFAULT_FLEET_LIFECYCLE_PHASE;
  const observability = agentOptions['observability'];
  if (!isRecord(observability)) return DEFAULT_FLEET_LIFECYCLE_PHASE;
  const phase = observability['fleetLifecycle'];
  return isFleetLifecyclePhase(phase) ? phase : DEFAULT_FLEET_LIFECYCLE_PHASE;
}

/** True when `phase` is at or beyond `minimum` in promotion order. */
export function fleetLifecyclePhaseAtLeast(phase: FleetLifecyclePhase, minimum: FleetLifecyclePhase): boolean {
  return FLEET_LIFECYCLE_PHASES.indexOf(phase) >= FLEET_LIFECYCLE_PHASES.indexOf(minimum);
}
