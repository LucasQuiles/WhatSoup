import { describe, expect, it } from 'vitest';
import { capabilityRoleRule, driftRule } from '../../src/evaluator/canonical-rules.ts';
import type { ProbeDoc } from '../../src/types.ts';

const baseline: ProbeDoc = {
  probe_id: 'probe.example',
  scope_id: 'scope-a',
  captured_at: '2026-05-08T09:00:00.000Z',
  fields: { ports: [80] },
};

describe('driftRule', () => {
  it('emits no event when observed fields equal baseline fields', () => {
    const observed: ProbeDoc = { ...baseline, captured_at: '2026-05-08T10:00:00.000Z' };

    const events = driftRule({ observed, baseline, severity: 'high', domain: 'exposure' });

    expect(events).toEqual([]);
  });

  it('emits a drift event when observed fields differ', () => {
    const observed: ProbeDoc = {
      ...baseline,
      captured_at: '2026-05-08T10:00:00.000Z',
      fields: { ports: [80, 443] },
    };

    const events = driftRule({ observed, baseline, severity: 'high', domain: 'exposure' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: observed.captured_at,
      kind: 'drift',
      domain: 'exposure',
      scope_id: observed.scope_id,
      probe_id: observed.probe_id,
      severity: 'high',
      payload: {
        diff: {
          added: {},
          removed: {},
          changed: { ports: { from: [80], to: [80, 443] } },
        },
      },
    });
    expect(events[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('emits no event when there is no baseline', () => {
    const observed: ProbeDoc = { ...baseline, captured_at: '2026-05-08T10:00:00.000Z' };

    const events = driftRule({ observed, baseline: undefined, severity: 'high', domain: 'exposure' });

    expect(events).toEqual([]);
  });

  it('produces stable fingerprints for equivalent structural diffs', () => {
    const observedA: ProbeDoc = {
      ...baseline,
      captured_at: '2026-05-08T10:00:00.000Z',
      fields: { z: true, ports: [80, 443] },
    };
    const baselineA: ProbeDoc = {
      ...baseline,
      fields: { ports: [80], z: true },
    };
    const observedB: ProbeDoc = {
      ...baseline,
      captured_at: '2026-05-08T11:00:00.000Z',
      fields: { ports: [80, 443], z: true },
    };
    const baselineB: ProbeDoc = {
      ...baseline,
      fields: { z: true, ports: [80] },
    };

    const [eventA] = driftRule({ observed: observedA, baseline: baselineA, severity: 'med', domain: 'change' });
    const [eventB] = driftRule({ observed: observedB, baseline: baselineB, severity: 'med', domain: 'change' });

    expect(eventA?.fingerprint).toBe(eventB?.fingerprint);
  });

  it('rejects unsupported field values before emitting drift', () => {
    const observed: ProbeDoc = {
      ...baseline,
      fields: { ports: [80], bad: undefined },
    };

    expect(() => driftRule({ observed, baseline, severity: 'high', domain: 'exposure' })).toThrow(/\$\.bad/);
  });
});

describe('capabilityRoleRule', () => {
  const observed = (fields: ProbeDoc['fields']): ProbeDoc => ({
    probe_id: 'fixture.capability',
    scope_id: 'scope-a',
    captured_at: '2026-05-08T10:00:00.000Z',
    fields,
  });

  it('emits capability.role_violation when actual runtime_type differs from the deployment role', () => {
    const events = capabilityRoleRule({
      observed: observed({ runtime_type: 'passive', role: 'support', provider_env: {} }),
      deploymentRole: { runtime_type: 'agent' },
    });

    expect(events[0]).toMatchObject({
      kind: 'drift',
      domain: 'capability',
      severity: 'high',
      payload: expect.objectContaining({
        action: 'alert',
        reason_code: 'capability.role_violation',
        expected_runtime_type: 'agent',
        actual_runtime_type: 'passive',
      }),
    });
  });

  it.each([
    ['required present', 'required', true, false],
    ['required absent', 'required', false, true],
    ['forbidden present', 'forbidden', true, true],
    ['forbidden absent', 'forbidden', false, false],
    ['optional present', 'optional', true, false],
    ['optional absent', 'optional', false, false],
  ] as const)('evaluates provider_env %s', (_name, expectation, present, emitsViolation) => {
    const events = capabilityRoleRule({
      observed: observed({
        runtime_type: 'agent',
        role: 'support',
        provider_env: present ? { GENERIC_PROVIDER_KEY: true } : {},
      }),
      deploymentRole: {
        runtime_type: 'agent',
        provider_env: { GENERIC_PROVIDER_KEY: expectation },
      },
    });

    if (emitsViolation) {
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'drift',
        domain: 'capability',
        severity: 'high',
        payload: expect.objectContaining({
          reason_code: 'capability.role_violation',
          provider_key: 'GENERIC_PROVIDER_KEY',
        }),
      });
    } else {
      expect(events).toEqual([]);
    }
  });

  it('emits no events when no deployment role context exists', () => {
    expect(capabilityRoleRule({
      observed: observed({ runtime_type: 'agent', role: 'support', provider_env: { GENERIC_PROVIDER_KEY: true } }),
      deploymentRole: undefined,
    })).toEqual([]);
  });

  describe('enabled_plugins_max enforcement', () => {
    it('emits no event when observed plugin count is within the declared maximum', () => {
      const events = capabilityRoleRule({
        observed: observed({ runtime_type: 'agent', role: 'support', enabled_plugins: ['a', 'b'] }),
        deploymentRole: { enabled_plugins_max: 3 },
      });
      expect(events).toEqual([]);
    });

    it('emits capability.role_violation when observed plugin count exceeds the declared maximum', () => {
      const events = capabilityRoleRule({
        observed: observed({ runtime_type: 'agent', role: 'support', enabled_plugins: ['a', 'b', 'c', 'd'] }),
        deploymentRole: { enabled_plugins_max: 2 },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'drift',
        domain: 'capability',
        severity: 'high',
        payload: expect.objectContaining({
          reason_code: 'capability.role_violation',
          reason: 'enabled_plugins_max_exceeded',
          expected_max: 2,
          actual_count: 4,
        }),
      });
    });
  });

  describe('enabled_plugins enforcement', () => {
    it('emits no event when observed plugins are a subset of the role allowlist', () => {
      const events = capabilityRoleRule({
        observed: observed({ runtime_type: 'agent', role: 'support', enabled_plugins: ['a', 'b'] }),
        deploymentRole: { enabled_plugins: ['a', 'b', 'c'] },
      });
      expect(events).toEqual([]);
    });

    it('emits capability.role_violation when observed plugins include entries outside the allowlist', () => {
      const events = capabilityRoleRule({
        observed: observed({ runtime_type: 'agent', role: 'support', enabled_plugins: ['a', 'rogue'] }),
        deploymentRole: { enabled_plugins: ['a', 'b'] },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'drift',
        domain: 'capability',
        severity: 'high',
        payload: expect.objectContaining({
          reason_code: 'capability.role_violation',
          reason: 'enabled_plugins_outside_allowlist',
          disallowed: ['rogue'],
        }),
      });
    });
  });

  describe('access_mode enforcement', () => {
    it('emits no event when observed access_mode entries match the role spec', () => {
      const events = capabilityRoleRule({
        observed: observed({
          runtime_type: 'agent',
          role: 'support',
          access_mode: { read: true, write: 'restricted' },
        }),
        deploymentRole: { access_mode: { read: true, write: 'restricted' } },
      });
      expect(events).toEqual([]);
    });

    it('emits capability.role_violation when an observed access_mode value diverges from the role spec', () => {
      const events = capabilityRoleRule({
        observed: observed({
          runtime_type: 'agent',
          role: 'support',
          access_mode: { read: true, write: 'open' },
        }),
        deploymentRole: { access_mode: { read: true, write: 'restricted' } },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'drift',
        domain: 'capability',
        severity: 'high',
        payload: expect.objectContaining({
          reason_code: 'capability.role_violation',
          reason: 'access_mode_mismatch',
          access_key: 'write',
          expected_value: 'restricted',
          actual_value: 'open',
        }),
      });
    });
  });

  describe('mcp_tool_set enforcement', () => {
    it('emits no event when observed mcp tools are a subset of the role allowlist', () => {
      const events = capabilityRoleRule({
        observed: observed({ runtime_type: 'agent', role: 'support', mcp_tool_set: ['tool.read'] }),
        deploymentRole: { mcp_tool_set: ['tool.read', 'tool.write'] },
      });
      expect(events).toEqual([]);
    });

    it('emits capability.role_violation when observed mcp tools include entries outside the allowlist', () => {
      const events = capabilityRoleRule({
        observed: observed({
          runtime_type: 'agent',
          role: 'support',
          mcp_tool_set: ['tool.read', 'tool.exec'],
        }),
        deploymentRole: { mcp_tool_set: ['tool.read', 'tool.write'] },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'drift',
        domain: 'capability',
        severity: 'high',
        payload: expect.objectContaining({
          reason_code: 'capability.role_violation',
          reason: 'mcp_tool_set_outside_allowlist',
          disallowed: ['tool.exec'],
        }),
      });
    });
  });
});
