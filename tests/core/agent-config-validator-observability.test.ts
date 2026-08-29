// FLOS Stage 1: the `agentOptions.observability.fleetLifecycle` dark flag.
// Every lifecycle-observability code path is gated behind it and it defaults
// to off; the validator must accept an absent block, accept a boolean flag,
// and reject malformed shapes fail-closed (a typo must not silently enable or
// disable emission).
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
  it('accepts an absent observability block (flag defaults to off)', () => {
    expect(validateInstanceConfig(agentRaw({}), createCtx)).toBeNull();
  });

  it('accepts fleetLifecycle as a boolean', () => {
    expect(validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: false } }), createCtx)).toBeNull();
    expect(validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: true } }), createCtx)).toBeNull();
  });

  it('rejects a non-object observability block', () => {
    const error = validateInstanceConfig(agentRaw({ observability: 'on' }), createCtx);
    expect(error?.field).toBe('agentOptions.observability');
  });

  it('rejects a non-boolean fleetLifecycle value', () => {
    const error = validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: 'yes' } }), createCtx);
    expect(error?.field).toBe('agentOptions.observability.fleetLifecycle');
  });

  it('rejects unknown keys inside observability (closed shape)', () => {
    const error = validateInstanceConfig(agentRaw({ observability: { fleetLifecycle: true, extra: 1 } }), createCtx);
    expect(error?.field).toBe('agentOptions.observability');
  });
});
