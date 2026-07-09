/**
 * WS-ALERT provider-reauth classification for the fleet health-poller (spec §2).
 *
 * Pure functions over a parsed /health body so tests and the developer replay
 * lane (ALERT-15) can feed tests/fixtures/health/*.json straight in — no SSH,
 * no poller construction.
 *
 * classifyProviderReauthSignal — trusts the instance's own top-level
 * `reauth_required` boolean when present (the shared derivation shipped in
 * src/core/health.ts). For older instance versions that predate the boolean it
 * derives the identical rule — including the decision-8 freshness supersession —
 * from the turn_capability enums. A malformed or missing turn_capability with
 * no boolean is NOT a reauth signal (taxonomy: provider_probe_inconclusive);
 * it falls through to the poller's existing generic handling.
 *
 * providerReauthClearProof — the ONE clear predicate (used by both the poller's
 * return-to-online ladder and the degraded-flow clear): fresh usable primary
 * proof only. Fallback serving, restarts, or WhatsApp connectivity never clear
 * (IMPACT-18).
 *
 * providerReauthCriticalAsset / providerReauthClearEvidence — the poller rail's
 * criticalAsset diagnostic and its proof-carrying clear-evidence string, shared
 * by both poller confirm sites and both poller clear sites. The type-only
 * import keeps this module pure (no runtime dependency).
 */

import type { BotErrorsCriticalAssetDiagnostic } from '../lib/bot-errors-outbox.ts';

export interface ProviderReauthSignal {
  confirmed: boolean;
  evidence: string[];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deriveFromTurnCapability(tc: Record<string, unknown>): boolean {
  if (tc['model_usability_status'] === 'credential-unavailable') return true;
  if (tc['last_turn_error_class'] !== 'auth-required') return false;
  const checkedAt = typeof tc['model_usable_checked_at'] === 'number' ? tc['model_usable_checked_at'] : null;
  const errorAt = typeof tc['last_turn_error_at'] === 'number' ? tc['last_turn_error_at'] : null;
  return !(
    tc['model_usability_status'] === 'usable' &&
    tc['model_usable'] === true &&
    checkedAt !== null &&
    errorAt !== null &&
    checkedAt > errorAt
  );
}

export function classifyProviderReauthSignal(health: Record<string, unknown>): ProviderReauthSignal {
  const tc = readRecord(health['turn_capability']);
  let confirmed: boolean;
  if (typeof health['reauth_required'] === 'boolean') {
    confirmed = health['reauth_required'] === true;
  } else if (tc !== null) {
    confirmed = deriveFromTurnCapability(tc);
  } else {
    confirmed = false;
  }
  if (!confirmed) return { confirmed: false, evidence: [] };
  const instance = readRecord(health['instance']);
  return {
    confirmed: true,
    evidence: [
      `provider=${String(instance?.['provider'] ?? 'unknown')}`,
      `model_usability_status=${String(tc?.['model_usability_status'] ?? 'unknown')}`,
      `last_turn_error_class=${String(tc?.['last_turn_error_class'] ?? 'none')}`,
      `model_usable_checked_at=${String(tc?.['model_usable_checked_at'] ?? 'unknown')}`,
      `reauth_required=${typeof health['reauth_required'] === 'boolean' ? String(health['reauth_required']) : 'derived'}`,
      'evidence_schema_version=1',
    ],
  };
}

export function providerReauthClearProof(health: Record<string, unknown>): boolean {
  if (health['reauth_required'] === true) return false;
  const tc = readRecord(health['turn_capability']);
  if (tc === null) return false;
  return (
    tc['model_usability_status'] === 'usable' &&
    tc['model_usable'] === true &&
    tc['model_usable_stale'] !== true
  );
}

/**
 * Poller-rail twin of AgentRuntime.providerReauthCriticalAsset()
 * (src/runtimes/agent/runtime.ts) — every field value must stay byte-identical
 * across the two rails so both coalesce onto one cross-rail diagnostic
 * identity (the host-side deploy/scripts/bot-errors-health-check.py emits the
 * same asset shape). Deliberately mirrored, NOT factored into a shared module:
 * the deploy-pinned artifacts isolate their own copies, and duplicating the
 * literal here keeps this signal module dependency-light (type-only import).
 */
export function providerReauthCriticalAsset(instance: string): BotErrorsCriticalAssetDiagnostic {
  return {
    asset: { kind: 'agent_provider', instance },
    failure: {
      code: 'AGENT_PROVIDER_AUTH_REQUIRED',
      domain: 'provider_access',
      recoverability: 'operator_recoverable',
      confidence: 'confirmed',
      operatorAction: 'Restore provider authentication or switch to a proven fallback provider; do not mark the underlying auth failure resolved until the primary provider probe passes.',
      clearRequirement: 'fresh usable primary-model probe after the incident (clear_code=AGENT_PROVIDER_AUTH_RECOVERED)',
    },
  };
}

/**
 * The one proof-carrying clear-evidence string for the poller rail, used by
 * BOTH poller clear sites (the degraded-flow clear and the recovered-alert
 * ladder) so the two can never drift apart. The runtime rail's clear evidence
 * intentionally stays separate — it carries provider/model fields this rail
 * does not have, and a fleet→runtime import is not wanted.
 */
export function providerReauthClearEvidence(tc: Record<string, unknown> | null): string {
  return [
    'clear_code=AGENT_PROVIDER_AUTH_RECOVERED',
    'proof=primary_model_probe_ok',
    `model_usable_checked_at=${String(tc?.['model_usable_checked_at'] ?? 'unknown')}`,
  ].join(' ');
}
