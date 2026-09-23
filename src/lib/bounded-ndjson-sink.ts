// src/lib/bounded-ndjson-sink.ts
// Bounded, append-only NDJSON sidecar writer. enqueue() is synchronous and
// never throws or blocks; all filesystem I/O runs on one async drain loop with
// at most one write in flight. Every record that is not written lands in a
// named drop counter, so gaps in the file are visible in stats().

import { mkdir, open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireProcessLock, defaultIsProcessAlive, isProcessLockError, releaseProcessLock } from './process-lock.ts';
import type { ProcessLockHandle } from './process-lock.ts';
import { systemClock } from './clock.ts';

export interface BoundedNdjsonSinkOptions {
  dir: string;
  filePrefix: string;
  maxQueue?: number;
  maxLineBytes?: number;
  flushBatch?: number;
  segmentMaxBytes?: number;
  maxSegments?: number;
  /** Receives closed reason codes only, never file contents or record text. */
  warn?: (code: string) => void;
}

export type EnqueueResult =
  | 'queued'
  | 'dropped_queue_full'
  | 'dropped_oversize'
  | 'dropped_closed'
  | 'dropped_degraded'
  | 'dropped_unserializable';

export type SinkState = 'starting' | 'ready' | 'degraded' | 'closed';

export interface BoundedNdjsonSinkStats {
  /** Admitted records not yet written or dropped, including a batch whose write is in flight. */
  queued: number;
  written: number;
  droppedQueueFull: number;
  droppedOversize: number;
  droppedClosed: number;
  droppedDegraded: number;
  /** Records discarded because the batch holding them failed to write. */
  droppedWriteFailed: number;
  droppedUnserializable: number;
  writeErrors: number;
  segmentIndex: number;
  segmentBytes: number;
}

export interface BoundedNdjsonSink {
  enqueue(record: unknown): EnqueueResult;
  state(): SinkState;
  degradedReason(): string | null;
  stats(): BoundedNdjsonSinkStats;
  /**
   * Stops admission and flushes queued records until `timeoutMs` (default 1000)
   * elapses; records still queued then count as droppedClosed. A write already
   * in flight is then awaited for up to a further 1000 ms. When it settles in
   * that window, the file handle is closed and the lock released before the
   * promise resolves, so a successor on the same dir can start immediately.
   * A write stuck beyond the window keeps the lock until it settles. Never throws.
   */
  close(timeoutMs?: number): Promise<void>;
}

const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_MAX_LINE_BYTES = 4096;
const DEFAULT_FLUSH_BATCH = 32;
const DEFAULT_SEGMENT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 32;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;
const IN_FLIGHT_SETTLE_MS = 1000;
const WRITE_WARN_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_WRITE_ERRORS = 3;
const SEGMENT_INDEX_DIGITS = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lock paths held by live sinks in this process. A lock file carrying our pid
// whose path is not in this set was left by an earlier process that had the
// same pid (a container restart with a persistent dir, or pid reuse), so it is
// treated as dead rather than as a competing writer.
const heldLockPaths = new Set<string>();

function lockHolderAlive(lockPath: string): (pid: number) => boolean {
  return (pid) => (pid === process.pid ? heldLockPaths.has(lockPath) : defaultIsProcessAlive(pid));
}

function lockFailureReason(err: unknown): string {
  if (!isProcessLockError(err)) return 'lock_failed';
  if (err.reason === 'active') return 'competing_writer';
  return err.reason === 'stale' ? 'lock_stale' : 'lock_corrupt';
}

export function createBoundedNdjsonSink(options: BoundedNdjsonSinkOptions): BoundedNdjsonSink {
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const flushBatch = Math.max(1, options.flushBatch ?? DEFAULT_FLUSH_BATCH);
  const segmentMaxBytes = options.segmentMaxBytes ?? DEFAULT_SEGMENT_MAX_BYTES;
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const { dir, filePrefix } = options;
  const lockPath = resolve(dir, `${filePrefix}.lock`);
  const segmentPattern = new RegExp(`^${escapeRegExp(filePrefix)}\\.(\\d{${SEGMENT_INDEX_DIGITS}})\\.ndjson$`);

  let current: SinkState = 'starting';
  let reason: string | null = null;
  let admissionClosed = false;
  const queue: Array<{ line: string; bytes: number }> = [];
  const counters = {
    written: 0,
    droppedQueueFull: 0,
    droppedOversize: 0,
    droppedClosed: 0,
    droppedDegraded: 0,
    droppedWriteFailed: 0,
    droppedUnserializable: 0,
    writeErrors: 0,
  };
  let segmentIndex = 0;
  let segmentBytes = 0;
  let handle: FileHandle | null = null;
  let lock: ProcessLockHandle | null = null;
  let inFlight = 0;
  let drainScheduled = false;
  let draining: Promise<void> | null = null;
  let consecutiveWriteErrors = 0;
  let lastWriteWarnAt = Number.NEGATIVE_INFINITY;
  let closePromise: Promise<void> | null = null;

  const warn = (code: string): void => {
    try {
      options.warn?.(code);
    } catch {
      // intentional: a throwing warn callback must not break the sink.
    }
  };

  const segmentPath = (index: number): string =>
    join(dir, `${filePrefix}.${String(index).padStart(SEGMENT_INDEX_DIGITS, '0')}.ndjson`);

  const closeHandle = async (): Promise<void> => {
    const h = handle;
    handle = null;
    if (!h) return;
    try {
      await h.close();
    } catch {
      // intentional: nothing further can be done with a handle that fails to close.
    }
  };

  const releaseLock = (): void => {
    const l = lock;
    lock = null;
    if (!l) return;
    process.removeListener('exit', releaseLock);
    heldLockPaths.delete(lockPath);
    try {
      releaseProcessLock(l);
    } catch {
      // intentional: release is best-effort; the payload identity check prevents deleting another writer's lock.
    }
  };

  const degrade = (why: string): void => {
    if (current === 'degraded' || current === 'closed') return;
    current = 'degraded';
    reason = why;
    counters.droppedDegraded += queue.length;
    queue.length = 0;
    warn(why);
    void closeHandle();
  };

  const scheduleDrain = (): void => {
    if (drainScheduled || draining || current !== 'ready' || queue.length === 0) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (draining || current !== 'ready') return;
      draining = drain().finally(() => {
        draining = null;
        scheduleDrain();
      });
    });
  };

  // A segment whose last byte is not "\n" ends in a partial line (a short or
  // failed earlier write); appending would fuse the next record onto it, so the
  // sink moves to the next index and leaves the old segment untouched.
  const endsMidLine = async (h: FileHandle, size: number): Promise<boolean> => {
    if (size === 0) return false;
    const tail = Buffer.alloc(1);
    const { bytesRead } = await h.read(tail, 0, 1, size - 1);
    return bytesRead !== 1 || tail[0] !== 0x0a;
  };

  /** Opens the first appendable segment at or after `index`; false when that would exceed maxSegments. */
  const openSegment = async (index: number): Promise<boolean> => {
    for (let i = index; i <= maxSegments; i += 1) {
      const h = await open(segmentPath(i), 'a+', 0o600);
      try {
        const { size } = await h.stat();
        if (await endsMidLine(h, size)) {
          await h.close();
          continue;
        }
        handle = h;
        segmentIndex = i;
        segmentBytes = size;
        return true;
      } catch (err) {
        await h.close().catch(() => undefined);
        throw err;
      }
    }
    return false;
  };

  const takeBatch = (): { lines: string[]; bytes: number; rotate: boolean } => {
    const lines: string[] = [];
    let bytes = 0;
    while (lines.length < flushBatch && lines.length < queue.length) {
      const next = queue[lines.length]!;
      if (segmentBytes + bytes + next.bytes > segmentMaxBytes) {
        // An empty segment always takes at least one line, so rotation cannot loop.
        if (lines.length === 0 && segmentBytes > 0) return { lines, bytes, rotate: true };
        if (lines.length > 0) break;
      }
      lines.push(next.line);
      bytes += next.bytes;
    }
    return { lines, bytes, rotate: false };
  };

  const drain = async (): Promise<void> => {
    while (current === 'ready' && queue.length > 0) {
      let batch = takeBatch();
      if (batch.rotate) {
        if (segmentIndex + 1 > maxSegments) {
          degrade('segment_cap_reached');
          return;
        }
        await closeHandle();
        segmentIndex += 1;
        segmentBytes = 0;
        // A close() that landed during the handle close must not open a new, empty segment.
        if (current !== 'ready') return;
        batch = takeBatch();
        if (batch.lines.length === 0) continue;
      }
      queue.splice(0, batch.lines.length);
      // In-flight records stay visible in stats().queued until they are counted as written or dropped.
      inFlight = batch.lines.length;
      let ok = true;
      let capped = false;
      try {
        if (!handle && !(await openSegment(segmentIndex))) {
          capped = true;
        } else {
          await handle!.writeFile(batch.lines.join(''), 'utf8');
        }
      } catch {
        ok = false;
      }
      inFlight = 0;
      if (capped) {
        counters.droppedDegraded += batch.lines.length;
        degrade('segment_cap_reached');
        return;
      }
      if (ok) {
        segmentBytes += batch.bytes;
        counters.written += batch.lines.length;
        consecutiveWriteErrors = 0;
      } else {
        counters.writeErrors += 1;
        counters.droppedWriteFailed += batch.lines.length;
        consecutiveWriteErrors += 1;
        await closeHandle();
        const now = systemClock.now();
        if (now - lastWriteWarnAt >= WRITE_WARN_INTERVAL_MS) {
          lastWriteWarnAt = now;
          warn('write_failed');
        }
        if (consecutiveWriteErrors >= MAX_CONSECUTIVE_WRITE_ERRORS) {
          degrade('write_failed');
          return;
        }
      }
    }
  };

  const resumeIndex = async (): Promise<number> => {
    let highest = 0;
    for (const name of await readdir(dir)) {
      const m = segmentPattern.exec(name);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    if (highest === 0) return 1;
    let size = 0;
    try {
      size = (await stat(segmentPath(highest))).size;
    } catch {
      // intentional: an unreadable highest segment is surfaced by the first write attempt.
    }
    return size < segmentMaxBytes ? highest : highest + 1;
  };

  const start = async (): Promise<void> => {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      degrade('mkdir_failed');
      return;
    }
    // close() may have finished during mkdir; acquiring now would leak the lock.
    if (current !== 'starting') return;
    try {
      lock = acquireProcessLock(lockPath, { reclaimDeadSameBoot: true, isProcessAlive: lockHolderAlive(lockPath) });
    } catch (err) {
      degrade(lockFailureReason(err));
      return;
    }
    heldLockPaths.add(lockPath);
    // Production never calls close(); release synchronously on exit so a
    // successor with the same pid does not see its own stale lock.
    process.once('exit', releaseLock);
    let index: number;
    try {
      index = await resumeIndex();
    } catch {
      degrade('readdir_failed');
      return;
    }
    // A close() that ran during the listing already released the lock.
    if (current !== 'starting') return;
    if (index > maxSegments) {
      degrade('segment_cap_reached');
      return;
    }
    segmentIndex = index;
    segmentBytes = 0;
    current = 'ready';
    scheduleDrain();
  };

  const starting = start().catch(() => {
    degrade('start_failed');
  });

  const enqueue = (record: unknown): EnqueueResult => {
    try {
      if (admissionClosed || current === 'closed') {
        counters.droppedClosed += 1;
        return 'dropped_closed';
      }
      if (current === 'degraded') {
        counters.droppedDegraded += 1;
        return 'dropped_degraded';
      }
      let line: string | undefined;
      try {
        line = JSON.stringify(record);
      } catch {
        line = undefined;
      }
      if (typeof line !== 'string') {
        counters.droppedUnserializable += 1;
        return 'dropped_unserializable';
      }
      line += '\n';
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > maxLineBytes) {
        counters.droppedOversize += 1;
        return 'dropped_oversize';
      }
      if (queue.length >= maxQueue) {
        counters.droppedQueueFull += 1;
        return 'dropped_queue_full';
      }
      queue.push({ line, bytes });
      scheduleDrain();
      return 'queued';
    } catch {
      counters.droppedUnserializable += 1;
      return 'dropped_unserializable';
    }
  };

  const close = (timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<void> => {
    if (closePromise) return closePromise;
    admissionClosed = true;
    closePromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs));
        timer.unref?.();
      });
      const flushed = (async () => {
        await starting;
        while (current === 'ready' && (queue.length > 0 || draining)) {
          if (draining) {
            await draining;
          } else {
            draining = drain().finally(() => {
              draining = null;
            });
          }
        }
      })();
      try {
        await Promise.race([flushed, deadline]);
      } catch {
        // intentional: close() never throws; unflushed records are counted below.
      } finally {
        if (timer) clearTimeout(timer);
      }
      counters.droppedClosed += queue.length;
      queue.length = 0;
      current = 'closed';
      const inFlightWrite = draining;
      if (inFlightWrite) {
        let settled = false;
        let settleTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          inFlightWrite.then(() => { settled = true; }, () => { settled = true; }),
          new Promise<void>((resolve) => {
            settleTimer = setTimeout(resolve, IN_FLIGHT_SETTLE_MS);
            settleTimer.unref?.();
          }),
        ]);
        if (settleTimer) clearTimeout(settleTimer);
        if (!settled) {
          // A write stuck past the settle bound keeps the lock until it settles,
          // so a successor cannot interleave with it.
          void inFlightWrite.finally(async () => {
            await closeHandle();
            releaseLock();
          });
          return;
        }
      }
      await closeHandle();
      releaseLock();
    })();
    return closePromise;
  };

  return {
    enqueue,
    state: () => current,
    degradedReason: () => reason,
    stats: () => ({
      queued: queue.length + inFlight,
      ...counters,
      segmentIndex,
      segmentBytes,
    }),
    close,
  };
}
