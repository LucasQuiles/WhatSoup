/**
 * Durable recovery-authority marker store (#2394, wired #3057).
 *
 * Each warning producer that would lose its "alert was active" flag across a
 * restart writes a marker when it emits an alert and removes it on clear.
 * On startup a producer reads the marker — if one exists and current state is
 * healthy it emits the idempotent same-source clear without the process-local
 * memory that the prior process held.
 *
 * Production consumer: ``HealthPoller`` in ``src/fleet/health-poller.ts``
 * calls ``setRecoveryMarker`` on durable alert emit, ``clearRecoveryMarker``
 * on recovery clear, and ``loadRecoveryMarkers`` in the first-poll startup
 * scan to reconcile markers left by a prior process.
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
 * Respects BOT_ERRORS_STATE_DIR for testing (see tests/lib/recovery-authority-store.test.ts),
 * otherwise mirrors the XDG_DATA_HOME pattern in keyring.ts and bot-errors-outbox.ts.
 *
 * ENV-LATE BY DESIGN (#2192 slice 3c): BOT_ERRORS_STATE_DIR's absence selects
 * the XDG default (absence is load-bearing — see the stateDir() note in
 * bot-errors-outbox.ts); XDG_DATA_HOME is OS-ambient; WHATSOUP_INSTANCE is
 * deploy-injected instance identity (systemd/launchd Environment=), never set
 * inside src, forwarded to children via the child-env allow-list. None of the
 * three can move into config without a second source of truth.
 *
 * KNOWN INCONSISTENCY (flagged, out of slice scope): this default resolves
 * under XDG .local/share/whatsoup/instances/<instance>, while
 * bot-errors-outbox.ts defaults to ~/.local/state/bot-errors — the same
 * override var lands in different fallback roots across the two readers.
 */
function state_root(): string {
  // env-allowed: lib cannot import config (ring rule); env is the sanctioned channel
  const override = process.env['BOT_ERRORS_STATE_DIR'];
  if (override) return override;
  // env-allowed: ambient OS contract (XDG dirs); absence handling load-bearing
  const base = process.env.XDG_DATA_HOME || Path.join(os.homedir(), '.local', 'share');
  // env-allowed: deploy-injected instance identity (systemd/launchd); never set in src
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
    // intentional: marker file missing or unreadable — start fresh; the
    // atomic write below re-establishes it from this call's marker alone.
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
    // intentional: marker file missing or unreadable — there is nothing to
    // clear, and writing an empty object here would clobber a concurrent set.
    return;
  }
  markers.delete(source);
  if (markers.size === 0) {
    atomicWriteMarkers(markers); // writes {} — never unlink the file.
  } else {
    atomicWriteMarkers(markers);
  }
}
