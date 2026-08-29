/**
 * `service` block validation coverage for agent-config-validator.ts.
 *
 * Mirrors the naming and style of agent-config-validator-transport.test.ts.
 * The block's shape rules live in src/lib/launchd-service-config.ts (single
 * source of truth shared with the fleet-side launchd render resolver); this
 * file pins that validateInstanceConfig enforces them on every write and read
 * path, for every instance type, so an invalid block is rejected at config
 * admission instead of first failing a launchd render.
 */
import { describe, expect, it } from 'vitest';
import { validateInstanceConfig } from '../../src/core/agent-config-validator.ts';
import type { ValidatorContext } from '../../src/core/agent-config-validator.ts';

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-line',
    type: 'agent',
    accessMode: 'self_only',
    adminPhones: ['15555550123'],
    agentOptions: { sessionScope: 'single' },
    ...overrides,
  };
}

const ctx = (mode: ValidatorContext['mode'] = 'create'): ValidatorContext => ({
  name: 'test-line',
  mode,
});

describe('validateInstanceConfig — service block', () => {
  it('accepts an absent service block', () => {
    expect(validateInstanceConfig(baseRaw(), ctx())).toBeNull();
  });

  it('accepts a valid service block', () => {
    const raw = baseRaw({
      service: {
        claudeConfigDir: '/opt/claude-roots/phbot',
        pathPrepend: ['/opt/service-bin'],
      },
    });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });

  it('rejects a relative claudeConfigDir on create', () => {
    const raw = baseRaw({ service: { claudeConfigDir: 'relative/root' } });
    expect(validateInstanceConfig(raw, ctx())).toMatchObject({
      field: 'service.claudeConfigDir',
    });
  });

  it('rejects an invalid pathPrepend entry in every validator mode', () => {
    for (const mode of ['create', 'patch', 'load', 'discovery'] as const) {
      const raw = baseRaw({ service: { pathPrepend: ['relative/bin'] } });
      expect(validateInstanceConfig(raw, ctx(mode))).toMatchObject({
        field: 'service.pathPrepend[0]',
      });
    }
  });

  it('rejects an invalid service block on non-agent instance types too', () => {
    const raw = baseRaw({
      type: 'passive',
      service: { pathPrepend: 'not-an-array' },
    });
    delete raw.agentOptions;
    expect(validateInstanceConfig(raw, ctx())).toMatchObject({
      field: 'service.pathPrepend',
    });
  });

  it('rejects an invalid service block even in authOnly loader mode', () => {
    const raw = baseRaw({ service: { claudeConfigDir: '' } });
    const context: ValidatorContext = { name: 'test-line', mode: 'load', authOnly: true };
    expect(validateInstanceConfig(raw, context)).toMatchObject({
      field: 'service.claudeConfigDir',
    });
  });
});
