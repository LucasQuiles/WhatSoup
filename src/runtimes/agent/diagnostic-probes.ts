/**
 * Assembles the concrete {@link DiagnosticProbeMap} the bundle orchestrator runs,
 * from the runtime's capabilities. Kept as a pure builder over injected
 * dependencies so the mapping (provider status → finding ok/confidence) is
 * unit-testable without an AgentRuntime, a keyring, or a spawned process. The
 * runtime binds its real methods (`getFallbackState`, `probePrimaryModel-
 * Usability`, `probePrimaryProviderRecovered`, `extractUsageLimitResetTime`) and
 * the account-auth dependencies, and passes them here.
 *
 * The runtime owns redaction: `getHealthSnapshot` returns the already-curated
 * summary + data it is willing to surface; the builder never reaches into raw
 * provider state itself.
 */

import type {
  DiagnosticProbe,
  DiagnosticProbeMap,
  DiagnosticProbeResult,
} from './diagnostic-bundle.ts';
import type { PrimaryModelUsabilityResult } from './providers/primary-model-usability.ts';
import {
  makeAccountAuthStatusProbe,
  type AccountAuthStatusDeps,
  type AccountAuthTarget,
} from './providers/account-auth-status.ts';

export interface DiagnosticProbeBuilderDeps {
  /** Terminal result text, for usage-limit reset parsing. */
  providerText: string;
  /** Effective provider/model/config the failure occurred on. */
  target: AccountAuthTarget;
  /** Curated, non-secret health snapshot the runtime is willing to surface. */
  getHealthSnapshot: () => { summary: string; data: Record<string, unknown> };
  /** Parse a usage-limit reset time (epoch ms) from the result text, or null. */
  parseUsageLimitReset: (text: string) => number | null;
  /** Probe whether the primary model is currently usable. */
  runPrimaryModelUsability: () => Promise<PrimaryModelUsabilityResult>;
  /** Probe whether the primary provider's auth has recovered. */
  runPrimaryRecoveryProbe: () => Promise<boolean>;
  /** Dependencies for the account/auth-status probe. */
  accountAuthDeps: AccountAuthStatusDeps;
}

function mapPrimaryModelUsability(r: PrimaryModelUsabilityResult): DiagnosticProbeResult {
  const data = { status: r.status, provider: r.provider, ...(r.model ? { model: r.model } : {}) };
  switch (r.status) {
    case 'usable':
      return { ok: true, confidence: 'confirmed', summary: `primary model usable (${r.provider})`, data };
    case 'model-unavailable':
    case 'credential-unavailable':
    case 'provider-unavailable':
      return { ok: false, confidence: 'confirmed', summary: `primary model ${r.status} (${r.provider})`, data };
    case 'timeout':
    case 'unknown':
      // Inconclusive — the probe could not establish a verdict.
      return { ok: false, confidence: 'suspected', summary: `primary model usability ${r.status} (${r.provider})`, data };
  }
}

export function buildDiagnosticProbes(deps: DiagnosticProbeBuilderDeps): DiagnosticProbeMap {
  const healthSnapshot: DiagnosticProbe = async () => {
    const snap = deps.getHealthSnapshot();
    return { ok: true, confidence: 'confirmed', summary: snap.summary, data: snap.data };
  };

  const usageLimitResetParse: DiagnosticProbe = async () => {
    const resetAt = deps.parseUsageLimitReset(deps.providerText);
    return resetAt === null
      ? { ok: false, confidence: 'suspected', summary: 'no usage-limit reset time parsed', resetAt: null }
      : { ok: true, confidence: 'confirmed', summary: 'usage-limit reset time parsed', resetAt, data: { resetAt } };
  };

  const primaryModelUsability: DiagnosticProbe = async () =>
    mapPrimaryModelUsability(await deps.runPrimaryModelUsability());

  const primaryRecoveryProbe: DiagnosticProbe = async () => {
    const recovered = await deps.runPrimaryRecoveryProbe();
    return recovered
      ? { ok: true, confidence: 'probable', summary: 'primary provider recovered', data: { recovered } }
      : { ok: false, confidence: 'probable', summary: 'primary provider not yet recovered', data: { recovered } };
  };

  return {
    'health-snapshot': healthSnapshot,
    'usage-limit-reset-parse': usageLimitResetParse,
    'primary-model-usability': primaryModelUsability,
    'primary-recovery-probe': primaryRecoveryProbe,
    'account-auth-status': makeAccountAuthStatusProbe(deps.target, deps.accountAuthDeps),
  };
}
