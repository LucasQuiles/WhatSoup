import { describe, expect, it } from 'vitest';

import {
  runDiagnosticBundle,
  type DiagnosticProbe,
  type DiagnosticProbeMap,
} from '../../../src/runtimes/agent/diagnostic-bundle.ts';
import { RESPONSE_WORKFLOWS, type DiagnosticId } from '../../../src/runtimes/agent/response-registry.ts';

const NOW = 1_781_000_000_000;

function okProbe(summary: string, extra: Partial<Awaited<ReturnType<DiagnosticProbe>>> = {}): DiagnosticProbe {
  return async () => ({ ok: true, confidence: 'confirmed', summary, ...extra });
}

describe('runDiagnosticBundle', () => {
  it('runs only the workflow-named diagnostics and preserves their order', async () => {
    const called: DiagnosticId[] = [];
    const mk = (id: DiagnosticId): DiagnosticProbe => async () => {
      called.push(id);
      return { ok: true, confidence: 'confirmed', summary: id };
    };
    // rate-limit names [health-snapshot, primary-recovery-probe] only.
    const probes: DiagnosticProbeMap = {
      'health-snapshot': mk('health-snapshot'),
      'primary-recovery-probe': mk('primary-recovery-probe'),
      'account-auth-status': mk('account-auth-status'), // not named — must not run
      'usage-limit-reset-parse': mk('usage-limit-reset-parse'), // not named — must not run
    };
    const bundle = await runDiagnosticBundle({ workflow: RESPONSE_WORKFLOWS.provider_rate_limit, probes, now: NOW });

    expect(bundle.findings.map((f) => f.id)).toEqual(['health-snapshot', 'primary-recovery-probe']);
    expect(new Set(called)).toEqual(new Set(['health-snapshot', 'primary-recovery-probe']));
    expect(bundle.errorClass).toBe('provider_rate_limit');
    expect(bundle.collectedAt).toBe(NOW);
  });

  it('degrades a hanging probe to a low-confidence finding without blocking others, and aborts it', async () => {
    // This also proves probes run concurrently: a never-resolving probe must not
    // stall the fast one — only possible if they are awaited in parallel.
    let aborted = false;
    const hang: DiagnosticProbe = (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => { /* never resolves */ });
    };
    const probes: DiagnosticProbeMap = {
      'health-snapshot': hang,
      'primary-recovery-probe': okProbe('recovered'),
    };
    const bundle = await runDiagnosticBundle({
      workflow: RESPONSE_WORKFLOWS.provider_rate_limit,
      probes,
      now: NOW,
      perProbeTimeoutMs: 40,
    });

    const health = bundle.findings.find((f) => f.id === 'health-snapshot')!;
    expect(health.ok).toBe(false);
    expect(health.confidence).toBe('suspected');
    expect(health.summary).toContain('timed out');
    expect(aborted).toBe(true);
    // The fast probe still produced a real finding.
    expect(bundle.findings.find((f) => f.id === 'primary-recovery-probe')!.ok).toBe(true);
  });

  it('degrades a throwing probe (sync and async) to a suspected finding', async () => {
    const asyncThrow: DiagnosticProbe = async () => { throw new Error('async boom'); };
    const syncThrow: DiagnosticProbe = () => { throw new Error('sync boom'); };
    const probes: DiagnosticProbeMap = {
      'health-snapshot': asyncThrow,
      'primary-recovery-probe': syncThrow,
    };
    const bundle = await runDiagnosticBundle({ workflow: RESPONSE_WORKFLOWS.provider_rate_limit, probes, now: NOW });

    for (const f of bundle.findings) {
      expect(f.ok).toBe(false);
      expect(f.confidence).toBe('suspected');
      expect(f.summary).toContain('failed');
    }
  });

  it('degrades an unregistered named probe', async () => {
    const bundle = await runDiagnosticBundle({
      workflow: RESPONSE_WORKFLOWS.provider_rate_limit,
      probes: {}, // nothing registered
      now: NOW,
    });
    expect(bundle.findings).toHaveLength(2);
    for (const f of bundle.findings) {
      expect(f.ok).toBe(false);
      expect(f.summary).toContain('not registered');
    }
  });

  it('lifts resetAt from the usage-limit-reset-parse probe onto the bundle', async () => {
    const resetAt = NOW + 3_600_000;
    const probes: DiagnosticProbeMap = {
      'usage-limit-reset-parse': okProbe('resets in 1h', { resetAt }),
      'health-snapshot': okProbe('healthy'),
      'account-auth-status': okProbe('authed'),
      'primary-recovery-probe': okProbe('not recovered', { ok: false, confidence: 'probable' }),
    };
    const bundle = await runDiagnosticBundle({ workflow: RESPONSE_WORKFLOWS.provider_usage_limit, probes, now: NOW });

    expect(bundle.resetAt).toBe(resetAt);
    expect(bundle.findings.map((f) => f.id)).toEqual([
      'usage-limit-reset-parse',
      'health-snapshot',
      'account-auth-status',
      'primary-recovery-probe',
    ]);
  });

  it('passes probe data through and defaults resetAt to null', async () => {
    const probes: DiagnosticProbeMap = {
      'health-snapshot': okProbe('healthy', { data: { effectiveProvider: 'opencode-cli' } }),
      'primary-recovery-probe': okProbe('recovered'),
    };
    const bundle = await runDiagnosticBundle({ workflow: RESPONSE_WORKFLOWS.provider_rate_limit, probes, now: NOW });
    expect(bundle.resetAt).toBeNull();
    expect(bundle.findings.find((f) => f.id === 'health-snapshot')!.data).toEqual({ effectiveProvider: 'opencode-cli' });
  });
});
