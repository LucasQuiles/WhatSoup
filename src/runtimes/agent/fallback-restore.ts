// src/runtimes/agent/fallback-restore.ts
//
// #3019: extracted from AgentRuntime to keep runtime.ts under the per-file
// ceiling (12500 lines). Owns the fallback-window restore/reconciliation
// logic: version-incompatible rejection, active-entry identity validation
// against the configured chain, failedKeys reconstitution, and the save-call
// helper that persists the chain identity + failed keys.
//
// The restore function is a pure-ish collaborator: it takes a context object
// with the runtime's state and returns a result. The runtime's
// restorePersistedFallbackWindow method is a thin wrapper that builds the
// context and applies the result. No behavior change from v1 — this is a
// field-relocation extraction, same as the FallbackWindowState /
// FallbackWindowMetrics decompositions.

import type { Database } from '../../core/database.ts';
import type { AgentFallbackEntry } from '../../core/fallback-chain.ts';
import {
  ensureFallbackStateSchema,
  getFallbackState,
  clearFallbackState,
  PERSISTED_FALLBACK_STATE_VERSION,
  type FallbackRecoveryState,
  type FallbackRecoveryTerminalReason,
  type PersistedFailedKey,
} from './fallback-state-db.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import log from '../../logger.ts';

export type FallbackRestoreUnavailableReason =
  | 'persisted-state-evidence-unavailable'
  | 'failed-provider-evidence-unavailable'
  | 'recovery-state-evidence-unavailable'
  | 'persisted-version-incompatible'
  | 'fallback-route-unavailable';

/** A failed key serialized for persistence (provider + model only, no secrets). */
export function failedKeysToPersistedKeys(failedKeys: Set<string>): PersistedFailedKey[] {
  return [...failedKeys].map((k) => {
    const [provider, model] = k.split('\u0000');
    return { provider: provider ?? '', model: model ?? '' };
  });
}

/** Context the restore function needs from the AgentRuntime. */
export interface FallbackRestoreContext {
  readonly db: Database;
  readonly agentFallbacks: readonly AgentFallbackEntry[];
  /** Clear and re-populate the in-memory failedKeys set. */
  readonly resetFailedKeys: () => void;
  readonly addFailedKey: (key: string) => void;
  /** Build the entry-key string for provider+model (mirrors FallbackChain.entryKey). */
  readonly entryKeyFor: (provider: string, model: string | null) => string;
}

/** Result of the restore attempt. */
export type FallbackRestoreResult =
  | { outcome: 'no-state'; cleared: boolean }
  | { outcome: 'unavailable'; cleared: false; reason: FallbackRestoreUnavailableReason }
  | {
    outcome: 'armed';
    clampedUntil: number;
    persistedUntil: number;
    persistedReason: string;
    persistedActivatedAt: number;
    persistedRecoveryEpisodeStartedAt: number;
    persistedProbeAttempts: number;
    persistedRecoveryState: FallbackRecoveryState;
    persistedRecoveryTerminalReason: FallbackRecoveryTerminalReason | null;
    persistedRecoveryProbeInFlight: boolean;
    restoredFailedKeys: number;
  }
  | { outcome: 'arm-failed'; cleared: boolean }
  | { outcome: 'error' };

/**
 * Re-arm a persisted fallback window after a process restart.
 *
 * #3019: reconstitutes `FallbackChain.failedKeys` + active-entry identity from
 * the persisted row so a restart mid-window does not retry a known-failed entry
 * against an empty chain. Validates restored entries against the configured
 * chain by exact provider AND model — malformed, future-version, or
 * no-longer-routable rows enter an explicit unavailable reconciliation state
 * without clearing their raw evidence or re-routing to primary.
 *
 * Returns the result; the caller (runtime.ts) applies it (e.g. sets
 * fallbackWindowRestored, restores probeAttempts, calls armFallbackWindow).
 */
export function restorePersistedFallbackWindowState(
  ctx: FallbackRestoreContext,
  maxFallbackWindowMs: number,
  now: () => number,
): FallbackRestoreResult {
  try {
    ensureFallbackStateSchema(ctx.db);
    const persisted = getFallbackState(ctx.db);
    if (!persisted) {
      clearFallbackState(ctx.db);
      return { outcome: 'no-state', cleared: true };
    }
    // A present row with malformed core fields is not an absent episode. Keep
    // its raw bytes and block routing until an operator reconciles it.
    if (persisted.fallbackStateEvidenceAvailability === 'unavailable') {
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_state_evidence_unavailable',
        'Persisted fallback state evidence is unavailable — fallback restore is quarantined',
        'state_evidence=unavailable action=operator-reconciliation-required',
      );
      return { outcome: 'unavailable', cleared: false, reason: 'persisted-state-evidence-unavailable' };
    }
    // #3019: version-incompatible rows are explicit reconciliation, never a
    // silent re-route. A future version the running code doesn't understand
    // must not be re-armed with guessed semantics or cleared into primary.
    if (persisted.version > PERSISTED_FALLBACK_STATE_VERSION) {
      log.warn(
        { persistedVersion: persisted.version, knownVersion: PERSISTED_FALLBACK_STATE_VERSION },
        'persisted fallback state version is newer than known — quarantining to reconcile',
      );
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_version_incompatible',
        'Persisted fallback state version is incompatible — restore is quarantined',
        `persistedVersion=${persisted.version} knownVersion=${PERSISTED_FALLBACK_STATE_VERSION}`,
      );
      return { outcome: 'unavailable', cleared: false, reason: 'persisted-version-incompatible' };
    }
    // A corrupt failed-key record is evidence that a prior route failed. It
    // must remain available for reconciliation, not be erased or overwritten
    // by a fresh empty array.
    if (persisted.failedKeysEvidenceAvailability === 'unavailable') {
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_evidence_unavailable',
        'Persisted failed-provider evidence is unavailable — fallback restore is quarantined',
        'failed_keys_evidence=unavailable action=operator-reconciliation-required',
      );
      return { outcome: 'unavailable', cleared: false, reason: 'failed-provider-evidence-unavailable' };
    }
    // Version-2 recovery fields are authoritative durable control state. Do
    // not reinterpret malformed fields as legacy defaults, because that could
    // convert terminal or unknown work into an active expiry/recovery path.
    if (persisted.recoveryEvidenceAvailability === 'unavailable') {
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_recovery_evidence_unavailable',
        'Persisted fallback recovery evidence is unavailable — fallback restore is quarantined',
        'recovery_evidence=unavailable action=operator-reconciliation-required',
      );
      return { outcome: 'unavailable', cleared: false, reason: 'recovery-state-evidence-unavailable' };
    }
    const restoredAt = now();
    // An existing episode with no configured fallback route cannot resume on
    // primary before fresh proof. Keep its row for reconciliation and block
    // new routing instead of treating configuration removal as recovery.
    if (ctx.agentFallbacks.length === 0) {
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_route_unavailable',
        'Persisted fallback route is no longer configured — restore is quarantined',
        'route=config-missing action=operator-reconciliation-required',
      );
      return { outcome: 'unavailable', cleared: false, reason: 'fallback-route-unavailable' };
    }
    // #3019: validate the persisted active-entry identity against the
    // configured chain by exact provider AND model. A removed/reordered/
    // duplicated/malformed identity is explicit reconciliation, never a
    // silent re-route to a different entry.
    if (persisted.version >= 1 && persisted.activeEntryProvider !== null) {
      const configuredMatch = ctx.agentFallbacks.some(
        (entry) =>
          entry.provider === persisted.activeEntryProvider &&
          (entry.model ?? null) === (persisted.activeEntryModel ?? null),
      );
      if (!configuredMatch) {
        log.warn(
          {
            persistedProvider: persisted.activeEntryProvider,
            persistedModel: persisted.activeEntryModel,
            configuredChain: ctx.agentFallbacks.map((e) => ({ provider: e.provider, model: e.model })),
          },
          'persisted fallback active-entry identity not found in configured chain — quarantining to reconcile',
        );
        emitAlertChecked(
          'fallback-restore',
          'fallback_persist_chain_mismatch',
          'Persisted fallback active-entry not in configured chain — restore is quarantined',
          `persistedProvider=${persisted.activeEntryProvider} persistedModel=${persisted.activeEntryModel ?? 'default'}`,
        );
        return { outcome: 'unavailable', cleared: false, reason: 'fallback-route-unavailable' };
      }
    }
    // #3019: reconstitute FallbackChain.failedKeys from the persisted row,
    // validating each against the configured chain by exact provider AND
    // model. Only keys that match a configured entry are restored — a key
    // for a removed entry is dropped (it can no longer be retried). A
    // malformed key is dropped. This happens BEFORE armFallbackWindow so
    // selectFallbackEntryForWindow sees the reconstituted failedKeys and
    // skips known-failed entries.
    if (persisted.version >= 1) {
      ctx.resetFailedKeys();
      for (const fk of persisted.failedKeys) {
        // fk.model is always a string here: getFallbackState drops entries
        // without a string model at the read boundary.
        const configured = ctx.agentFallbacks.some(
          (entry) => entry.provider === fk.provider && (entry.model ?? null) === fk.model,
        );
        if (configured) {
          ctx.addFailedKey(ctx.entryKeyFor(fk.provider, fk.model));
        }
      }
    }
    // Clamp the restored window so a clock-skew or tampered row cannot pin
    // the fallback for longer than MAX_FALLBACK_WINDOW_MS from now.
    const clampedUntil = persisted.recoveryState === 'active'
      ? Math.min(persisted.activeUntil, restoredAt + maxFallbackWindowMs)
      : persisted.activeUntil;
    const restoredFailedKeys = persisted.version >= 1
      ? persisted.failedKeys.filter((fk) =>
          ctx.agentFallbacks.some((e) => e.provider === fk.provider && (e.model ?? null) === fk.model),
        ).length
      : 0;
    return {
      outcome: 'armed',
      clampedUntil,
      persistedUntil: persisted.activeUntil,
      persistedReason: persisted.reason,
      persistedActivatedAt: persisted.activatedAt,
      persistedRecoveryEpisodeStartedAt: persisted.recoveryEpisodeStartedAt ?? persisted.activatedAt,
      // getFallbackState sanitizes probe_attempts (finite, >= 0) at the read
      // boundary — a corrupt row can never surface a non-finite value here.
      persistedProbeAttempts: persisted.probeAttempts,
      // A crash after a probe claim has an unknown outcome. The caller holds
      // the fallback route and requires explicit operator retry/recovery; it
      // never replays accepted work from this ambiguous episode.
      persistedRecoveryState: persisted.recoveryProbeInFlight ? 'operator-held' : (persisted.recoveryState ?? 'active'),
      persistedRecoveryTerminalReason: persisted.recoveryProbeInFlight
        ? 'probe-outcome-unknown'
        : (persisted.recoveryTerminalReason ?? null),
      persistedRecoveryProbeInFlight: persisted.recoveryProbeInFlight ?? false,
      restoredFailedKeys,
    };
  } catch (err) {
    log.warn({ err }, 'failed to restore persisted fallback window');
    return { outcome: 'error' };
  }
}
