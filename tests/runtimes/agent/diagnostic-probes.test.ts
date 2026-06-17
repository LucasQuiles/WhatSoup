import { describe, expect, it } from 'vitest';

import { buildDiagnosticProbes, type DiagnosticProbeBuilderDeps } from '../../../src/runtimes/agent/diagnostic-probes.ts';
import { runDiagnosticBundle } from '../../../src/runtimes/agent/diagnostic-bundle.ts';
import { RESPONSE_WORKFLOWS } from '../../../src/runtimes/agent/response-registry.ts';
import type { PrimaryModelUsabilityResult, PrimaryModelUsabilityStatus } from '../../../src/runtimes/agent/providers/primary-model-usability.ts';
import type { AccountAuthStatusDeps } from '../../../src/runtimes/agent/providers/account-auth-status.ts';

const NOW = 1_781_000_000_000;

const accountAuthDeps: AccountAuthStatusDeps = {
  resolveKeyService: () => 'openai',
  lookupCredential: () => 'present',
  getProviderBinary: () => 'claude',
  probeBinaryAuthStatus: async () => ({ status: 'ok', output: 'ok' }),
  isAuthRequiredMessage: () => false,
  env: { HOME: '/h', PATH: '/usr/bin', USER: 'x' },
};

function deps(overrides: Partial<DiagnosticProbeBuilderDeps> = {}): DiagnosticProbeBuilderDeps {
  return {
    providerText: 'Claude usage limit reached. resets at 3pm.',
    target: { provider: 'claude-cli', model: 'claude-opus-4-8' },
    getHealthSnapshot: () => ({ summary: 'effective provider opencode-cli', data: { effectiveProvider: 'opencode-cli' } }),
    parseUsageLimitReset: () => NOW + 3_600_000,
    runPrimaryModelUsability: async () => ({ status: 'usable', provider: 'claude-cli', model: 'claude-opus-4-8' }),
    runPrimaryRecoveryProbe: async () => false,
    accountAuthDeps,
    ...overrides,
  };
}

const signal = (): AbortSignal => new AbortController().signal;

describe('buildDiagnosticProbes', () => {
  it('registers all five diagnostic ids', () => {
    const map = buildDiagnosticProbes(deps());
    expect(Object.keys(map).sort()).toEqual([
      'account-auth-status',
      'health-snapshot',
      'primary-model-usability',
      'primary-recovery-probe',
      'usage-limit-reset-parse',
    ]);
  });

  it('health-snapshot surfaces the runtime-curated summary + data', async () => {
    const map = buildDiagnosticProbes(deps());
    const r = await map['health-snapshot']!(signal());
    expect(r).toMatchObject({ ok: true, confidence: 'confirmed', summary: 'effective provider opencode-cli' });
    expect(r.data).toEqual({ effectiveProvider: 'opencode-cli' });
  });

  it('health-snapshot returns ok:true when snapshot shows no active fallback and no unusable model status', async () => {
    const map = buildDiagnosticProbes(deps({
      getHealthSnapshot: () => ({
        summary: 'effective=claude-cli fallbackReason=none modelUsable=true',
        data: {
          effectiveProvider: 'claude-cli',
          fallbackReason: null,
          fallbackActiveUntil: null,
          modelUsabilityStatus: 'usable',
        },
      }),
    }));
    const r = await map['health-snapshot']!(signal());
    expect(r).toMatchObject({ ok: true, confidence: 'confirmed' });
  });

  it('health-snapshot returns ok:false when snapshot has a non-null fallbackReason (fallback active = degraded)', async () => {
    const map = buildDiagnosticProbes(deps({
      getHealthSnapshot: () => ({
        summary: 'effective=opencode-cli fallbackReason=usage-limit modelUsable=unknown',
        data: {
          effectiveProvider: 'opencode-cli',
          fallbackReason: 'usage-limit',
          fallbackActiveUntil: NOW + 3_600_000,
          modelUsabilityStatus: null,
        },
      }),
    }));
    const r = await map['health-snapshot']!(signal());
    expect(r).toMatchObject({ ok: false, confidence: 'confirmed' });
  });

  it('health-snapshot returns ok:false for each unusable modelUsabilityStatus', async () => {
    const unusableStatuses = ['model-unavailable', 'credential-unavailable', 'provider-unavailable'] as const;
    for (const status of unusableStatuses) {
      const map = buildDiagnosticProbes(deps({
        getHealthSnapshot: () => ({
          summary: `effective=claude-cli fallbackReason=none modelUsable=false`,
          data: {
            effectiveProvider: 'claude-cli',
            fallbackReason: null,
            fallbackActiveUntil: null,
            modelUsabilityStatus: status,
          },
        }),
      }));
      const r = await map['health-snapshot']!(signal());
      expect(r, `modelUsabilityStatus=${status}`).toMatchObject({ ok: false, confidence: 'confirmed' });
    }
  });

  it('usage-limit-reset-parse lifts a parsed reset time; degrades when unparseable', async () => {
    const parsed = await buildDiagnosticProbes(deps())['usage-limit-reset-parse']!(signal());
    expect(parsed).toMatchObject({ ok: true, confidence: 'confirmed' });
    expect(parsed.resetAt).toBe(NOW + 3_600_000);

    const none = await buildDiagnosticProbes(deps({ parseUsageLimitReset: () => null }))['usage-limit-reset-parse']!(signal());
    expect(none).toMatchObject({ ok: false, confidence: 'suspected', resetAt: null });
  });

  it('maps every primary-model-usability status to the right ok/confidence', async () => {
    const expected: Record<PrimaryModelUsabilityStatus, { ok: boolean; confidence: string }> = {
      usable: { ok: true, confidence: 'confirmed' },
      'model-unavailable': { ok: false, confidence: 'confirmed' },
      'credential-unavailable': { ok: false, confidence: 'confirmed' },
      'provider-unavailable': { ok: false, confidence: 'confirmed' },
      timeout: { ok: false, confidence: 'suspected' },
      unknown: { ok: false, confidence: 'suspected' },
    };
    for (const status of Object.keys(expected) as PrimaryModelUsabilityStatus[]) {
      const result: PrimaryModelUsabilityResult = { status, provider: 'claude-cli', model: 'claude-opus-4-8' };
      const map = buildDiagnosticProbes(deps({ runPrimaryModelUsability: async () => result }));
      const r = await map['primary-model-usability']!(signal());
      expect(r, status).toMatchObject(expected[status]);
    }
  });

  it('primary-recovery-probe reflects recovery as probable either way', async () => {
    const recovered = await buildDiagnosticProbes(deps({ runPrimaryRecoveryProbe: async () => true }))['primary-recovery-probe']!(signal());
    expect(recovered).toMatchObject({ ok: true, confidence: 'probable' });
    const not = await buildDiagnosticProbes(deps())['primary-recovery-probe']!(signal());
    expect(not).toMatchObject({ ok: false, confidence: 'probable' });
  });

  it('feeds a usage-limit workflow end-to-end through the orchestrator', async () => {
    const map = buildDiagnosticProbes(deps());
    const bundle = await runDiagnosticBundle({ workflow: RESPONSE_WORKFLOWS.provider_usage_limit, probes: map, now: NOW });
    // usage-limit names [usage-limit-reset-parse, health-snapshot, account-auth-status, primary-recovery-probe]
    expect(bundle.findings.map((f) => f.id)).toEqual([
      'usage-limit-reset-parse',
      'health-snapshot',
      'account-auth-status',
      'primary-recovery-probe',
    ]);
    expect(bundle.resetAt).toBe(NOW + 3_600_000);
    expect(bundle.errorClass).toBe('provider_usage_limit');
  });
});
