// ---------------------------------------------------------------------------
//  Realtime event poller — snapshot-diff emission for WebSocket invalidation.
//
//  Maintains last-seen markers per instance and emits WS events only when
//  a marker changes. Runs on a configurable interval (default 2s).
// ---------------------------------------------------------------------------

import { statSync } from 'node:fs';
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
// FleetRealtimeEventPoller
// ---------------------------------------------------------------------------

export class FleetRealtimeEventPoller {
  private deps: RealtimeEventPollerDeps;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshots = new Map<string, InstanceSnapshot>();
  private lastTyping = new Map<string, number>(); // key: `instance|jid` → since
  private polling = false;

  constructor(deps: RealtimeEventPollerDeps, intervalMs = 2000) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
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
    log.info('realtime poller stopped');
  }

  /** Single poll cycle — compare snapshots and emit diffs. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const instances = this.deps.discovery.getInstances();

      for (const [name, inst] of instances) {
        try {
          const dbSnapshot = this.getSnapshot(name, inst.dbPath);
          const previous = this.snapshots.get(name);

          // Re-scan each cycle so pino-roll rotation to a newer numbered file is observed.
          const logMtime = this.getLogMtime(inst.logDir, previous?.lastLogPath ?? null);
          const current: InstanceSnapshot = {
            ...dbSnapshot,
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
          // Instance DB unavailable — skip
        }
      }

      const discoveredNames = new Set(instances.keys());
      for (const name of this.snapshots.keys()) {
        if (!discoveredNames.has(name)) {
          this.snapshots.delete(name);
        }
      }

      // Typing indicators via health proxy
      await this.pollTyping(instances);
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getSnapshot(name: string, dbPath: string): { latestMessageMarker: string | null; latestAccessMarker: string | null } {
    const result = this.deps.dbReader.getLatestMarkers(name, dbPath);
    if (!result.ok) {
      return { latestMessageMarker: null, latestAccessMarker: null };
    }
    return {
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

  private async pollTyping(instances: Map<string, any>): Promise<void> {
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
      } catch { /* skip — instance stays unobserved */ }
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
  }
}
