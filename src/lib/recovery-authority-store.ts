/**
 * Durable recovery-authority marker store (#2394).
 *
 * Each warning producer that would lose its "alert was active" flag across a
 * restart writes a marker when it emits an alert and removes it on clear.
 * On startup a producer reads the marker — if one exists and current state is
 * healthy it emits the idempotent same-source clear without the process-local
 * memory that the prior process held.
 *
 * Markers are stored at ``state_root() / "recovery-authority.json"`` and are
 * therefore durable across restarts but scoped to the same deployment.
 * Markers use string source keys; the values are ignored (presence = was
 * active).  The file is read once at construction and written atomically.
 */

import Path from 'node:path';
import fs from 'node:fs';
import { state_root } from './state-root.ts';

const MARKER_FILE = 'recovery-authority.json';

function markerPath(): string {
  return Path.join(state_root(), MARKER_FILE);
}

/** Restore the set of source keys that had an alert when the process died. */
export function loadRecoveryMarkers(): Set<string> {
  const path = markerPath();
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return new Set(Object.keys(raw).filter((k) => raw[k] === true));
    }
  } catch {
    // File missing or corrupt — no markers.
  }
  return new Set();
}

/** Write a marker indicating *source* has an active alert. */
export function setRecoveryMarker(source: string): void {
  const markers = new Map<string, boolean>();
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'boolean') markers.set(k, v);
      }
    }
  } catch {
    // File missing — start fresh.
  }
  markers.set(source, true);
  fs.writeFileSync(markerPath(), JSON.stringify(Object.fromEntries(markers), null, 2));
}

/** Remove a marker (alert cleared). No-op if the marker never existed. */
export function clearRecoveryMarker(source: string): void {
  const markers = new Map<string, boolean>();
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'boolean') markers.set(k, v);
      }
    }
  } catch {
    return; // Nothing to clear.
  }
  markers.delete(source);
  if (markers.size === 0) {
    try { fs.unlinkSync(markerPath()); } catch { /* ok */ }
  } else {
    fs.writeFileSync(markerPath(), JSON.stringify(Object.fromEntries(markers), null, 2));
  }
}
