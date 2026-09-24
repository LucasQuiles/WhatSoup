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
import { isNonEmptyString } from '../../lib/type-guards.ts';
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
  runPrimaryModelUsability: (signal?: AbortSignal) => Promise<PrimaryModelUsabilityResult>;
  /** Probe whether the primary provider's auth has recovered. */
  runPrimaryRecoveryProbe: (signal?: AbortSignal) => Promise<boolean>;
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
    case 'probe-blocked':
      // #3017 AXIS C: the probe target context differs from the serving
      // context — inconclusive, not a confirmed failure.
      return { ok: false, confidence: 'suspected', summary: `primary model probe blocked: context mismatch (${r.provider})`, data };
    case 'probe-error':
      // #3017 AXIS C: the probe itself errored — inconclusive.
      return { ok: false, confidence: 'suspected', summary: `primary model probe error (${r.provider})`, data };
  }
}

/**
 * Use the runtime's canonical readiness derivation, which owns freshness and
 * in-flight probe handling. Raw model status is diagnostic context only.
 */
function snapshotVerdict(data: Record<string, unknown>): Pick<DiagnosticProbeResult, 'ok' | 'confidence'> {
  // getFallbackState only supplies a reason while its fallback window is active.
  if (isNonEmptyString(data['fallbackReason'])) {
    return { ok: false, confidence: 'confirmed' };
  }
  return typeof data['modelUsable'] === 'boolean' && data['modelUsableStale'] === false
    ? { ok: data['modelUsable'], confidence: 'confirmed' }
    : { ok: false, confidence: 'suspected' };
}

export function buildDiagnosticProbes(deps: DiagnosticProbeBuilderDeps): DiagnosticProbeMap {
  const healthSnapshot: DiagnosticProbe = async () => {
    const snap = deps.getHealthSnapshot();
    return { ...snapshotVerdict(snap.data), summary: snap.summary, data: snap.data };
  };

  const usageLimitResetParse: DiagnosticProbe = async () => {
    const resetAt = deps.parseUsageLimitReset(deps.providerText);
    return resetAt === null
      ? { ok: false, confidence: 'suspected', summary: 'no usage-limit reset time parsed', resetAt: null }
      : { ok: true, confidence: 'confirmed', summary: 'usage-limit reset time parsed', resetAt, data: { resetAt } };
  };

  const primaryModelUsability: DiagnosticProbe = async (signal) =>
    mapPrimaryModelUsability(await deps.runPrimaryModelUsability(signal));

  const primaryRecoveryProbe: DiagnosticProbe = async (signal) => {
    const recovered = await deps.runPrimaryRecoveryProbe(signal);
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
