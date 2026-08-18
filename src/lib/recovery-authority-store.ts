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
 * ONE DURABLE FILE PER MARKER (redesign 2026-08-17). Markers previously shared a
 * single ``recovery-authority.json`` object, so every mutation was a
 * read-modify-write of that one file and had to serialise through one process
 * lock. With 16 distinct marker keys mutating concurrently that lock starved
 * deterministically: 15 writers succeeded and one failed with
 * ProcessLockError('active') on every run, because the lock is poll-based with
 * no FIFO or anti-starvation guarantee. The keys are independent, so the shared
 * file was imposing false sharing.
 *
 * Each marker is now its own file under ``state_root() / recovery-authority.d /``.
 * Presence is the truth (as before, values are not interpreted). ``set`` is a
 * single atomic temp-file + rename and ``clear`` is a single unlink — both are
 * atomic filesystem operations on a path no other key touches, so the
 * read-modify-write disappears and with it the need for a lock. Distinct keys
 * can no longer contend at all.
 *
 * The only remaining lock is transitional: while a pre-redesign
 * ``recovery-authority.json`` still exists, that aggregate file IS shared state
 * and clears against it still need the old serialisation. Once migrated the file
 * is gone and the lock is never taken again.
 */
import Path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createChildLogger } from '../logger.ts';
import {
  forceEnsurePrivateDirectorySync,
  writePrivateJsonMarkerSync,
} from './private-fs.ts';
import {
  acquireProcessLock,
  isProcessLockError,
  releaseProcessLock,
  type ProcessLockHandle,
} from './process-lock.ts';

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

/** Pre-redesign aggregate file. Read for migration only; never written anew. */
const LEGACY_MARKER_FILE = 'recovery-authority.json';
const MARKER_DIR = 'recovery-authority.d';
const MARKER_SUFFIX = '.json';
/** Only used while a legacy aggregate file still exists (see module header). */
const RECOVERY_AUTHORITY_LOCK_WAIT_MS = 500;
const RECOVERY_AUTHORITY_LOCK_POLL_MS = 10;
/**
 * Filesystem components are capped at 255 bytes on both ext4 and APFS. Real keys
 * are `<source>:<botName>` and encode to well under this; the guard exists so an
 * over-long key fails loudly at the boundary instead of producing ENAMETOOLONG
 * from inside the atomic writer.
 */
const MAX_MARKER_FILENAME_BYTES = 255;
const log = createChildLogger('recovery-authority-store');

function legacyMarkerPath(): string {
  return Path.join(state_root(), LEGACY_MARKER_FILE);
}

function markerDirPath(): string {
  return Path.join(state_root(), MARKER_DIR);
}

/**
 * Percent-encode every byte outside `[A-Za-z0-9_-]`.
 *
 * encodeURIComponent alone is NOT sufficient here: it leaves `.`, `!`, `~`, `*`,
 * `'` and `()` unescaped, so a key could produce `.` or `..`, or collide with the
 * `.lock` / `.tmp` suffixes the atomic writer and process lock use. Escaping the
 * remainder makes every encoded name match /^[A-Za-z0-9_%-]+$/, which cannot be a
 * relative-path component and cannot collide with those suffixes.
 * decodeURIComponent reverses it exactly, so enumeration round-trips.
 */
function encodeMarkerKey(source: string): string {
  return encodeURIComponent(source).replace(
    /[.!~*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function decodeMarkerKey(encoded: string): string {
  return decodeURIComponent(encoded);
}

function markerFilePath(source: string): string {
  const name = encodeMarkerKey(source) + MARKER_SUFFIX;
  if (Buffer.byteLength(name, 'utf8') > MAX_MARKER_FILENAME_BYTES) {
    throw new RangeError(
      `recovery marker key encodes to ${Buffer.byteLength(name, 'utf8')} bytes, ` +
        `exceeding the ${MAX_MARKER_FILENAME_BYTES}-byte filename limit`,
    );
  }
  return Path.join(markerDirPath(), name);
}

/** Parse markers from an already-read JSON object, returning truthy-key set. */
function parseMarkerJson(raw: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(raw).filter((k) => raw[k] === true));
}

/**
 * Read the legacy aggregate file.
 *
 * Returns null when the file EXISTS but cannot be parsed — distinct from an empty
 * set, so migration can refuse to delete bytes it could not interpret. A missing
 * file (the normal post-migration state) is an empty set.
 */
function readLegacyMarkersStrict(): Set<string> | null {
  const path = legacyMarkerPath();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path, 'utf-8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return parseMarkerJson(raw as Record<string, unknown>);
    }
    // Readable but wrong shape (e.g. an array): no markers, and safe to migrate away.
    return new Set();
  } catch {
    if (fs.existsSync(path)) {
      log.warn('corrupt legacy marker file, treating as empty');
      return null;
    }
    return new Set();
  }
}

/** Legacy markers for union reads. Missing or corrupt both read as empty. */
function readLegacyMarkers(): Set<string> {
  return readLegacyMarkersStrict() ?? new Set();
}

/**
 * Enumerate per-marker files.
 *
 * A single unreadable or undecodable entry is skipped with a warning rather than
 * zeroing the whole set. Under the old single-file layout one corrupt file
 * legitimately meant "no markers", because that file WAS the whole state; with a
 * directory it would silently discard every other producer's marker, which is a
 * far worse failure than dropping one.
 */
function readMarkerDirectory(): Set<string> {
  const dir = markerDirPath();
  const markers = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return markers; // missing directory = no markers (normal on first run)
  }
  for (const entry of entries) {
    if (!entry.endsWith(MARKER_SUFFIX)) continue;
    const encoded = entry.slice(0, -MARKER_SUFFIX.length);
    try {
      markers.add(decodeMarkerKey(encoded));
    } catch {
      log.warn({ reason: 'undecodable_marker_name' }, 'skipping unreadable recovery marker entry');
    }
  }
  return markers;
}

/**
 * Fold any legacy aggregate file into per-marker files, then remove it.
 *
 * Holds the legacy lock for the whole conversion so a concurrent clear cannot
 * interleave (see clearRecoveryMarker). Best-effort: any failure leaves the
 * legacy file in place, and callers still see its markers because reads union
 * both planes.
 */
function migrateLegacyMarkers(): void {
  const legacyPath = legacyMarkerPath();
  if (!fs.existsSync(legacyPath)) return;
  // Parse BEFORE taking the lock: a corrupt file can never be migrated, so there is
  // nothing to serialise against, and paying the lock on every read would be waste.
  // Corrupt bytes are left in place for forensics rather than deleted — the
  // pre-redesign store preserved them too.
  if (readLegacyMarkersStrict() === null) return;

  let lock: ProcessLockHandle;
  try {
    lock = acquireProcessLock(`${legacyPath}.lock`, {
      reclaimDeadSameBoot: true,
      wait: { timeoutMs: RECOVERY_AUTHORITY_LOCK_WAIT_MS, pollMs: RECOVERY_AUTHORITY_LOCK_POLL_MS },
    });
  } catch {
    // Another process is migrating or mutating; its migration is as good as ours.
    return;
  }

  try {
    if (!fs.existsSync(legacyPath)) return; // migrated while we waited
    const legacy = readLegacyMarkersStrict();
    if (legacy === null) return; // became unreadable under us; never delete it
    forceEnsurePrivateDirectorySync(markerDirPath(), 'recovery authority state');
    for (const source of legacy) {
      const file = markerFilePath(source);
      if (!fs.existsSync(file)) {
        writePrivateJsonMarkerSync(file, markerPayload(source), {
          label: 'recovery authority marker',
        });
      }
    }
    fs.unlinkSync(legacyPath);
    log.info({ migrated: legacy.size }, 'migrated legacy recovery markers to per-marker files');
  } catch (error) {
    log.warn(
      { reason: 'legacy_migration_failed', code: mutationErrorCode(error) },
      'legacy recovery marker migration failed; reads still union both planes',
    );
  } finally {
    try {
      releaseProcessLock(lock);
    } catch (error) {
      // A failed release must not fail a best-effort migration, but it must not be
      // silent either: the lock file is now stale and the next acquirer pays the
      // reclaim path, so an operator needs the signal.
      log.warn(
        { reason: 'legacy_lock_release_failed', code: mutationErrorCode(error) },
        'could not release the legacy recovery marker lock after migration',
      );
    }
  }
}

function markerPayload(source: string): Record<string, unknown> {
  return { source, setAt: new Date().toISOString() };
}

/**
 * Restore the set of source keys that had an alert when the process died.
 *
 * Unions the per-marker directory with any legacy aggregate file so no marker is
 * lost across the upgrade, and opportunistically migrates the legacy file — the
 * startup scan is the natural one-time moment. Migration is best-effort and can
 * never make this function throw; callers treat it as infallible.
 */
export function loadRecoveryMarkers(): Set<string> {
  try {
    migrateLegacyMarkers();
  } catch (error) {
    // Migration is opportunistic and must never break a read, but swallowing this
    // silently would hide a permanently stuck upgrade: reads keep unioning both
    // planes and look correct while the legacy file never goes away.
    log.warn(
      { reason: 'legacy_migration_unavailable', code: mutationErrorCode(error) },
      'legacy recovery marker migration threw; continuing with a union read',
    );
  }
  const markers = readMarkerDirectory();
  for (const source of readLegacyMarkers()) markers.add(source);
  return markers;
}

function mutationErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? 'unknown')
    : 'unknown';
}

function logMutationFailure(operation: 'set' | 'clear', startedAtMs: number, error: unknown): void {
  log.warn({
    operation,
    reason: 'mutation_failed',
    code: mutationErrorCode(error),
    elapsedMs: Math.round(performance.now() - startedAtMs),
  }, 'recovery authority mutation failed');
}

/** Write a marker indicating *source* has an active alert. */
export function setRecoveryMarker(source: string): void {
  const startedAtMs = performance.now();
  try {
    forceEnsurePrivateDirectorySync(markerDirPath(), 'recovery authority state');
    // Atomic temp-file + rename on a path unique to this key. Two processes
    // setting the same key converge on "present", which is the intended meaning;
    // distinct keys never touch the same path, so no lock is required.
    writePrivateJsonMarkerSync(markerFilePath(source), markerPayload(source), {
      label: 'recovery authority marker',
    });
  } catch (error) {
    logMutationFailure('set', startedAtMs, error);
    throw error;
  }
}

/**
 * Remove a marker indicating *source* no longer has an active alert.
 *
 * MIGRATION RACE (closed deliberately): if a legacy aggregate file still exists,
 * the key may live only there. Unlinking the per-marker file would then be a
 * no-op, and a concurrent migration could afterwards materialise the key from the
 * legacy file — resurrecting a marker that was just cleared. So while the legacy
 * file exists this takes the legacy lock, which migration also holds, and removes
 * the key from BOTH planes under it. The per-marker unlink happens after the lock
 * is held so migration cannot re-add the key behind it. Once migration has
 * completed the file is gone, the fast path applies, and no lock is ever taken.
 */
export function clearRecoveryMarker(source: string): void {
  const startedAtMs = performance.now();
  const legacyPath = legacyMarkerPath();

  if (!fs.existsSync(legacyPath)) {
    // Steady state. If the legacy file is absent, any migration already finished
    // (it unlinks the aggregate last), so nothing can re-create this key.
    try {
      unlinkMarkerFile(source);
    } catch (error) {
      logMutationFailure('clear', startedAtMs, error);
      throw error;
    }
    return;
  }

  let lock: ProcessLockHandle;
  try {
    lock = acquireProcessLock(`${legacyPath}.lock`, {
      reclaimDeadSameBoot: true,
      wait: { timeoutMs: RECOVERY_AUTHORITY_LOCK_WAIT_MS, pollMs: RECOVERY_AUTHORITY_LOCK_POLL_MS },
    });
  } catch (error) {
    const reason = isProcessLockError(error)
      ? (error.reason === 'active' ? 'lock_timeout' : `lock_${error.reason}`)
      : 'lock_unavailable';
    log.warn({
      operation: 'clear',
      reason,
      elapsedMs: Math.round(performance.now() - startedAtMs),
    }, 'recovery authority mutation not accepted');
    throw error;
  }

  let mutationFailed = false;
  try {
    unlinkMarkerFile(source);
    if (fs.existsSync(legacyPath)) {
      const remaining = readLegacyMarkers();
      if (remaining.delete(source)) {
        writePrivateJsonMarkerSync(
          legacyPath,
          Object.fromEntries([...remaining].map((k) => [k, true])),
          { label: 'recovery authority markers' },
        );
      }
    }
  } catch (error) {
    mutationFailed = true;
    logMutationFailure('clear', startedAtMs, error);
    throw error;
  } finally {
    try {
      if (!releaseProcessLock(lock)) {
        log.error({
          operation: 'clear',
          reason: 'lock_release_lost_ownership',
          elapsedMs: Math.round(performance.now() - startedAtMs),
        }, 'recovery authority lock release lost ownership');
      }
    } catch (error) {
      log.error({
        operation: 'clear',
        reason: 'lock_release_failed',
        code: mutationErrorCode(error),
        elapsedMs: Math.round(performance.now() - startedAtMs),
      }, 'recovery authority lock release failed');
      if (!mutationFailed) throw error;
    }
  }
}

/** Unlink one marker file. A missing file is success — clear is idempotent. */
function unlinkMarkerFile(source: string): void {
  try {
    fs.unlinkSync(markerFilePath(source));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
