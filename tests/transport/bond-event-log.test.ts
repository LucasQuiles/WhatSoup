import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOND_EVENT_LOG_LEAF,
  appendBondEventSync,
  maintainBondEventLog,
  parseBondEventSegmentName,
  scheduleBondEventMaintenance,
  type BondEventLogStep,
} from '../../src/transport/bond-event-log.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bond-event-log-test-'));
  roots.push(root);
  return root;
}

const LIVE = BOND_EVENT_LOG_LEAF;
const ID_A = '20260924T010000000Z-0000000a';
const ID_B = '20260924T010000001Z-0000000b';

function event(n: number, pad = 60): { n: number; pad: string } {
  return { n, pad: 'x'.repeat(pad) };
}

function lineOf(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

function recordsIn(text: string): number[] {
  return text.split('\n').filter(Boolean).map(line => (JSON.parse(line) as { n: number }).n);
}

function names(root: string): string[] {
  return readdirSync(root).sort();
}

function archives(root: string): string[] {
  return names(root).filter(name => parseBondEventSegmentName(name)?.kind === 'archive');
}

function closedSegments(root: string): string[] {
  return names(root).filter(name => parseBondEventSegmentName(name)?.kind === 'closed');
}

/** Every record across archives (oldest first) and the live file, in order. */
function allRecords(root: string): number[] {
  const fromArchives = archives(root).flatMap(name =>
    recordsIn(gunzipSync(readFileSync(join(root, name))).toString('utf8')));
  const livePath = join(root, LIVE);
  const fromLive = existsSync(livePath) ? recordsIn(readFileSync(livePath, 'utf8')) : [];
  return [...fromArchives, ...fromLive];
}

function writeSegment(root: string, name: string, data: string | Buffer): void {
  writeFileSync(join(root, name), data, { mode: 0o600 });
}

describe('appendBondEventSync rotation', () => {
  it('rotates only when the next record would pass maxBytes, never at exactly the limit', () => {
    const root = makeRoot();
    const size = Buffer.byteLength(lineOf(event(1)));
    const maxBytes = size * 2;

    expect(appendBondEventSync(root, event(1), { maxBytes })).toEqual({ rotated: false, rotationError: null });
    expect(appendBondEventSync(root, event(2), { maxBytes })).toEqual({ rotated: false, rotationError: null });
    expect(readFileSync(join(root, LIVE)).length).toBe(maxBytes);
    expect(closedSegments(root)).toEqual([]);

    expect(appendBondEventSync(root, event(3), { maxBytes })).toEqual({ rotated: true, rotationError: null });
    const [closed] = closedSegments(root);
    expect(recordsIn(readFileSync(join(root, closed), 'utf8'))).toEqual([1, 2]);
    expect(recordsIn(readFileSync(join(root, LIVE), 'utf8'))).toEqual([3]);
  });

  it('writes a record larger than maxBytes alone instead of dropping it', () => {
    const root = makeRoot();
    expect(appendBondEventSync(root, event(1, 500), { maxBytes: 100 }).rotated).toBe(false);
    expect(recordsIn(readFileSync(join(root, LIVE), 'utf8'))).toEqual([1]);
    expect(appendBondEventSync(root, event(2), { maxBytes: 100 }).rotated).toBe(true);
    expect(recordsIn(readFileSync(join(root, LIVE), 'utf8'))).toEqual([2]);
  });

  it('names closed segments so lexical order is close order, even for a repeated or backwards clock', () => {
    const root = makeRoot();
    // One stamp per rotation: normal, repeated millisecond, clock stepped back, later.
    const stamps = [
      '2026-09-24T01:00:00.000Z',
      '2026-09-24T01:00:00.000Z',
      '2026-09-24T00:59:00.000Z',
      '2026-09-24T02:00:00.000Z',
    ];
    appendBondEventSync(root, event(0), { maxBytes: 50 });
    stamps.forEach((stamp, index) => {
      expect(appendBondEventSync(root, event(index + 1), { maxBytes: 50, now: () => new Date(stamp) }).rotated).toBe(true);
    });
    const closed = closedSegments(root);
    expect(closed.map(name => parseBondEventSegmentName(name)?.segmentId.slice(0, 19))).toEqual([
      '20260924T010000000Z',
      '20260924T010000001Z',
      '20260924T010000002Z',
      '20260924T020000000Z',
    ]);
    expect(closed.flatMap(name => recordsIn(readFileSync(join(root, name), 'utf8')))).toEqual([0, 1, 2, 3]);
  });

  it('still appends the record when rotation fails, and reports the rotation error', () => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 50 });
    const result = appendBondEventSync(root, event(2), {
      maxBytes: 50,
      now: () => { throw new Error('clock unavailable'); },
    });
    expect(result.rotated).toBe(false);
    expect(String(result.rotationError)).toMatch(/clock unavailable/);
    expect(recordsIn(readFileSync(join(root, LIVE), 'utf8'))).toEqual([1, 2]);
    expect(closedSegments(root)).toEqual([]);
  });

  it('throws when the live path cannot be appended, so the caller can log it', () => {
    const root = makeRoot();
    const outside = join(makeRoot(), 'outside.ndjson');
    writeFileSync(outside, '');
    symlinkSync(outside, join(root, LIVE));
    expect(() => appendBondEventSync(root, event(1), { maxBytes: 50 })).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('');
  });
});

describe('maintainBondEventLog', () => {
  it('returns idle after one directory read when there is nothing to do, including a missing root', async () => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 1_000 });
    expect((await maintainBondEventLog(root)).status).toBe('idle');
    expect((await maintainBondEventLog(join(root, 'missing'))).status).toBe('idle');
    expect(names(root)).toEqual([LIVE]);
  });

  it('round-trips every record exactly once through rotation and gzip', async () => {
    const root = makeRoot();
    const written: number[] = [];
    for (let n = 0; n < 40; n++) {
      appendBondEventSync(root, event(n), { maxBytes: 300 });
      written.push(n);
    }
    expect(closedSegments(root).length).toBeGreaterThan(5);

    const report = await maintainBondEventLog(root, { retainArchives: 1_000 });
    expect(report.status).toBe('completed');
    expect(report.anomalies).toEqual([]);
    expect(report.pendingSegments).toBe(0);
    expect(closedSegments(root)).toEqual([]);
    expect(archives(root).length).toBe(report.compressed.length);
    expect(allRecords(root)).toEqual(written);
    expect(names(root).filter(name => name.endsWith('.partial'))).toEqual([]);
  });

  it('bounds retention to the newest archives and leaves the survivors intact', async () => {
    const root = makeRoot();
    for (let n = 0; n < 12; n++) appendBondEventSync(root, event(n), { maxBytes: 100 });
    const closedBefore = closedSegments(root);
    expect(closedBefore.length).toBe(11);
    const expectedSurvivors = closedBefore.slice(-3).map(name => `${name}.gz`);
    const survivorRecords = closedBefore.slice(-3)
      .flatMap(name => recordsIn(readFileSync(join(root, name), 'utf8')));

    const report = await maintainBondEventLog(root, { retainArchives: 3 });
    expect(report.retentionRemoved).toEqual(
      closedBefore.slice(0, 8).map(name => parseBondEventSegmentName(name)!.segmentId),
    );
    expect(archives(root)).toEqual(expectedSurvivors);
    expect(allRecords(root)).toEqual([...survivorRecords, 11]);
  });

  it('runs each durable step in order: fsync before rename, rename before source unlink', async () => {
    const root = makeRoot();
    const steps: string[] = [];
    const observe = (step: BondEventLogStep) => { steps.push(step); };
    // Record the real file fsync, not just the step marker beside it.
    const probe = await open(join(root, 'probe'), 'w');
    const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const realSync = fileHandleProto.sync;
    const syncSpy = vi.spyOn(fileHandleProto, 'sync').mockImplementation(function (this: unknown) {
      steps.push('filehandle-sync');
      return realSync.call(this);
    });
    try {
      appendBondEventSync(root, event(1), { maxBytes: 50, observe });
      appendBondEventSync(root, event(2), { maxBytes: 50, observe });
      await maintainBondEventLog(root, { observe });
    } finally {
      syncSpy.mockRestore();
    }
    expect(steps).toEqual([
      'rotation-renamed',
      'rotation-dir-fsynced',
      'partial-written',
      'filehandle-sync',
      'partial-fsynced',
      'partial-verified',
      'archive-renamed',
      'archive-dir-fsynced',
      'source-unlinked',
      'source-dir-fsynced',
    ]);
  });

  it('never deletes a renamed archive when a step after the rename fails', async () => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 50 });
    appendBondEventSync(root, event(2), { maxBytes: 50 });
    const [closed] = closedSegments(root);

    const failed = await maintainBondEventLog(root, {
      observe: (step) => { if (step === 'archive-renamed') throw new Error('injected failure after rename'); },
    });
    expect(failed.anomalies).toEqual([{ segmentId: parseBondEventSegmentName(closed)!.segmentId, reason: 'compression_failed' }]);
    expect(names(root)).toEqual([LIVE, closed, `${closed}.gz`]);

    const recovered = await maintainBondEventLog(root);
    expect(recovered.sourcesRemovedAfterReverify).toEqual([parseBondEventSegmentName(closed)!.segmentId]);
    expect(names(root)).toEqual([LIVE, `${closed}.gz`]);
    expect(allRecords(root)).toEqual([1, 2]);
  });

  it.each([
    ['a torn, undecodable partial', () => Buffer.from('torn')],
    ['a well-formed gzip that lost records', () => gzipSync(Buffer.alloc(0))],
  ])('never names or trusts %s, and keeps the source', async (_label, replacement) => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 50 });
    appendBondEventSync(root, event(2), { maxBytes: 50 });
    const [closed] = closedSegments(root);

    const report = await maintainBondEventLog(root, {
      observe: (step, segmentId) => {
        if (step === 'partial-written') writeFileSync(join(root, `${LIVE}.${segmentId}.gz.partial`), replacement());
      },
    });
    expect(report.anomalies.map(anomaly => anomaly.reason)).toEqual(['compression_failed']);
    expect(names(root)).toEqual([LIVE, closed]);
    expect(recordsIn(readFileSync(join(root, closed), 'utf8'))).toEqual([1]);
  });

  it('removes its own partial when compression fails before the rename, keeping the source', async () => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 50 });
    appendBondEventSync(root, event(2), { maxBytes: 50 });
    const [closed] = closedSegments(root);

    const failed = await maintainBondEventLog(root, {
      observe: (step) => { if (step === 'partial-fsynced') throw new Error('injected failure before rename'); },
    });
    expect(failed.anomalies.map(anomaly => anomaly.reason)).toEqual(['compression_failed']);
    expect(failed.pendingSegments).toBe(1);
    expect(names(root)).toEqual([LIVE, closed]);

    await maintainBondEventLog(root);
    expect(allRecords(root)).toEqual([1, 2]);
  });
});

describe('crash recovery: on-disk state left at each crash point', () => {
  const first = lineOf(event(1)) + lineOf(event(2));

  it('crash after R1 (live renamed, new live not yet created): compresses, next append recreates live', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}`, first);

    const report = await maintainBondEventLog(root);
    expect(report.compressed).toEqual([ID_A]);
    expect(appendBondEventSync(root, event(3), { maxBytes: 1_000 }).rotated).toBe(false);
    expect(names(root)).toEqual([LIVE, `${LIVE}.${ID_A}.gz`]);
    expect(allRecords(root)).toEqual([1, 2, 3]);
  });

  it('crash during C1 (truncated partial beside its source): discards the partial and compresses again', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}`, first);
    writeSegment(root, `${LIVE}.${ID_A}.gz.partial`, gzipSync(Buffer.from(first)).subarray(0, 12));
    writeSegment(root, LIVE, lineOf(event(3)));

    const report = await maintainBondEventLog(root);
    expect(report.partialsDiscarded).toEqual([ID_A]);
    expect(report.compressed).toEqual([ID_A]);
    expect(names(root)).toEqual([LIVE, `${LIVE}.${ID_A}.gz`]);
    expect(allRecords(root)).toEqual([1, 2, 3]);
  });

  it('crash after C1 fsync, before C3 rename (complete partial): still treated as unverified, no duplicate', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}`, first);
    writeSegment(root, `${LIVE}.${ID_A}.gz.partial`, gzipSync(Buffer.from(first)));

    const report = await maintainBondEventLog(root);
    expect(report.partialsDiscarded).toEqual([ID_A]);
    expect(names(root)).toEqual([`${LIVE}.${ID_A}.gz`]);
    expect(allRecords(root)).toEqual([1, 2]);
  });

  it('crash between C3 and C4 (archive named, source still present): re-verifies, then removes the source once', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}`, first);
    writeSegment(root, `${LIVE}.${ID_A}.gz`, gzipSync(Buffer.from(first)));
    writeSegment(root, LIVE, lineOf(event(3)));

    const report = await maintainBondEventLog(root);
    expect(report.sourcesRemovedAfterReverify).toEqual([ID_A]);
    expect(report.compressed).toEqual([]);
    expect(names(root)).toEqual([LIVE, `${LIVE}.${ID_A}.gz`]);
    expect(allRecords(root)).toEqual([1, 2, 3]);
  });

  it('a half-written archive beside its source is never trusted: both files are kept and reported', async () => {
    const root = makeRoot();
    const truncated = gzipSync(Buffer.from(first)).subarray(0, 15);
    writeSegment(root, `${LIVE}.${ID_A}`, first);
    writeSegment(root, `${LIVE}.${ID_A}.gz`, truncated);

    const report = await maintainBondEventLog(root, { retainArchives: 1 });
    expect(report.anomalies).toEqual([{ segmentId: ID_A, reason: 'archive_does_not_match_source' }]);
    expect(report.retentionRemoved).toEqual([]);
    expect(readFileSync(join(root, `${LIVE}.${ID_A}`), 'utf8')).toBe(first);
    expect(readFileSync(join(root, `${LIVE}.${ID_A}.gz`))).toEqual(truncated);
  });

  it('an archive holding different records than its source is kept with the source', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}`, first);
    writeSegment(root, `${LIVE}.${ID_A}.gz`, gzipSync(Buffer.from(lineOf(event(9)))));

    const report = await maintainBondEventLog(root);
    expect(report.anomalies).toEqual([{ segmentId: ID_A, reason: 'archive_does_not_match_source' }]);
    expect(names(root)).toEqual([`${LIVE}.${ID_A}`, `${LIVE}.${ID_A}.gz`]);
  });

  it('a partial with no source (possibly the only copy) is kept and reported', async () => {
    const root = makeRoot();
    const onlyCopy = gzipSync(Buffer.from(first));
    writeSegment(root, `${LIVE}.${ID_A}.gz.partial`, onlyCopy);

    const report = await maintainBondEventLog(root);
    expect(report.anomalies).toEqual([{ segmentId: ID_A, reason: 'partial_without_source' }]);
    expect(readFileSync(join(root, `${LIVE}.${ID_A}.gz.partial`))).toEqual(onlyCopy);
  });

  it('a partial beside a finalized archive is kept and the archive is not counted for retention', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.${ID_A}.gz`, gzipSync(Buffer.from(first)));
    writeSegment(root, `${LIVE}.${ID_A}.gz.partial`, gzipSync(Buffer.from(first)));
    writeSegment(root, `${LIVE}.${ID_B}.gz`, gzipSync(Buffer.from(lineOf(event(3)))));

    const report = await maintainBondEventLog(root, { retainArchives: 1 });
    expect(report.anomalies).toEqual([{ segmentId: ID_A, reason: 'partial_beside_archive' }]);
    expect(report.retentionRemoved).toEqual([]);
    expect(names(root)).toEqual([`${LIVE}.${ID_A}.gz`, `${LIVE}.${ID_A}.gz.partial`, `${LIVE}.${ID_B}.gz`]);
  });

  it('never touches names it does not own, and reports a non-regular segment name', async () => {
    const root = makeRoot();
    // The live maintenance lock itself is not planted: a corrupt lock makes a
    // pass fail closed (asserted below), which is the process-lock contract.
    const decoys = [
      `${LIVE}.maintenance.lock.123.token.tmp`,
      `${LIVE}.foo`,
      `${LIVE}.20260924T010000000Z-XYZ`,
      `${LIVE}.${ID_A}.gz.partial.bak`,
      `${LIVE}.${ID_A}.tmp`,
      `other-events.ndjson.${ID_A}`,
    ];
    for (const decoy of decoys) writeSegment(root, decoy, 'decoy');
    mkdirSync(join(root, `${LIVE}.${ID_B}`));
    writeSegment(root, `${LIVE}.${ID_A}`, first);

    const report = await maintainBondEventLog(root, { retainArchives: 1 });
    expect(report.anomalies).toEqual([{ segmentId: ID_B, reason: 'non_regular_entry' }]);
    expect(report.compressed).toEqual([ID_A]);
    for (const decoy of decoys) expect(readFileSync(join(root, decoy), 'utf8')).toBe('decoy');
    expect(existsSync(join(root, `${LIVE}.${ID_B}`))).toBe(true);
  });
});

describe('maintenance lock', () => {
  it('fails closed on a corrupt maintenance lock and leaves every segment in place', async () => {
    const root = makeRoot();
    writeSegment(root, `${LIVE}.maintenance.lock`, 'not a lock payload');
    writeSegment(root, `${LIVE}.${ID_A}`, lineOf(event(1)));

    await expect(maintainBondEventLog(root)).rejects.toThrow(/process lock corrupt/);
    expect(names(root)).toEqual([`${LIVE}.${ID_A}`, `${LIVE}.maintenance.lock`]);
  });
});

describe('scheduleBondEventMaintenance', () => {
  it('runs one pass at a time per root and re-runs for a rotation that lands mid-pass', async () => {
    const root = makeRoot();
    appendBondEventSync(root, event(1), { maxBytes: 50 });
    appendBondEventSync(root, event(2), { maxBytes: 50 });
    const running = scheduleBondEventMaintenance(root);
    appendBondEventSync(root, event(3), { maxBytes: 50 });
    const joined = scheduleBondEventMaintenance(root);
    expect(joined).toBe(running);

    await running;
    expect(closedSegments(root)).toEqual([]);
    expect(allRecords(root)).toEqual([1, 2, 3]);
  });
});
