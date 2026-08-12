/**
 * D3 — obligation-owned staged media retention (capability-obligation replay).
 *
 * DISTINCT from src/core/media-retention.ts (the SP7 media/tmp + cache cleanup
 * timer): that module expires TRANSIENT inbound media on a schedule; this one
 * creates and verifies DURABLE obligation-referenced copies that must outlive
 * exactly that expiry.
 *
 * Transient inbound media (media/tmp, workspace copies) has no lifetime binding
 * to a deferred obligation. This module stages a durable, content-addressed,
 * hash-verified copy BEFORE the C3 terminal transaction:
 *
 *   stat source → copy to <root>/<aa>/<sha256> via a same-directory temp file →
 *   fsync(file) → rename → fsync(parent dir) → reopen → re-hash + size verify.
 *
 * The returned identity (path, sha256, bytes, policyVersion) is what the
 * obligation row commits inside C3. Crash semantics:
 *   - crash before C3 → the staged object is an unreferenced orphan; bounded GC
 *     (`cleanupUnreferencedMedia`) may remove it only after a grace period, and
 *     the caller must invoke GC OUTSIDE any active database transaction;
 *   - crash after C3 → the committed obligation references a verified retained
 *     object; referenced objects are NEVER removed by GC.
 *
 * Dispatch re-verifies with `verifyRetainedMedia` (reopen + re-hash); `missing`
 * and `mismatch` are typed outcomes the caller maps to `blocked_media` without
 * consuming an execution attempt (D3).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { systemClock } from '../lib/clock.ts';

export interface MediaRetentionOptions {
  /** Obligation-owned retention root (never media/tmp). */
  root: string;
  /** Governing retention policy version, persisted with the obligation. */
  policyVersion: string;
}

export interface RetainedMedia {
  path: string;
  sha256: string;
  bytes: number;
  policyVersion: string;
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function fsyncPath(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Stage a durable retained copy of `sourcePath`. Throws on a missing/unreadable
 * source or any verification failure — creation must fail closed BEFORE C3, never
 * commit an unverified reference. Idempotent for identical content.
 */
export async function retainMediaForObligation(
  opts: MediaRetentionOptions,
  sourcePath: string,
): Promise<RetainedMedia> {
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile()) {
    throw new Error(`media retention: source is not a regular file: ${sourcePath}`);
  }
  const { sha256, bytes } = await hashFile(sourcePath);

  const shard = sha256.slice(0, 2);
  const destDir = join(opts.root, shard);
  const destPath = join(destDir, sha256);
  await mkdir(destDir, { recursive: true });

  // Idempotency: an existing object with the same digest and verified bytes IS
  // the retained copy.
  try {
    const existing = await hashFile(destPath);
    if (existing.sha256 === sha256 && existing.bytes === bytes) {
      return { path: destPath, sha256, bytes, policyVersion: opts.policyVersion };
    }
    // Content-addressed collision with wrong bytes = corruption; replace below.
  } catch {
    // intentional: hashFile throws only when no retained object exists at the
    // content-addressed path yet — absence simply means we stage the copy below.
  }

  // Same-directory temp so the rename is atomic on the same filesystem.
  const tempPath = join(destDir, `stage-${randomUUID()}.tmp`);
  const source = createReadStream(sourcePath);
  const destHandle = await open(tempPath, 'w');
  try {
    for await (const chunk of source) {
      await destHandle.write(chunk as Buffer);
    }
    await destHandle.sync();
  } finally {
    await destHandle.close();
  }
  try {
    await rename(tempPath, destPath);
  } catch (err) {
    await rm(tempPath, { force: true });
    throw err;
  }
  await fsyncPath(dirname(destPath));

  // Reopen + independently re-verify the retained bytes (D3: the identity the
  // obligation commits must be proven on the RETAINED object, not the source).
  const verified = await hashFile(destPath);
  if (verified.sha256 !== sha256 || verified.bytes !== bytes) {
    throw new Error('media retention: retained object failed post-copy verification');
  }
  return { path: destPath, sha256, bytes, policyVersion: opts.policyVersion };
}

export type RetainedMediaVerification = 'ok' | 'missing' | 'mismatch';

/** Reopen and re-hash the retained object. Typed outcome; never throws on content. */
export async function verifyRetainedMedia(retained: {
  path: string;
  sha256: string;
  bytes: number;
}): Promise<RetainedMediaVerification> {
  let actual: { sha256: string; bytes: number };
  try {
    actual = await hashFile(retained.path);
  } catch {
    return 'missing';
  }
  return actual.sha256 === retained.sha256 && actual.bytes === retained.bytes ? 'ok' : 'mismatch';
}

export interface CleanupOptions {
  /** Retained paths currently referenced by any obligation row. Never removed. */
  referencedPaths: ReadonlySet<string>;
  /** Minimum age (ms since mtime) before an unreferenced object may be removed. */
  graceMs: number;
}

/**
 * Bounded orphan GC. Removes only files under the retention root that are BOTH
 * unreferenced and older than the grace period. The caller guarantees this runs
 * outside any active database transaction (D3).
 */
export async function cleanupUnreferencedMedia(
  opts: MediaRetentionOptions,
  cleanup: CleanupOptions,
): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const cutoff = systemClock.now() - cleanup.graceMs;

  let shards: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    shards = await readdir(opts.root, { withFileTypes: true });
  } catch {
    return { removed }; // missing root = nothing retained
  }

  const candidates: string[] = [];
  for (const entry of shards) {
    const p = join(opts.root, entry.name);
    if (entry.isFile()) {
      candidates.push(p);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = await readdir(p, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile()) candidates.push(join(p, f.name));
    }
  }

  for (const path of candidates) {
    if (cleanup.referencedPaths.has(path)) continue;
    let info;
    try {
      info = await stat(path);
    } catch {
      continue; // vanished concurrently
    }
    if (info.mtimeMs > cutoff) continue; // inside grace period
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed };
}
