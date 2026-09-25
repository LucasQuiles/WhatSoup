// ---------------------------------------------------------------------------
//  Realtime event poller — snapshot-diff emission for WebSocket invalidation.
//
//  Maintains last-seen markers per instance and emits WS events only when
//  a marker changes. Runs on a configurable interval (default 2s).
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createChildLogger } from '../logger.ts';
import type { FleetDiscovery } from './discovery.ts';
import type { FleetDbReader } from './db-reader.ts';
import type { FleetRealtimePublisher } from './realtime-publisher.ts';
import {
  publishMessageReceived,
  publishChatUpdated,
  publishAccessChanged,
  publishLogChanged,
  publishFeedEvent,
  publishTypingUpdate,
} from './realtime-publisher.ts';
import { proxyToInstance } from './http-proxy.ts';
import { findLatestLogFile } from './log-utils.ts';
import { isTypingHealthEntry } from './typing-payload.ts';

const log = createChildLogger('fleet:realtime-poller');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstanceSnapshot {
  latestMessageMarker: string | null;
  latestAccessMarker: string | null;
  latestLogMtime: number | null;
  lastLogPath: string | null;
}

export interface RealtimeEventPollerDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
  realtime: FleetRealtimePublisher;
}

// ---------------------------------------------------------------------------
// Cycle/coverage observability (#2522)
// ---------------------------------------------------------------------------

export type RealtimePollerLifecycle =
  | 'stopped'
  | 'starting'
  | 'current'
  | 'partial'
  | 'late'
  | 'stalled'
  | 'failed';

/** Bounded aggregate projection: counts, ages, and lifecycle only — never
 * instance names, paths, or per-source detail (those stay diagnostic-only). */
export interface RealtimePollerHealthSnapshot {
  schemaVersion: 1;
  generation: string | null;
  lifecycle: RealtimePollerLifecycle;
  cycleSequence: number;
  inFlightAgeMs: number | null;
  lastCompletedAgeMs: number | null;
  lastFullyObservedAgeMs: number | null;
  lastRecoveredAgeMs: number | null;
  durationBucket: 'under_interval' | 'over_interval' | 'over_budget' | null;
  scheduledTicks: number;
  completedCycles: number;
  skippedOverlaps: number;
  consecutiveFailedCycles: number;
  expectedSources: number;
  observedSources: number;
  unavailableSources: number;
}

export interface RealtimePollerOptions {
  /** Monotonic clock; injectable for deterministic tests. */
  monotonicNow?: () => number;
  /** Completed-cycle age beyond which an armed poller reads `late` (default 3× interval). */
  lateBudgetMs?: number;
  /** In-flight cycle age beyond which the poller reads `stalled` (default 5× interval). */
  stalledBudgetMs?: number;
}

// ---------------------------------------------------------------------------
// FleetRealtimeEventPoller
// ---------------------------------------------------------------------------

export class FleetRealtimeEventPoller {
  private deps: RealtimeEventPollerDeps;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots = new Map<string, InstanceSnapshot>();
  private lastTyping = new Map<string, number>(); // key: `instance|jid` → since
  private polling = false;
  private readonly monotonicNow: () => number;
  private readonly lateBudgetMs: number;
  private readonly stalledBudgetMs: number;
  // #2522 cycle/coverage accounting. `lifecycleBase` holds only settled states;
  // `late`/`stalled` are DERIVED at snapshot time from monotonic ages so no
  // extra timers exist to themselves stall.
  private generation: string | null = null;
  private lifecycleBase: 'stopped' | 'starting' | 'current' | 'partial' | 'failed' = 'stopped';
  private cycleSequence = 0;
  private cycleStartedAtMs: number | null = null;
  private lastCompletedAtMs: number | null = null;
  private lastFullyObservedAtMs: number | null = null;
  private lastRecoveredAtMs: number | null = null;
  private lastDurationMs: number | null = null;
  private scheduledTicks = 0;
  private completedCycles = 0;
  private skippedOverlaps = 0;
  private consecutiveFailedCycles = 0;
  private lastExpectedSources = 0;
  private lastObservedSources = 0;
  // Set by a failure episode; cleared only by a FULLY observed completion,
  // which is the recovery proof (a partial completion clears the consecutive
  // counter but must not claim recovery).
  private recoveryPending = false;

  constructor(deps: RealtimeEventPollerDeps, intervalMs = 2000, options: RealtimePollerOptions = {}) {
    this.deps = deps;
    this.intervalMs = intervalMs;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.lateBudgetMs = options.lateBudgetMs ?? intervalMs * 3;
    this.stalledBudgetMs = options.stalledBudgetMs ?? intervalMs * 5;
  }

  start(): void {
    if (this.timer) return;
    // A fresh generation per start (#2522): restart proof requires a
    // post-restart fully observed cycle under the NEW generation, never the
    // mere existence of the timer.
    this.generation = randomUUID();
    this.lifecycleBase = 'starting';
    this.cycleSequence = 0;
    this.scheduledTicks = 0;
    this.completedCycles = 0;
    this.skippedOverlaps = 0;
    // Prior-generation observation state must not leak into the new generation
    // (restart proof requires a post-restart cycle, #3286 review finding A) —
    // but the failure episode is NOT cleared here: only a completed cycle under
    // the new generation may clear it (item 9).
    this.cycleStartedAtMs = null;
    this.lastCompletedAtMs = null;
    this.lastFullyObservedAtMs = null;
    this.lastRecoveredAtMs = null;
    this.lastDurationMs = null;
    this.lastExpectedSources = 0;
    this.lastObservedSources = 0;
    this.timer = setInterval(() => {
      this.poll().catch((err) => log.warn({ err }, 'realtime poll error'));
    }, this.intervalMs);
    log.info({ intervalMs: this.intervalMs }, 'realtime poller started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.snapshots.clear();
    this.lastTyping.clear();
    this.lifecycleBase = 'stopped';
    // Lifecycle receipt (#2522): bounded counters only.
    log.info(
      {
        completedCycles: this.completedCycles,
        skippedOverlaps: this.skippedOverlaps,
        consecutiveFailedCycles: this.consecutiveFailedCycles,
      },
      'realtime poller stopped',
    );
  }

  /** Aggregate cycle/coverage projection (#2522). Read-only: `late`/`stalled`
   * are derived here from monotonic ages, so reading never mutates state. */
  healthSnapshot(): RealtimePollerHealthSnapshot {
    const now = this.monotonicNow();
    const age = (mark: number | null): number | null => (mark === null ? null : Math.max(0, Math.round(now - mark)));
    const inFlightAgeMs = this.polling ? age(this.cycleStartedAtMs) : null;
    let lifecycle: RealtimePollerLifecycle = this.lifecycleBase;
    if (this.polling && inFlightAgeMs !== null && inFlightAgeMs > this.stalledBudgetMs) {
      lifecycle = 'stalled';
    } else if (
      this.timer !== null &&
      !this.polling &&
      this.lastCompletedAtMs !== null &&
      (age(this.lastCompletedAtMs) ?? 0) > this.lateBudgetMs &&
      this.lifecycleBase !== 'failed'
    ) {
      lifecycle = 'late';
    }
    let durationBucket: RealtimePollerHealthSnapshot['durationBucket'] = null;
    if (this.lastDurationMs !== null) {
      if (this.lastDurationMs <= this.intervalMs) durationBucket = 'under_interval';
      else if (this.lastDurationMs <= this.intervalMs * 3) durationBucket = 'over_interval';
      else durationBucket = 'over_budget';
    }
    return {
      schemaVersion: 1,
      generation: this.generation,
      lifecycle,
      cycleSequence: this.cycleSequence,
      inFlightAgeMs,
      lastCompletedAgeMs: age(this.lastCompletedAtMs),
      lastFullyObservedAgeMs: age(this.lastFullyObservedAtMs),
      lastRecoveredAgeMs: age(this.lastRecoveredAtMs),
      durationBucket,
      scheduledTicks: this.scheduledTicks,
      completedCycles: this.completedCycles,
      skippedOverlaps: this.skippedOverlaps,
      consecutiveFailedCycles: this.consecutiveFailedCycles,
      expectedSources: this.lastExpectedSources,
      observedSources: this.lastObservedSources,
      unavailableSources: Math.max(0, this.lastExpectedSources - this.lastObservedSources),
    };
  }

  /** Single poll cycle — compare snapshots and emit diffs. */
  async poll(): Promise<void> {
    this.scheduledTicks += 1;
    if (this.polling) {
      // Skipped overlap is a receipt, not a silent return (#2522).
      this.skippedOverlaps += 1;
      return;
    }
    this.polling = true;
    this.cycleSequence += 1;
    this.cycleStartedAtMs = this.monotonicNow();
    const cycleGeneration = this.generation;
    let expectedSources = 0;
    let observedSources = 0;
    try {
      const instances = this.deps.discovery.getInstances();

      for (const [name, inst] of instances) {
        expectedSources += 1;
        try {
          const dbSnapshot = this.getSnapshot(name, inst.dbPath);
          if (!dbSnapshot.available) continue; // #2520 preserve prior snapshot on read failure
          observedSources += 1;

          const previous = this.snapshots.get(name);

          // Re-scan each cycle so pino-roll rotation to a newer numbered file is observed.
          const logMtime = this.getLogMtime(inst.logDir, previous?.lastLogPath ?? null);
          const current: InstanceSnapshot = {
            latestMessageMarker: dbSnapshot.latestMessageMarker,
            latestAccessMarker: dbSnapshot.latestAccessMarker,
            latestLogMtime: logMtime?.mtimeMs ?? previous?.latestLogMtime ?? null,
            lastLogPath: logMtime?.path ?? previous?.lastLogPath ?? null,
          };

          if (previous) {
            if (current.latestMessageMarker !== previous.latestMessageMarker) {
              publishMessageReceived(this.deps.realtime, name);
              publishChatUpdated(this.deps.realtime, name);
              publishFeedEvent(this.deps.realtime, name);
            }
            if (current.latestAccessMarker !== previous.latestAccessMarker) {
              publishAccessChanged(this.deps.realtime, name);
              publishFeedEvent(this.deps.realtime, name);
            }
            // A log change is either a newer mtime OR a rotation to a different
            // active file. pino-roll can rotate to a new numbered file that lands
            // on an identical mtimeMs (coarse FS granularity / same-tick rotation);
            // an mtime-only predicate would silently miss it and the dashboard
            // would go stale (#1086). The path-change clause closes that gap.
            if (
              current.latestLogMtime !== null &&
              (current.latestLogMtime !== previous.latestLogMtime ||
                current.lastLogPath !== previous.lastLogPath)
            ) {
              publishLogChanged(this.deps.realtime, name);
              publishFeedEvent(this.deps.realtime, name);
            }
          }

          this.snapshots.set(name, current);
        } catch {
          // intentional: instance DB unavailable — this poll cycle skips the
          // instance and the PREVIOUS snapshot is preserved (#2520), so a
          // transient read failure cannot publish spurious change events.
        }
      }

      const discoveredNames = new Set(instances.keys());
      for (const name of this.snapshots.keys()) {
        if (!discoveredNames.has(name)) {
          this.snapshots.delete(name);
        }
      }

      // Typing indicators via health proxy
      const typingCoverage = await this.pollTyping(instances);
      expectedSources += typingCoverage.expected;
      observedSources += typingCoverage.observed;

      // Cycle completion (#2522): a cycle completes only after every scheduled
      // source has a terminal outcome; fully observed and partial stay distinct.
      // An obsolete cycle — the poller was stopped or restarted while this one
      // was in flight — must not publish a completion (#3286 review finding B):
      // its generation no longer owns the lifecycle, and stop()'s clears are
      // reasserted instead.
      // "Obsolete" means the poller was STOPPED or RESTARTED while this cycle
      // was in flight — never a manual poll on a never-started poller (both
      // generations null), which keeps the legacy diff-and-publish behavior.
      const obsolete =
        cycleGeneration !== this.generation ||
        (cycleGeneration !== null && this.lifecycleBase === 'stopped');
      if (obsolete) {
        this.snapshots.clear();
        this.lastTyping.clear();
        return;
      }
      const now = this.monotonicNow();
      this.lastDurationMs = Math.max(0, Math.round(now - (this.cycleStartedAtMs ?? now)));
      this.lastCompletedAtMs = now;
      this.completedCycles += 1;
      this.lastExpectedSources = expectedSources;
      this.lastObservedSources = observedSources;
      const fullyObserved = observedSources === expectedSources;
      // A completed cycle proves the loop runs again and clears the failure
      // counter; the RECOVERY mark additionally requires full observation
      // (item 7: a partial observation must not overstate "recovered").
      this.consecutiveFailedCycles = 0;
      if (this.recoveryPending && fullyObserved) {
        this.lastRecoveredAtMs = now;
        this.recoveryPending = false;
      }
      if (fullyObserved && this.generation !== null) {
        this.lastFullyObservedAtMs = now;
        this.lifecycleBase = 'current';
      } else if (this.generation !== null) {
        this.lifecycleBase = 'partial';
      }
    } catch (err) {
      // A thrown cycle is a bounded failure receipt, never a bare disappearance —
      // unless the cycle is obsolete (stopped/restarted mid-flight), which may
      // not resurrect a lifecycle it no longer owns.
      const failureObsolete =
        cycleGeneration !== this.generation ||
        (cycleGeneration !== null && this.lifecycleBase === 'stopped');
      if (!failureObsolete) {
        this.consecutiveFailedCycles += 1;
        this.recoveryPending = true;
        if (this.generation !== null) this.lifecycleBase = 'failed';
      }
      throw err;
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the current snapshot for `name`, or a sentinel indicating the
   * database was unavailable (#2520). The caller preserves the previous
   * snapshot and emits no domain events when unavailable.
   */
  private getSnapshot(name: string, dbPath: string): { available: false } | { available: true; latestMessageMarker: string | null; latestAccessMarker: string | null } {
    const result = this.deps.dbReader.getLatestMarkers(name, dbPath);
    if (!result.ok) {
      return { available: false };
    }
    return {
      available: true,
      latestMessageMarker: result.data.latestMessageMarker
        ?? (result.data.latestMessagePk == null ? null : `pk:${result.data.latestMessagePk}`),
      latestAccessMarker: result.data.latestAccessMarker,
    };
  }

  /** Find the latest log file, falling back to the cached path for transient scan misses. */
  private getLogMtime(logDir: string, cachedPath: string | null): { path: string; mtimeMs: number } | null {
    const latest = findLatestLogFile(logDir);
    if (latest) return latest;

    if (cachedPath) {
      try { return { path: cachedPath, mtimeMs: statSync(cachedPath).mtimeMs }; } catch { /* cached file gone */ }
    }
    return null;
  }

  private async pollTyping(instances: Map<string, any>): Promise<{ expected: number; observed: number }> {
    const currentTyping = new Map<string, number>();
    // #2137: failure-to-observe and observed-empty are different states. A probe
    // that times out or returns non-200 tells us nothing about that instance's
    // typing set, but the old code let its absence from `currentTyping` look
    // identical to "the instance reported nobody is typing" — publishing a false
    // `composing: false` for every prior key and then overwriting `lastTyping`
    // with the partial map. Only instances that answered are eligible to have
    // their entries retired.
    const observed = new Set<string>();

    const promises = Array.from(instances.values()).map(async (inst) => {
      if (!inst.healthPort) return;
      try {
        const result = await proxyToInstance(inst.healthPort, '/typing', 'GET', null, inst.healthToken, 2000);
        if (result.status !== 200) return;
        const data = JSON.parse(result.body);
        // Marked observed only after a parseable 200: a body that throws below
        // is as uninformative as a timeout.
        observed.add(inst.name);
        if (Array.isArray(data.composing)) {
          for (const entry of data.composing) {
            if (!isTypingHealthEntry(entry)) continue;
            const key = `${inst.name}|${entry.jid.trim()}`;
            currentTyping.set(key, entry.since);
          }
        }
      } catch { /* intentional: one unreachable instance simply stays unobserved for this poll cycle */ }
    });

    await Promise.all(promises);

    // Emit typing_update for new/changed entries
    for (const [key, since] of currentTyping) {
      const prevSince = this.lastTyping.get(key);
      if (prevSince !== since) {
        const [instance, jid] = key.split('|');
        publishTypingUpdate(this.deps.realtime, instance, jid, true);
      }
    }

    // Emit typing_update (composing=false) for entries that disappeared — but
    // only for instances we actually heard from this cycle (#2137).
    const next = new Map(currentTyping);
    for (const [key, since] of this.lastTyping) {
      if (currentTyping.has(key)) continue;
      // Split on the FIRST separator: the instance name is the prefix, and a JID
      // may legitimately contain further ones.
      const sep = key.indexOf('|');
      const instance = key.slice(0, sep);
      if (!observed.has(instance)) {
        // Unobserved: make no claim either way, and carry the prior entry
        // forward so the next successful probe compares against real history
        // instead of an empty map. An instance that has left the fleet is NOT
        // carried — it can never be observed again, and holding its keys would
        // leak them forever.
        if (instances.has(instance)) next.set(key, since);
        else publishTypingUpdate(this.deps.realtime, instance, key.slice(sep + 1), false);
        continue;
      }
      publishTypingUpdate(this.deps.realtime, instance, key.slice(sep + 1), false);
    }

    this.lastTyping = next;

    const expected = Array.from(instances.values()).filter((inst) => Boolean(inst.healthPort)).length;
    return { expected, observed: observed.size };
  }
}
