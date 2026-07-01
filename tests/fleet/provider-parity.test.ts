import { describe, expect, it } from 'vitest';

import {
  evaluateProviderParity,
  exitCodeForProviderParityReport,
  type ProviderParityExpectedInstance,
  type ProviderStatusSnapshot,
} from '../../src/fleet/provider-parity.ts';

function expected(overrides: Partial<ProviderParityExpectedInstance> = {}): ProviderParityExpectedInstance {
  return {
    host: 'mini3',
    instance: 'agent',
    expected: 'always_on',
    type: 'agent',
    providerProbeExpected: true,
    ...overrides,
  };
}

function status(overrides: Partial<ProviderStatusSnapshot> = {}): ProviderStatusSnapshot {
  return {
    primary: {
      provider: 'claude-cli',
      model: null,
      keyPresent: null,
    },
    fallback: {
      provider: 'opencode-cli',
      model: 'minimax/MiniMax-M2',
      keyPresent: true,
      active: false,
      activeUntil: null,
      effectiveProvider: null,
      recoveryProbeRequired: false,
      activeEntry: null,
      chain: [
        { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true },
      ],
    },
    signal: {
      status: 'online',
      confidence: 'confirmed',
      reason: null,
      evidence: [],
    },
    lineReachable: true,
    ...overrides,
  };
}

describe('evaluateProviderParity', () => {
  it('returns green for a reachable agent with canonical primary, independent fallback, native primary auth, API fallback key, and ok probe', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected()],
      statuses: {
        'mini3/agent': status(),
      },
      probes: [
        {
          host: 'mini3',
          instance: 'agent',
          provider: 'opencode-cli',
          state: 'ok',
          evidenceRef: 'provider-probe:mini3/agent/opencode-cli',
        },
      ],
    });

    expect(report.verdict).toBe('green');
    expect(report.counts).toMatchObject({ green: 1, blocked: 0, inconclusive: 0, warn: 0 });
    expect(report.rows[0]).toMatchObject({
      host: 'mini3',
      instance: 'agent',
      verdict: 'green',
      credentialState: 'mixed',
      probeState: 'ok',
      fallbackProviders: ['opencode-cli'],
      reasons: [],
    });
    expect(exitCodeForProviderParityReport(report)).toBe(0);
  });

  it('fails closed for unknown providers, same-provider-only CLI fallback, missing credentials, and failed probes', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini4', instance: 'loops' })],
      statuses: {
        'mini4/loops': status({
          primary: { provider: 'mystery-cli', model: null, keyPresent: null },
          fallback: {
            provider: 'mystery-cli',
            model: null,
            keyPresent: false,
            active: true,
            activeUntil: 1_783_000_000_000,
            effectiveProvider: 'mystery-cli',
            recoveryProbeRequired: true,
            activeEntry: { provider: 'mystery-cli', model: null },
            chain: [
              { provider: 'mystery-cli', model: null, eligible: false },
            ],
          },
        }),
      },
      probes: [
        {
          host: 'mini4',
          instance: 'loops',
          provider: 'mystery-cli',
          state: 'failed',
          evidenceRef: 'provider-probe:mini4/loops/mystery-cli',
          reason: 'provider_probe_failed',
        },
      ],
    });

    expect(report.verdict).toBe('blocked');
    expect(report.rows[0]?.verdict).toBe('blocked');
    expect(report.rows[0]?.reasons).toEqual([
      'primary_provider_unknown',
      'fallback_provider_unknown:mystery-cli',
      'missing_independent_fallback',
      'credential_missing:mystery-cli',
      'provider_probe_failed:mystery-cli',
      'fallback_active',
      'recovery_probe_required',
      'fallback_entry_ineligible:mystery-cli',
    ]);
    expect(exitCodeForProviderParityReport(report)).toBe(1);
  });

  it('distinguishes inconclusive evidence from green when provider-status or required probe data is missing', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [
        expected({ host: 'mini7', instance: 'agent' }),
        expected({ host: 'mini8', instance: 'agent' }),
      ],
      statuses: {
        'mini7/agent': status(),
      },
      probes: [
        {
          host: 'mini7',
          instance: 'agent',
          provider: 'opencode-cli',
          state: 'skipped',
          evidenceRef: 'provider-probe:mini7/agent/opencode-cli',
        },
      ],
    });

    expect(report.verdict).toBe('inconclusive');
    expect(report.rows.map((row) => [row.host, row.verdict, row.reasons])).toEqual([
      ['mini7', 'inconclusive', ['provider_probe_skipped']],
      ['mini8', 'inconclusive', ['provider_status_missing']],
    ]);
  });

  it('blocks API fallbacks without a model while keeping native CLI credentials non-secret and non-missing', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini10', instance: 'agent' })],
      statuses: {
        'mini10/agent': status({
          fallback: {
            provider: 'openai-api',
            model: null,
            keyPresent: true,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [{ provider: 'openai-api', model: null, eligible: true }],
          },
        }),
      },
      probes: [
        { host: 'mini10', instance: 'agent', provider: 'openai-api', state: 'ok' },
      ],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'blocked',
      credentialState: 'mixed',
      reasons: ['api_fallback_model_missing:openai-api'],
    });
  });

  it('warns, rather than blocks, for an otherwise healthy active fallback window', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected()],
      statuses: {
        'mini3/agent': status({
          fallback: {
            provider: 'opencode-cli',
            model: 'minimax/MiniMax-M2',
            keyPresent: true,
            active: true,
            activeUntil: 1_783_000_000_000,
            effectiveProvider: 'opencode-cli',
            recoveryProbeRequired: true,
            activeEntry: { provider: 'opencode-cli', model: 'minimax/MiniMax-M2' },
            chain: [{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true }],
          },
        }),
      },
      probes: [
        { host: 'mini3', instance: 'agent', provider: 'opencode-cli', state: 'ok' },
      ],
    });

    expect(report.verdict).toBe('warn');
    expect(report.rows[0]).toMatchObject({
      verdict: 'warn',
      fallbackActive: true,
      reasons: ['fallback_active', 'recovery_probe_required'],
    });
    expect(exitCodeForProviderParityReport(report)).toBe(1);
  });

  it('uses the configured fallback provider when health omits fallback chain entries and probes are disabled', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ providerProbeExpected: false })],
      statuses: {
        'mini3/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: true },
          fallback: {
            provider: 'opencode-cli',
            model: 'minimax/MiniMax-M2',
            keyPresent: null,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [],
          },
        }),
      },
      probes: [
        {
          host: 'mini3',
          instance: 'agent',
          provider: 'opencode-cli',
          state: 'failed',
          evidenceRef: 'provider-probe:mini3/agent/opencode-cli',
        },
      ],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'green',
      fallbackProviders: ['opencode-cli'],
      credentialState: 'mixed',
      probeState: 'not_required',
      reasons: [],
      evidenceRefs: [],
    });
  });

  it('reports a missing required probe when no fallback providers are available to scope probe evidence', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini13', instance: 'agent' })],
      statuses: {
        'mini13/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: null },
          fallback: {
            provider: null,
            model: null,
            keyPresent: null,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [],
          },
        }),
      },
      probes: [],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'blocked',
      fallbackProviders: [],
      credentialState: 'native',
      probeState: 'unknown',
      reasons: ['missing_independent_fallback', 'provider_probe_missing'],
    });
  });

  it('defaults omitted probes to empty and reports present credentials for a primary-only status when probes are disabled', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini17', instance: 'agent', providerProbeExpected: false })],
      statuses: {
        'mini17/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: true },
          fallback: {
            provider: null,
            model: null,
            keyPresent: null,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [],
          },
        }),
      },
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'blocked',
      fallbackProviders: [],
      credentialState: 'present',
      probeState: 'not_required',
      reasons: ['missing_independent_fallback'],
    });
  });

  it('reports a missing primary credential even when the independent fallback credential is present', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini18', instance: 'agent' })],
      statuses: {
        'mini18/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: false },
          fallback: {
            provider: 'opencode-cli',
            model: 'minimax/MiniMax-M2',
            keyPresent: true,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true }],
          },
        }),
      },
      probes: [
        { host: 'mini18', instance: 'agent', provider: 'opencode-cli', state: 'ok' },
      ],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'blocked',
      credentialState: 'missing',
      probeState: 'ok',
      reasons: ['credential_missing:claude-cli'],
    });
  });

  it('keeps headless-auth and inconclusive provider probes as inconclusive and preserves evidence refs', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini14', instance: 'agent' })],
      statuses: {
        'mini14/agent': status(),
      },
      probes: [
        {
          host: 'mini14',
          instance: 'agent',
          provider: 'opencode-cli',
          state: 'headless_auth_inconclusive',
          evidenceRef: 'provider-probe:mini14/agent/opencode-cli/headless',
        },
        {
          host: 'mini14',
          instance: 'agent',
          provider: 'opencode-cli',
          state: 'inconclusive',
          evidenceRef: 'provider-probe:mini14/agent/opencode-cli/inconclusive',
        },
      ],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'inconclusive',
      probeState: 'inconclusive',
      reasons: ['provider_probe_headless_auth_inconclusive', 'provider_probe_inconclusive'],
      evidenceRefs: [
        'provider-probe:mini14/agent/opencode-cli/headless',
        'provider-probe:mini14/agent/opencode-cli/inconclusive',
      ],
    });
  });

  it('surfaces unknown credentials, unreachable lines, and degraded provider status as inconclusive evidence', () => {
    const unknownKeyState = undefined as unknown as boolean | null;
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini15', instance: 'agent' })],
      statuses: {
        'mini15/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: unknownKeyState },
          fallback: {
            provider: 'opencode-cli',
            model: 'minimax/MiniMax-M2',
            keyPresent: unknownKeyState,
            active: false,
            activeUntil: null,
            effectiveProvider: null,
            recoveryProbeRequired: false,
            activeEntry: null,
            chain: [{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true }],
          },
          signal: {
            status: 'degraded',
            confidence: 'confirmed',
            reason: 'health-probe',
            evidence: ['health:mini15/agent'],
          },
          lineReachable: false,
        }),
      },
      probes: [
        { host: 'mini15', instance: 'agent', provider: 'opencode-cli', state: 'ok' },
      ],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'inconclusive',
      credentialState: 'unknown',
      probeState: 'ok',
      reasons: [
        'credential_unknown:claude-cli',
        'credential_unknown:opencode-cli',
        'provider_status_unreachable',
        'provider_status_degraded',
      ],
    });
  });

  it('marks missing provider status probe state not_required when probe checks are disabled', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [expected({ host: 'mini16', instance: 'agent', providerProbeExpected: false })],
      statuses: {},
      probes: [],
    });

    expect(report.rows[0]).toMatchObject({
      verdict: 'inconclusive',
      reasons: ['provider_status_missing'],
      probeState: 'not_required',
    });
  });

  it('marks no-bot, blocked, deferred, and non-agent rows not_applicable without requiring provider status', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [
        expected({ host: 'mini5', instance: 'agent', expected: 'no_bot' }),
        expected({ host: 'mini6', instance: 'agent', expected: 'blocked' }),
        expected({ host: 'mini11', instance: 'agent', expected: 'owner_deferred' }),
        expected({ host: 'mini12', instance: 'chat-bot', type: 'chat' }),
      ],
      statuses: {},
      probes: [],
    });

    expect(report.verdict).toBe('green');
    expect(report.counts.not_applicable).toBe(4);
    expect(report.rows.every((row) => row.verdict === 'not_applicable')).toBe(true);
    expect(exitCodeForProviderParityReport(report)).toBe(0);
  });

  it('sorts rows by severity, host, instance, and reason for deterministic reports', () => {
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [
        expected({ host: 'mini8', instance: 'agent' }),
        expected({ host: 'mini3', instance: 'agent' }),
        expected({ host: 'mini5', instance: 'agent', expected: 'no_bot' }),
      ],
      statuses: {
        'mini3/agent': status(),
      },
      probes: [
        { host: 'mini3', instance: 'agent', provider: 'opencode-cli', state: 'ok' },
      ],
    });

    expect(report.rows.map((row) => `${row.verdict}:${row.host}/${row.instance}`)).toEqual([
      'inconclusive:mini8/agent',
      'green:mini3/agent',
      'not_applicable:mini5/agent',
    ]);
  });

  it('sorts same-host ties by instance and then reason text for deterministic reports', () => {
    const unknownKeyState = undefined as unknown as boolean | null;
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [
        expected({ host: 'mini20', instance: 'agent-b', providerProbeExpected: false }),
        expected({ host: 'mini20', instance: 'agent-a', providerProbeExpected: false }),
        expected({ host: 'mini21', instance: 'agent', providerProbeExpected: true }),
        expected({ host: 'mini21', instance: 'agent', providerProbeExpected: false }),
      ],
      statuses: {
        'mini20/agent-a': status(),
        'mini20/agent-b': status(),
        'mini21/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: unknownKeyState },
        }),
      },
      probes: [
        { host: 'mini21', instance: 'agent', provider: 'opencode-cli', state: 'skipped' },
      ],
    });

    expect(report.rows.map((row) => ({
      key: `${row.verdict}:${row.host}/${row.instance}`,
      reasons: row.reasons,
    }))).toEqual([
      {
        key: 'inconclusive:mini21/agent',
        reasons: ['credential_unknown:claude-cli'],
      },
      {
        key: 'inconclusive:mini21/agent',
        reasons: ['credential_unknown:claude-cli', 'provider_probe_skipped'],
      },
      {
        key: 'green:mini20/agent-a',
        reasons: [],
      },
      {
        key: 'green:mini20/agent-b',
        reasons: [],
      },
    ]);
  });
});
