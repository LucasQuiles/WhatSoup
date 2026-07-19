// src/core/startup-ping-marker.ts
// Idempotency guard for the generic startup notification (M1).
//
// Modeled on the introSent flag's persist-before-send discipline: main.ts
// persists this marker BEFORE scheduling the '*Agent back online* ✓' ping and
// clears it after a confirmed send. A fresh marker at boot therefore means a
// previous boot crashed somewhere around its own ping send — the new boot
// consumes the marker and skips its ping, so a crash loop can never stack
// duplicate back-online notices into the admin DM (the production 403-storm
// failure mode). At-most-once deliberately beats at-least-once here: a missed
// continuity ping is cosmetic, a duplicate storm is a spam-flag risk.

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readFreshMarkerSync, writePrivateJsonMarkerSync } from '../lib/private-fs.ts';

/** Stable filename of the startup-ping marker inside an instance dataRoot. */
export const STARTUP_PING_MARKER = 'startup-ping.marker';

/**
 * Freshness window. Wider than the send path needs (persist→send is ~3s) so a
 * crash-restart cycle under service-manager backoff still sees the marker, but
 * bounded so an ancient leftover cannot suppress a genuinely new boot's ping.
 */
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export interface StartupPingMarker {
  timestamp: string;
  pid: number;
}

/** Persist the intent-to-send marker (call BEFORE scheduling the ping). */
export function persistStartupPingMarker(dataRoot: string): string {
  const markerPath = join(dataRoot, STARTUP_PING_MARKER);
  writePrivateJsonMarkerSync(markerPath, {
    timestamp: new Date().toISOString(),
    pid: process.pid,
  } satisfies StartupPingMarker);
  return markerPath;
}

/**
 * Read the marker if fresh, delete it (consume-once), and return it. A stale
 * or missing marker yields null; any leftover stale file is removed so it
 * cannot suppress a later boot's ping.
 */
export function consumeStartupPingMarker(dataRoot: string, maxAgeMs?: number): StartupPingMarker | null {
  const markerPath = join(dataRoot, STARTUP_PING_MARKER);
  const marker = readFreshMarkerSync<StartupPingMarker>(markerPath, maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  try {
    unlinkSync(markerPath);
  } catch {
    // Missing or already removed — best effort.
  }
  return marker;
}

/** Remove the marker after a confirmed send (the ping is no longer in flight). */
export function clearStartupPingMarker(dataRoot: string): void {
  try {
    unlinkSync(join(dataRoot, STARTUP_PING_MARKER));
  } catch {
    // Missing — best effort.
  }
}
