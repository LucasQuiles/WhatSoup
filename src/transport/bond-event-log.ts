// src/transport/bond-event-log.ts
//
// Size-bounded, crash-recoverable storage for `<dataRoot>/bond-events.ndjson`.
//
// The live file keeps the append guarantees of appendPrivateJsonLineSync
// (O_APPEND, O_NOFOLLOW, 0600, fsync per record). This module adds rotation,
// gzip archival and bounded retention without ever copying or truncating the
// live file, and without doing compression work on the append path.
//
// On-disk names (all siblings in dataRoot; <id> = UTC stamp + random suffix,
// e.g. 20260924T010339123Z-1a2b3c4d; each new stamp is forced past the newest
// existing one, so lexical order is close order):
//   bond-events.ndjson                  live file, the only file appended to
//   bond-events.ndjson.<id>             closed segment (uncompressed, immutable)
//   bond-events.ndjson.<id>.gz.partial  compression in progress, never trusted
//   bond-events.ndjson.<id>.gz          finalized archive (verified before named)
//   bond-events.ndjson.maintenance.lock cross-process maintenance owner
// Any other name, including a matching name that is not a regular file, is
// never read, renamed or deleted by this module.
//
// State machine and durable ordering. Each arrow is one atomic filesystem step;
// every state between two steps is one that startup recovery resolves.
//
//   Rotation (synchronous, inside the append call, before the incoming record):
//     R1 rename live -> closed <id>        (records already fsynced per append)
//     R2 fsync dataRoot                     (best effort; the append below
//                                            fsyncs the directory again when it
//                                            creates the new live file)
//     R3 append incoming record             (creates live, fsync file + dir)
//   Compression (asynchronous, under the maintenance lock):
//     C1 gzip closed -> <id>.gz.partial     (O_EXCL, 0600), fsync partial
//     C2 inflate partial, compare byte count + SHA-256 with the closed segment
//     C3 rename partial -> <id>.gz, fsync dataRoot (required)
//     C4 unlink closed, fsync dataRoot (required)
//   Retention (under the same lock): when more than `retainArchives` finalized
//     archives exist, unlink the oldest finalized archives. Only an archive with
//     no closed segment and no partial beside it counts as finalized.
//
// Recovery table (grouped per <id>; runs at startup and before each pass):
//   closed only                    -> compress (C1..C4)
//   closed + partial               -> crash in C1/C2/C3-before-rename: the
//                                     partial is an unverified derivative of a
//                                     closed segment that still exists; unlink
//                                     the partial and compress again
//   closed + archive               -> crash between C3 and C4: re-verify the
//                                     archive against the closed segment; match
//                                     -> C4; mismatch -> keep BOTH, report
//   partial without closed         -> not reachable by the ordering above; keep,
//                                     report (it may be the only copy)
//   partial + archive              -> not reachable; keep, report
//   archive only                   -> finalized; eligible for retention
//   live missing                   -> crash between R1 and R3; the next append
//                                     recreates it, nothing is lost
// Recovery never deletes the only copy of any record. The only deliberate
// deletions are: a partial whose closed source is present, a closed segment
// whose archive was re-verified byte-for-byte, and the oldest finalized
// archives beyond the retention bound.

import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync, lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  appendPrivateSerializedJsonLineSync,
  assertWritablePrivateFileSync,
  deletePrivateFileSync,
  fsyncDirectory,
  fsyncDirectoryRequired,
  privateWriteError,
} from '../lib/private-fs.ts';
import { systemClock } from '../lib/clock.ts';
import { acquireProcessLock, isProcessLockError, releaseProcessLock } from '../lib/process-lock.ts';

export const BOND_EVENT_LOG_LEAF = 'bond-events.ndjson';
/** Rotate the live file before an append would take it past this size. */
export const BOND_EVENT_LOG_MAX_BYTES = 50 * 1024 * 1024;
/** Finalized gzip archives kept after rotation; older archives are unlinked. */
export const BOND_EVENT_ARCHIVE_RETAIN = 10;

const SEGMENT_ID_SOURCE = String.raw`\d{8}T\d{9}Z-[0-9a-f]{8}`;
const SEGMENT_NAME_RE = new RegExp(
  `^${BOND_EVENT_LOG_LEAF.replaceAll('.', '\\.')}\\.(${SEGMENT_ID_SOURCE})(\\.gz|\\.gz\\.partial)?$`,
);

export type BondEventLogStep =
  | 'rotation-renamed'
  | 'rotation-dir-fsynced'
  | 'partial-written'
  | 'partial-fsynced'
  | 'partial-verified'
  | 'archive-renamed'
  | 'archive-dir-fsynced'
  | 'source-unlinked'
  | 'source-dir-fsynced'
  | 'retention-unlinked';

export interface BondEventLogOptions {
  maxBytes?: number;
  retainArchives?: number;
  now?: () => Date;
  /**
   * Observation seam: called after each durable step. Tests record the order
   * of steps and throw from it to model a failure at an exact step.
   */
  observe?: (step: BondEventLogStep, segmentId: string) => void;
}

export interface BondEventAppendResult {
  rotated: boolean;
  /** Rotation failure; the record was still appended to the live file. */
  rotationError: unknown;
}

export type BondEventAnomalyReason =
  | 'partial_without_source'
  | 'partial_beside_archive'
  | 'archive_does_not_match_source'
  | 'compression_failed'
  | 'non_regular_entry';

export interface BondEventMaintenanceReport {
  status: 'idle' | 'busy' | 'completed';
  compressed: string[];
  partialsDiscarded: string[];
  sourcesRemovedAfterReverify: string[];
  retentionRemoved: string[];
  anomalies: Array<{ segmentId: string; reason: BondEventAnomalyReason }>;
  /** Closed segments still uncompressed after this pass. */
  pendingSegments: number;
}

interface SegmentGroup {
  closed: boolean;
  archive: boolean;
  partial: boolean;
  nonRegular: boolean;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function segmentStampMs(segmentId: string): number {
  const s = segmentId;
  return Date.parse(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`,
  );
}

/**
 * The stamp is forced strictly past the newest existing segment, so lexical
 * order stays close order across same-millisecond rotations, restarts and a
 * wall clock that steps backwards.
 */
function nextSegmentId(now: Date, latestSegmentId: string | undefined): string {
  let ms = now.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('bond event rotation clock returned an invalid date');
  if (latestSegmentId !== undefined) {
    const latestMs = segmentStampMs(latestSegmentId);
    if (Number.isFinite(latestMs) && ms <= latestMs) ms = latestMs + 1;
  }
  const stamp = new Date(ms).toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

function closedPath(dataRoot: string, segmentId: string): string {
  return join(dataRoot, `${BOND_EVENT_LOG_LEAF}.${segmentId}`);
}

function archivePath(dataRoot: string, segmentId: string): string {
  return `${closedPath(dataRoot, segmentId)}.gz`;
}

function partialPath(dataRoot: string, segmentId: string): string {
  return `${archivePath(dataRoot, segmentId)}.partial`;
}

/** Strict parse: only exact segment names map to a group; everything else is ignored. */
export function parseBondEventSegmentName(
  name: string,
): { segmentId: string; kind: 'closed' | 'archive' | 'partial' } | null {
  const match = SEGMENT_NAME_RE.exec(name);
  if (!match) return null;
  const kind = match[2] === '.gz' ? 'archive' : match[2] === '.gz.partial' ? 'partial' : 'closed';
  return { segmentId: match[1], kind };
}

function listSegments(dataRoot: string): Map<string, SegmentGroup> {
  const groups = new Map<string, SegmentGroup>();
  let entries;
  try {
    entries = readdirSync(dataRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return groups;
    throw err;
  }
  for (const entry of entries) {
    const parsed = parseBondEventSegmentName(entry.name);
    if (!parsed) continue;
    const group = groups.get(parsed.segmentId)
      ?? { closed: false, archive: false, partial: false, nonRegular: false };
    if (!entry.isFile()) group.nonRegular = true;
    else group[parsed.kind] = true;
    groups.set(parsed.segmentId, group);
  }
  return groups;
}

function rotateIfNeededSync(
  dataRoot: string,
  incomingBytes: number,
  maxBytes: number,
  options: BondEventLogOptions,
): boolean {
  const livePath = join(dataRoot, BOND_EVENT_LOG_LEAF);
  let size: number;
  try {
    const stat = lstatSync(livePath);
    if (!stat.isFile()) {
      throw privateWriteError('refusing to rotate a non-regular bond event log', 'EINVAL');
    }
    size = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  // An empty live file is never closed, so a record larger than maxBytes is
  // still written (alone) rather than dropped.
  if (size === 0 || size + incomingBytes <= maxBytes) return false;
  const latest = [...listSegments(dataRoot).keys()].sort().at(-1);
  const now = options.now ? options.now() : new Date(systemClock.now());
  const segmentId = nextSegmentId(now, latest);
  const target = closedPath(dataRoot, segmentId);
  // rename(2) replaces an existing target; never let it overwrite a segment.
  if (existsSync(target)) {
    throw privateWriteError('refusing to overwrite an existing bond event segment', 'EEXIST');
  }
  renameSync(livePath, target);
  options.observe?.('rotation-renamed', segmentId);
  fsyncDirectory(dataRoot);
  options.observe?.('rotation-dir-fsynced', segmentId);
  return true;
}

/**
 * Append one bond event, rotating the live file first when the record would
 * take it past `maxBytes`. A rotation failure is returned, not thrown: the
 * record is still appended to the live file so evidence is never traded for
 * the size bound. An append failure throws, exactly as appendPrivateJsonLineSync.
 */
export function appendBondEventSync(
  dataRoot: string,
  value: unknown,
  options: BondEventLogOptions = {},
): BondEventAppendResult {
  const maxBytes = positiveInteger(options.maxBytes ?? BOND_EVENT_LOG_MAX_BYTES, 'bond event log maxBytes');
  const line = JSON.stringify(value) + '\n';
  let rotated = false;
  let rotationError: unknown = null;
  try {
    rotated = rotateIfNeededSync(dataRoot, Buffer.byteLength(line, 'utf8'), maxBytes, options);
  } catch (err) {
    rotationError = err;
  }
  appendPrivateSerializedJsonLineSync(join(dataRoot, BOND_EVENT_LOG_LEAF), line);
  return { rotated, rotationError };
}

async function digestStream(
  path: string,
  inflate: boolean,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) {
      throw privateWriteError('refusing to read a non-regular bond event segment', 'EINVAL');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const source = handle.createReadStream({ autoClose: false });
    const sink = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        hash.update(chunk);
      }
    };
    if (inflate) await pipeline(source, createGunzip(), sink);
    else await pipeline(source, sink);
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function archiveMatchesSource(dataRoot: string, segmentId: string): Promise<boolean> {
  try {
    const [source, inflated] = await Promise.all([
      digestStream(closedPath(dataRoot, segmentId), false),
      digestStream(archivePath(dataRoot, segmentId), true),
    ]);
    return source.bytes === inflated.bytes && source.sha256 === inflated.sha256;
  } catch {
    // A truncated or corrupt gzip cannot prove it holds the closed segment.
    return false;
  }
}

function removeVerifiedSource(dataRoot: string, segmentId: string, options: BondEventLogOptions): void {
  unlinkSync(closedPath(dataRoot, segmentId));
  options.observe?.('source-unlinked', segmentId);
  fsyncDirectoryRequired(dataRoot);
  options.observe?.('source-dir-fsynced', segmentId);
}

async function compressSegment(dataRoot: string, segmentId: string, options: BondEventLogOptions): Promise<void> {
  const source = closedPath(dataRoot, segmentId);
  const partial = partialPath(dataRoot, segmentId);
  const archive = archivePath(dataRoot, segmentId);
  const expected = await digestStream(source, false);
  const output = await open(
    partial,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  let partialExists = true;
  try {
    try {
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        await pipeline(
          input.createReadStream({ autoClose: false }),
          createGzip(),
          async (chunks: AsyncIterable<Buffer>) => {
            for await (const chunk of chunks) {
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
                offset += bytesWritten;
              }
            }
          },
        );
      } finally {
        await input.close();
      }
      options.observe?.('partial-written', segmentId);
      await output.sync();
      options.observe?.('partial-fsynced', segmentId);
    } finally {
      await output.close();
    }
    const inflated = await digestStream(partial, true);
    if (inflated.bytes !== expected.bytes || inflated.sha256 !== expected.sha256) {
      throw privateWriteError('bond event archive does not match its closed segment', 'EIO');
    }
    options.observe?.('partial-verified', segmentId);
    assertWritablePrivateFileSync(archive, 'bond event archive');
    if (existsSync(archive)) {
      throw privateWriteError('refusing to overwrite an existing bond event archive', 'EEXIST');
    }
    renameSync(partial, archive);
    // From here the archive is the named, verified copy; a later failure must
    // leave "closed + archive" for recovery, never delete the archive.
    partialExists = false;
    options.observe?.('archive-renamed', segmentId);
    fsyncDirectoryRequired(dataRoot);
    options.observe?.('archive-dir-fsynced', segmentId);
    removeVerifiedSource(dataRoot, segmentId, options);
  } catch (err) {
    if (partialExists) {
      // The partial is a derivative of a closed segment that still exists.
      try {
        unlinkSync(partial);
      } catch {
        // intentional: the closed source still exists, so the next recovery pass discards this partial
      }
    }
    throw err;
  }
}

function emptyReport(status: BondEventMaintenanceReport['status']): BondEventMaintenanceReport {
  return {
    status,
    compressed: [],
    partialsDiscarded: [],
    sourcesRemovedAfterReverify: [],
    retentionRemoved: [],
    anomalies: [],
    pendingSegments: 0,
  };
}

function needsWork(groups: Map<string, SegmentGroup>, retain: number): boolean {
  let finalized = 0;
  for (const group of groups.values()) {
    if (group.closed || group.partial || group.nonRegular) return true;
    if (group.archive) finalized += 1;
  }
  return finalized > retain;
}

/**
 * Recover any interrupted rotation or compression, compress closed segments,
 * and apply the retention bound. Returns `idle` after a single directory read
 * when there is nothing to do, and `busy` when another process holds the
 * maintenance lock. Never throws for a single segment; per-segment problems
 * are reported as anomalies and their files are kept.
 */
export async function maintainBondEventLog(
  dataRoot: string,
  options: BondEventLogOptions = {},
): Promise<BondEventMaintenanceReport> {
  const retain = positiveInteger(options.retainArchives ?? BOND_EVENT_ARCHIVE_RETAIN, 'bond event archive retention');
  if (!needsWork(listSegments(dataRoot), retain)) return emptyReport('idle');

  let lock: ReturnType<typeof acquireProcessLock>;
  try {
    lock = acquireProcessLock(join(dataRoot, `${BOND_EVENT_LOG_LEAF}.maintenance.lock`), {
      reclaimDeadSameBoot: true,
    });
  } catch (err) {
    if (isProcessLockError(err) && err.reason === 'active') return emptyReport('busy');
    throw err;
  }
  const report = emptyReport('completed');
  try {
    const groups = listSegments(dataRoot);
    const ids = [...groups.keys()].sort();
    for (const segmentId of ids) {
      const group = groups.get(segmentId)!;
      if (group.nonRegular) {
        report.anomalies.push({ segmentId, reason: 'non_regular_entry' });
        continue;
      }
      if (group.partial) {
        if (group.closed && !group.archive) {
          deletePrivateFileSync(partialPath(dataRoot, segmentId), 'bond event partial archive');
          group.partial = false;
          report.partialsDiscarded.push(segmentId);
        } else {
          report.anomalies.push({
            segmentId,
            reason: group.archive ? 'partial_beside_archive' : 'partial_without_source',
          });
          continue;
        }
      }
      if (group.closed && group.archive) {
        if (await archiveMatchesSource(dataRoot, segmentId)) {
          removeVerifiedSource(dataRoot, segmentId, options);
          group.closed = false;
          report.sourcesRemovedAfterReverify.push(segmentId);
        } else {
          report.anomalies.push({ segmentId, reason: 'archive_does_not_match_source' });
        }
        continue;
      }
      if (group.closed) {
        try {
          await compressSegment(dataRoot, segmentId, options);
          group.closed = false;
          group.archive = true;
          report.compressed.push(segmentId);
        } catch {
          report.anomalies.push({ segmentId, reason: 'compression_failed' });
        }
      }
    }

    const finalized = ids.filter((id) => {
      const group = groups.get(id)!;
      return group.archive && !group.closed && !group.partial && !group.nonRegular;
    });
    for (const segmentId of finalized.slice(0, Math.max(0, finalized.length - retain))) {
      deletePrivateFileSync(archivePath(dataRoot, segmentId), 'bond event archive');
      options.observe?.('retention-unlinked', segmentId);
      report.retentionRemoved.push(segmentId);
    }
    report.pendingSegments = ids.filter(id => groups.get(id)!.closed).length;
    return report;
  } finally {
    releaseProcessLock(lock);
  }
}

const maintenanceRuns = new Map<string, { again: boolean; running: Promise<BondEventMaintenanceReport> }>();

/**
 * Single-flight maintenance per dataRoot within this process. A request that
 * arrives while a pass is running schedules one more pass, so a rotation that
 * lands after the running pass listed the directory is not missed.
 */
export function scheduleBondEventMaintenance(
  dataRoot: string,
  options: BondEventLogOptions = {},
): Promise<BondEventMaintenanceReport> {
  const current = maintenanceRuns.get(dataRoot);
  if (current) {
    current.again = true;
    return current.running;
  }
  const entry = { again: false, running: Promise.resolve(emptyReport('idle')) };
  entry.running = (async () => {
    try {
      let report: BondEventMaintenanceReport;
      do {
        entry.again = false;
        report = await maintainBondEventLog(dataRoot, options);
      } while (entry.again);
      return report;
    } finally {
      maintenanceRuns.delete(dataRoot);
    }
  })();
  maintenanceRuns.set(dataRoot, entry);
  return entry.running;
}
