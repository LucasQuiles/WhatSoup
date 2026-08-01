/**
 * AutoCompactController — silent-compact + auto-compact rearm state machine for
 * AgentRuntime.
 *
 * Extracted from AgentRuntime as the second slice of the god-class decomposition.
 * Owns the per-scope auto-compact bookkeeping: the silent-compact suppression
 * timers, the compact-boundary set, the cooldown / last-success / rapid-rearm
 * tracking maps, the in-flight auto-compact waiters, and the cumulative health
 * counters. AgentRuntime keeps thin delegating privates
 * (beginSilentCompact/isSilentCompact/clearSilentCompact/finishAutoCompact/
 * consumeCompactBoundary/recordAutoCompactSuccess/recordAutoCompactRapidRearm/
 * recordAutoCompactNextTurnIfNeeded) so the turn-pipeline call sites are unchanged,
 * and the prior scattered per-chat cleanup / JID-alias rekey / shutdown map
 * manipulations collapse into cleanupScope / rekey / shutdown.
 *
 * Behavior is identical to the previous inline implementation — see the existing
 * auto-compact characterization suite in tests/runtimes/agent/runtime.test.ts
 * (silent compaction, baseline advancement on compact_boundary, cooldown windows,
 * rapid-rearm escalation tiers, reset-after-recovery, first-post-compact-turn
 * counting, per-chat vs single mode, crash cleanup, /new & /kill-session clearing).
 *
 * The TRIGGER decision (maybeStartAutoCompact) intentionally stays in AgentRuntime:
 * it depends on the db, session manager, and pending-system-result tracking, not on
 * the auto-compact bookkeeping state. It reaches into this controller's maps for the
 * eligibility reads/writes (exposed as public readonly fields).
 */
import { createChildLogger } from '../../logger.ts';
import { MS_PER_MINUTE, MS_PER_HOUR } from '../../lib/time-units.ts';

// Same component name as AgentRuntime: the rapid-rearm / next-turn warnings keep
// their existing `component: 'agent-runtime'` log binding (no observable change).
const log = createChildLogger('agent-runtime');

/** TTL for the silent-compact suppression window (mirrors a /compact round-trip). */
export const SILENT_COMPACT_TTL_MS = 5 * MS_PER_MINUTE;
// Baseline cooldown after a successful auto-compact before another may start.
// Keeps success and timeout paths from re-arming /compact on every turn.
export const AUTO_COMPACT_SUCCESS_COOLDOWN_MS = 5 * MS_PER_MINUTE;
// A scope eligible again inside this window after a successful compact is a
// rapid re-arm: the compact completed but was operationally ineffective.
export const AUTO_COMPACT_RAPID_REARM_WINDOW_MS = 5 * MS_PER_MINUTE;
export const AUTO_COMPACT_BACKOFF_TIERS_MS = [
  AUTO_COMPACT_SUCCESS_COOLDOWN_MS,
  15 * MS_PER_MINUTE,
  30 * MS_PER_MINUTE,
  MS_PER_HOUR,
] as const;

interface AutoCompactWaiter {
  promise: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AutoCompactHealthSnapshot {
  readonly state: 'idle' | 'backoff';
  readonly activeBackoffScopes: number;
  readonly worstCurrentBackoffTier: number;
}

export class AutoCompactController {
  /** Scopes currently inside a silent-compact suppression window → its TTL timer. */
  readonly silentCompactScopes = new Map<string, ReturnType<typeof setTimeout>>();
  /** Scopes that have observed a compact_boundary not yet consumed by the next turn. */
  readonly compactBoundaryScopes = new Set<string>();
  /** Scope → epoch-ms until which a new auto-compact is suppressed (cooldown). */
  readonly cooldownUntil = new Map<string, number>();
  /** Scope → epoch-ms of the most recent successful auto-compact. */
  readonly lastSuccessAt = new Map<string, number>();
  /** Scope → lastSuccessAt value already counted as a rapid re-arm (dedupe guard). */
  readonly rapidRearmRecordedForSuccessAt = new Map<string, number>();
  /** Scope → count of consecutive rapid re-arms (drives the backoff tier). */
  readonly consecutiveRapidRearms = new Map<string, number>();
  /** Scopes to measure on their next turn for post-compact effectiveness. */
  readonly measureNextTurn = new Set<string>();
  /** Scope → in-flight auto-compact waiter (promise + resolve + timeout timer). */
  readonly waiters = new Map<string, AutoCompactWaiter>();

  /** Cumulative count of rapid re-arms observed (health metric). */
  ineffective = 0;
  /** High-water mark of consecutive rapid re-arms across all scopes (health metric). */
  consecutiveRapidRearmsMax = 0;
  /** Cumulative count of first-post-compact turns that exceeded threshold (health metric). */
  nextTurnOverThreshold = 0;

  /**
   * The auto-compact input-token threshold (undefined disables next-turn
   * measurement), mirroring AgentRuntime.autoCompactInputTokens.
   */
  private readonly inputTokens: number | undefined;

  constructor(inputTokens: number | undefined) {
    this.inputTokens = inputTokens;
  }

  healthSnapshot(now = Date.now()): AutoCompactHealthSnapshot {
    let activeBackoffScopes = 0;
    let worstCurrentBackoffTier = 0;
    for (const [scopeKey, consecutiveRapidRearms] of this.consecutiveRapidRearms) {
      const cooldownUntil = this.cooldownUntil.get(scopeKey);
      if (
        !Number.isFinite(consecutiveRapidRearms)
        || consecutiveRapidRearms <= 0
        || cooldownUntil === undefined
        || !Number.isFinite(cooldownUntil)
        || cooldownUntil <= now
      ) {
        continue;
      }
      activeBackoffScopes += 1;
      worstCurrentBackoffTier = Math.max(
        worstCurrentBackoffTier,
        Math.min(
          Math.floor(consecutiveRapidRearms),
          AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1,
        ),
      );
    }
    return {
      state: activeBackoffScopes > 0 ? 'backoff' : 'idle',
      activeBackoffScopes,
      worstCurrentBackoffTier,
    };
  }

  beginSilentCompact(scopeKey: string): void {
    this.clearSilentCompact(scopeKey);
    const timer = setTimeout(() => {
      this.silentCompactScopes.delete(scopeKey);
    }, SILENT_COMPACT_TTL_MS);
    timer.unref?.();
    this.silentCompactScopes.set(scopeKey, timer);
  }

  isSilentCompact(scopeKey?: string): boolean {
    return scopeKey !== undefined && this.silentCompactScopes.has(scopeKey);
  }

  clearSilentCompact(scopeKey?: string): void {
    if (scopeKey === undefined) return;
    const timer = this.silentCompactScopes.get(scopeKey);
    if (timer) clearTimeout(timer);
    this.silentCompactScopes.delete(scopeKey);
  }

  finishAutoCompact(scopeKey: string): void {
    const waiter = this.waiters.get(scopeKey);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(scopeKey);
    waiter.resolve();
  }

  consumeCompactBoundary(scopeKey: string): boolean {
    const hadBoundary = this.compactBoundaryScopes.has(scopeKey);
    this.compactBoundaryScopes.delete(scopeKey);
    return hadBoundary;
  }

  recordAutoCompactSuccess(scopeKey: string): void {
    const now = Date.now();
    this.lastSuccessAt.set(scopeKey, now);
    this.rapidRearmRecordedForSuccessAt.delete(scopeKey);
    this.measureNextTurn.add(scopeKey);
    this.cooldownUntil.set(scopeKey, now + AUTO_COMPACT_SUCCESS_COOLDOWN_MS);
  }

  recordAutoCompactRapidRearm(scopeKey: string, lastSuccessAt: number, now: number): void {
    if (this.rapidRearmRecordedForSuccessAt.get(scopeKey) === lastSuccessAt) return;
    const next = (this.consecutiveRapidRearms.get(scopeKey) ?? 0) + 1;
    this.rapidRearmRecordedForSuccessAt.set(scopeKey, lastSuccessAt);
    this.consecutiveRapidRearms.set(scopeKey, next);
    this.ineffective += 1;
    if (next > this.consecutiveRapidRearmsMax) {
      this.consecutiveRapidRearmsMax = next;
    }
    const tier = Math.min(next, AUTO_COMPACT_BACKOFF_TIERS_MS.length - 1);
    this.cooldownUntil.set(scopeKey, now + AUTO_COMPACT_BACKOFF_TIERS_MS[tier]);
    log.warn(
      {
        scopeKey,
        consecutiveRapidRearms: next,
        cooldownMs: AUTO_COMPACT_BACKOFF_TIERS_MS[tier],
        rapidRearmWindowMs: AUTO_COMPACT_RAPID_REARM_WINDOW_MS,
      },
      'auto compact rapid re-arm detected',
    );
  }

  recordAutoCompactNextTurnIfNeeded(
    scopeKey: string,
    inputTokens: number | undefined,
    consumeWhenNotOverThreshold = true,
  ): void {
    if (this.inputTokens === undefined) return;
    if (!this.measureNextTurn.has(scopeKey)) return;
    if (inputTokens === undefined || inputTokens <= this.inputTokens) {
      if (consumeWhenNotOverThreshold) this.measureNextTurn.delete(scopeKey);
      return;
    }

    this.measureNextTurn.delete(scopeKey);
    this.nextTurnOverThreshold += 1;
    const lastSuccessAt = this.lastSuccessAt.get(scopeKey);
    const now = Date.now();
    if (lastSuccessAt !== undefined && now - lastSuccessAt < AUTO_COMPACT_RAPID_REARM_WINDOW_MS) {
      this.recordAutoCompactRapidRearm(scopeKey, lastSuccessAt, now);
    }
    log.warn(
      { scopeKey, inputTokens: inputTokens ?? 0, threshold: this.inputTokens },
      'auto compact next turn input exceeded threshold',
    );
  }

  /**
   * Remove all auto-compact bookkeeping for a scope. Mirrors the prior inline
   * cleanup (cleanupPerChatState / cleanupGlobalAutoCompactState): drops the
   * cooldown/last-success/rapid-rearm/measure/boundary entries and resolves+clears
   * any in-flight waiter and silent-compact timer. Cumulative health counters are
   * intentionally NOT reset (they track lifetime totals).
   */
  cleanupScope(scopeKey: string): void {
    this.compactBoundaryScopes.delete(scopeKey);
    this.cooldownUntil.delete(scopeKey);
    this.lastSuccessAt.delete(scopeKey);
    this.rapidRearmRecordedForSuccessAt.delete(scopeKey);
    this.consecutiveRapidRearms.delete(scopeKey);
    this.measureNextTurn.delete(scopeKey);
    this.finishAutoCompact(scopeKey);
    this.clearSilentCompact(scopeKey);
  }

  /**
   * Migrate auto-compact bookkeeping from oldKey to newKey on a JID-alias change.
   * Mirrors the prior inline per-map get/delete/set sequence exactly: only the
   * cooldown, last-success, rapid-rearm-recorded, consecutive-rapid-rearm, and
   * measure-next-turn entries move (silent-compact timers, the boundary set, and
   * in-flight waiters are intentionally left untouched, as before).
   */
  rekey(oldKey: string, newKey: string): void {
    const cooldownUntil = this.cooldownUntil.get(oldKey);
    if (cooldownUntil !== undefined) {
      this.cooldownUntil.delete(oldKey);
      this.cooldownUntil.set(newKey, cooldownUntil);
    }
    const lastSuccessAt = this.lastSuccessAt.get(oldKey);
    if (lastSuccessAt !== undefined) {
      this.lastSuccessAt.delete(oldKey);
      this.lastSuccessAt.set(newKey, lastSuccessAt);
    }
    const rapidRearmRecordedAt = this.rapidRearmRecordedForSuccessAt.get(oldKey);
    if (rapidRearmRecordedAt !== undefined) {
      this.rapidRearmRecordedForSuccessAt.delete(oldKey);
      this.rapidRearmRecordedForSuccessAt.set(newKey, rapidRearmRecordedAt);
    }
    const consecutiveRapidRearms = this.consecutiveRapidRearms.get(oldKey);
    if (consecutiveRapidRearms !== undefined) {
      this.consecutiveRapidRearms.delete(oldKey);
      this.consecutiveRapidRearms.set(newKey, consecutiveRapidRearms);
    }
    if (this.measureNextTurn.has(oldKey)) {
      this.measureNextTurn.delete(oldKey);
      this.measureNextTurn.add(newKey);
    }
  }

  /**
   * Shutdown: clear every silent-compact timer, resolve+clear every in-flight
   * waiter, and drop all per-scope bookkeeping maps. Mirrors the prior inline
   * shutdown sequence. Cumulative health counters are left intact.
   */
  shutdown(): void {
    for (const timer of this.silentCompactScopes.values()) {
      clearTimeout(timer);
    }
    this.silentCompactScopes.clear();
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.waiters.clear();
    this.compactBoundaryScopes.clear();
    this.cooldownUntil.clear();
    this.lastSuccessAt.clear();
    this.rapidRearmRecordedForSuccessAt.clear();
    this.consecutiveRapidRearms.clear();
    this.measureNextTurn.clear();
  }
}
