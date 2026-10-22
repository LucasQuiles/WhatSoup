// runtime.ts re-exports these, so existing importers keep runtime.ts as their entry point.
import type { RuntimeTurnCapabilityHealth } from '../types.ts';
import { MS_PER_MINUTE } from '../../lib/time-units.ts';
import type { TurnCapabilityErrorClass } from './turn-capability-tracker.ts';
import { primaryModelUsabilityRequiresAlert, type PrimaryModelUsabilityResult } from './providers/primary-model-usability.ts';

/**
 * `modelUsable` reports `true` only when the primary-model usability probe behind
 * it is no older than this window. A stale `usable` probe (e.g. after reverting to
 * primary and then sitting idle, or if an external process strips creds) is
 * downgraded to `null` (unknown) so /health and monitors cannot read a green that
 * is hours out of date. See RCA 2026-06-24 (rb-bot stale-`modelUsable` gap).
 */
export const MODEL_USABILITY_FRESHNESS_MS = 30 * MS_PER_MINUTE;

export type RuntimeTurnCapability = RuntimeTurnCapabilityHealth & {
  modelUsabilityStatus: PrimaryModelUsabilityResult['status'] | null;
  lastTurnErrorClass: TurnCapabilityErrorClass | null;
};

export type RuntimePrimaryModelUsability = PrimaryModelUsabilityResult & {
  checkedAt: number | null;
  probeInFlight: boolean;
};

/**
 * Pure derivation of the `modelUsable` health verdict from the last usability
 * probe, gated on freshness. Either verdict — a `usable` green OR a
 * requires-alert red — older than `freshnessMs` is reported as `null` (unknown)
 * with `modelUsableStale=true` rather than a stale green or a stale red (#1884).
 * Pure + exported for direct unit testing (the probe state itself is private).
 */
export function deriveModelUsable(
  usability: RuntimePrimaryModelUsability | null,
  nowMs: number,
  freshnessMs: number = MODEL_USABILITY_FRESHNESS_MS,
): { modelUsable: boolean | null; modelUsableStale: boolean; modelUsableCheckedAt: number | null } {
  const modelUsableCheckedAt = usability?.checkedAt ?? null;
  if (!usability || usability.probeInFlight) {
    return { modelUsable: null, modelUsableStale: false, modelUsableCheckedAt };
  }
  // A future-dated or non-finite proof time, clock or window is not current evidence.
  const ageMs = typeof modelUsableCheckedAt === 'number' ? nowMs - modelUsableCheckedAt : NaN;
  const fresh = Number.isFinite(ageMs) && Number.isFinite(freshnessMs)
    && ageMs >= 0 && ageMs <= freshnessMs;
  if (usability.status === 'usable') {
    return fresh
      ? { modelUsable: true, modelUsableStale: false, modelUsableCheckedAt }
      : { modelUsable: null, modelUsableStale: true, modelUsableCheckedAt };
  }
  if (primaryModelUsabilityRequiresAlert(usability)) {
    // Symmetric with the `usable` branch (#1884): a "not usable" verdict older
    // than freshnessMs (e.g. a credential-unavailable cached at startup) is
    // stale evidence, not an authoritative red — report null (unknown) +
    // modelUsableStale=true so it re-probes rather than caching a stale false.
    return fresh
      ? { modelUsable: false, modelUsableStale: false, modelUsableCheckedAt }
      : { modelUsable: null, modelUsableStale: true, modelUsableCheckedAt };
  }
  return { modelUsable: null, modelUsableStale: false, modelUsableCheckedAt };
}
