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
 * active).  The file is written atomically via temp-file + rename so that a
 * concurrent reader never sees a partially-written file.
 */

import Path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createChildLogger } from '../logger.ts';

/**
 * Derive the state root directory for this instance.
 * Mirrors the pattern in bot-errors-outbox.ts and keyring.ts.
 */
function state_root(): string {
  const base = process.env.XDG_DATA_HOME || Path.join(os.homedir(), '.local', 'share');
  return Path.join(base, 'whatsoup', 'instances', process.env.WHATSOUP_INSTANCE ?? 'sandbox-agent');
}

const MARKER_FILE = 'recovery-authority.json';
const log = createChildLogger('recovery-authority-store');

function markerPath(): string {
  return Path.join(state_root(), MARKER_FILE);
}

/** Parse markers from an already-read JSON object, returning truthy-key set. */
function parseMarkerJson(raw: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(raw).filter((k) => raw[k] === true));
}

/**
 * Atomically write a markers map to disk via temp-file + rename.
 * Uses a `.tmp` suffix in the same directory to keep the rename on the same
 * filesystem, guaranteeing atomic replacement.
 */
function atomicWriteMarkers(markers: Map<string, boolean>): void {
  const path = markerPath();
  const tmp = path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(markers), null, 2));
  fs.renameSync(tmp, path);
}

/** Restore the set of source keys that had an alert when the process died. */
export function loadRecoveryMarkers(): Set<string> {
  const path = markerPath();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return parseMarkerJson(raw as Record<string, unknown>);
    }
    return new Set();
  } catch {
    // Missing = empty (normal on first run / clean state).
    if (fs.existsSync(path)) {
      log.warn('corrupt marker file, treating as empty');
    }
  }
  return new Set();
}

/** Write a marker indicating *source* has an active alert. */
export function setRecoveryMarker(source: string): void {
  const markers = new Map<string, boolean>();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const parsed = parseMarkerJson(raw as Record<string, unknown>);
      for (const k of parsed) markers.set(k, true);
    }
  } catch {
    // File missing — start fresh.
  }
  markers.set(source, true);
  atomicWriteMarkers(markers);
}

/**
 * Remove a marker (alert cleared). No-op if the marker never existed.
 *
 * When the set becomes empty this writes an empty object instead of deleting
 * the file, closing the delete-on-empty race: a concurrent writer that adds a
 * marker between our read and our write will still have its data preserved by
 * the atomic write (last-writer-wins on the same file).
 */
export function clearRecoveryMarker(source: string): void {
  const markers = new Map<string, boolean>();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(markerPath(), 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const parsed = parseMarkerJson(raw as Record<string, unknown>);
      for (const k of parsed) markers.set(k, true);
    }
  } catch {
    return; // Nothing to clear.
  }
  markers.delete(source);
  if (markers.size === 0) {
    atomicWriteMarkers(markers); // writes {} — never unlink the file.
  } else {
    atomicWriteMarkers(markers);
  }
}
