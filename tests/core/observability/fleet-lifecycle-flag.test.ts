// FLOS Stage 1: the single reader of `agentOptions.observability.fleetLifecycle`.
// Design §11 defines the flag as the four-phase promotion axis
// `off | shadow | alerting | default` (default `off`). Every later stage gates
// through this resolver so defaulting and phase ordering cannot fork per call
// site; a malformed value resolves to `off` (emission can never be enabled by
// accident — the validator rejects it at load, this is the runtime backstop).
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLEET_LIFECYCLE_PHASE,
  FLEET_LIFECYCLE_PHASES,
  fleetLifecyclePhaseAtLeast,
  isFleetLifecyclePhase,
  resolveFleetLifecyclePhase,
} from '../../../src/core/observability/fleet-lifecycle-flag.ts';

describe('fleet lifecycle flag (FLOS design §11)', () => {
  it('exposes the four spec phases in promotion order, defaulting to off', () => {
    expect(FLEET_LIFECYCLE_PHASES).toEqual(['off', 'shadow', 'alerting', 'default']);
    expect(DEFAULT_FLEET_LIFECYCLE_PHASE).toBe('off');
  });

  it('resolves to off when agentOptions, the block, or the flag is absent', () => {
    expect(resolveFleetLifecyclePhase(undefined)).toBe('off');
    expect(resolveFleetLifecyclePhase({})).toBe('off');
    expect(resolveFleetLifecyclePhase({ observability: {} })).toBe('off');
  });

  it('resolves each explicit phase', () => {
    for (const phase of FLEET_LIFECYCLE_PHASES) {
      expect(resolveFleetLifecyclePhase({ observability: { fleetLifecycle: phase } })).toBe(phase);
    }
  });

  it('fails closed to off on a malformed value (never enables emission by accident)', () => {
    expect(resolveFleetLifecyclePhase({ observability: { fleetLifecycle: true } })).toBe('off');
    expect(resolveFleetLifecyclePhase({ observability: { fleetLifecycle: 'DEFAULT' } })).toBe('off');
    expect(resolveFleetLifecyclePhase({ observability: { fleetLifecycle: 'on' } })).toBe('off');
    expect(resolveFleetLifecyclePhase({ observability: 'shadow' })).toBe('off');
    expect(resolveFleetLifecyclePhase('shadow')).toBe('off');
  });

  it('orders phases so gating is monotonic across promotions', () => {
    expect(fleetLifecyclePhaseAtLeast('shadow', 'shadow')).toBe(true);
    expect(fleetLifecyclePhaseAtLeast('alerting', 'shadow')).toBe(true);
    expect(fleetLifecyclePhaseAtLeast('default', 'alerting')).toBe(true);
    expect(fleetLifecyclePhaseAtLeast('off', 'shadow')).toBe(false);
    expect(fleetLifecyclePhaseAtLeast('shadow', 'alerting')).toBe(false);
  });

  it('isFleetLifecyclePhase is a strict, case-sensitive guard', () => {
    expect(isFleetLifecyclePhase('shadow')).toBe(true);
    expect(isFleetLifecyclePhase('Shadow')).toBe(false);
    expect(isFleetLifecyclePhase(true)).toBe(false);
    expect(isFleetLifecyclePhase(undefined)).toBe(false);
  });
});
