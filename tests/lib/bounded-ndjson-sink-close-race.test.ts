import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

// Parks one startup stage so close() provably finishes while startup is mid-flight.
const gate = vi.hoisted(() => {
  const state = {
    on: null as 'mkdir' | 'readdir' | null,
    entered: false,
    done: false,
    release: () => undefined as void,
    opened: Promise.resolve(),
    arm(stage: 'mkdir' | 'readdir') {
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
  const parked = async (stage: 'mkdir' | 'readdir'): Promise<void> => {
    if (gate.on !== stage) return;
    gate.entered = true;
    await gate.opened;
  };
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
});
