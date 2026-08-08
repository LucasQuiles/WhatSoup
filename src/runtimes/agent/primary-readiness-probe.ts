// src/runtimes/agent/primary-readiness-probe.ts
//
// #3017: extracted from AgentRuntime to keep runtime.ts under the per-file
// ceiling (12500 lines). Owns the periodic primary-readiness probe scheduling
// logic (single-flight, rate-limit, jitter, backoff) and the serving-context
// receipt construction (content-free hashes for the probe target-context
// binding — AXIS C).
//
// The runtime calls these helpers; the timer state and backoff counter stay
// on the AgentRuntime instance (they're process-local lifecycle state), but
// the scheduling CALCULATION and the receipt CONSTRUCTION live here.

import { shortHash } from '../../lib/short-hash.ts';
import { getProviderBinary } from './session.ts';
import { homedir } from 'node:os';
import type { ServingContextReceipt } from './providers/primary-model-usability.ts';
import type { PrimaryModelProbeAdapterDeps } from './providers/primary-model-usability-adapters.ts';

// #3017 AXIS A: periodic primary-readiness probe. The freshness window
// (MODEL_USABILITY_FRESHNESS_MS in runtime.ts = 30min) only matters if
// something refreshes the evidence — without a periodic probe, an idle
// primary with expired OAuth stays green until a user turn triggers a
// manual probe. The periodic probe fires at FRESHNESS_MS (so evidence
// never goes stale on an idle bot), with ±10% jitter (thundering-herd
// avoidance), a 5min rate-limit floor (probe-storm prevention), and
// exponential backoff on probe failures (2x up to 4x = 2h max — a
// persistently-failing probe gradually widens its cadence rather than
// spinning).
export const PERIODIC_PROBE_INTERVAL_MS = 30 * 60_000;
export const PERIODIC_PROBE_JITTER_MS = Math.floor(PERIODIC_PROBE_INTERVAL_MS * 0.1);
export const PERIODIC_PROBE_RATE_LIMIT_MS = 5 * 60_000;
export const PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE = 4;
export const PERIODIC_PROBE_BACKOFF_BASE = 2;

/**
 * Calculate the delay for the next periodic primary-readiness probe.
 *
 * Single-flight, rate-limit, jitter, and backoff are all encoded in the
 * returned delay. The caller sets the timer; this function is pure
 * (no side effects, no I/O) so it's unit-testable.
 */
export function calculatePeriodicProbeDelay(
  backoff: number,
  lastProbeCheckedAt: number | null,
  now: number,
): number {
  const backoffMultiple = Math.min(
    Math.pow(PERIODIC_PROBE_BACKOFF_BASE, backoff),
    PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE,
  );
  const baseInterval = PERIODIC_PROBE_INTERVAL_MS * backoffMultiple;
  // Jitter: ±10% of the (backoff-adjusted) interval, centered.
  const jitter = (Math.random() - 0.5) * 2 * PERIODIC_PROBE_JITTER_MS * backoffMultiple;
  // Rate-limit floor: never fire sooner than the rate-limit after the last probe.
  const msSinceLastProbe = now - (typeof lastProbeCheckedAt === 'number' ? lastProbeCheckedAt : 0);
  const rateLimitRemaining = Math.max(0, PERIODIC_PROBE_RATE_LIMIT_MS - msSinceLastProbe);
  return Math.max(rateLimitRemaining, baseInterval + jitter);
}

/**
 * Calculate the next backoff counter after a probe result.
 *
 * Reset to 0 on a successful 'usable' result; increment on failure,
 * capped at log2(MAX_MULTIPLE) so the delay calculation's Math.pow
 * never exceeds the cap.
 */
export function calculatePeriodicProbeBackoff(
  currentBackoff: number,
  probeSucceeded: boolean,
): number {
  if (probeSucceeded) return 0;
  return Math.min(
    currentBackoff + 1,
    Math.log2(PERIODIC_PROBE_BACKOFF_MAX_MULTIPLE),
  );
}

/**
 * #3017 AXIS C: build the serving-context receipt — content-free hashes of
 * the config root, credential-store class, binary digest, provider, and model
 * the runtime is actually serving with. The probe fail-closes when any of
 * these differ from the probe target, preventing a probe of a DIFFERENT
 * environment from reading green for a primary whose real serving context is
 * broken. Never includes credential material, paths that expose user data,
 * or account identity.
 */
export function buildServingContextReceipt(
  agentProvider: string,
  model: string | null | undefined,
  cwd: string | null | undefined,
): ServingContextReceipt {
  const configRoot = cwd ?? homedir();
  // Defensive — getProviderBinary may be unavailable in test mocks; null
  // is a valid "no binary digest" receipt field.
  let binary: string | null = null;
  try {
    binary = getProviderBinary(agentProvider);
  } catch {
    binary = null;
  }
  return {
    configRootHash: shortHash(configRoot),
    credentialStoreClass: deriveCredentialStoreClass(agentProvider),
    binaryDigest: binary !== null ? shortHash(binary) : null,
    provider: agentProvider,
    model: model ?? null,
  };
}

function deriveCredentialStoreClass(provider: string): string | null {
  if (provider === 'claude-cli') return 'keychain-or-file-store';
  if (provider === 'opencode-cli') return 'keyring';
  if (provider === 'openai-api' || provider === 'anthropic-api') return 'api-key';
  return null;
}

/**
 * Build the PrimaryModelProbeAdapterDeps with the serving-context receipt
 * bound (AXIS C). The caller passes its existing adapter deps (cwd,
 * egressProxyPort, providerExecutionGate) and this function adds the
 * servingContext.
 */
export function buildPrimaryProbeAdapterDeps(
  agentProvider: string,
  model: string | null | undefined,
  cwd: string | null | undefined,
  egressProxyPort: number | undefined,
  providerExecutionGate: PrimaryModelProbeAdapterDeps['providerExecutionGate'],
): PrimaryModelProbeAdapterDeps {
  return {
    cwd: cwd ?? homedir(),
    egressProxyPort,
    providerExecutionGate,
    servingContext: buildServingContextReceipt(agentProvider, model, cwd),
  };
}

/**
 * #3017: extracted from AgentRuntime to keep runtime.ts under the per-file
 * ceiling. Builds the alert evidence string for a primary-model-usability
 * result. Pure function — the alertEvidenceValue formatter is passed as a dep.
 */
export function formatPrimaryModelUsabilityEvidence(
  result: { status: string; provider: string; model: string | null; reason?: string | null; suggestion?: string | null },
  trigger: string,
  alertEvidenceValue: (v: string | null | undefined) => string,
): string {
  const parts = [
    `trigger=${trigger}`,
    `status=${alertEvidenceValue(result.status)}`,
    `provider=${alertEvidenceValue(result.provider)}`,
    `model=${alertEvidenceValue(result.model)}`,
  ];
  if (result.reason) parts.push(`reason=${alertEvidenceValue(result.reason)}`);
  if (result.suggestion) parts.push(`suggestion=${alertEvidenceValue(result.suggestion)}`);
  return parts.join(' ');
}
