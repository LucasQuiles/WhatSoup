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
  type PersistedFailedKey,
} from './fallback-state-db.ts';
import { emitAlertChecked } from '../../lib/emit-alert.ts';
import log from '../../logger.ts';

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
  | { outcome: 'expired-or-no-fallback'; cleared: boolean }
  | { outcome: 'version-incompatible'; cleared: boolean }
  | { outcome: 'chain-mismatch'; cleared: boolean }
  | { outcome: 'armed'; clampedUntil: number; persistedUntil: number; persistedReason: string; persistedActivatedAt: number; persistedProbeAttempts: number; restoredFailedKeys: number }
  | { outcome: 'arm-failed'; cleared: boolean }
  | { outcome: 'error' };

/**
 * Re-arm a persisted fallback window after a process restart.
 *
 * #3019: reconstitutes `FallbackChain.failedKeys` + active-entry identity from
 * the persisted row so a restart mid-window does not retry a known-failed entry
 * against an empty chain. Validates restored entries against the configured
 * chain by exact provider AND model — removed/reordered/duplicated/malformed/
 * version-incompatible rows enter an explicit fail-closed reconciliation state
 * (clear + alert + proceed on primary), never a silent re-route.
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
    if (ctx.agentFallbacks.length === 0 || persisted.activeUntil <= now()) {
      clearFallbackState(ctx.db);
      return { outcome: 'expired-or-no-fallback', cleared: true };
    }
    // #3019: version-incompatible rows are explicit reconciliation, never a
    // silent re-route. A future version the running code doesn't understand
    // must not be re-armed with guessed semantics.
    if (persisted.version > PERSISTED_FALLBACK_STATE_VERSION) {
      log.warn(
        { persistedVersion: persisted.version, knownVersion: PERSISTED_FALLBACK_STATE_VERSION },
        'persisted fallback state version is newer than known — clearing to reconcile',
      );
      emitAlertChecked(
        'fallback-restore',
        'fallback_persist_version_incompatible',
        'Persisted fallback state version is incompatible — cleared to reconcile',
        `persistedVersion=${persisted.version} knownVersion=${PERSISTED_FALLBACK_STATE_VERSION}`,
      );
      clearFallbackState(ctx.db);
      return { outcome: 'version-incompatible', cleared: true };
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
          'persisted fallback active-entry identity not found in configured chain — clearing to reconcile',
        );
        emitAlertChecked(
          'fallback-restore',
          'fallback_persist_chain_mismatch',
          'Persisted fallback active-entry not in configured chain — cleared to reconcile',
          `persistedProvider=${persisted.activeEntryProvider} persistedModel=${persisted.activeEntryModel ?? 'default'}`,
        );
        clearFallbackState(ctx.db);
        return { outcome: 'chain-mismatch', cleared: true };
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
    const clampedUntil = Math.min(persisted.activeUntil, now() + maxFallbackWindowMs);
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
      // getFallbackState sanitizes probe_attempts (finite, >= 0) at the read
      // boundary — a corrupt row can never surface a non-finite value here.
      persistedProbeAttempts: persisted.probeAttempts,
      restoredFailedKeys,
    };
  } catch (err) {
    log.warn({ err }, 'failed to restore persisted fallback window');
    return { outcome: 'error' };
  }
}
