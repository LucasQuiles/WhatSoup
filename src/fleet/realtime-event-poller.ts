// ---------------------------------------------------------------------------
//  Realtime event poller — snapshot-diff emission for WebSocket invalidation.
//
//  Maintains last-seen markers per instance and emits WS events only when
//  a marker changes. Runs on a configurable interval (default 2s).
// ---------------------------------------------------------------------------

import { createChildLogger } from '../logger.ts';
import type { FleetDiscovery } from './discovery.ts';
import type { FleetDbReader } from './db-reader.ts';
import type { FleetRealtimePublisher } from './realtime-publisher.ts';
import {
  publishMessageReceived,
  publishChatUpdated,
  publishAccessChanged,
  publishFeedEvent,
  publishTypingUpdate,
} from './realtime-publisher.ts';
import { proxyToInstance } from './http-proxy.ts';

const log = createChildLogger('fleet:realtime-poller');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstanceSnapshot {
  latestMessagePk: number | null;
  latestAccessMarker: string | null;
}

interface TypingEntry {
  instance: string;
  jid: string;
  since: number;
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
    const instances = this.deps.discovery.getInstances();

    // DB-based snapshot diffs (messages + access)
    for (const [name, inst] of instances) {
      try {
        const current = this.getSnapshot(name, inst.dbPath);
        const previous = this.snapshots.get(name);

        if (previous) {
          // Message change
          if (current.latestMessagePk !== previous.latestMessagePk) {
            publishMessageReceived(this.deps.realtime, name);
            publishChatUpdated(this.deps.realtime, name);
            publishFeedEvent(this.deps.realtime, name);
          }

          // Access change
          if (current.latestAccessMarker !== previous.latestAccessMarker) {
            publishAccessChanged(this.deps.realtime, name);
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
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getSnapshot(name: string, dbPath: string): InstanceSnapshot {
    const result = this.deps.dbReader.getLatestMarkers(name, dbPath);
    if (!result.ok) {
      return { latestMessagePk: null, latestAccessMarker: null };
    }
    return result.data;
  }

  private async pollTyping(instances: Map<string, any>): Promise<void> {
    const currentTyping = new Map<string, number>();

    const promises = Array.from(instances.values()).map(async (inst) => {
      if (!inst.healthPort) return;
      try {
        const result = await proxyToInstance(inst.healthPort, '/typing', 'GET', null, inst.healthToken, 2000);
        if (result.status !== 200) return;
        const data = JSON.parse(result.body);
        if (Array.isArray(data.composing)) {
          for (const entry of data.composing) {
            const key = `${inst.name}|${entry.jid}`;
            currentTyping.set(key, entry.since);
          }
        }
      } catch { /* skip */ }
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

    // Emit typing_update (composing=false) for entries that disappeared
    for (const [key] of this.lastTyping) {
      if (!currentTyping.has(key)) {
        const [instance, jid] = key.split('|');
        publishTypingUpdate(this.deps.realtime, instance, jid, false);
      }
    }

    this.lastTyping = currentTyping;
  }
}
