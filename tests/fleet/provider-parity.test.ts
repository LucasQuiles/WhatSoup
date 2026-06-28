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

  it('classifies present-only credentials, skipped probes, and the bare-provider fallback form', () => {
    // Exercises credentialState='present' (no native parts), probeState='skipped',
    // and fallbackEntries() deriving the chain from `fallback.provider` when chain is empty.
    const report = evaluateProviderParity({
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'abc',
      expected: [expected()],
      statuses: {
        'mini3/agent': status({
          primary: { provider: 'claude-cli', model: null, keyPresent: true },
          fallback: {
            provider: 'openai-api',
            model: 'gpt-4',
            keyPresent: true,
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
        { host: 'mini3', instance: 'agent', provider: 'openai-api', state: 'skipped', evidenceRef: 'ev' },
      ],
    });

    const row = report.rows[0];
    expect(row.credentialState).toBe('present');
    expect(row.probeState).toBe('skipped');
    expect(row.fallbackProviders).toEqual(['openai-api']);
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
});
