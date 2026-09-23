import { existsSync, readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

type Stage = 'mkdir' | 'readdir' | 'write';

// Parks one sink stage so close() provably overlaps a startup step or an in-flight write.
const gate = vi.hoisted(() => {
  const state = {
    on: null as Stage | null,
    entered: false,
    done: false,
    release: () => undefined as void,
    opened: Promise.resolve(),
    arm(stage: Stage) {
      state.on = stage;
      state.entered = false;
      state.done = false;
      state.opened = new Promise<void>((resolve) => { state.release = resolve; });
    },
  };
  return state;
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const parked = async (stage: Stage): Promise<void> => {
    if (gate.on !== stage) return;
    gate.entered = true;
    await gate.opened;
  };
  const gatedHandle = (h: FileHandle): FileHandle => new Proxy(h, {
    get(target, prop) {
      if (prop === 'writeFile') {
        return async (...args: Parameters<FileHandle['writeFile']>) => {
          await parked('write');
          const result = await target.writeFile(...args);
          if (gate.on === 'write') gate.done = true;
          return result;
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      await parked('mkdir');
      const result = await actual.mkdir(...args);
      if (gate.on === 'mkdir') gate.done = true;
      return result;
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await parked('readdir');
      const result = await actual.readdir(...args);
      if (gate.on === 'readdir') gate.done = true;
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => gatedHandle(await actual.open(...args)),
  };
});

const { createBoundedNdjsonSink } = await import('../../src/lib/bounded-ndjson-sink.ts');

const tmp = trackTmpDirs('ndjson-sink-race-');

afterEach(() => {
  gate.release();
  gate.on = null;
});

async function afterGatedStage(): Promise<void> {
  await vi.waitFor(() => {
    expect(gate.done).toBe(true);
  });
  // Startup's continuation after the gated await is synchronous up to its
  // next await, so one macrotask turn has run it.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('createBoundedNdjsonSink close/startup race', () => {
  it('never acquires the lock when close() finishes during mkdir', async () => {
    gate.arm('mkdir');
    const dir = join(tmp.make('mkdir'), 'sink');
    const sink = createBoundedNdjsonSink({ dir, filePrefix: 'events' });
    sink.enqueue({ pending: true });
    await vi.waitFor(() => {
      expect(gate.entered).toBe(true);
    });
    await sink.close(0);
    expect(sink.state()).toBe('closed');
    expect(sink.stats().droppedClosed).toBe(1);
    gate.release();
    await afterGatedStage();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'events.lock'))).toBe(false);
    expect(sink.state()).toBe('closed');
  });

  it('releases the lock when close() finishes during the resume listing', async () => {
    gate.arm('readdir');
    const dir = join(tmp.make('readdir'), 'sink');
    const lockPath = join(dir, 'events.lock');
    const sink = createBoundedNdjsonSink({ dir, filePrefix: 'events' });
    await vi.waitFor(() => {
      expect(gate.entered).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(true);
    await sink.close(0);
    expect(existsSync(lockPath)).toBe(false);
    gate.release();
    await afterGatedStage();
    expect(sink.state()).toBe('closed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('waits for a slow in-flight write and releases the lock before close() resolves', async () => {
    gate.arm('write');
    const dir = join(tmp.make('inflight'), 'sink');
    const lockPath = join(dir, 'events.lock');
    const sink = createBoundedNdjsonSink({ dir, filePrefix: 'events' });
    sink.enqueue({ slow: true });
    await vi.waitFor(() => {
      expect(gate.entered).toBe(true);
    });
    const closing = sink.close(0);
    // close() marks the sink closed only once its flush deadline has passed;
    // the write is still parked, so it is now waiting on the in-flight write.
    await vi.waitFor(() => {
      expect(sink.state()).toBe('closed');
    });
    expect(gate.done).toBe(false);
    gate.release();
    await closing;
    expect(gate.done).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(sink.stats()).toMatchObject({ written: 1, queued: 0, droppedClosed: 0 });

    gate.on = null;
    const successor = createBoundedNdjsonSink({ dir, filePrefix: 'events' });
    await vi.waitFor(() => {
      expect(successor.state()).not.toBe('starting');
    });
    expect(successor.state()).toBe('ready');
    successor.enqueue({ next: true });
    await successor.close(1000);
    const lines = readFileSync(join(dir, 'events.000001.ndjson'), 'utf8').split('\n').filter(Boolean);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ slow: true }, { next: true }]);
  });
});
