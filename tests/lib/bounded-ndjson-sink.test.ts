import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedNdjsonSink } from '../../src/lib/bounded-ndjson-sink.ts';
import type { BoundedNdjsonSink, BoundedNdjsonSinkOptions } from '../../src/lib/bounded-ndjson-sink.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('ndjson-sink-');
const isRoot = process.getuid?.() === 0;
const PREFIX = 'events';

const open: BoundedNdjsonSink[] = [];
afterEach(async () => {
  for (const sink of open.splice(0)) await sink.close(500);
});

function make(opts: Partial<BoundedNdjsonSinkOptions> & { dir: string }): BoundedNdjsonSink {
  const sink = createBoundedNdjsonSink({ filePrefix: PREFIX, ...opts });
  open.push(sink);
  return sink;
}

async function settled(sink: BoundedNdjsonSink): Promise<void> {
  await vi.waitFor(() => {
    expect(sink.state()).not.toBe('starting');
  });
}

async function drained(sink: BoundedNdjsonSink): Promise<void> {
  await vi.waitFor(() => {
    expect(sink.stats().queued).toBe(0);
  });
}

function segments(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^events\.\d{6}\.ndjson$/.test(n)).sort();
}

function readLines(dir: string, name: string): unknown[] {
  return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
}

describe('createBoundedNdjsonSink', () => {
  it('writes records in order to the first segment and reads them back', async () => {
    const dir = join(tmp.make('write'), 'sink');
    const sink = make({ dir });
    for (let i = 0; i < 5; i += 1) expect(sink.enqueue({ i })).toBe('queued');
    await settled(sink);
    await drained(sink);
    expect(sink.state()).toBe('ready');
    expect(segments(dir)).toEqual(['events.000001.ndjson']);
    expect(readLines(dir, 'events.000001.ndjson')).toEqual([0, 1, 2, 3, 4].map((i) => ({ i })));
    expect(sink.stats()).toMatchObject({ written: 5, queued: 0, segmentIndex: 1 });
  });

  // @skip-env: POSIX mode bits are not enforced for root or on win32.
  it.skipIf(isRoot || process.platform === 'win32')('creates the directory 0700 and segments 0600', async () => {
    const dir = join(tmp.make('modes'), 'sink');
    const sink = make({ dir });
    sink.enqueue({ a: 1 });
    await settled(sink);
    await drained(sink);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'events.000001.ndjson')).mode & 0o777).toBe(0o600);
  });

  it('counts queue-full drops without throwing', async () => {
    const dir = join(tmp.make('full'), 'sink');
    const sink = make({ dir, maxQueue: 3 });
    const results = [1, 2, 3, 4, 5].map((i) => sink.enqueue({ i }));
    expect(results).toEqual(['queued', 'queued', 'queued', 'dropped_queue_full', 'dropped_queue_full']);
    expect(sink.stats().droppedQueueFull).toBe(2);
    await settled(sink);
    await drained(sink);
    expect(readLines(dir, 'events.000001.ndjson')).toHaveLength(3);
  });

  it('drops a line larger than maxLineBytes (UTF-8 bytes including newline)', async () => {
    const dir = join(tmp.make('oversize'), 'sink');
    const sink = make({ dir, maxLineBytes: 20 });
    // JSON "\"é...\"\n": 2 quotes + newline + 2 bytes per é.
    expect(sink.enqueue('é'.repeat(8))).toBe('queued'); // 19 bytes
    expect(sink.enqueue('é'.repeat(9))).toBe('dropped_oversize'); // 21 bytes
    expect(sink.stats().droppedOversize).toBe(1);
  });

  it('never throws on unserializable records', () => {
    const dir = join(tmp.make('unser'), 'sink');
    const sink = make({ dir });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sink.enqueue(circular)).toBe('dropped_unserializable');
    expect(sink.enqueue(undefined)).toBe('dropped_unserializable');
    expect(sink.enqueue(10n)).toBe('dropped_unserializable');
    expect(sink.stats().droppedUnserializable).toBe(3);
  });

  it('rotates to the next segment before a segment would exceed segmentMaxBytes', async () => {
    const dir = join(tmp.make('rotate'), 'sink');
    // Each {"i":N}\n line is 8 bytes; 20-byte segments hold two lines.
    const sink = make({ dir, segmentMaxBytes: 20, flushBatch: 4 });
    for (let i = 0; i < 5; i += 1) sink.enqueue({ i });
    await settled(sink);
    await drained(sink);
    expect(segments(dir)).toEqual(['events.000001.ndjson', 'events.000002.ndjson', 'events.000003.ndjson']);
    for (const name of segments(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(20);
    const all = segments(dir).flatMap((n) => readLines(dir, n));
    expect(all).toEqual([0, 1, 2, 3, 4].map((i) => ({ i })));
    expect(sink.stats()).toMatchObject({ written: 5, segmentIndex: 3 });
  });

  it('enters segment_cap_reached without deleting or modifying existing segments', async () => {
    const dir = join(tmp.make('cap'), 'sink');
    const sink = make({ dir, segmentMaxBytes: 20, maxSegments: 2, flushBatch: 1 });
    const results: string[] = [];
    for (let i = 0; i < 4; i += 1) results.push(sink.enqueue({ i }));
    await settled(sink);
    await drained(sink);
    expect(segments(dir)).toEqual(['events.000001.ndjson', 'events.000002.ndjson']);
    const before = segments(dir).map((n) => readFileSync(join(dir, n)));
    for (let i = 4; i < 7; i += 1) results.push(sink.enqueue({ i }));
    await vi.waitFor(() => {
      expect(sink.state()).toBe('degraded');
    });
    expect(sink.degradedReason()).toBe('segment_cap_reached');
    expect(sink.enqueue({ late: true })).toBe('dropped_degraded');
    await sink.close(200);
    expect(segments(dir)).toEqual(['events.000001.ndjson', 'events.000002.ndjson']);
    expect(segments(dir).map((n) => readFileSync(join(dir, n)))).toEqual(before);
    const s = sink.stats();
    const admitted = results.filter((r) => r === 'queued').length;
    // Conservation: every admitted record ends in exactly one bucket; the late
    // enqueue above was rejected at admission and also counted as degraded.
    expect(s.written + s.droppedWriteFailed + (s.droppedDegraded - 1) + s.droppedClosed + s.queued).toBe(admitted);
    expect(s.written).toBe(4);
  });

  it('resumes in the highest existing segment when it is below segmentMaxBytes', async () => {
    const dir = join(tmp.make('resume'), 'sink');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'events.000001.ndjson'), '{"old":1}\n', { mode: 0o600 });
    writeFileSync(join(dir, 'events.000003.ndjson'), '{"old":3}\n', { mode: 0o600 });
    writeFileSync(join(dir, 'events.lock.123.tmp'), 'noise');
    writeFileSync(join(dir, 'events.9.ndjson'), 'noise');
    const sink = make({ dir });
    sink.enqueue({ fresh: true });
    await settled(sink);
    await drained(sink);
    expect(readLines(dir, 'events.000003.ndjson')).toEqual([{ old: 3 }, { fresh: true }]);
    expect(readLines(dir, 'events.000001.ndjson')).toEqual([{ old: 1 }]);
    expect(sink.stats().segmentIndex).toBe(3);
  });

  it('starts the next segment when the highest one is full', async () => {
    const dir = join(tmp.make('resume-full'), 'sink');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'events.000002.ndjson'), 'x'.repeat(40), { mode: 0o600 });
    const sink = make({ dir, segmentMaxBytes: 40 });
    sink.enqueue({ n: 1 });
    await settled(sink);
    await drained(sink);
    expect(segments(dir)).toEqual(['events.000002.ndjson', 'events.000003.ndjson']);
    expect(readFileSync(join(dir, 'events.000002.ndjson'), 'utf8')).toBe('x'.repeat(40));
  });

  it('degrades a second sink on the same directory as a competing writer', async () => {
    const dir = join(tmp.make('compete'), 'sink');
    const first = make({ dir });
    await settled(first);
    expect(first.state()).toBe('ready');
    const warnings: string[] = [];
    const second = make({ dir, warn: (c) => warnings.push(c) });
    expect(second.enqueue({ early: true })).toBe('queued');
    await settled(second);
    expect(second.state()).toBe('degraded');
    expect(second.degradedReason()).toBe('competing_writer');
    expect(warnings).toEqual(['competing_writer']);
    expect(second.enqueue({ late: true })).toBe('dropped_degraded');
    expect(second.stats().droppedDegraded).toBe(2);
    // The loser's close must not release the winner's lock.
    await second.close(200);
    expect(readdirSync(dir)).toContain('events.lock');
    first.enqueue({ still: 'writing' });
    await drained(first);
    expect(readLines(dir, 'events.000001.ndjson')).toEqual([{ still: 'writing' }]);
  });

  it('releases the lock on close so a successor can acquire it', async () => {
    const dir = join(tmp.make('release'), 'sink');
    const first = make({ dir });
    await settled(first);
    await first.close(200);
    expect(first.state()).toBe('closed');
    expect(readdirSync(dir)).not.toContain('events.lock');
    const second = make({ dir });
    await settled(second);
    expect(second.state()).toBe('ready');
  });

  // @skip-env: root ignores directory write permission; win32 has no chmod 0o500.
  it.skipIf(isRoot || process.platform === 'win32')('degrades on an unwritable directory and enqueue never throws', async () => {
    const parent = tmp.make('ro');
    const dir = join(parent, 'sink');
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o500);
    try {
      const warnings: string[] = [];
      const sink = make({ dir, warn: (c) => warnings.push(c) });
      expect(() => sink.enqueue({ a: 1 })).not.toThrow();
      await settled(sink);
      expect(sink.state()).toBe('degraded');
      expect(sink.degradedReason()).toBe('lock_failed');
      expect(warnings).toEqual(['lock_failed']);
      expect(sink.enqueue({ b: 2 })).toBe('dropped_degraded');
      expect(sink.stats().droppedDegraded).toBe(2);
      await expect(sink.close(200)).resolves.toBeUndefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('degrades with write_failed after three consecutive failed writes', async () => {
    const dir = join(tmp.make('writefail'), 'sink');
    mkdirSync(dir, { mode: 0o700 });
    // A directory in the segment's place makes every open() fail.
    mkdirSync(join(dir, 'events.000001.ndjson'));
    const warnings: string[] = [];
    const sink = make({ dir, flushBatch: 1, warn: (c) => warnings.push(c) });
    const results = [1, 2, 3, 4, 5].map((i) => sink.enqueue({ i }));
    await vi.waitFor(() => {
      expect(sink.state()).toBe('degraded');
    });
    expect(sink.degradedReason()).toBe('write_failed');
    const s = sink.stats();
    expect(s.writeErrors).toBe(3);
    expect(s.droppedWriteFailed).toBe(3);
    expect(s.written).toBe(0);
    // Warn is rate-limited: one per-error warning inside the 60 s window, one degraded warning.
    expect(warnings).toEqual(['write_failed', 'write_failed']);
    const admitted = results.filter((r) => r === 'queued').length;
    expect(s.written + s.droppedWriteFailed + s.droppedDegraded + s.droppedClosed + s.queued).toBe(admitted);
  });

  it('close() flushes pending records within the deadline, then refuses admission', async () => {
    const dir = join(tmp.make('close'), 'sink');
    const sink = createBoundedNdjsonSink({ dir, filePrefix: PREFIX });
    for (let i = 0; i < 50; i += 1) sink.enqueue({ i });
    const started = Date.now();
    await sink.close(1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sink.state()).toBe('closed');
    expect(sink.stats()).toMatchObject({ written: 50, queued: 0, droppedClosed: 0 });
    expect(readLines(dir, 'events.000001.ndjson')).toHaveLength(50);
    expect(sink.enqueue({ late: true })).toBe('dropped_closed');
    expect(readdirSync(dir)).not.toContain('events.lock');
  });

  it('close() with a zero deadline counts unflushed records as droppedClosed and never throws', async () => {
    const dir = join(tmp.make('close-zero'), 'sink');
    const sink = createBoundedNdjsonSink({ dir, filePrefix: PREFIX });
    for (let i = 0; i < 10; i += 1) sink.enqueue({ i });
    await expect(sink.close(0)).resolves.toBeUndefined();
    expect(sink.state()).toBe('closed');
    const s = sink.stats();
    expect(s.written + s.droppedClosed + s.droppedWriteFailed + s.queued).toBe(10);
    await drained(sink);
    const settledStats = sink.stats();
    expect(settledStats.written + settledStats.droppedClosed + settledStats.droppedWriteFailed).toBe(10);
    // Startup that finishes after close must not leave the lock behind.
    await vi.waitFor(() => {
      expect(readdirSync(dir)).not.toContain('events.lock');
    });
  });
});
