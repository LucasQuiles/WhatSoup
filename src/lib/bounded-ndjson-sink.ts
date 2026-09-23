// src/lib/bounded-ndjson-sink.ts
// Bounded, append-only NDJSON sidecar writer. enqueue() is synchronous and
// never throws or blocks; all filesystem I/O runs on one async drain loop with
// at most one write in flight. Every record that is not written lands in a
// named drop counter, so gaps in the file are visible in stats().

import { mkdir, open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock, isProcessLockError, releaseProcessLock } from './process-lock.ts';
import type { ProcessLockHandle } from './process-lock.ts';

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
  close(timeoutMs?: number): Promise<void>;
}

const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_MAX_LINE_BYTES = 4096;
const DEFAULT_FLUSH_BATCH = 32;
const DEFAULT_SEGMENT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 32;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;
const WRITE_WARN_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_WRITE_ERRORS = 3;
const SEGMENT_INDEX_DIGITS = 6;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const lockPath = join(dir, `${filePrefix}.lock`);
  const segmentPattern = new RegExp(`^${escapeRegExp(filePrefix)}\\.(\\d{${SEGMENT_INDEX_DIGITS}})\\.ndjson$`);

  let current: SinkState = 'starting';
  let reason: string | null = null;
  let admissionClosed = false;
  const queue: string[] = [];
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
  let drainScheduled = false;
  let draining: Promise<void> | null = null;
  let consecutiveWriteErrors = 0;
  let lastWriteWarnAt = Number.NEGATIVE_INFINITY;
  let closePromise: Promise<void> | null = null;

  const warn = (code: string): void => {
    try {
      options.warn?.(code);
    } catch {
      // A throwing warn callback must not break the sink.
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
      // Nothing further can be done with a handle that fails to close.
    }
  };

  const releaseLock = (): void => {
    const l = lock;
    lock = null;
    if (!l) return;
    try {
      releaseProcessLock(l);
    } catch {
      // Release is best-effort; the payload identity check prevents deleting another writer's lock.
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

  const openSegment = async (index: number): Promise<void> => {
    const h = await open(segmentPath(index), 'a', 0o600);
    try {
      const { size } = await h.stat();
      handle = h;
      segmentIndex = index;
      segmentBytes = size;
    } catch (err) {
      await h.close().catch(() => undefined);
      throw err;
    }
  };

  const takeBatch = (): { lines: string[]; bytes: number; rotate: boolean } => {
    const lines: string[] = [];
    let bytes = 0;
    while (lines.length < flushBatch && lines.length < queue.length) {
      const lineBytes = Buffer.byteLength(queue[lines.length]!, 'utf8');
      if (segmentBytes + bytes + lineBytes > segmentMaxBytes) {
        // An empty segment always takes at least one line, so rotation cannot loop.
        if (lines.length === 0 && segmentBytes > 0) return { lines, bytes, rotate: true };
        if (lines.length > 0) break;
      }
      lines.push(queue[lines.length]!);
      bytes += lineBytes;
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
        batch = takeBatch();
      }
      queue.splice(0, batch.lines.length);
      try {
        if (!handle) await openSegment(segmentIndex);
        await handle!.writeFile(batch.lines.join(''), 'utf8');
        segmentBytes += batch.bytes;
        counters.written += batch.lines.length;
        consecutiveWriteErrors = 0;
      } catch {
        counters.writeErrors += 1;
        counters.droppedWriteFailed += batch.lines.length;
        consecutiveWriteErrors += 1;
        await closeHandle();
        const now = Date.now();
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
      // An unreadable highest segment is surfaced by the first write attempt.
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
      lock = acquireProcessLock(lockPath, { reclaimDeadSameBoot: true });
    } catch (err) {
      degrade(lockFailureReason(err));
      return;
    }
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
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        counters.droppedOversize += 1;
        return 'dropped_oversize';
      }
      if (queue.length >= maxQueue) {
        counters.droppedQueueFull += 1;
        return 'dropped_queue_full';
      }
      queue.push(line);
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
        // close() never throws.
      } finally {
        if (timer) clearTimeout(timer);
      }
      counters.droppedClosed += queue.length;
      queue.length = 0;
      current = 'closed';
      if (draining) {
        // A write still in flight past the deadline keeps the lock until it settles.
        void draining.finally(async () => {
          await closeHandle();
          releaseLock();
        });
      } else {
        await closeHandle();
        releaseLock();
      }
    })();
    return closePromise;
  };

  return {
    enqueue,
    state: () => current,
    degradedReason: () => reason,
    stats: () => ({
      queued: queue.length,
      ...counters,
      segmentIndex,
      segmentBytes,
    }),
    close,
  };
}
