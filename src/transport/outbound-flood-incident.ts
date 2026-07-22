import { join } from 'node:path';

import { clearAlertSourceChecked, emitAlertChecked } from '../lib/emit-alert.ts';
import {
  deletePrivateFileSync,
  readPrivateFileSync,
  writePrivateJsonMarkerSync,
} from '../lib/private-fs.ts';
import type { OutboundFloodRecordResult, OutboundFloodStats } from './outbound-flood-detector.ts';

interface IncidentLogger {
  info: (context: Record<string, unknown>, message: string) => void;
  warn: ((message: string) => void) & ((context: Record<string, unknown>, message: string) => void);
}

interface OutboundFloodIncidentOptions {
  instance: string;
  stateRoot: string | null | undefined;
  log: IncidentLogger;
}

export class OutboundFloodIncidentLifecycle {
  private readonly instance: string;
  private readonly markerPath: string | null;
  private readonly log: IncidentLogger;
  private open = false;
  private restored = false;
  private openedAt = 0;

  constructor(options: OutboundFloodIncidentOptions) {
    this.instance = options.instance;
    this.markerPath = typeof options.stateRoot === 'string' && options.stateRoot.length > 0
      ? join(options.stateRoot, 'outbound-flood-incident.json')
      : null;
    this.log = options.log;
    this.restore();
  }

  emitTrip(result: OutboundFloodRecordResult, destHash: string, windowMs: number): void {
    const windowMin = Math.round(windowMs / 60_000);
    const emitted = emitAlertChecked(
      this.instance,
      'outbound_flood',
      `outbound flood: ${result.count}+ sends in ${windowMin}m to conversation ${destHash}`,
      JSON.stringify({ dest: destHash, count: result.count, windowMs }),
      'critical',
    );
    if (emitted) this.persist();
  }

  reconcile(stats: OutboundFloodStats): void {
    if (!this.open || stats.flooding) return;
    if (this.restored && Date.now() - this.openedAt <= stats.windowMs) return;

    const evidence = JSON.stringify({
      reason: 'verified_quiet_window',
      windowMs: stats.windowMs,
      threshold: stats.threshold,
      destCount: stats.destCount,
      worstCount: stats.worstCount,
    });
    if (!clearAlertSourceChecked(this.instance, 'outbound_flood', evidence)) return;

    this.open = false;
    this.restored = false;
    this.openedAt = 0;
    if (this.markerPath) {
      try {
        deletePrivateFileSync(this.markerPath, 'outbound flood incident marker');
      } catch (err) {
        this.log.warn({ err }, 'failed to delete recovered outbound flood incident marker');
      }
    }
    this.log.info(
      { windowMs: stats.windowMs, threshold: stats.threshold, destCount: stats.destCount, worstCount: stats.worstCount },
      'outbound flood recovered after verified quiet window',
    );
  }

  private persist(): void {
    const openedAt = Date.now();
    this.open = true;
    this.restored = false;
    this.openedAt = openedAt;
    if (!this.markerPath) {
      this.log.warn('outbound flood incident marker path unavailable; restart recovery is not durable');
      return;
    }
    try {
      writePrivateJsonMarkerSync(this.markerPath, {
        version: 1,
        instance: this.instance,
        source: 'outbound_flood',
        openedAt: new Date(openedAt).toISOString(),
      }, { label: 'outbound flood incident marker', directoryFsync: 'required' });
    } catch (err) {
      this.log.warn({ err }, 'failed to persist outbound flood incident marker');
    }
  }

  private restore(): void {
    if (!this.markerPath) return;
    try {
      const raw = readPrivateFileSync(this.markerPath, {
        maxBytes: 4_096,
        label: 'outbound flood incident marker',
      });
      if (raw === null) return;
      const marker = JSON.parse(raw) as Record<string, unknown>;
      const openedAt = typeof marker['openedAt'] === 'string'
        ? new Date(marker['openedAt']).getTime()
        : Number.NaN;
      if (
        marker['version'] !== 1
        || marker['instance'] !== this.instance
        || marker['source'] !== 'outbound_flood'
        || !Number.isFinite(openedAt)
      ) {
        this.log.warn('ignored invalid outbound flood incident marker');
        return;
      }
      this.open = true;
      this.restored = true;
      this.openedAt = openedAt;
    } catch (err) {
      this.log.warn({ err }, 'failed to restore outbound flood incident marker');
    }
  }
}
