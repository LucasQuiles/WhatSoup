import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.ts';

const VALID_MINIMAL_POLICY = `
extends: development
inventory:
  hosts: []
  instances: []
deployment_roles: {}
actions: {}
transport:
  alert_sink:
    kind: whatsoup
mute_constraints:
  default_max_duration: 24h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
`;

const POLICY_FIXTURES = [
  VALID_MINIMAL_POLICY,
  `
extends: production
inventory: { hosts: [], instances: [] }
deployment_roles:
  generic-role:
    runtime_type: chat
actions:
  exposure: alert
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 1h, forbidden_domains: [alerting], wildcard_blocks_remediation: false }
`,
];

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-policy-'));
  const f = join(dir, 'policy.yaml');
  writeFileSync(f, content);
  return f;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'wg-policy-'));
}

function writePolicy(dir: string, name: string, content: string): string {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, content);
  return path;
}

function expectPolicyLoadError(content: string, pattern: RegExp): void {
  expect(() => loadPolicy(tmpFile(content))).toThrow(pattern);
}

describe('loadPolicy', () => {
  it('loads a minimal policy', () => {
    const p = loadPolicy(tmpFile(VALID_MINIMAL_POLICY));

    expect(p.extends).toBe('development');
    expect(p.mute_constraints.forbidden_domains).toContain('alerting');
  });

  it('rejects an unknown extends profile', () => {
    expectPolicyLoadError(`
extends: not-a-real-profile
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 1h, forbidden_domains: [alerting], wildcard_blocks_remediation: false }
`, /policy invalid.*extends/s);
  });

  it('rejects malformed YAML with the policy path in the error', () => {
    expectPolicyLoadError(`
extends: development
inventory: { hosts: [
`, /policy yaml parse failed.*policy\.yaml/s);
  });

  it('rejects unknown top-level fields', () => {
    expectPolicyLoadError(`${VALID_MINIMAL_POLICY}
unexpected_field: true
`, /policy invalid.*unexpected_field/s);
  });

  it('rejects missing required sections', () => {
    const dir = tmpDir();
    const path = writePolicy(dir, 'development', `
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
`);

    expect(() => loadPolicy(path, { profileDir: dir })).toThrow(/policy invalid.*mute_constraints/s);
  });

  it('applies default transport timeout and retry policy', () => {
    const p = loadPolicy(tmpFile(VALID_MINIMAL_POLICY));

    expect(p.transport.alert_sink.timeout_s).toBe(10);
    expect(p.transport.alert_sink.retry_crit).toEqual([1, 5, 30]);
    expect(p.transport.alert_sink.retry_other).toEqual([]);
  });

  it('loads domain severity tuning', () => {
    const p = loadPolicy(tmpFile(`${VALID_MINIMAL_POLICY}
domains:
  change:
    severity: med
`));

    expect(p.domains.change?.severity).toBe('med');
  });

  it('resolves extends through loadPolicy', () => {
    const dir = tmpDir();
    writePolicy(dir, 'development', VALID_MINIMAL_POLICY);
    writePolicy(dir, 'production', `
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  capability.role_violation: alert
transport:
  alert_sink: { kind: whatsoup, timeout_s: 20 }
  meta_alert: { enabled: true }
mute_constraints:
  default_max_duration: 8h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
`);
    const childPath = writePolicy(dir, 'child', `
extends: production
inventory: { hosts: [], instances: [] }
deployment_roles:
  support:
    runtime_type: passive
transport:
  meta_alert: { enabled: false }
`);

    const policy = loadPolicy(childPath, { profileDir: dir });

    expect(policy.transport.alert_sink.kind).toBe('whatsoup');
    expect(policy.transport.alert_sink.timeout_s).toBe(20);
    expect(policy.transport.meta_alert?.enabled).toBe(false);
    expect(policy.mute_constraints.forbidden_domains).toContain('alerting');
    expect(policy.actions['capability.role_violation']).toBe('alert');
    expect(policy.deployment_roles.support?.runtime_type).toBe('passive');
  });

  it('rejects missing parent profiles during loadPolicy inheritance resolution', () => {
    const dir = tmpDir();
    const childPath = writePolicy(dir, 'child', `
extends: production
inventory: { hosts: [], instances: [] }
deployment_roles: {}
`);

    expect(() => loadPolicy(childPath, { profileDir: dir })).toThrow(/parent profile not found/s);
  });

  it('rejects profile extends cycles during loadPolicy inheritance resolution', () => {
    const dir = tmpDir();
    const productionPath = writePolicy(dir, 'production', `
extends: customer-managed
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 8h, forbidden_domains: [alerting], wildcard_blocks_remediation: true }
`);
    writePolicy(dir, 'customer-managed', `
extends: production
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 24h, forbidden_domains: [alerting], wildcard_blocks_remediation: true }
`);

    expect(() => loadPolicy(productionPath, { profileDir: dir })).toThrow(/profile extends cycle/s);
  });

  it('rejects child policies that weaken inherited forbidden mute domains', () => {
    const dir = tmpDir();
    writePolicy(dir, 'development', VALID_MINIMAL_POLICY);
    writePolicy(dir, 'production', `
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints:
  default_max_duration: 8h
  forbidden_domains: [alerting]
  wildcard_blocks_remediation: true
`);
    const childPath = writePolicy(dir, 'child', `
extends: production
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints:
  default_max_duration: 8h
  forbidden_domains: []
  wildcard_blocks_remediation: true
`);

    expect(() => loadPolicy(childPath, { profileDir: dir })).toThrow(/cannot weaken forbidden mute domains/s);
  });

  it('rejects invalid actions', () => {
    expectPolicyLoadError(`
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles: {}
actions:
  exposure: invalid
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 1h, forbidden_domains: [alerting], wildcard_blocks_remediation: false }
`, /policy invalid.*actions.*exposure/s);
  });

  it('rejects invalid deployment role runtime types', () => {
    expectPolicyLoadError(`
extends: development
inventory: { hosts: [], instances: [] }
deployment_roles:
  generic-role:
    runtime_type: shell
actions: {}
transport: { alert_sink: { kind: whatsoup } }
mute_constraints: { default_max_duration: 1h, forbidden_domains: [alerting], wildcard_blocks_remediation: false }
`, /policy invalid.*deployment_roles.*generic-role.*runtime_type/s);
  });

  it('keeps policy fixture examples deployment-neutral', () => {
    for (const fixture of POLICY_FIXTURES) {
      expect(fixture).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/u);
      expect(fixture).not.toMatch(/\b[a-z0-9.-]+\.(?:com|dev|io|net|org)\b/iu);
      expect(fixture).not.toMatch(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u);
      expect(fixture).not.toMatch(/\bhttps?:\/\//iu);
      expect(fixture).not.toMatch(/\b(?:base_url|conversation_key|delivery_jid|target_label|token_file):/u);
    }
  });
});
