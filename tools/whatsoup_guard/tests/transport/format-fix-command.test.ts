import { describe, expect, it } from 'vitest';
import { formatAlert } from '../../src/transport/format.ts';
import { resolveFixCommand } from '../../src/transport/fix-commands.ts';
import type { PolicyActionKey } from '../../src/policy/runtime.ts';
import type { Severity } from '../../src/types.ts';

const BASE = {
  eventId: 99,
  severity: 'high' as Severity,
  scopeId: 'scope-a',
  probeId: 'probe.test',
  domain: 'credential' as const,
  ts: '2026-05-12T00:00:00.000Z',
  diff: { added: {}, removed: {}, changed: {} },
  actionLabel: 'propose_fix',
  fingerprint: 'f'.repeat(64),
};

describe('formatAlert propose_fix command rendering', () => {
  it('renders propose_fix:<command> when fixCommand is supplied', () => {
    const text = formatAlert({
      ...BASE,
      actionLabel: 'propose_fix',
      fixCommand: 'chmod 0600 /tmp/secret',
    });
    expect(text).toContain('action:  propose_fix:chmod 0600 /tmp/secret');
  });

  it('renders bare action label when fixCommand is absent', () => {
    const text = formatAlert({
      ...BASE,
      actionLabel: 'propose_fix',
    });
    expect(text).toContain('action:  propose_fix');
    expect(text).not.toMatch(/action:\s+propose_fix:/u);
  });

  it('does not append fix command for non propose_fix labels', () => {
    const text = formatAlert({
      ...BASE,
      actionLabel: 'alert',
      fixCommand: 'chmod 0600 /tmp/secret',
    });
    expect(text).toContain('action:  alert');
    expect(text).not.toContain('chmod 0600');
  });
});

describe('resolveFixCommand coverage across PolicyActionKey entries', () => {
  const cases: Array<{
    key: PolicyActionKey;
    payload: Record<string, unknown>;
    expectIncludes: string;
  }> = [
    {
      key: 'exposure.unauthenticated_mutation',
      payload: { route: '/api/agent/run' },
      expectIncludes: '/api/agent/run',
    },
    {
      key: 'exposure.public_funnel_internal',
      payload: { funnel: 'mw-prod', port: 11434 },
      expectIncludes: 'mw-prod',
    },
    {
      key: 'exposure.firewall_disabled',
      payload: {},
      expectIncludes: 'pfctl',
    },
    {
      key: 'capability.role_violation',
      payload: { role: 'agent', reason: 'enabled_plugins_outside_allowlist' },
      expectIncludes: 'agent',
    },
    {
      key: 'credential.file_mode_widened',
      payload: { path: '/etc/whatsoup/secret.key', expected_mode: 0o600, actual_mode: 0o644 },
      expectIncludes: 'chmod',
    },
    {
      key: 'credential.token_aging',
      payload: { path: '/var/lib/whatsoup/token', max_age_days: 30, age_days: 45 },
      expectIncludes: '/var/lib/whatsoup/token',
    },
    {
      key: 'change.new_persistence_unit',
      payload: { field: 'units', diff: { added: ['svc.plist'] } },
      expectIncludes: 'whatsoup-guard',
    },
    {
      key: 'change.new_application_route',
      payload: { field: 'routes', diff: { added: ['/api/new'] } },
      expectIncludes: 'whatsoup-guard',
    },
    {
      key: 'alerting.self_secret_widened',
      payload: { path: '/etc/whatsoup/hmac.key', expected_mode: 0o600, actual_mode: 0o644 },
      expectIncludes: 'chmod 0600',
    },
    {
      key: 'alerting.baseline_integrity_fail',
      payload: { error: 'baseline integrity failed' },
      expectIncludes: 'whatsoup-guard',
    },
    {
      key: 'alerting.transport_failed',
      payload: {},
      expectIncludes: 'whatsoup-guard',
    },
  ];

  it('returns a non-empty command for every PolicyActionKey entry', () => {
    for (const c of cases) {
      const cmd = resolveFixCommand(c.key, c.payload);
      expect(cmd, `key=${c.key}`).toBeTypeOf('string');
      expect(cmd!.length, `key=${c.key}`).toBeGreaterThan(0);
    }
  });

  it.each(cases)('templates contextual payload into the command for $key', ({ key, payload, expectIncludes }) => {
    const cmd = resolveFixCommand(key, payload);
    expect(cmd).toBeDefined();
    expect(cmd!).toContain(expectIncludes);
  });

  it('returns undefined for an unknown action key', () => {
    expect(resolveFixCommand('totally.unknown.key', {})).toBeUndefined();
  });

  it('shell-quotes path values to prevent injection', () => {
    const cmd = resolveFixCommand('credential.file_mode_widened', {
      path: "/tmp/evil; rm -rf /",
      expected_mode: 0o600,
    });
    // Hostile suffix must be inside single quotes so the shell treats it as
    // a literal argument, never a command separator. The exact rendering is
    // load-bearing — `chmod 0600 '<the whole path>'` with no unquoted ';'.
    expect(cmd).toBe("chmod 0600 '/tmp/evil; rm -rf /'");
  });

  it('escapes embedded single quotes in path values', () => {
    const cmd = resolveFixCommand('credential.file_mode_widened', {
      path: "/tmp/has'quote",
      expected_mode: 0o600,
    });
    // Standard POSIX single-quote escape: close, escaped quote, reopen.
    expect(cmd).toBe(`chmod 0600 '/tmp/has'"'"'quote'`);
  });

  it('falls back when required payload fields are missing', () => {
    // path-templated keys should produce undefined (graceful degradation) when
    // no path is in the payload, so the bare prose remains. The same key with
    // path present must produce a command, proving the gating is contextual.
    expect(resolveFixCommand('credential.file_mode_widened', {})).toBeUndefined();
    expect(resolveFixCommand('credential.file_mode_widened', { path: '/tmp/x', expected_mode: 0o600 }))
      .toBe("chmod 0600 '/tmp/x'");
  });
});
