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
import { ContextGaugeStore } from './context-gauge.ts';

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
// #3523: consecutive-rapid-rearm ceiling. Once a scope has re-armed auto-compact
// this many times in a row without effect, /compact is proven unable to bring the
// context back under threshold (a compaction livelock). Re-arming a (K+1)th
// /compact would loop forever, so the runtime stops looping and escalates — for
// resident '::scheduled-agent-job' scopes, to a hard session reset (fresh
// session_id + dropped resumable checkpoint) rather than another ineffective
// compact. Reuses the existing consecutiveRapidRearms counter; not a parallel one.
export const AUTO_COMPACT_CONVERGENCE_LIMIT = 3;
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
  /**
   * #3717: scope → the rapid-rearm backoff currently in force (deadline + tier).
   * Kept apart from consecutiveRapidRearms, which is a retained streak that
   * survives a later successful compact so the next rapid re-arm escalates a
   * tier. A success replaces the backoff with the ordinary success cooldown and
   * removes this entry; health reports backoff only while an entry is unexpired.
   */
  readonly rapidRearmBackoff = new Map<string, { until: number; tier: number }>();
  /** Scopes to measure on their next turn for post-compact effectiveness. */
  readonly measureNextTurn = new Set<string>();
  /**
   * #3523 layer 1 (iteration 1): scope → count of consecutive compactions that
   * did NOT converge. A compaction is non-convergent when the FIRST auto-compact
   * eligibility evaluation after it still finds inputSinceCompact at or above the
   * threshold — i.e. the compact ran and the context did not shrink below the
   * trigger point. Unlike consecutiveRapidRearms this counter measures
   * compaction effectiveness directly and is INDEPENDENT of inter-turn timing,
   * so it accumulates at any cadence (the incident in #3523 re-fired every ~30
   * minutes, always outside AUTO_COMPACT_RAPID_REARM_WINDOW_MS, so the
   * rapid-rearm counter was deleted every cycle and could never reach the limit).
   */
  readonly consecutiveNonConvergentCompactions = new Map<string, number>();
  /**
   * Scope → the lastSuccessAt epoch whose convergence verdict has already been
   * recorded. Exactly ONE verdict per compaction: the first post-compaction
   * evaluation decides it, so ordinary productive turns later in the same
   * compaction epoch cannot increment the streak.
   */
  readonly compactionOutcomeRecordedForCompactAt = new Map<string, number>();
  /** Scope → in-flight auto-compact waiter (promise + resolve + timeout timer). */
  readonly waiters = new Map<string, AutoCompactWaiter>();
  /** #3717c: per-scope, per-generation context of the last distinct request. */
  readonly contextGauge = new ContextGaugeStore();

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
    for (const { until, tier } of this.rapidRearmBackoff.values()) {
      if (!Number.isFinite(until) || until <= now) continue;
      activeBackoffScopes += 1;
      worstCurrentBackoffTier = Math.max(worstCurrentBackoffTier, tier);
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
    // #3717: the success cooldown supersedes any rapid-rearm backoff. The streak
    // in consecutiveRapidRearms is kept so a rapid re-arm of THIS compact still
    // escalates to the next tier.
    this.rapidRearmBackoff.delete(scopeKey);
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
    this.rapidRearmBackoff.set(scopeKey, { until: now + AUTO_COMPACT_BACKOFF_TIERS_MS[tier], tier });
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

  /**
   * #3523 layer 1 (iteration 1): record the convergence verdict of the most
   * recent successful compaction for a scope, at the FIRST auto-compact
   * eligibility evaluation that follows it.
   *
   * `stillOverThreshold` is the trigger's own `inputSinceCompact >= threshold`
   * measurement taken against the post-compaction baseline. True means the
   * compaction did not bring the context back under the trigger point — the
   * livelock signal. False means it did, and the streak is cleared.
   *
   * Deduped on `compactedAt` so exactly one verdict is recorded per compaction:
   * an ordinary productive turn that crosses the threshold LATER in the same
   * compaction epoch cannot increment the streak, because that epoch's verdict
   * was already taken (and, if the compaction converged, the streak was cleared).
   * A single productive turn that happens to be over threshold on the very next
   * turn does increment by one; escalation still needs
   * AUTO_COMPACT_CONVERGENCE_LIMIT consecutive non-convergent compactions.
   */
  recordCompactionOutcome(scopeKey: string, compactedAt: number, stillOverThreshold: boolean): void {
    if (this.compactionOutcomeRecordedForCompactAt.get(scopeKey) === compactedAt) return;
    this.compactionOutcomeRecordedForCompactAt.set(scopeKey, compactedAt);
    if (!stillOverThreshold) {
      this.consecutiveNonConvergentCompactions.delete(scopeKey);
      return;
    }
    const next = (this.consecutiveNonConvergentCompactions.get(scopeKey) ?? 0) + 1;
    this.consecutiveNonConvergentCompactions.set(scopeKey, next);
    log.warn(
      { scopeKey, consecutiveNonConvergentCompactions: next, compactedAt },
      'auto compact did not converge — context still over threshold on the first turn after the compact',
    );
  }

  /**
   * True once a scope has run AUTO_COMPACT_CONVERGENCE_LIMIT consecutive
   * non-convergent compactions: /compact is proven unable to shrink this
   * context, so arming another one loops forever.
   */
  isCompactionNonConvergent(scopeKey: string): boolean {
    return (this.consecutiveNonConvergentCompactions.get(scopeKey) ?? 0)
      >= AUTO_COMPACT_CONVERGENCE_LIMIT;
  }

  /**
   * #3717c P4: `contextTokens` is the context gauge (undefined = unknown, which
   * records nothing). `summedInputTokens` is the turn's summed usage, logged only.
   */
  recordAutoCompactNextTurnIfNeeded(
    scopeKey: string,
    contextTokens: number | undefined,
    consumeWhenNotOverThreshold = true,
    summedInputTokens?: number,
  ): void {
    if (this.inputTokens === undefined) return;
    if (!this.measureNextTurn.has(scopeKey)) return;
    if (contextTokens === undefined || contextTokens <= this.inputTokens) {
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
      {
        scopeKey,
        contextTokens,
        summedInputTokens: summedInputTokens ?? null,
        threshold: this.inputTokens,
        crossed: 'context',
      },
      'auto compact next turn context exceeded threshold',
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
    this.rapidRearmBackoff.delete(scopeKey);
    this.consecutiveNonConvergentCompactions.delete(scopeKey);
    this.compactionOutcomeRecordedForCompactAt.delete(scopeKey);
    this.measureNextTurn.delete(scopeKey);
    this.contextGauge.delete(scopeKey);
    this.finishAutoCompact(scopeKey);
    this.clearSilentCompact(scopeKey);
  }

  /**
   * Migrate auto-compact bookkeeping from oldKey to newKey on a JID-alias change.
   * Mirrors the prior inline per-map get/delete/set sequence exactly: only the
   * cooldown, last-success, rapid-rearm-recorded, consecutive-rapid-rearm,
   * rapid-rearm-backoff, and measure-next-turn entries move (silent-compact timers, the boundary set, and
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
    const backoff = this.rapidRearmBackoff.get(oldKey);
    if (backoff !== undefined) {
      this.rapidRearmBackoff.delete(oldKey);
      this.rapidRearmBackoff.set(newKey, backoff);
    }
    // #3523 layer 1: the non-convergence streak and its per-compaction dedupe
    // travel with the scope for the same reason the rapid-rearm counter does —
    // a JID-alias rekey is the same conversation, not a fresh context.
    const nonConvergent = this.consecutiveNonConvergentCompactions.get(oldKey);
    if (nonConvergent !== undefined) {
      this.consecutiveNonConvergentCompactions.delete(oldKey);
      this.consecutiveNonConvergentCompactions.set(newKey, nonConvergent);
    }
    const outcomeRecordedAt = this.compactionOutcomeRecordedForCompactAt.get(oldKey);
    if (outcomeRecordedAt !== undefined) {
      this.compactionOutcomeRecordedForCompactAt.delete(oldKey);
      this.compactionOutcomeRecordedForCompactAt.set(newKey, outcomeRecordedAt);
    }
    if (this.measureNextTurn.has(oldKey)) {
      this.measureNextTurn.delete(oldKey);
      this.measureNextTurn.add(newKey);
    }
    // #3717c: the context gauge is the same conversation's context; it moves too.
    this.contextGauge.rekey(oldKey, newKey);
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
    this.rapidRearmBackoff.clear();
    this.consecutiveNonConvergentCompactions.clear();
    this.compactionOutcomeRecordedForCompactAt.clear();
    this.measureNextTurn.clear();
    this.contextGauge.clear();
  }
}
