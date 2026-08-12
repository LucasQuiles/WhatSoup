/**
 * D3 — obligation-owned staged media retention (capability-obligation replay).
 *
 * Filesystem copy + fsync happen BEFORE the C3 transaction: stat → content-
 * addressed staged copy → fsync file + parent → reopen → size/sha256 verify.
 * A crash before C3 leaves only an unreferenced staged orphan, removable by
 * bounded GC after a grace period; a committed obligation references a verified
 * retained object that is never GC'd while referenced. Dispatch re-verifies by
 * reopening and re-hashing; missing/mismatched bytes are typed outcomes, never
 * exceptions swallowed into a dispatch.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupUnreferencedMedia,
  retainMediaForObligation,
  verifyRetainedMedia,
} from '../../src/core/obligation-media-retention.ts';

let dir: string;
let root: string;

const OPTS = () => ({ root, policyVersion: 'test-policy/1' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'media-retention-'));
  root = join(dir, 'retained');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeSource(name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('retainMediaForObligation', () => {
  it('copies, verifies, and returns the content-addressed identity', async () => {
    const content = Buffer.from('webm-bytes-0123456789');
    const src = makeSource('clip.webm', content);
    const retained = await retainMediaForObligation(OPTS(), src);
    expect(retained.sha256).toBe(sha256(content));
    expect(retained.bytes).toBe(content.length);
    expect(retained.policyVersion).toBe('test-policy/1');
    expect(retained.path.startsWith(root)).toBe(true);
    expect(readFileSync(retained.path)).toEqual(content);
    // Content-addressed: the digest is embedded in the path.
    expect(retained.path).toContain(retained.sha256);
  });

  it('is idempotent for identical content (same retained identity, no duplicate)', async () => {
    const content = Buffer.from('same-bytes');
    const a = await retainMediaForObligation(OPTS(), makeSource('a.ogg', content));
    const b = await retainMediaForObligation(OPTS(), makeSource('b.ogg', content));
    expect(b.path).toBe(a.path);
    expect(b.sha256).toBe(a.sha256);
  });

  it('fails closed when the source is missing', async () => {
    await expect(retainMediaForObligation(OPTS(), join(dir, 'nope.bin'))).rejects.toThrow();
  });

  it('the retained copy is independent of the source (source eviction is harmless)', async () => {
    const content = Buffer.from('evictable');
    const src = makeSource('tmp.ogg', content);
    const retained = await retainMediaForObligation(OPTS(), src);
    rmSync(src);
    expect(await verifyRetainedMedia(retained)).toBe('ok');
  });
});

describe('verifyRetainedMedia', () => {
  it('returns ok for intact bytes', async () => {
    const retained = await retainMediaForObligation(OPTS(), makeSource('x.bin', 'intact'));
    expect(await verifyRetainedMedia(retained)).toBe('ok');
  });

  it('returns missing when the retained object is gone', async () => {
    const retained = await retainMediaForObligation(OPTS(), makeSource('x.bin', 'gone'));
    rmSync(retained.path);
    expect(await verifyRetainedMedia(retained)).toBe('missing');
  });

  it('returns mismatch on corrupted bytes', async () => {
    const retained = await retainMediaForObligation(OPTS(), makeSource('x.bin', 'orig-bytes'));
    writeFileSync(retained.path, 'corrupted!');
    expect(await verifyRetainedMedia(retained)).toBe('mismatch');
  });

  it('returns mismatch on a size-preserving byte flip', async () => {
    const content = Buffer.from('abcdefgh');
    const retained = await retainMediaForObligation(OPTS(), makeSource('x.bin', content));
    const flipped = Buffer.from(content);
    flipped[0] = flipped[0]! ^ 0xff;
    writeFileSync(retained.path, flipped);
    expect(await verifyRetainedMedia(retained)).toBe('mismatch');
  });
});

describe('cleanupUnreferencedMedia — bounded orphan GC', () => {
  const AGE = 60_000; // grace period for tests

  async function allRetainedFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(p);
      }
    };
    await walk(root);
    return out;
  }

  function ageFile(p: string, ms: number): void {
    const past = new Date(Date.now() - ms);
    utimesSync(p, past, past);
  }

  it('never removes referenced objects, regardless of age', async () => {
    const retained = await retainMediaForObligation(OPTS(), makeSource('keep.bin', 'keep'));
    ageFile(retained.path, AGE * 10);
    const res = await cleanupUnreferencedMedia(OPTS(), {
      referencedPaths: new Set([retained.path]),
      graceMs: AGE,
    });
    expect(res.removed).toEqual([]);
    expect(await verifyRetainedMedia(retained)).toBe('ok');
  });

  it('removes unreferenced orphans only after the grace period', async () => {
    const orphan = await retainMediaForObligation(OPTS(), makeSource('orphan.bin', 'orphan'));
    // Young orphan: protected by grace.
    const young = await cleanupUnreferencedMedia(OPTS(), { referencedPaths: new Set(), graceMs: AGE });
    expect(young.removed).toEqual([]);
    // Aged orphan: removed.
    ageFile(orphan.path, AGE * 2);
    const aged = await cleanupUnreferencedMedia(OPTS(), { referencedPaths: new Set(), graceMs: AGE });
    expect(aged.removed).toEqual([orphan.path]);
    expect(await allRetainedFiles()).toEqual([]);
  });

  it('a partial staging temp file (simulated crash mid-copy) is GC-able after grace', async () => {
    // Simulate the torn write: a .tmp file under the root that no obligation references.
    await retainMediaForObligation(OPTS(), makeSource('real.bin', 'real'));
    const torn = join(root, 'stage-partial.tmp');
    writeFileSync(torn, 'partial');
    ageFile(torn, AGE * 2);
    const res = await cleanupUnreferencedMedia(OPTS(), {
      referencedPaths: new Set((await allRetainedFiles()).filter((p) => !p.endsWith('.tmp'))),
      graceMs: AGE,
    });
    expect(res.removed).toEqual([torn]);
  });

  it('an empty or missing root is a no-op', async () => {
    const res = await cleanupUnreferencedMedia(OPTS(), { referencedPaths: new Set(), graceMs: AGE });
    expect(res.removed).toEqual([]);
  });
});
