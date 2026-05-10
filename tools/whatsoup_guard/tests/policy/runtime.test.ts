import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.ts';
import { actionKeyForEvent, buildRuntimeConfig } from '../../src/policy/runtime.ts';
import type { EventInput } from '../../src/store/events.ts';

describe('buildRuntimeConfig', () => {
  it('builds runtime config from a parsed policy', () => {
    const policy = loadPolicy(new URL('../../src/policy/profiles/development.yaml', import.meta.url).pathname);
    const config = buildRuntimeConfig(policy);

    expect(config.actions).toEqual(policy.actions);
    expect(config.forbiddenMuteDomains).toEqual(policy.mute_constraints.forbidden_domains);
    expect(config.metaAlertEnabled).toBe(policy.transport.meta_alert?.enabled ?? false);
  });

  it('carries domain severity tuning into runtime config', () => {
    const policy = loadPolicy(new URL('../../src/policy/profiles/development.yaml', import.meta.url).pathname);
    policy.domains = {
      change: { severity: 'med' },
    };

    const config = buildRuntimeConfig(policy);

    expect(config.domainSeverities.change).toBe('med');
  });

  it('carries explicit policy domain enablement into runtime config', () => {
    const policy = loadPolicy(new URL('../../src/policy/profiles/development.yaml', import.meta.url).pathname);
    policy.domains = {
      change: { enabled: false, severity: 'med' },
      credential: { enabled: true },
    };

    const config = buildRuntimeConfig(policy);

    expect(config.enabledDomains).toEqual({
      change: false,
      credential: true,
    });
  });

  it('rejects disabling alerting self-protection at runtime construction', () => {
    const policy = loadPolicy(new URL('../../src/policy/profiles/development.yaml', import.meta.url).pathname);
    policy.domains = {
      alerting: { enabled: false },
    };

    expect(() => buildRuntimeConfig(policy)).toThrow(
      /domains\.alerting\.enabled false is not supported because alerting self-protection must fail closed/u,
    );
  });

  it.each(['remediate', 'block'] as const)('rejects unsupported user action %s during runtime construction', (action) => {
    const policy = loadPolicy(new URL('../../src/policy/profiles/development.yaml', import.meta.url).pathname);
    policy.actions['change.new_persistence_unit'] = action;

    expect(() => buildRuntimeConfig(policy)).toThrow(
      new RegExp(`unsupported policy action "${action}" for key "change\\.new_persistence_unit"`),
    );
  });
});

describe('actionKeyForEvent', () => {
  it('maps drift events by reason code', () => {
    expect(actionKeyForEvent(event({
      kind: 'drift',
      domain: 'change',
      payload: { reason_code: 'change.new_persistence_unit' },
    }))).toBe('change.new_persistence_unit');
  });

  it('maps token aging events to the credential token aging policy action key', () => {
    expect(actionKeyForEvent(event({
      kind: 'alert_token_aging',
      domain: 'credential',
    }))).toBe('credential.token_aging');
  });

  it('maps self-secret widened events to the alerting policy action key', () => {
    expect(actionKeyForEvent(event({
      kind: 'self_secret_widened',
      domain: 'credential',
    }))).toBe('alerting.self_secret_widened');
  });

  it('maps baseline integrity failures to the alerting baseline policy action key', () => {
    expect(actionKeyForEvent(event({
      kind: 'baseline_integrity_fail',
      domain: 'alerting',
    }))).toBe('alerting.baseline_integrity_fail');
  });

  it('returns undefined for events without a policy action key', () => {
    expect(actionKeyForEvent(event({
      kind: 'heartbeat',
      domain: 'alerting',
      payload: { status: 'cycle_complete' },
    }))).toBeUndefined();
  });
});

function event(input: Partial<EventInput> & Pick<EventInput, 'kind'>): EventInput {
  return {
    ts: '2026-05-08T10:00:00.000Z',
    severity: 'high',
    payload: {},
    alerted_to: 'none',
    ...input,
  };
}
