// FLOS Stage 1: the `agentOptions.observability.fleetLifecycle` dark flag.
// Design §11 defines it as the four-phase promotion axis
// `off | shadow | alerting | default` (default `off`). Every lifecycle-
// observability code path is gated behind it; the validator must accept an
// absent block, accept exactly the spec phases, and reject malformed shapes
// fail-closed (a typo inside the block must not silently change the phase).
import { describe, expect, it } from 'vitest';

import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';

function agentRaw(agentOptions: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    healthPort: 9095,
    systemPrompt: 'hi',
    agentOptions: {
      sessionScope: 'single',
      ...agentOptions,
    },
  };
}

const createCtx = { name: 'test-line', mode: 'create' } as const;

describe('validateInstanceConfig — agentOptions.observability (FLOS dark flag)', () => {
  it('accepts an absent observability block (phase defaults to off)', () => {
    expect(validateInstanceConfig(agentRaw({}), createCtx)).toBeNull();
    expect(validateInstanceConfig(agentRaw({ observability: {} }), createCtx)).toBeNull();
  });

  it('accepts each spec phase for fleetLifecycle', () => {
    for (const phase of ['off', 'shadow', 'alerting', 'default']) {
      expect(validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: phase } }), createCtx)).toBeNull();
    }
  });

  it('rejects a non-object observability block', () => {
    const error = validateInstanceConfig(agentRaw({ observability: 'on' }), createCtx);
    expect(error?.field).toBe('agentOptions.observability');
  });

  it('rejects a boolean fleetLifecycle (true has no phase meaning)', () => {
    const error = validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: true } }), createCtx);
    expect(error?.field).toBe('agentOptions.observability.fleetLifecycle');
    expect(error?.message).toContain('off, shadow, alerting, default');
  });

  it('rejects an unknown or case-variant phase value', () => {
    for (const value of ['yes', 'on', 'Shadow', 'DEFAULT', 1]) {
      const error = validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: value } }), createCtx);
      expect(error?.field, `value=${String(value)}`).toBe('agentOptions.observability.fleetLifecycle');
    }
  });

  it('rejects unknown keys inside observability (closed shape)', () => {
    const error = validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: 'shadow', extra: 1 } }), createCtx);
    expect(error?.field).toBe('agentOptions.observability');
  });
});
